use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{watch, Mutex};

const MAX_RECENT_EVENTS: usize = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreEvent {
    pub cursor: u64,
    pub name: String,
    pub timestamp: u64,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventBatch {
    pub events: Vec<CoreEvent>,
    pub current_cursor: u64,
    pub oldest_cursor: Option<u64>,
    pub overflowed: bool,
    pub future_cursor: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWaitResult {
    pub events: Vec<CoreEvent>,
    pub current_cursor: u64,
    pub oldest_cursor: Option<u64>,
    pub overflowed: bool,
    pub future_cursor: bool,
    pub timed_out: bool,
}

#[derive(Default)]
struct RecentEventState {
    events: VecDeque<CoreEvent>,
    current_cursor: u64,
}

#[derive(Clone)]
pub struct RecentEventBuffer {
    state: Arc<Mutex<RecentEventState>>,
    cursor_tx: watch::Sender<u64>,
}

impl Default for RecentEventBuffer {
    fn default() -> Self {
        let (cursor_tx, _) = watch::channel(0);
        Self {
            state: Arc::new(Mutex::new(RecentEventState::default())),
            cursor_tx,
        }
    }
}

impl RecentEventBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn push_serializable<T: Serialize>(
        &self,
        name: impl Into<String>,
        timestamp: u64,
        payload: T,
    ) -> u64 {
        let payload = serde_json::to_value(payload).unwrap_or(Value::Null);
        self.push_value(name, timestamp, payload).await
    }

    pub async fn push_value(&self, name: impl Into<String>, timestamp: u64, payload: Value) -> u64 {
        let cursor = {
            let mut state = self.state.lock().await;
            state.current_cursor = state.current_cursor.saturating_add(1);
            let cursor = state.current_cursor;
            state.events.push_back(CoreEvent {
                cursor,
                name: name.into(),
                timestamp,
                payload,
            });

            while state.events.len() > MAX_RECENT_EVENTS {
                state.events.pop_front();
            }
            cursor
        };

        self.cursor_tx.send_replace(cursor);
        cursor
    }

    /// Return the cursor assigned to the most recently buffered event.
    pub async fn checkpoint(&self) -> u64 {
        self.state.lock().await.current_cursor
    }

    /// Compatibility view used by existing event-history callers.
    pub async fn list(&self, limit: Option<usize>) -> Vec<CoreEvent> {
        let state = self.state.lock().await;
        let keep = limit.unwrap_or(state.events.len()).min(state.events.len());
        state
            .events
            .iter()
            .skip(state.events.len().saturating_sub(keep))
            .cloned()
            .collect()
    }

    /// Return retained events strictly newer than `after_cursor`.
    ///
    /// `overflowed` means at least one cursor newer than `after_cursor` has
    /// already fallen out of the bounded buffer, so callers must not treat the
    /// returned events as a complete transaction history.
    pub async fn list_after(&self, after_cursor: u64) -> EventBatch {
        let state = self.state.lock().await;
        event_batch_from_state(&state, after_cursor)
    }

    /// Wait until at least one retained event newer than `after_cursor`
    /// satisfies `predicate`, the buffer overflows that cursor, or the timeout
    /// expires. A watch channel avoids lost wakeups and supports many waiters.
    pub async fn wait_after<F>(
        &self,
        after_cursor: u64,
        timeout: Duration,
        predicate: F,
    ) -> EventWaitResult
    where
        F: Fn(&CoreEvent) -> bool,
    {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut cursor_rx = self.cursor_tx.subscribe();

        loop {
            let batch = self.list_after(after_cursor).await;
            let events = batch
                .events
                .iter()
                .filter(|event| predicate(event))
                .cloned()
                .collect::<Vec<_>>();

            if batch.overflowed || batch.future_cursor || !events.is_empty() {
                return EventWaitResult {
                    events,
                    current_cursor: batch.current_cursor,
                    oldest_cursor: batch.oldest_cursor,
                    overflowed: batch.overflowed,
                    future_cursor: batch.future_cursor,
                    timed_out: false,
                };
            }

            if tokio::time::timeout_at(deadline, cursor_rx.changed())
                .await
                .is_err()
            {
                let final_batch = self.list_after(after_cursor).await;
                let events = final_batch
                    .events
                    .iter()
                    .filter(|event| predicate(event))
                    .cloned()
                    .collect::<Vec<_>>();
                let timed_out =
                    events.is_empty() && !final_batch.overflowed && !final_batch.future_cursor;
                return EventWaitResult {
                    events,
                    current_cursor: final_batch.current_cursor,
                    oldest_cursor: final_batch.oldest_cursor,
                    overflowed: final_batch.overflowed,
                    future_cursor: final_batch.future_cursor,
                    timed_out,
                };
            }
        }
    }
}

fn event_batch_from_state(state: &RecentEventState, after_cursor: u64) -> EventBatch {
    let oldest_cursor = state.events.front().map(|event| event.cursor);
    let overflowed = oldest_cursor.is_some_and(|oldest| after_cursor.saturating_add(1) < oldest);
    let future_cursor = after_cursor > state.current_cursor;
    let events = state
        .events
        .iter()
        .filter(|event| event.cursor > after_cursor)
        .cloned()
        .collect();

    EventBatch {
        events,
        current_cursor: state.current_cursor,
        oldest_cursor,
        overflowed,
        future_cursor,
    }
}

pub fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
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
    fn recent_event_buffer_keeps_last_items_with_monotonic_cursors() {
        run_async(async {
            let buffer = RecentEventBuffer::new();
            assert_eq!(buffer.checkpoint().await, 0);
            assert_eq!(
                buffer
                    .push_value("first", 1, serde_json::json!({ "value": 1 }))
                    .await,
                1
            );
            assert_eq!(
                buffer
                    .push_value("second", 2, serde_json::json!({ "value": 2 }))
                    .await,
                2
            );

            let events = buffer.list(Some(1)).await;
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].cursor, 2);
            assert_eq!(events[0].name, "second");
            assert_eq!(buffer.checkpoint().await, 2);
        });
    }

    #[test]
    fn list_after_reports_cursor_overflow() {
        run_async(async {
            let buffer = RecentEventBuffer::new();
            for index in 0..300_u64 {
                buffer
                    .push_value("event", index, serde_json::json!({ "index": index }))
                    .await;
            }

            let complete = buffer.list_after(44).await;
            assert!(!complete.overflowed);
            assert!(!complete.future_cursor);
            assert_eq!(complete.events.first().map(|event| event.cursor), Some(45));
            assert_eq!(complete.events.last().map(|event| event.cursor), Some(300));

            let overflowed = buffer.list_after(43).await;
            assert!(overflowed.overflowed);
            assert_eq!(overflowed.oldest_cursor, Some(45));
            assert_eq!(overflowed.current_cursor, 300);

            let future = buffer.list_after(301).await;
            assert!(future.future_cursor);
            assert!(!future.overflowed);
        });
    }

    #[test]
    fn wait_after_ignores_unmatched_events_and_wakes_for_match() {
        run_async(async {
            let buffer = RecentEventBuffer::new();
            let producer = buffer.clone();
            tokio::spawn(async move {
                producer.push_value("other", 1, Value::Null).await;
                tokio::task::yield_now().await;
                producer.push_value("wanted", 2, Value::Null).await;
            });

            let result = buffer
                .wait_after(0, Duration::from_secs(1), |event| event.name == "wanted")
                .await;
            assert!(!result.timed_out);
            assert!(!result.overflowed);
            assert!(!result.future_cursor);
            assert_eq!(result.events.len(), 1);
            assert_eq!(result.events[0].cursor, 2);
        });
    }

    #[test]
    fn wait_after_times_out_without_match() {
        run_async(async {
            let buffer = RecentEventBuffer::new();
            buffer.push_value("other", 1, Value::Null).await;
            let result = buffer
                .wait_after(1, Duration::from_millis(1), |_| false)
                .await;
            assert!(result.timed_out);
            assert!(!result.overflowed);
            assert!(result.events.is_empty());
        });
    }
}
