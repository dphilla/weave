//! Iterative pre-copy page tracking.
//!
//! Memory is streamed in 4 KiB pages while the guest keeps executing; a
//! truncated-SHA-256 digest per page detects dirtying between rounds (a
//! cryptographic digest is mandatory here — a missed dirty page is silent
//! memory corruption on the target). All-zero pages are elided in the first
//! round because the target's fresh memory is already zeroed; if a page later
//! becomes nonzero (or a zero page had nonzero history) it is re-sent.

use crate::MemRead;
use weave_core::sha256::page_digest;
use weave_core::WPAGE_SIZE;

const ZERO_DIGEST_SENTINEL: [u8; 16] = [0u8; 16];

pub struct PageTracker {
    /// Per memory: digest of every page as of the last completed round.
    /// `ZERO_DIGEST_SENTINEL` means "known zero and never sent".
    digests: Vec<Vec<[u8; 16]>>,
    pub round: u32,
}

pub struct ScanCursor {
    mem: usize,
    page: u64,
}

impl Default for ScanCursor {
    fn default() -> Self {
        ScanCursor { mem: 0, page: 0 }
    }
}

pub struct ScanOutput {
    /// (mem index, page number, bytes) for each dirty page found this step.
    pub pages: Vec<(u8, u64, Vec<u8>)>,
    /// Cursor completed a full pass over all memories.
    pub round_complete: bool,
}

impl PageTracker {
    pub fn new(n_mems: usize) -> Self {
        PageTracker { digests: vec![Vec::new(); n_mems], round: 0 }
    }

    fn is_zero(buf: &[u8]) -> bool {
        buf.iter().all(|b| *b == 0)
    }

    /// Scan up to `budget_bytes` worth of pages from `cursor`, returning the
    /// dirty ones. When `round_complete` is true the caller decides whether
    /// another round is warranted.
    pub fn scan_step(
        &mut self,
        mems: &dyn MemRead,
        cursor: &mut ScanCursor,
        budget_bytes: usize,
    ) -> ScanOutput {
        let mut out = ScanOutput { pages: Vec::new(), round_complete: false };
        let mut scanned = 0usize;
        let n = mems.n_mems();
        let mut buf = vec![0u8; WPAGE_SIZE];
        loop {
            if cursor.mem >= n {
                cursor.mem = 0;
                cursor.page = 0;
                self.round += 1;
                out.round_complete = true;
                return out;
            }
            let mem_size = mems.size(cursor.mem);
            let n_pages = (mem_size / WPAGE_SIZE) as u64;
            if self.digests[cursor.mem].len() < n_pages as usize {
                self.digests[cursor.mem].resize(n_pages as usize, ZERO_DIGEST_SENTINEL);
            }
            if cursor.page >= n_pages {
                cursor.mem += 1;
                cursor.page = 0;
                continue;
            }
            if scanned >= budget_bytes {
                return out;
            }
            let off = (cursor.page as usize) * WPAGE_SIZE;
            mems.read(cursor.mem, off, &mut buf);
            scanned += WPAGE_SIZE;
            let prev = self.digests[cursor.mem][cursor.page as usize];
            if prev == ZERO_DIGEST_SENTINEL && Self::is_zero(&buf) {
                // never sent, still zero: target already agrees
            } else {
                let d = page_digest(&buf);
                if d != prev {
                    self.digests[cursor.mem][cursor.page as usize] = d;
                    out.pages.push((cursor.mem as u8, cursor.page, buf.clone()));
                }
            }
            cursor.page += 1;
        }
    }

    /// One full synchronous pass (used for the final stop-and-copy delta and
    /// by hosts that don't budget).
    pub fn scan_full(&mut self, mems: &dyn MemRead) -> Vec<(u8, u64, Vec<u8>)> {
        let mut cursor = ScanCursor::default();
        let mut all = Vec::new();
        loop {
            let step = self.scan_step(mems, &mut cursor, usize::MAX);
            all.extend(step.pages);
            if step.round_complete {
                return all;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeMem(Vec<Vec<u8>>);
    impl MemRead for FakeMem {
        fn n_mems(&self) -> usize {
            self.0.len()
        }
        fn size(&self, m: usize) -> usize {
            self.0[m].len()
        }
        fn read(&self, m: usize, off: usize, buf: &mut [u8]) {
            buf.copy_from_slice(&self.0[m][off..off + buf.len()]);
        }
    }

    #[test]
    fn dirty_tracking() {
        let mut mem = FakeMem(vec![vec![0u8; WPAGE_SIZE * 8]]);
        let mut tr = PageTracker::new(1);
        // round 1: all zero → nothing sent
        assert!(tr.scan_full(&mem).is_empty());
        // dirty two pages
        mem.0[0][WPAGE_SIZE * 2] = 7;
        mem.0[0][WPAGE_SIZE * 5 + 100] = 9;
        let d = tr.scan_full(&mem);
        assert_eq!(d.iter().map(|p| p.1).collect::<Vec<_>>(), vec![2, 5]);
        // untouched: nothing
        assert!(tr.scan_full(&mem).is_empty());
        // zero a previously-sent page: must be re-sent (target has stale data)
        mem.0[0][WPAGE_SIZE * 2] = 0;
        let d = tr.scan_full(&mem);
        assert_eq!(d.iter().map(|p| p.1).collect::<Vec<_>>(), vec![2]);
        // memory growth is picked up
        mem.0[0].extend_from_slice(&vec![1u8; WPAGE_SIZE]);
        let d = tr.scan_full(&mem);
        assert_eq!(d.iter().map(|p| p.1).collect::<Vec<_>>(), vec![8]);
    }
}
