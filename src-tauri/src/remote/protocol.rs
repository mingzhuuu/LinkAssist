use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use iroh::{
    endpoint::{RecvStream, SendStream},
    EndpointAddr,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};

pub const ALPN: &[u8] = b"linkassist/remote/1";
pub const MAX_FRAME: usize = 2 * 1024 * 1024;
pub const MAX_ACTION: usize = 64 * 1024;
pub const MAX_WORKSPACE_EDIT: usize = 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Invitation {
    pub version: u8,
    pub address: EndpointAddr,
    pub secret: String,
    pub name: String,
}

impl Invitation {
    pub fn encode(&self) -> Result<String, String> {
        // Endpoint discovery resolves relay/direct addresses from the public key.
        // A compact ticket carries only that key and a 128-bit pairing secret.
        if self.version == 1 && (self.secret.is_empty() || uuid::Uuid::parse_str(&self.secret).is_ok()) {
            let mut bytes = self.address.id.as_bytes().to_vec();
            if !self.secret.is_empty() {
                bytes.extend_from_slice(uuid::Uuid::parse_str(&self.secret).map_err(err)?.as_bytes());
            }
            return Ok(format!("LA2:{}", URL_SAFE_NO_PAD.encode(bytes)));
        }
        Ok(format!(
            "linkassist1:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).map_err(err)?)
        ))
    }

