use crate::{mailbox::Mailbox, stop::Stop};
use soreno_mobile_protocol::{Frame, Key, PHONE_FRAME_LIMIT};
use std::{
    collections::HashMap,
    hash::Hash,
    net::IpAddr,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex, MutexGuard, PoisonError,
    },
};

pub const MAX_CHANNELS: usize = 32;
pub const PHONES_PER_ADDRESS: usize = 64;
/// Well below `MAX_CHANNELS`: a channel opens before any end-to-end authentication.
pub const CHANNELS_PER_ADDRESS: usize = 8;
/// What waits for one side of a channel before the channel is closed.
pub const CHANNEL_QUEUE_LIMIT: usize = 16 << 20;
/// What waits for one server across its channels: four channels at their own limit. Phones that
/// come and go would otherwise pile up messages without end for a server that stopped reading.
pub const LINK_QUEUE_LIMIT: usize = 4 * CHANNEL_QUEUE_LIMIT;
/// What waits across the whole relay, both ways: one host can own many server identities.
pub const RELAY_QUEUE_LIMIT: usize = 4 * LINK_QUEUE_LIMIT;
/// What a queued message counts beyond its bytes, so that empty ones are not free.
pub const MESSAGE_COST: usize = 64;

pub const CLOSED: u16 = 1000;
pub const STOPPING: u16 = 1001;
/// The channel fell too far behind.
pub const OVERFLOW: u16 = 1008;
pub const INVALID: u16 = 4400;
pub const OFFLINE: u16 = 4404;
pub const TOO_MANY: u16 = 4429;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How many of each key are held, each up to the `max` it is taken with.
pub struct Counts<K>(Mutex<HashMap<K, usize>>);

impl<K: Eq + Hash> Default for Counts<K> {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

impl<K: Eq + Hash> Counts<K> {
    pub fn take(&self, key: K, max: usize) -> bool {
        let mut counts = lock(&self.0);
        let count = counts.entry(key).or_insert(0);
        if *count >= max {
            return false;
        }
        *count += 1;
        true
    }

    pub fn give(&self, key: &K) {
        let mut counts = lock(&self.0);
        if let Some(count) = counts.get_mut(key) {
            *count -= 1;
            if *count == 0 {
                counts.remove(key);
            }
        }
    }
}

pub struct Relay {
    pub private: Key,
    pub origin: String,
    links: Mutex<HashMap<String, Arc<Link>>>,
    addresses: Counts<IpAddr>,
    channels: Counts<(IpAddr, String)>,
    /// What all the links and channels hold queued, against `RELAY_QUEUE_LIMIT`.
    pub(crate) queued: Arc<AtomicUsize>,
}

impl Relay {
    pub fn new(private: Key, origin: String) -> Self {
        Self {
            private,
            origin,
            links: Mutex::new(HashMap::new()),
            addresses: Counts::default(),
            channels: Counts::default(),
            queued: Arc::default(),
        }
    }

    pub fn link(&self, server: &str) -> Option<Arc<Link>> {
        lock(&self.links).get(server).cloned()
    }

    /// `link` replaces any previous link of its server.
    pub fn connect(&self, link: Arc<Link>) {
        let previous = lock(&self.links).insert(link.server.clone(), link);
        if let Some(previous) = previous {
            previous.shut(OFFLINE);
        }
    }

    pub fn disconnect(&self, link: &Arc<Link>) {
        let mut links = lock(&self.links);
        if links
            .get(&link.server)
            .is_some_and(|current| Arc::ptr_eq(current, link))
        {
            links.remove(&link.server);
        }
        drop(links);
        link.shut(OFFLINE);
    }

    /// A place among the phones of `address` and among its channels to `server`, given back
    /// when dropped.
    pub fn admit(&self, address: IpAddr, server: &str) -> Option<Admission<'_>> {
        if !self.addresses.take(address, PHONES_PER_ADDRESS) {
            return None;
        }
        let pair = (address, server.to_owned());
        if !self.channels.take(pair.clone(), CHANNELS_PER_ADDRESS) {
            self.addresses.give(&address);
            return None;
        }
        Some(Admission { relay: self, pair })
    }
}

pub struct Admission<'a> {
    relay: &'a Relay,
    pair: (IpAddr, String),
}

impl Drop for Admission<'_> {
    fn drop(&mut self) {
        self.relay.channels.give(&self.pair);
        self.relay.addresses.give(&self.pair.0);
    }
}

/// A frame for the server, with what counts the queued bytes of its channel: holding the whole
/// channel would keep its queue towards the phone after the phone left.
pub struct Outgoing {
    pub frame: Frame,
    up: Option<Arc<AtomicUsize>>,
}

impl Outgoing {
    /// Once the frame left the queue.
    pub fn sent(&self) {
        if let Some(up) = &self.up {
            up.fetch_sub(cost(&self.frame), Ordering::AcqRel);
        }
    }
}

fn cost(frame: &Frame) -> usize {
    match frame {
        Frame::Data(_, data) => data.len() + MESSAGE_COST,
        Frame::Open(_) | Frame::Close(_) => MESSAGE_COST,
    }
}

pub struct Channel {
    pub id: u32,
    /// Server → phone.
    pub down: Mailbox<Vec<u8>>,
    /// What the phone's messages still queued for the link count.
    up: Arc<AtomicUsize>,
    code: Mutex<Option<u16>>,
}

