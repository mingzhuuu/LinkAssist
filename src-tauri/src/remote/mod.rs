pub mod commands;
mod dns;
mod identity;
mod protocol;

use iroh::{
    endpoint::{presets, Connection},
    Endpoint,
};
use protocol::{
    err, read_frame, write_frame, Hello, Invitation, Reply, Request, ALPN, MAX_WORKSPACE_EDIT, MAX_FRAME,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, watch, Mutex, Semaphore};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub invitation: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct SavedPeers {
    #[serde(default)]
    trusted: Vec<Peer>,
    #[serde(default)]
    recent: Vec<Peer>,
    #[serde(default)]
    no_approval: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPeer {
    pub id: String,
    pub name: String,
    pub request_id: String,
}

struct PendingApproval {
    peer: PendingPeer,
    answer: oneshot::Sender<bool>,
}
struct InviteSecret {
    secret: String,
    expires: Option<Instant>,
    expires_at: Option<u64>,
    code: String,
}

#[derive(Clone)]
struct Session {
    id: String,
    name: String,
    connection: Connection,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    enabled: bool,
    no_approval: bool,
    invitation: Option<String>,
    invite_expires_at: Option<u64>,
    persistent_invite: bool,
    endpoint_id: Option<String>,
    pending: Option<PendingPeer>,
    trusted: Vec<Peer>,
    recent: Vec<Peer>,
    controller: Option<Peer>,
    connected: Option<Peer>,
    connecting: bool,
    transport: Option<String>,
    rtt_ms: Option<u64>,
    reconnect_allowed: bool,
}

#[derive(Default)]
struct Inner {
    endpoint: Option<Endpoint>,
    directory: Option<PathBuf>,
    saved: SavedPeers,
    enabled: bool,
    invite: Option<InviteSecret>,
    pending: Option<PendingApproval>,
    controller: Option<Session>,
    client: Option<Session>,
    connecting: bool,
    generation: u64,
    connecting_connection: Option<Connection>,
    requests: HashMap<String, oneshot::Sender<Reply>>,
    client_snapshot: Option<Value>,
    reconnect_allowed: bool,
}

#[derive(Clone)]
pub struct RemoteAccess {
    inner: Arc<Mutex<Inner>>,
    snapshot: watch::Sender<Value>,
    admission: Arc<Semaphore>,
}

impl Default for RemoteAccess {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            snapshot: watch::channel(Value::Null).0,
            admission: Arc::new(Semaphore::new(4)),
        }
    }
}

fn peer(session: &Session) -> Peer {
    Peer {
        id: session.id.clone(),
        name: session.name.clone(),
        invitation: None,
    }
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "LinkAssist".into())
        .chars()
        .take(64)
        .collect()
}

fn storage_directory(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(config) = crate::snapshot::runtime_config_path()? {
        return config
            .parent()
            .map(|path| path.join("remote-access"))
            .ok_or_else(|| "Invalid snapshot configuration directory".into());
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(err)?
        .join("remote-access"))
}

