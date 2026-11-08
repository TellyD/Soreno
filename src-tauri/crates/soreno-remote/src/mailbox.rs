use std::{
    collections::VecDeque,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, RawFd},
        unix::net::UnixStream,
    },
    sync::{Mutex, MutexGuard, PoisonError},
};

struct Queue<T> {
    items: VecDeque<T>,
    /// What `push_within` counted for the pending items.
    size: usize,
    closed: bool,
}

/// A queue between threads whose descriptor wakes a `poll` when something arrives or it closes.
pub struct Mailbox<T> {
    queue: Mutex<Queue<T>>,
    read: UnixStream,
    write: UnixStream,
}

impl<T> Mailbox<T> {
    pub fn new() -> std::io::Result<Self> {
        let (read, write) = UnixStream::pair()?;
        read.set_nonblocking(true)?;
        write.set_nonblocking(true)?;
        Ok(Self {
            queue: Mutex::new(Queue {
                items: VecDeque::new(),
                size: 0,
                closed: false,
            }),
            read,
            write,
        })
    }

    fn lock(&self) -> MutexGuard<'_, Queue<T>> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `false` once closed.
    pub fn push(&self, item: T) -> bool {
        self.push_within(item, 0, usize::MAX)
    }

    /// `false` once closed, or when the pending items would weigh more than `limit` with this one.
    pub fn push_within(&self, item: T, size: usize, limit: usize) -> bool {
        let mut queue = self.lock();
        let total = queue.size.saturating_add(size);
        if queue.closed || total > limit {
            return false;
        }
        queue.items.push_back(item);
        queue.size = total;
        drop(queue);
        let _ = (&self.write).write(b".");
        true
    }

    /// What was pushed before still comes out of `take`.
    pub fn close(&self) {
        self.lock().closed = true;
        let _ = (&self.write).write(b".");
    }

    /// Whether `close` was called, leaving the pending items in place.
    pub fn closed(&self) -> bool {
        self.lock().closed
    }

    /// The pending items, and whether the mailbox is closed.
    pub fn take(&self) -> (Vec<T>, bool) {
        let mut drain = [0u8; 256];
        while matches!((&self.read).read(&mut drain), Ok(read) if read > 0) {}
        let mut queue = self.lock();
        queue.size = 0;
        (queue.items.drain(..).collect(), queue.closed)
    }

    pub fn fd(&self) -> RawFd {
        self.read.as_raw_fd()
    }
}
