pub mod connection;
pub mod gatt;
pub mod pairing;
pub mod scanner;

pub use connection::BleConnectionManager;
pub use scanner::BleScanner;

use crate::error::{AppError, AppResult};
use btleplug::platform::Peripheral;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

const CONNECT_REDISCOVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
const CONNECT_REDISCOVERY_POLL_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(200);
const CONNECT_REDISCOVERY_FINAL_GRACE: std::time::Duration = std::time::Duration::from_millis(500);

async fn poll_until_found<T, Lookup, LookupFuture>(
    timeout: std::time::Duration,
    poll_interval: std::time::Duration,
    mut lookup: Lookup,
) -> AppResult<Option<T>>
where
    Lookup: FnMut() -> LookupFuture,
    LookupFuture: Future<Output = AppResult<Option<T>>>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(value) = lookup().await? {
            return Ok(Some(value));
        }

        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Ok(None);
        }

        tokio::time::sleep(std::cmp::min(
            poll_interval,
            deadline.saturating_duration_since(now),
        ))
        .await;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotificationConsumer {
    Ui,
    Mcp(String),
}

#[derive(Debug)]
struct NotificationConsumers {
    device_id: String,
    service_uuid: String,
    char_uuid: String,
    ui_count: usize,
    mcp_subscription_ids: HashSet<String>,
}

impl NotificationConsumers {
    fn new(device_id: &str, service_uuid: &str, char_uuid: &str) -> Self {
        Self {
            device_id: device_id.to_string(),
            service_uuid: service_uuid.to_string(),
            char_uuid: char_uuid.to_string(),
            ui_count: 0,
            mcp_subscription_ids: HashSet::new(),
        }
    }

    fn contains(&self, consumer: &NotificationConsumer) -> bool {
        match consumer {
            NotificationConsumer::Ui => self.ui_count > 0,
            NotificationConsumer::Mcp(subscription_id) => {
                self.mcp_subscription_ids.contains(subscription_id)
            }
        }
    }

    fn insert(&mut self, consumer: &NotificationConsumer) {
        match consumer {
            NotificationConsumer::Ui => self.ui_count = self.ui_count.saturating_add(1),
            NotificationConsumer::Mcp(subscription_id) => {
                self.mcp_subscription_ids.insert(subscription_id.clone());
            }
        }
    }

    fn remove(&mut self, consumer: &NotificationConsumer) {
        match consumer {
            NotificationConsumer::Ui => {
                self.ui_count = self.ui_count.saturating_sub(1);
            }
            NotificationConsumer::Mcp(subscription_id) => {
                self.mcp_subscription_ids.remove(subscription_id);
            }
        }
    }

    fn is_empty(&self) -> bool {
        self.ui_count == 0 && self.mcp_subscription_ids.is_empty()
    }
}

/// Find a peripheral by id, running one continuous rediscovery scan when it is
/// not already known. The manager lock is only held for brief adapter lookups,
/// never across the scan wait, so other BLE commands stay responsive.
///
/// Windows watcher stop/start transitions are asynchronous. Stopping two short
/// scans before checking the adapter can miss a late advertisement callback:
/// the failed request warms the cache and an immediate retry then succeeds.
/// Poll while a single scan remains active and perform one final lookup after
/// stopping it so the first request observes those callbacks itself.
pub async fn find_peripheral_for_connect(
    manager: &Arc<Mutex<BleManager>>,
    device_id: &str,
) -> AppResult<Peripheral> {
    if let Some(peripheral) = manager
        .lock()
        .await
        .scanner
        .known_peripheral(device_id)
        .await?
    {
        return Ok(peripheral);
    }

    manager.lock().await.scanner.rescan_start().await?;

    let lookup_manager = manager.clone();
    let lookup_device_id = device_id.to_string();
    let rediscovery_result = poll_until_found(
        CONNECT_REDISCOVERY_TIMEOUT,
        CONNECT_REDISCOVERY_POLL_INTERVAL,
        move || {
            let manager = lookup_manager.clone();
            let device_id = lookup_device_id.clone();
            async move {
                let mut guard = manager.lock().await;
                guard.scanner.known_peripheral(&device_id).await
            }
        },
    )
    .await;

    // Always release the internal scan lease after a normal lookup result,
    // including adapter errors. This also leaves a user-facing scan running.
    manager.lock().await.scanner.rescan_stop().await?;

    if let Some(peripheral) = rediscovery_result? {
        return Ok(peripheral);
    }

    // WinRT can deliver advertisement callbacks after Stop() returns. Drain
    // that short tail by polling the map instead of taking one final snapshot.
    let final_lookup_manager = manager.clone();
    let final_lookup_device_id = device_id.to_string();
    if let Some(peripheral) = poll_until_found(
        CONNECT_REDISCOVERY_FINAL_GRACE,
        CONNECT_REDISCOVERY_POLL_INTERVAL,
        move || {
            let manager = final_lookup_manager.clone();
            let device_id = final_lookup_device_id.clone();
            async move {
                let mut guard = manager.lock().await;
                guard.scanner.known_peripheral(&device_id).await
            }
        },
    )
    .await?
    {
        return Ok(peripheral);
    }

    Err(AppError::Ble(format!(
        "Peripheral not found: {}",
        device_id
    )))
}