fn save_peers(inner: &Inner) -> Result<(), String> {
    let dir = inner
        .directory
        .as_ref()
        .ok_or("Remote identity is not initialized")?;
    std::fs::create_dir_all(dir).map_err(err)?;
    let temporary = dir.join(format!("peers-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, serde_json::to_vec(&inner.saved).map_err(err)?).map_err(err)?;
    if let Err(error) = std::fs::rename(&temporary, dir.join("peers.json")) {
        let _ = std::fs::remove_file(temporary);
        return Err(err(error));
    }
    Ok(())
}

impl RemoteAccess {
    pub async fn load_profiles(&self, app: &AppHandle) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        if inner.directory.is_some() {
            return Ok(());
        }
        let directory = storage_directory(app)?;
        let path = directory.join("peers.json");
        if path.exists() {
            inner.saved =
                serde_json::from_slice(&std::fs::read(path).map_err(err)?).map_err(err)?;
        }
        // Identity and network sockets are created only when explicitly enabled/connected.
        inner.directory = Some(directory);
        Ok(())
    }

    async fn endpoint(&self, app: &AppHandle) -> Result<Endpoint, String> {
        let mut inner = self.inner.lock().await;
        if let Some(endpoint) = &inner.endpoint {
            return Ok(endpoint.clone());
        }
        let directory = storage_directory(app)?;
        let key = identity::load_key(&directory)?;
        let saved_path = directory.join("peers.json");
        let saved = if saved_path.exists() {
            serde_json::from_slice(&std::fs::read(saved_path).map_err(err)?).map_err(err)?
        } else {
            SavedPeers::default()
        };
        let endpoint = Endpoint::builder(presets::N0)
            .dns_resolver(dns::resolver())
            .secret_key(key)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .map_err(err)?;
        inner.directory = Some(directory);
        inner.saved = saved;
        inner.endpoint = Some(endpoint.clone());
        drop(inner);
        let accept_endpoint = endpoint.clone();
        let service = self.clone();
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(incoming) = accept_endpoint.accept().await {
                let Ok(permit) = service.admission.clone().try_acquire_owned() else {
                    incoming.refuse();
                    continue;
                };
                if !service.inner.lock().await.enabled {
                    incoming.refuse();
                    continue;
                }
                let service = service.clone();
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let _permit = permit;
                    if let Ok(Ok(connection)) =
                        tokio::time::timeout(Duration::from_secs(10), incoming).await
                    {
                        service.serve_peer(handle, connection).await;
                    }
                });
            }
        });
        Ok(endpoint)
    }

    pub async fn status(&self) -> Status {
        let inner = self.inner.lock().await;
        let selected = inner.client.as_ref().and_then(|s| {
            s.connection
                .paths()
                .iter()
                .find(|path| path.is_selected())
                .map(|path| {
                    (
                        if path.is_ip() { "direct" } else { "relay" }.to_string(),
                        path.rtt().as_millis() as u64,
                    )
                })
        });
        Status {
            enabled: inner.enabled,
            no_approval: inner.saved.no_approval,
            invitation: inner.invite.as_ref().map(|i| i.code.clone()),
            invite_expires_at: inner.invite.as_ref().and_then(|i| i.expires_at),
            persistent_invite: inner.invite.as_ref().is_some_and(|i| i.expires.is_none()),
            endpoint_id: inner.endpoint.as_ref().map(|e| e.id().to_string()),
            pending: inner.pending.as_ref().map(|p| p.peer.clone()),
            trusted: inner.saved.trusted.clone(),
            recent: inner.saved.recent.clone(),
            controller: inner
                .controller
                .as_ref()
                .filter(|s| s.connection.close_reason().is_none())
                .map(peer),
            connected: inner
                .client
                .as_ref()
                .filter(|s| s.connection.close_reason().is_none())
                .map(peer),
            connecting: inner.connecting,
            transport: selected.as_ref().map(|s| s.0.clone()),
            rtt_ms: selected.map(|s| s.1),
            reconnect_allowed: inner.reconnect_allowed,
        }
    }

    async fn changed(&self, app: &AppHandle) {
        let _ = app.emit("remote-status", self.status().await);
    }

    pub async fn enable(&self, app: &AppHandle, enabled: bool) -> Result<(), String> {
        if enabled {
            self.endpoint(app).await?;
        }
        let mut inner = self.inner.lock().await;
        if enabled && (inner.client.is_some() || inner.connecting) {
            return Err("Disconnect from the remote host before enabling incoming control".into());
        }
        inner.enabled = enabled;
        if !enabled {
            inner.invite = None;
            inner.pending = None;
            inner.requests.clear();
            if let Some(session) = inner.controller.take() {
                session
                    .connection
                    .close(0u32.into(), b"Host disabled remote access");
            }
        }
        drop(inner);
        if enabled {
            let directory = storage_directory(app)?;
            if let Some(code) = identity::load_pairing(&directory)? {
                let ticket = Invitation::decode(&code)?;
                let mut inner = self.inner.lock().await;
                if inner.endpoint.as_ref().is_some_and(|e| e.id() == ticket.address.id) {
                    inner.invite = Some(InviteSecret { secret: ticket.secret, code, expires: None, expires_at: None });
                }
            }
            let needs_invite = self.inner.lock().await.invite.is_none();
            if needs_invite { self.invite(app, Some(false)).await?; }
        }
        self.changed(app).await;
        Ok(())
    }

    pub async fn set_no_approval(&self, app: &AppHandle, enabled: bool) -> Result<(), String> {
        self.load_profiles(app).await?;
        let mut inner = self.inner.lock().await;
        let previous = inner.saved.no_approval;
        inner.saved.no_approval = enabled;
        if let Err(error) = save_peers(&inner) { inner.saved.no_approval = previous; return Err(error); }
        drop(inner);
        self.changed(app).await;
        Ok(())
    }

    pub async fn invite(&self, app: &AppHandle, persistent: Option<bool>) -> Result<String, String> {
        let endpoint = self.endpoint(app).await?;
        tokio::time::timeout(Duration::from_secs(15), endpoint.online()).await
            .map_err(|_| "Cannot reach iroh public relays. Check your network.")?;
        let mut inner = self.inner.lock().await;
        if !inner.enabled { return Err("Enable remote access first".into()); }
        let persistent = persistent.unwrap_or_else(|| inner.invite.as_ref().is_some_and(|i| i.expires.is_none()));
        let secret = uuid::Uuid::new_v4().simple().to_string();
        let code = Invitation { version: 1, address: endpoint.addr(), secret: secret.clone(), name: device_name() }.encode()?;
        identity::save_pairing(inner.directory.as_ref().ok_or("Missing remote directory")?, if persistent { Some(&code) } else { None })?;
        let expires_at = if persistent { None } else { Some(SystemTime::now().duration_since(UNIX_EPOCH).map_err(err)?.as_millis() as u64 + 300_000) };
        inner.invite = Some(InviteSecret { secret, code: code.clone(), expires: if persistent { None } else { Some(Instant::now() + Duration::from_secs(300)) }, expires_at });
        drop(inner);
        self.changed(app).await;
        Ok(code)
    }

    pub async fn approve(
        &self,
        app: &AppHandle,
        request_id: String,
        allow: bool,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        if inner
            .pending
            .as_ref()
            .is_none_or(|p| p.peer.request_id != request_id)
        {
            return Err("Pairing request expired".into());
        }
        let pending = inner.pending.take().ok_or("Pairing request expired")?;
        if allow && inner.enabled {
            inner
                .saved
                .trusted
                .retain(|peer| peer.id != pending.peer.id);
            inner.saved.trusted.push(Peer {
                id: pending.peer.id,
                name: pending.peer.name,
                invitation: None,
            });
            if let Err(error) = save_peers(&inner) {
                inner.saved.trusted.pop();
                return Err(error);
            }
            let _ = pending.answer.send(true);
        } else {
            let _ = pending.answer.send(false);
        }
        drop(inner);
        self.changed(app).await;
        Ok(())
    }

    pub async fn revoke(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        inner.saved.trusted.retain(|peer| peer.id != id);
        // A revoked peer must not re-enroll using a previously shared persistent code.
        inner.invite = None;
        if let Some(directory) = &inner.directory {
            if let Err(error) = identity::save_pairing(directory, None) {
                inner.enabled = false;
                if let Some(session) = inner.controller.take() { session.connection.close(0u32.into(), b"Revocation persistence failed"); }
                inner.requests.clear();
                drop(inner);
                self.changed(app).await;
                return Err(error);
            }
        }
        // Stop access immediately, even if saving the revocation fails.
        if inner.controller.as_ref().is_some_and(|s| s.id == id) {
            if let Some(session) = inner.controller.take() {
                session.connection.close(0u32.into(), b"Access revoked");
            }
            inner.requests.clear();
        }
        let result = save_peers(&inner);
        if result.is_err() {
            inner.enabled = false;
        }
        drop(inner);
        self.changed(app).await;
        result
    }

    async fn authorize(
        &self,
        app: &AppHandle,
        connection: &Connection,
        hello: Hello,
    ) -> Result<String, String> {
        if hello.version != 1 || hello.name.len() > 128 || hello.secret.len() > 128 {
            return Err("Incompatible remote protocol".into());
        }
        let id = connection.remote_id().to_string();
        let mut inner = self.inner.lock().await;
        if !inner.enabled {
            return Err("Remote access is disabled".into());
        }
        if inner
            .controller
            .as_ref()
            .is_some_and(|s| s.connection.close_reason().is_none())
        {
            return Err("Another remote controller is connected".into());
        }
        if let Some(peer) = inner.saved.trusted.iter().find(|p| p.id == id) {
            return Ok(peer.name.clone());
        }
        if inner.pending.is_some() {
            return Err("Another pairing request is pending".into());
        }
        let valid = inner
            .invite
            .as_ref()
            .is_some_and(|invite| invite.expires.is_none_or(|expiry| expiry > Instant::now()) && invite.secret == hello.secret);
        if !valid {
            return Err("Invitation expired or invalid; ask the host for a new invitation".into());
        }
        if inner.invite.as_ref().is_some_and(|invite| invite.expires.is_some()) { inner.invite = None; }
        if inner.saved.no_approval {
            inner.saved.trusted.push(Peer { id, name: hello.name.clone(), invitation: None });
            if let Err(error) = save_peers(&inner) { inner.saved.trusted.pop(); return Err(error); }
            drop(inner);
            self.changed(app).await;
            return Ok(hello.name);
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let (answer, receiver) = oneshot::channel();
        inner.pending = Some(PendingApproval {
            peer: PendingPeer {
                id,
                name: hello.name.clone(),
                request_id: request_id.clone(),
            },
            answer,
        });
        drop(inner);
        // Only the trusted local main window can approve a peer.
        let _ = crate::reveal_main_window(app);
        self.changed(app).await;
        let allowed = tokio::select! {
            _ = connection.closed() => false,
            answer = tokio::time::timeout(Duration::from_secs(60), receiver) => matches!(answer, Ok(Ok(true))),
        };
        let mut inner = self.inner.lock().await;
        if inner
            .pending
            .as_ref()
            .is_some_and(|p| p.peer.request_id == request_id)
        {
            inner.pending = None;
        }
        drop(inner);
        self.changed(app).await;
        if allowed {
            Ok(hello.name)
        } else {
            Err("Pairing was rejected or timed out".into())
        }
    }

    async fn serve_peer(&self, app: AppHandle, connection: Connection) {
        let result = self.serve_authorized(&app, &connection).await;
        if let Err(error) = result {
            log::debug!("Remote session ended: {error}");
        }
        connection.close(0u32.into(), b"Remote session ended");
        let mut inner = self.inner.lock().await;
        if inner
            .controller
            .as_ref()
            .is_some_and(|s| s.connection.stable_id() == connection.stable_id())
        {
            inner.controller = None;
            inner.requests.clear();
        }
        drop(inner);
        self.changed(&app).await;
    }

    async fn serve_authorized(
        &self,
        app: &AppHandle,
        connection: &Connection,
    ) -> Result<(), String> {
        let (mut send, mut recv) =
            tokio::time::timeout(Duration::from_secs(10), connection.accept_bi())
                .await
                .map_err(err)?
                .map_err(err)?;
        let hello =
            tokio::time::timeout(Duration::from_secs(5), read_frame::<Hello>(&mut recv, 4096))
                .await
                .map_err(err)??;
        let authorization = self.authorize(app, connection, hello).await;
        if let Err(error) = &authorization {
            write_frame(&mut send, &Reply::from_result(Err(error.clone()))).await?;
            send.finish().map_err(err)?;
            let _ = tokio::time::timeout(Duration::from_secs(1), send.stopped()).await;
            return Err(error.clone());
        }
        let name = authorization?;
        {
            let mut inner = self.inner.lock().await;
            let id = connection.remote_id().to_string();
            if !inner.enabled
                || !inner.saved.trusted.iter().any(|p| p.id == id)
                || inner
                    .controller
                    .as_ref()
                    .is_some_and(|s| s.connection.close_reason().is_none())
            {
                return Err("Control is no longer available".into());
            }
            inner.controller = Some(Session {
                id,
                name,
                connection: connection.clone(),
            });
        }
        write_frame(
            &mut send,
            &Reply::from_result(Ok(json!({"name": device_name()}))),
        )
        .await?;
        send.finish().map_err(err)?;
        self.changed(app).await;
        let mut snapshots = self.snapshot.subscribe();
        let snapshot_connection = connection.clone();
        let snapshot_task = tauri::async_runtime::spawn(async move {
            let Ok(mut stream) = snapshot_connection.open_uni().await else {
                return;
            };
            loop {
                let value = snapshots.borrow_and_update().clone();
                if !matches!(
                    tokio::time::timeout(Duration::from_secs(10), write_frame(&mut stream, &value))
                        .await,
                    Ok(Ok(()))
                ) {
                    break;
                }
                tokio::select! { _ = snapshot_connection.closed() => break, result = snapshots.changed() => if result.is_err() { break; } }
            }
        });
        let mut completed: VecDeque<(String, Reply)> = VecDeque::new();
        let result = async {
            loop {
                let (mut send, mut recv) = connection.accept_bi().await.map_err(err)?;
                let request = tokio::time::timeout(
                    Duration::from_secs(5),
                    read_frame::<Request>(&mut recv, MAX_WORKSPACE_EDIT + 1024),
                )
                .await
                .map_err(err)??;
                let reply = if request.action == "ping" {
                    Reply::from_result(Ok(Value::Null))
                } else if let Some((_, reply)) = completed.iter().find(|(id, _)| id == &request.id)
                {
                    reply.clone()
                } else {
                    let result = match protocol::validate_request(&request) {
                        Ok(()) => self.dispatch(app, connection, &request).await,
                        Err(error) => Err(error),
                    };
                    let reply = Reply::from_result(result);
                    completed.push_back((request.id, reply.clone()));
                    while completed.len() > 128 {
                        completed.pop_front();
                    }
                    reply
                };
                write_frame(&mut send, &reply).await?;
                send.finish().map_err(err)?;
            }
            #[allow(unreachable_code)]
            Ok::<(), String>(())
        }
        .await;
        snapshot_task.abort();
        result
    }

    async fn dispatch(
        &self,
        app: &AppHandle,
        connection: &Connection,
        request: &Request,
    ) -> Result<Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        {
            let mut inner = self.inner.lock().await;
            if !inner.enabled
                || inner
                    .controller
                    .as_ref()
                    .is_none_or(|s| s.connection.stable_id() != connection.stable_id())
            {
                return Err("Remote control revoked".into());
            }
            inner.requests.insert(id.clone(), sender);
        }
        let emitted = app
            .emit_to(
                "main",
                "remote-host-request",
                json!({"id": id, "action": request.action, "args": request.args}),
            )
            .map_err(err);
        let result = match emitted {
            Err(error) => Err(error),
            Ok(()) => tokio::select! {
                _ = connection.closed() => Err("Connection lost; action result is unknown. Do not resend automatically.".into()),
                reply = tokio::time::timeout(Duration::from_secs(30), receiver) => match reply {
                    Ok(Ok(reply)) => reply.into_result(),
                    _ => Err("Host did not respond; action result is unknown. Check the host before retrying.".into()),
                }
            },
        };
        self.inner.lock().await.requests.remove(&id);
        result
    }

    pub async fn respond(&self, id: String, reply: Reply) -> bool {
        if let Some(sender) = self.inner.lock().await.requests.remove(&id) {
            sender.send(reply).is_ok()
        } else {
            false
        }
    }

    pub async fn request_active(&self, id: &str) -> bool {
        let inner = self.inner.lock().await;
        inner.enabled
            && inner.requests.contains_key(id)
            && inner
                .controller
                .as_ref()
                .is_some_and(|s| s.connection.close_reason().is_none())
    }

    pub async fn reconnect(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let invitation = self
            .inner
            .lock()
            .await
            .saved
            .recent
            .iter()
            .find(|p| p.id == id)
            .and_then(|p| p.invitation.clone())
            .ok_or("No saved pairing for this device")?;
        self.connect(app, invitation).await
    }

    pub async fn publish(&self, snapshot: Value) -> Result<(), String> {
        if serde_json::to_vec(&snapshot).map_err(err)?.len() > MAX_FRAME {
            return Err("Remote snapshot is too large".into());
        }
        self.snapshot.send_replace(snapshot);
        Ok(())
    }

    pub async fn connect(&self, app: &AppHandle, invitation: String) -> Result<(), String> {
        let ticket = Invitation::decode(&invitation)?;
        let endpoint = self.endpoint(app).await?;
        if ticket.address.id == endpoint.id() {
            return Err("Choose another computer, not this device".into());
        }
        let generation = {
            let mut inner = self.inner.lock().await;
            if inner.enabled { return Err("Turn off incoming remote control before connecting to another host".into()); }
            if inner.connecting || inner.client.is_some() {
                return Err("Disconnect the current remote workspace first".into());
            }
            inner.connecting = true;
            inner.generation += 1;
            inner.generation
        };
        self.changed(app).await;
        let result = async {
            let connection = tokio::time::timeout(
                Duration::from_secs(25),
                endpoint.connect(ticket.address.clone(), ALPN),
            )
            .await
            .map_err(err)?
            .map_err(err)?;
            {
                let mut inner = self.inner.lock().await;
                if inner.generation != generation {
                    connection.close(0u32.into(), b"Cancelled");
                    return Err("Connection cancelled".into());
                }
                inner.connecting_connection = Some(connection.clone());
            }
            let authenticated = async {
                let (mut send, mut recv) = connection.open_bi().await.map_err(err)?;
                write_frame(
                    &mut send,
                    &Hello {
                        version: 1,
                        secret: ticket.secret.clone(),
                        name: device_name(),
                    },
                )
                .await?;
                send.finish().map_err(err)?;
                let reply: Reply =
                    tokio::time::timeout(Duration::from_secs(70), read_frame(&mut recv, 4096))
                        .await
                        .map_err(err)??;
                reply.into_result()
            }
            .await;
            let value = match authenticated {
                Ok(value) => value,
                Err(error) => {
                    connection.close(0u32.into(), b"Pairing failed");
                    return Err(error);
                }
            };
            let name = value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&ticket.name)
                .chars()
                .take(128)
                .collect::<String>();
            let id = connection.remote_id().to_string();
            let mut inner = self.inner.lock().await;
            if inner.generation != generation {
                connection.close(0u32.into(), b"Cancelled");
                return Err("Connection cancelled".into());
            }
            let saved_invitation = Invitation {
                secret: String::new(),
                ..ticket
            }
            .encode()?;
            inner.saved.recent.retain(|peer| peer.id != id);
            inner.saved.recent.insert(
                0,
                Peer {
                    id: id.clone(),
                    name: name.clone(),
                    invitation: Some(saved_invitation),
                },
            );
            inner.saved.recent.truncate(16);
            if let Err(error) = save_peers(&inner) {
                connection.close(0u32.into(), b"Cannot save pairing");
                return Err(error);
            }
            inner.client = Some(Session {
                id,
                name,
                connection: connection.clone(),
            });
            inner.reconnect_allowed = true;
            inner.client_snapshot = None;
            drop(inner);
            self.receive_snapshots(app.clone(), connection, generation);
            Ok(())
        }
        .await;
        let mut inner = self.inner.lock().await;
        if inner.generation == generation {
            inner.connecting = false;
            inner.connecting_connection = None;
        }
        drop(inner);
        self.changed(app).await;
        result
    }

    fn receive_snapshots(&self, app: AppHandle, connection: Connection, generation: u64) {
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = async {
                let mut recv =
                    tokio::time::timeout(Duration::from_secs(15), connection.accept_uni())
                        .await
                        .map_err(err)?
                        .map_err(err)?;
                loop {
                    let snapshot: Value = tokio::time::timeout(
                        Duration::from_secs(20),
                        read_frame(&mut recv, MAX_FRAME),
                    )
                    .await
                    .map_err(|_| "Host workspace stopped updating")??;
                    let mut inner = service.inner.lock().await;
                    if inner.generation != generation {
                        break;
                    }
                    inner.client_snapshot = Some(snapshot.clone());
                    drop(inner);
                    let _ = app.emit_to("main", "remote-snapshot", &snapshot);
                }
                Ok::<(), String>(())
            }
            .await;
            if let Err(error) = result {
                log::debug!("Remote snapshot stream ended: {error}");
            }
            connection.close(0u32.into(), b"Snapshot stream ended");
            let mut inner = service.inner.lock().await;
            if inner.generation == generation {
                inner.client = None;
            }
            drop(inner);
            service.changed(&app).await;
        });
    }

    pub async fn action(&self, action: String, args: Value) -> Result<Value, String> {
        let request = Request {
            id: uuid::Uuid::new_v4().to_string(),
            action,
            args,
        };
        protocol::validate_request(&request)?;
        let connection = self
            .inner
            .lock()
            .await
            .client
            .as_ref()
            .map(|s| s.connection.clone())
            .ok_or("Remote device is disconnected")?;
        tokio::time::timeout(Duration::from_secs(35), async {
            let (mut send, mut recv) = connection.open_bi().await.map_err(err)?;
            write_frame(&mut send, &request).await?;
            send.finish().map_err(err)?;
            read_frame::<Reply>(&mut recv, MAX_FRAME)
                .await?
                .into_result()
        })
        .await
        .map_err(|_| {
            "Remote operation timed out; result unknown. Check the device before retrying."
        })?
    }

    pub async fn disconnect(&self, app: &AppHandle) {
        let mut inner = self.inner.lock().await;
        inner.generation += 1;
        inner.connecting = false;
        inner.reconnect_allowed = false;
        if let Some(connection) = inner.connecting_connection.take() {
            connection.close(0u32.into(), b"Cancelled");
        }
        if let Some(session) = inner.client.take() {
            session
                .connection
                .close(0u32.into(), b"Client disconnected");
        }
        inner.client_snapshot = None;
        drop(inner);
        self.changed(app).await;
    }

    pub async fn client_snapshot(&self) -> Option<Value> {
        self.inner.lock().await.client_snapshot.clone()
    }
}
