use std::{
    collections::VecDeque,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, RawFd},
        unix::net::UnixStream,
    },
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex, MutexGuard, PoisonError,
    },
};

struct Queue<T> {
    /// Each with what it counts towards the limits of `push_within`.
    items: VecDeque<(T, usize)>,
    size: usize,
    closed: bool,
}

pub enum Pop<T> {
    Item(T),
    Empty,
    /// Empty and closed: nothing more will come.
    Closed,
}

/// A queue between threads whose descriptor wakes a `poll` when something arrives or it closes,
/// once `pop` found it empty.
pub struct Mailbox<T> {
    queue: Mutex<Queue<T>>,
    /// What all the mailboxes sharing it hold, given back as items leave or are dropped.
    shared: Arc<AtomicUsize>,
    read: UnixStream,
    write: UnixStream,
}

impl<T> Mailbox<T> {
    pub fn new(shared: Arc<AtomicUsize>) -> std::io::Result<Self> {
        let (read, write) = UnixStream::pair()?;
        read.set_nonblocking(true)?;
        write.set_nonblocking(true)?;
        Ok(Self {
            queue: Mutex::new(Queue {
                items: VecDeque::new(),
                size: 0,
                closed: false,
            }),
            shared,
            read,
            write,
        })
    }

    fn lock(&self) -> MutexGuard<'_, Queue<T>> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `false` once closed, or when the items not yet popped would weigh more than `limit` with
    /// this one, or those of all the mailboxes sharing its count more than `total`.
    pub fn push_within(&self, item: T, size: usize, limit: usize, total: usize) -> bool {
        let mut queue = self.lock();
        let sum = queue.size.saturating_add(size);
        if queue.closed
            || sum > limit
            || self
                .shared
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |held| {
                    held.checked_add(size).filter(|&held| held <= total)
                })
                .is_err()
        {
            return false;
        }
        queue.items.push_back((item, size));
        queue.size = sum;
        drop(queue);
        let _ = (&self.write).write(b".");
        true
    }

    /// What was pushed before still comes out of `pop`.
    pub fn close(&self) {
        self.lock().closed = true;
        let _ = (&self.write).write(b".");
    }

    pub fn pop(&self) -> Pop<T> {
        let mut queue = self.lock();
        if let Some((item, size)) = queue.items.pop_front() {
            queue.size -= size;
            self.shared.fetch_sub(size, Ordering::AcqRel);
            return Pop::Item(item);
        }
        // Drained under the lock: any later push signals again.
        let mut drain = [0u8; 256];
        while matches!((&self.read).read(&mut drain), Ok(read) if read > 0) {}
        if queue.closed {
            Pop::Closed
        } else {
            Pop::Empty
        }
    }

    pub fn fd(&self) -> RawFd {
        self.read.as_raw_fd()
    }
}

impl<T> Drop for Mailbox<T> {
    fn drop(&mut self) {
        let size = self.lock().size;
        self.shared.fetch_sub(size, Ordering::AcqRel);
    }
}
