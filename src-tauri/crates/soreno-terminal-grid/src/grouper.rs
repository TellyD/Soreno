use memchr::memmem;
use std::time::{Duration, Instant};

pub(crate) const SYNC_TIMEOUT: Duration = Duration::from_secs(1);
const SYNC_LIMIT: usize = 32 * 1024 * 1024;
pub(crate) const BSU: &[u8; 8] = b"\x1b[?2026h";
pub(crate) const ESU: &[u8; 8] = b"\x1b[?2026l";

/// Holds DEC 2026 synchronized frames until their end marker so the parser only sees complete screens.
#[derive(Default)]
pub(crate) struct FrameGrouper {
    held: Vec<u8>,
    frame_since: Option<Instant>,
    /// Bytes of `held` already searched for the end marker.
    scanned: usize,
}

impl FrameGrouper {
    /// Appends to `out` every byte that no longer belongs to an incomplete frame.
    pub(crate) fn push(&mut self, bytes: &[u8], now: Instant, out: &mut Vec<u8>) {
        self.held.extend_from_slice(bytes);
        let mut start = 0;
        loop {
            if self.frame_since.is_none() {
                let rest = &self.held[start..];
                if let Some(index) = memmem::find(rest, BSU) {
                    out.extend_from_slice(&rest[..index]);
                    start += index;
                    self.frame_since = Some(now);
                    self.scanned = start + BSU.len();
                    continue;
                }
                let keep = marker_prefix_len(rest);
                out.extend_from_slice(&rest[..rest.len() - keep]);
                start = self.held.len() - keep;
                break;
            }
            let from = self
                .scanned
                .saturating_sub(ESU.len() - 1)
                .max(start + BSU.len());
            if let Some(index) = memmem::find(&self.held[from..], ESU) {
                let end = from + index + ESU.len();
                out.extend_from_slice(&self.held[start..end]);
                start = end;
                self.frame_since = None;
                continue;
            }
            if self.held.len() - start > SYNC_LIMIT {
                out.extend_from_slice(&self.held[start..]);
                start = self.held.len();
                self.frame_since = None;
            } else {
                self.scanned = self.held.len();
            }
            break;
        }
        self.held.drain(..start);
        self.scanned = self.scanned.saturating_sub(start);
    }
    /// Releases a frame whose end marker has not arrived within `SYNC_TIMEOUT`.
    pub(crate) fn flush_expired(&mut self, now: Instant, out: &mut Vec<u8>) {
        if self
            .frame_since
            .is_some_and(|since| now.saturating_duration_since(since) >= SYNC_TIMEOUT)
        {
            self.release(out);
        }
    }
    /// Releases every held byte, as if its frame had timed out.
    pub(crate) fn release(&mut self, out: &mut Vec<u8>) {
        out.append(&mut self.held);
        self.frame_since = None;
        self.scanned = 0;
    }
    /// Bytes of the incomplete frame, which start where the parsed bytes end.
    pub(crate) fn held(&self) -> &[u8] {
        &self.held
    }
    pub(crate) fn deadline(&self) -> Option<Instant> {
        self.frame_since.map(|since| since + SYNC_TIMEOUT)
    }
}

/// Length of the longest suffix that may start a begin marker split across chunks.
fn marker_prefix_len(bytes: &[u8]) -> usize {
    (1..BSU.len())
        .rev()
        .find(|&length| bytes.ends_with(&BSU[..length]))
        .unwrap_or(0)
}