impl Channel {
    /// The first ending wins.
    fn end(&self, code: u16) {
        lock(&self.code).get_or_insert(code);
        self.down.close();
    }

    /// How the phone's WebSocket closes once `down` is closed.
    pub fn code(&self) -> u16 {
        lock(&self.code).unwrap_or(OFFLINE)
    }
}

struct Channels {
    open: HashMap<u32, Arc<Channel>>,
    next: u32,
    shut: bool,
}

/// One server's link: its queue towards the server and its channels.
pub struct Link {
    pub server: String,
    pub outbox: Mailbox<Outgoing>,
    /// Requested once the link is gone or replaced.
    pub ended: Stop,
    channels: Mutex<Channels>,
    /// The relay's count of queued bytes.
    queued: Arc<AtomicUsize>,
}

impl Link {
    pub fn new(server: String, queued: Arc<AtomicUsize>) -> std::io::Result<Self> {
        Ok(Self {
            server,
            outbox: Mailbox::new(queued.clone())?,
            ended: Stop::new()?,
            channels: Mutex::new(Channels {
                open: HashMap::new(),
                next: 1,
                shut: false,
            }),
            queued,
        })
    }

    /// A new channel, announced to the server; otherwise the close code for the phone.
    pub fn open(&self) -> Result<Arc<Channel>, u16> {
        let mut channels = lock(&self.channels);
        if channels.shut {
            return Err(OFFLINE);
        }
        if channels.open.len() >= MAX_CHANNELS {
            return Err(TOO_MANY);
        }
        let mut id = channels.next;
        while channels.open.contains_key(&id) {
            id = id.wrapping_add(1);
        }
        let channel = Arc::new(Channel {
            id,
            down: Mailbox::new(self.queued.clone()).map_err(|_| OFFLINE)?,
            up: Arc::default(),
            code: Mutex::new(None),
        });
        // Not shut while `channels` is held: only a server that stopped reading refuses, once
        // its queue has no room left for one more message.
        let room = LINK_QUEUE_LIMIT - PHONE_FRAME_LIMIT - MESSAGE_COST;
        if !self.push(Frame::Open(id), None, room, RELAY_QUEUE_LIMIT) {
            return Err(TOO_MANY);
        }
        channels.next = id.wrapping_add(1);
        channels.open.insert(id, channel.clone());
        Ok(channel)
    }

    /// A phone message for the server; `false` once the channel cannot go on.
    pub fn send(&self, channel: &Arc<Channel>, data: Vec<u8>) -> bool {
        let frame = Frame::Data(channel.id, data);
        let size = cost(&frame);
        // A shut link ended its channels before closing the outbox: their code is kept.
        if channel.up.fetch_add(size, Ordering::AcqRel) + size > CHANNEL_QUEUE_LIMIT
            || !self.push(
                frame,
                Some(channel.up.clone()),
                LINK_QUEUE_LIMIT,
                RELAY_QUEUE_LIMIT,
            )
        {
            channel.up.fetch_sub(size, Ordering::AcqRel);
            channel.end(OVERFLOW);
            return false;
        }
        true
    }

    /// The phone left: the server forgets the channel.
    pub fn release(&self, channel: &Arc<Channel>) {
        if self.remove(channel.id, channel) {
            self.push(Frame::Close(channel.id), None, usize::MAX, usize::MAX);
        }
    }

    /// A server message for a phone.
    pub fn deliver(&self, id: u32, data: Vec<u8>) {
        let Some(channel) = lock(&self.channels).open.get(&id).cloned() else {
            return;
        };
        let size = data.len() + MESSAGE_COST;
        let queued = channel
            .down
            .push_within(data, size, CHANNEL_QUEUE_LIMIT, RELAY_QUEUE_LIMIT);
        if !queued && self.remove(id, &channel) {
            channel.end(OVERFLOW);
            self.push(Frame::Close(id), None, usize::MAX, usize::MAX);
        }
    }

    /// The server ended a channel.
    pub fn closed(&self, id: u32) {
        let channel = lock(&self.channels).open.remove(&id);
        if let Some(channel) = channel {
            channel.end(CLOSED);
        }
    }

    /// The link is gone or replaced: its phones are told with `code`.
    pub fn shut(&self, code: u16) {
        let mut channels = lock(&self.channels);
        channels.shut = true;
        let open: Vec<_> = channels.open.drain().map(|(_, channel)| channel).collect();
        drop(channels);
        for channel in open {
            channel.end(code);
        }
        self.ended.request();
        self.outbox.close();
    }

    fn remove(&self, id: u32, channel: &Arc<Channel>) -> bool {
        let mut channels = lock(&self.channels);
        if channels
            .open
            .get(&id)
            .is_some_and(|current| Arc::ptr_eq(current, channel))
        {
            channels.open.remove(&id);
            true
        } else {
            false
        }
    }

    /// Closes are always queued: each follows an open taken within the limits.
    fn push(&self, frame: Frame, up: Option<Arc<AtomicUsize>>, limit: usize, total: usize) -> bool {
        let size = cost(&frame);
        self.outbox
            .push_within(Outgoing { frame, up }, size, limit, total)
    }
}