pub struct BleManager {
    pub scanner: BleScanner,
    pub connections: BleConnectionManager,
    /// One notification stream pump per peripheral, keyed by device id.
    pub notification_tasks: HashMap<String, JoinHandle<()>>,
    /// Logical UI/MCP consumers keyed by "deviceId:serviceUuid:charUuid".
    notification_subscriptions: HashMap<String, NotificationConsumers>,
    /// Serializes user scans with the rediscovery/pause/connect sequence.
    pub connect_gate: Arc<Mutex<()>>,
    /// Devices whose current connection lifecycle already emitted closed.
    closed_event_devices: HashSet<String>,
    /// Key: deviceId, Value: JoinHandle of connection monitor
    pub monitor_tasks: HashMap<String, JoinHandle<()>>,
}

impl BleManager {
    pub fn new() -> Self {
        Self {
            scanner: BleScanner::new(),
            connections: BleConnectionManager::new(),
            notification_tasks: HashMap::new(),
            notification_subscriptions: HashMap::new(),
            connect_gate: Arc::new(Mutex::new(())),
            closed_event_devices: HashSet::new(),
            monitor_tasks: HashMap::new(),
        }
    }

    pub fn notification_key(device_id: &str, service_uuid: &str, char_uuid: &str) -> String {
        format!("{}:{}:{}", device_id, service_uuid, char_uuid)
    }

    /// Register a logical notification consumer. Returns true only when the
    /// characteristic needs its first physical GATT subscription.
    pub fn add_notification_consumer(
        &mut self,
        device_id: &str,
        service_uuid: &str,
        char_uuid: &str,
        consumer: NotificationConsumer,
    ) -> bool {
        let key = Self::notification_key(device_id, service_uuid, char_uuid);
        let consumers = self
            .notification_subscriptions
            .entry(key)
            .or_insert_with(|| NotificationConsumers::new(device_id, service_uuid, char_uuid));
        let was_empty = consumers.is_empty();
        consumers.insert(&consumer);
        was_empty
    }

    /// Remove a logical notification consumer. Returns true only when the
    /// characteristic no longer has any consumer and should be unsubscribed.
    pub fn remove_notification_consumer(
        &mut self,
        device_id: &str,
        service_uuid: &str,
        char_uuid: &str,
        consumer: NotificationConsumer,
    ) -> bool {
        let key = Self::notification_key(device_id, service_uuid, char_uuid);
        let Some(consumers) = self.notification_subscriptions.get_mut(&key) else {
            return false;
        };
        consumers.remove(&consumer);
        if consumers.is_empty() {
            self.notification_subscriptions.remove(&key);
            true
        } else {
            false
        }
    }

    pub fn has_notification_consumer(
        &self,
        device_id: &str,
        service_uuid: &str,
        char_uuid: &str,
        consumer: NotificationConsumer,
    ) -> bool {
        self.notification_subscriptions
            .get(&Self::notification_key(device_id, service_uuid, char_uuid))
            .is_some_and(|consumers| consumers.contains(&consumer))
    }

    pub fn notification_endpoint_for_subscription(
        &self,
        subscription_id: &str,
    ) -> Option<(String, String, String)> {
        self.notification_subscriptions
            .values()
            .find(|consumers| consumers.mcp_subscription_ids.contains(subscription_id))
            .map(|consumers| {
                (
                    consumers.device_id.clone(),
                    consumers.service_uuid.clone(),
                    consumers.char_uuid.clone(),
                )
            })
    }

    /// Remove all tokenized MCP holders for legacy endpoint-based unsubscribe.
    /// Returns the removed ids and whether the physical subscription is now unused.
    pub fn take_mcp_notification_consumers(
        &mut self,
        device_id: &str,
        service_uuid: &str,
        char_uuid: &str,
    ) -> (Vec<String>, bool) {
        let key = Self::notification_key(device_id, service_uuid, char_uuid);
        let Some(consumers) = self.notification_subscriptions.get_mut(&key) else {
            return (Vec::new(), false);
        };
        let removed = consumers.mcp_subscription_ids.drain().collect::<Vec<_>>();
        let empty = consumers.is_empty();
        if empty {
            self.notification_subscriptions.remove(&key);
        }
        (removed, empty)
    }