    pub fn decode(input: &str) -> Result<Self, String> {
        if input.len() > 8192 {
            return Err("Invitation is too large".into());
        }
        if let Some(raw) = input.trim().strip_prefix("LA2:") {
            let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(err)?;
            if bytes.len() != 32 && bytes.len() != 48 {
                return Err("Invalid compact pairing code".into());
            }
            let key: [u8; 32] = bytes[..32].try_into().map_err(err)?;
            return Ok(Self {
                version: 1,
                address: EndpointAddr::new(iroh::EndpointId::from_bytes(&key).map_err(err)?),
                secret: if bytes.len() == 48 { uuid::Uuid::from_slice(&bytes[32..]).map_err(err)?.simple().to_string() } else { String::new() },
                name: "LinkAssist".into(),
            });
        }
        let raw = input
            .trim()
            .strip_prefix("linkassist1:")
            .ok_or("Invalid LinkAssist invitation")?;
        let value: Self =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(raw).map_err(err)?).map_err(err)?;
        if value.version != 1 || value.secret.len() > 128 || value.name.len() > 128 {
            return Err("Unsupported or invalid invitation".into());
        }
        Ok(value)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hello {
    pub version: u8,
    pub secret: String,
    pub name: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub id: String,
    pub action: String,
    pub args: Value,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub value: Option<Value>,
    pub error: Option<String>,
}

impl Reply {
    pub fn from_result(result: Result<Value, String>) -> Self {
        match result {
            Ok(value) => Self {
                value: Some(value),
                error: None,
            },
            Err(error) => Self {
                value: None,
                error: Some(error),
            },
        }
    }
    pub fn into_result(self) -> Result<Value, String> {
        match self.error {
            Some(error) => Err(error),
            None => Ok(self.value.unwrap_or(Value::Null)),
        }
    }
}

pub fn action_allowed(action: &str) -> bool {
    matches!(
        action,
        "channel.create"
            | "channel.configure"
            | "channel.rename"
            | "channel.remove"
            | "channel.connect"
            | "channel.disconnect"
            | "channel.send"
            | "serial.refresh"
            | "ble.scan"
            | "ble.stopScan"
            | "ble.read"
            | "ble.subscribe"
            | "ble.unsubscribe"
            | "canvas.activate"
            | "canvas.deactivate"
            | "canvas.clear"
            | "canvas.pause"
            | "script.run"
            | "script.stop"
            | "script.action"
            | "canvas.formSend"
            | "workspace.watch"
            | "workspace.layout"
            | "workspace.edit"
            | "workspace.browse"
            | "workspace.protocolSummary"
            | "workspace.scriptDocument"
            | "workspace.lifecycleDocument"
            | "terminal.clear"
            | "terminal.append"
            | "ble.pairingStatuses"
            | "ble.discover"
            | "tcp.disconnectClient"
    )
}

pub fn validate_request(request: &Request) -> Result<(), String> {
    if request.id.is_empty() || request.id.len() > 64 || !action_allowed(&request.action) {
        return Err("Remote action is not allowed".into());
    }
    let limit = if request.action == "workspace.edit" { MAX_WORKSPACE_EDIT } else { MAX_ACTION };
    if !request.args.is_object()
        || serde_json::to_vec(&request.args).map_err(err)?.len() > limit
    {
        return Err("Invalid remote action arguments".into());
    }
    Ok(())
}

pub async fn write_frame<T: Serialize>(stream: &mut SendStream, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(err)?;
    if bytes.len() > MAX_FRAME {
        return Err("Remote frame exceeds 2 MiB limit".into());
    }
    // Reuse the application's existing compression dependency. Snapshots contain
    // repetitive terminal/config data; the decoded limit also stops zip bombs.
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(&bytes).map_err(err)?;
    let bytes = encoder.finish().map_err(err)?;
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await
        .map_err(err)?;
    stream.write_all(&bytes).await.map_err(err)
}

pub async fn read_frame<T: DeserializeOwned>(
    stream: &mut RecvStream,
    limit: usize,
) -> Result<T, String> {
    let mut header = [0; 4];
    stream.read_exact(&mut header).await.map_err(err)?;
    let len = u32::from_be_bytes(header) as usize;
    if len == 0 || len > limit + 1024 {
        return Err("Invalid remote frame length".into());
    }
    let mut bytes = vec![0; len];
    stream.read_exact(&mut bytes).await.map_err(err)?;
    decode_frame(&bytes, limit)
}

fn decode_frame<T: DeserializeOwned>(bytes: &[u8], limit: usize) -> Result<T, String> {
    let mut decoded = Vec::new();
    flate2::read::ZlibDecoder::new(bytes)
        .take(limit as u64 + 1)
        .read_to_end(&mut decoded)
        .map_err(err)?;
    if decoded.len() > limit {
        return Err("Decoded remote frame is too large".into());
    }
    serde_json::from_slice(&decoded).map_err(err)
}

pub fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_arbitrary_invokes_and_oversized_actions() {
        for action in [
            "save_app_config",
            "export_to_file",
            "remote_approve",
            "core.shutdown",
            "__proto__",
        ] {
            assert!(!action_allowed(action));
        }
        assert!(validate_request(&Request {
            id: "1".into(),
            action: "channel.send".into(),
            args: serde_json::json!({"data": "a".repeat(MAX_ACTION)})
        })
        .is_err());
        assert!(validate_request(&Request {
            id: "1".into(),
            action: "channel.send".into(),
            args: serde_json::json!({"data": [1, 2]})
        })
        .is_ok());
    }
    #[test]
    fn invitation_checks_version_and_size() {
        let invitation = Invitation {
            version: 1,
            address: EndpointAddr::new(iroh::SecretKey::generate().public()),
            secret: "secret".into(),
            name: "Device".into(),
        };
        let encoded = invitation.encode().unwrap();
        assert_eq!(
            Invitation::decode(&encoded).unwrap().address.id,
            invitation.address.id
        );
        assert!(Invitation::decode(&"a".repeat(9000)).is_err());
        assert!(Invitation::decode("https://example.com").is_err());
        let invalid = Invitation {
            version: 2,
            ..invitation
        };
        assert!(Invitation::decode(&invalid.encode().unwrap()).is_err());
    }

    #[test]
    fn compact_code_preserves_identity_and_secret_without_address_metadata() {
        let ticket = Invitation { version: 1, address: EndpointAddr::new(iroh::SecretKey::generate().public()), secret: uuid::Uuid::new_v4().simple().to_string(), name: "Device".into() };
        let encoded = ticket.encode().unwrap();
        assert_eq!(encoded.len(), 68);
        let decoded = Invitation::decode(&encoded).unwrap();
        assert_eq!(decoded.address.id, ticket.address.id);
        assert_eq!(decoded.secret, ticket.secret);
        for malformed in ["LA2:", "LA2:aaa", "LA2:!!!!"] { assert!(Invitation::decode(malformed).is_err()); }
        let reconnect = Invitation { secret: String::new(), ..ticket };
        assert!(Invitation::decode(&reconnect.encode().unwrap()).unwrap().secret.is_empty());
    }

    #[test]
    fn compressed_frames_cannot_bypass_decoded_limit() {
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder
            .write_all(&serde_json::to_vec(&"a".repeat(10000)).unwrap())
            .unwrap();
        let bytes = encoder.finish().unwrap();
        assert!(bytes.len() < 1024);
        assert!(decode_frame::<String>(&bytes, 1024).is_err());
        assert_eq!(decode_frame::<String>(&bytes, 20000).unwrap().len(), 10000);
        assert!(decode_frame::<Value>(b"invalid zlib", 1024).is_err());
    }

    #[tokio::test]
    async fn encrypted_loopback_frames_and_peer_identity() {
        use iroh::endpoint::presets;
        use iroh::Endpoint;
        use std::time::Duration;
        tokio::time::timeout(Duration::from_secs(15), async {
            let server = Endpoint::builder(presets::Minimal)
                .alpns(vec![ALPN.to_vec()])
                .bind()
                .await
                .unwrap();
            let client = Endpoint::bind(presets::Minimal).await.unwrap();
            let server_id = server.id();
            let client_id = client.id();
            let address = server.addr();
            let task = tokio::spawn(async move {
                let connection = server.accept().await.unwrap().await.unwrap();
                assert_eq!(connection.remote_id(), client_id);
                let (mut send, mut recv) = connection.accept_bi().await.unwrap();
                let request: Request = read_frame(&mut recv, MAX_ACTION + 1024).await.unwrap();
                validate_request(&request).unwrap();
                write_frame(&mut send, &Reply::from_result(Ok(request.args)))
                    .await
                    .unwrap();
                send.finish().unwrap();
                connection.closed().await;
                server.close().await;
            });
            let connection = client.connect(address, ALPN).await.unwrap();
            assert_eq!(connection.remote_id(), server_id);
            let (mut send, mut recv) = connection.open_bi().await.unwrap();
            let args = serde_json::json!({"data": [0, 127, 255], "channelId": "serial-one"});
            write_frame(
                &mut send,
                &Request {
                    id: "request-one".into(),
                    action: "channel.send".into(),
                    args: args.clone(),
                },
            )
            .await
            .unwrap();
            send.finish().unwrap();
            assert_eq!(
                read_frame::<Reply>(&mut recv, MAX_FRAME)
                    .await
                    .unwrap()
                    .into_result()
                    .unwrap(),
                args
            );
            connection.close(0u32.into(), b"test complete");
            client.close().await;
            task.await.unwrap();
        })
        .await
        .expect("loopback protocol timed out");
    }

    #[tokio::test]
    #[ignore = "Requires access to iroh's public relay network"]
    async fn public_relay_roundtrip_without_ip_transport() {
        use iroh::{endpoint::presets, Endpoint, Watcher};
        use std::time::Duration;
        let _ = tracing_subscriber::fmt()
            .with_env_filter("iroh=debug,iroh_relay=debug,n0_dns_resolver=debug")
            .with_ansi(false)
            .try_init();
        tokio::time::timeout(Duration::from_secs(50), async {
            let server = Endpoint::builder(presets::N0)
                .dns_resolver(super::super::dns::resolver())
                .clear_ip_transports()
                .alpns(vec![ALPN.to_vec()])
                .bind()
                .await
                .unwrap();
            let client = Endpoint::builder(presets::N0)
                .dns_resolver(super::super::dns::resolver())
                .clear_ip_transports()
                .bind()
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(25), async {
                tokio::join!(server.online(), client.online());
            })
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "Relay connection state: server={:?}, client={:?}",
                    server.home_relay_status().get(),
                    client.home_relay_status().get()
                )
            });
            let addr = server.addr();
            let task = tokio::spawn(async move {
                let connection = server.accept().await.unwrap().await.unwrap();
                let (mut send, mut recv) = connection.accept_bi().await.unwrap();
                let value: Value = read_frame(&mut recv, 4096).await.unwrap();
                write_frame(&mut send, &value).await.unwrap();
                send.finish().unwrap();
                connection.closed().await;
                server.close().await;
            });
            let connection = client.connect(addr, ALPN).await.unwrap();
            let (mut send, mut recv) = connection.open_bi().await.unwrap();
            write_frame(
                &mut send,
                &serde_json::json!({"probe": "LinkAssist encrypted relay test"}),
            )
            .await
            .unwrap();
            send.finish().unwrap();
            let value: Value = read_frame(&mut recv, 4096).await.unwrap();
            assert_eq!(value["probe"], "LinkAssist encrypted relay test");
            assert!(connection
                .paths()
                .iter()
                .any(|path| path.is_relay() && path.is_selected()));
            connection.close(0u32.into(), b"relay test complete");
            client.close().await;
            task.await.unwrap();
        })
        .await
        .expect("iroh public relay unreachable within 50 seconds");
    }
}