    pub fn device_has_notification_consumers(&self, device_id: &str) -> bool {
        self.notification_subscriptions
            .values()
            .any(|consumers| consumers.device_id == device_id)
    }

    pub fn mark_connection_open(&mut self, device_id: &str) {
        self.closed_event_devices.remove(device_id);
    }

    /// Returns true for the first close event in a connection lifecycle.
    pub fn claim_connection_closed(&mut self, device_id: &str) -> bool {
        self.closed_event_devices.insert(device_id.to_string())
    }

    pub fn cleanup_device_tasks(&mut self, device_id: &str) {
        if let Some(task) = self.monitor_tasks.remove(device_id) {
            task.abort();
        }

        if let Some(task) = self.notification_tasks.remove(device_id) {
            task.abort();
        }

        let keys = self
            .notification_subscriptions
            .iter()
            .filter_map(|(key, consumers)| (consumers.device_id == device_id).then(|| key.clone()))
            .collect::<Vec<_>>();

        for key in keys {
            self.notification_subscriptions.remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_async<F: std::future::Future<Output = ()>>(future: F) {
        tokio::runtime::Runtime::new()
            .expect("tokio runtime should build")
            .block_on(future);
    }

    #[test]
    fn notification_consumers_share_one_physical_subscription() {
        let mut manager = BleManager::new();
        assert!(manager.add_notification_consumer(
            "device",
            "service",
            "char",
            NotificationConsumer::Ui,
        ));
        assert!(!manager.add_notification_consumer(
            "device",
            "service",
            "char",
            NotificationConsumer::Ui,
        ));
        assert!(!manager.add_notification_consumer(
            "device",
            "service",
            "char",
            NotificationConsumer::Mcp("subscription-1".to_string()),
        ));
        assert!(!manager.remove_notification_consumer(
            "device",
            "service",
            "char",
            NotificationConsumer::Ui,
        ));
        assert!(manager.has_notification_consumer(
            "device",
            "service",
            "char",
            NotificationConsumer::Ui,
        ));
        assert!(!manager.remove_notification_consumer(
            "device",
            "service",
            "char",
            NotificationConsumer::Ui,
        ));
        assert!(manager.has_notification_consumer(
            "device",
            "service",
            "char",
            NotificationConsumer::Mcp("subscription-1".to_string()),
        ));
        assert_eq!(
            manager.notification_endpoint_for_subscription("subscription-1"),
            Some((
                "device".to_string(),
                "service".to_string(),
                "char".to_string(),
            ))
        );
        assert!(manager.remove_notification_consumer(
            "device",
            "service",
            "char",
            NotificationConsumer::Mcp("subscription-1".to_string()),
        ));
        assert!(!manager.device_has_notification_consumers("device"));
    }

    #[test]
    fn connection_closed_is_claimed_once_until_reopened() {
        let mut manager = BleManager::new();
        manager.mark_connection_open("device");
        assert!(manager.claim_connection_closed("device"));
        assert!(!manager.claim_connection_closed("device"));
        manager.mark_connection_open("device");
        assert!(manager.claim_connection_closed("device"));
    }

    #[test]
    fn cleanup_removes_tokenized_subscriptions_idempotently() {
        let mut manager = BleManager::new();
        manager.add_notification_consumer(
            "device",
            "service",
            "char",
            NotificationConsumer::Mcp("token".to_string()),
        );
        manager.cleanup_device_tasks("device");
        manager.cleanup_device_tasks("device");
        assert!(manager
            .notification_endpoint_for_subscription("token")
            .is_none());
    }

    #[test]
    fn connect_gate_provides_an_exclusive_lease() {
        run_async(async {
            let manager = BleManager::new();
            let first = manager.connect_gate.clone().lock_owned().await;
            let second_gate = manager.connect_gate.clone();
            let waiter = tokio::spawn(async move {
                let _second = second_gate.lock_owned().await;
            });
            tokio::task::yield_now().await;
            assert!(!waiter.is_finished());
            drop(first);
            tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
                .await
                .expect("second lease should acquire after release")
                .expect("lease waiter should finish");
        });
    }

    #[test]
    fn rediscovery_poll_observes_a_late_result_without_a_second_request() {
        run_async(async {
            let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let lookup_attempts = attempts.clone();
            let result = poll_until_found(
                std::time::Duration::from_millis(100),
                std::time::Duration::from_millis(1),
                move || {
                    let attempts = lookup_attempts.clone();
                    async move {
                        let attempt = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        Ok((attempt >= 2).then_some("peripheral"))
                    }
                },
            )
            .await
            .expect("polling should succeed");

            assert_eq!(result, Some("peripheral"));
            assert!(attempts.load(std::sync::atomic::Ordering::SeqCst) >= 3);
        });
    }
}

impl Default for BleManager {
    fn default() -> Self {
        Self::new()
    }
}
