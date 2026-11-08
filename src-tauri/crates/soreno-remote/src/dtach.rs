use crate::stop::Stop;
use std::{
    fs::{File, OpenOptions},
    io::{self, Write},
    mem,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{ffi::OsStrExt, fs::OpenOptionsExt, net::UnixStream},
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const MSG_PUSH: u8 = 0;
const PACKET_DATA: usize = 8;
const PACKET_LEN: usize = 2 + PACKET_DATA;
// Keeps a stop requested during a long write from waiting out its whole deadline.
const WRITE_SLICE: Duration = Duration::from_millis(100);

pub type Packet = [u8; PACKET_LEN];

fn packet(kind: u8, data: &[u8]) -> Packet {
    let mut packet = [0; PACKET_LEN];
    packet[0] = kind;
    packet[1] = data.len() as u8;
    packet[2..2 + data.len()].copy_from_slice(data);
    packet
}

pub fn push_packets(data: &[u8]) -> Vec<Packet> {
    data.chunks(PACKET_DATA)
        .map(|chunk| packet(MSG_PUSH, chunk))
        .collect()
}

/// A path to `socket` that fits in `sun_path`: past the limit, one through a descriptor of its
/// directory, valid while that descriptor stays open. Never `chdir`: the service is threaded.
fn reachable(socket: &Path) -> io::Result<(PathBuf, Option<File>)> {
    let limit = unsafe { mem::zeroed::<libc::sockaddr_un>() }.sun_path.len();
    if socket.as_os_str().len() < limit {
        return Ok((socket.to_path_buf(), None));
    }
    let (Some(parent), Some(name)) = (socket.parent(), socket.file_name()) else {
        return Err(io::ErrorKind::InvalidInput.into());
    };
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_DIRECTORY)
        .open(parent)?;
    let path = Path::new("/proc/self/fd")
        .join(directory.as_raw_fd().to_string())
        .join(name);
    Ok((path, Some(directory)))
}

fn remaining(deadline: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero())
}

pub trait PacketStream: Write {
    fn set_slice(&self, timeout: Duration) -> io::Result<()>;
}

impl PacketStream for UnixStream {
    fn set_slice(&self, timeout: Duration) -> io::Result<()> {
        self.set_write_timeout(Some(timeout))
    }
}

/// `false` unless every packet went out whole before `deadline` and before a stop.
pub fn write_until<S: PacketStream>(
    stream: &mut S,
    packets: &[Packet],
    deadline: Instant,
    stop: Option<&Stop>,
) -> bool {
    packets
        .iter()
        .all(|packet| write_packet(stream, packet, deadline, stop))
}

fn write_packet<S: PacketStream>(
    stream: &mut S,
    packet: &Packet,
    deadline: Instant,
    stop: Option<&Stop>,
) -> bool {
    loop {
        if stop.is_some_and(Stop::requested) {
            return false;
        }
        let Some(left) = remaining(deadline) else {
            return false;
        };
        if stream.set_slice(left.min(WRITE_SLICE)).is_err() {
            return false;
        }
        match stream.write(packet) {
            // The master takes any read as a whole packet: a torn one can never be resumed.
            Ok(count) => return count == PACKET_LEN,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::Interrupted
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return false,
        }
    }
}

/// Never attached: the master sends it nothing, not even the history replay, and still takes
/// its input.
pub fn connect(socket: &Path, deadline: Instant) -> io::Result<UnixStream> {
    let (path, _directory) = reachable(socket)?;
    let path = path.as_os_str().as_bytes();
    let mut address: libc::sockaddr_un = unsafe { mem::zeroed() };
    if path.len() >= address.sun_path.len() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in address.sun_path.iter_mut().zip(path) {
        *slot = *byte as libc::c_char;
    }
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let stream = UnixStream::from(unsafe { OwnedFd::from_raw_fd(fd) });
    // Linux bounds a blocking connect to a full backlog with the send timeout.
    stream.set_write_timeout(Some(remaining(deadline).ok_or(io::ErrorKind::TimedOut)?))?;
    let length = mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
    let address = (&address as *const libc::sockaddr_un).cast::<libc::sockaddr>();
    if unsafe { libc::connect(stream.as_raw_fd(), address, length) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;
    use std::{fs, io::Read, os::unix::net::UnixListener};

    #[test]
    fn a_socket_past_the_sun_path_limit_is_reached_through_its_directory() {
        let directory = TempDir::new();
        let deep = directory.path().join("d".repeat(120));
        fs::create_dir(&deep).unwrap();
        let socket = deep.join("socket");
        let (path, _directory) = reachable(&socket).unwrap();
        let listener = UnixListener::bind(path).unwrap();
        let deadline = Instant::now() + Duration::from_millis(500);
        let mut input = connect(&socket, deadline).unwrap();
        assert!(write_until(&mut input, &push_packets(b"x"), deadline, None));
        drop(input);
        let mut received = Vec::new();
        listener
            .accept()
            .unwrap()
            .0
            .read_to_end(&mut received)
            .unwrap();
        assert_eq!(received, push_packets(b"x").concat());
    }

    #[test]
    fn a_stalled_write_gives_up_at_its_deadline_or_on_stop() {
        let (mut stream, _peer) = UnixStream::pair().unwrap();
        let packets = vec![push_packets(b"x")[0]; (16 << 20) / PACKET_LEN];
        let started = Instant::now();
        let deadline = started + Duration::from_millis(300);
        assert!(!write_until(&mut stream, &packets, deadline, None));
        assert!(started.elapsed() < Duration::from_millis(600));
        let stop = Stop::new().unwrap();
        stop.request();
        let deadline = Instant::now() + Duration::from_secs(5);
        assert!(!write_until(&mut stream, &packets, deadline, Some(&stop)));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    /// Takes `room` bytes, then a single byte per write.
    struct Narrow {
        room: usize,
        written: Vec<u8>,
        writes: usize,
    }

    impl Write for Narrow {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.writes += 1;
            let count = bytes
                .len()
                .min(self.room.saturating_sub(self.written.len()).max(1));
            self.written.extend_from_slice(&bytes[..count]);
            Ok(count)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl PacketStream for Narrow {
        fn set_slice(&self, _timeout: Duration) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_packet_cut_short_fails_without_resuming() {
        let packets = push_packets(b"0123456789abcdefgh");
        let mut stream = Narrow {
            room: PACKET_LEN + 4,
            written: Vec::new(),
            writes: 0,
        };
        let deadline = Instant::now() + Duration::from_secs(1);
        assert!(!write_until(&mut stream, &packets, deadline, None));
        assert_eq!(stream.writes, 2);
        assert_eq!(stream.written, packets.concat()[..PACKET_LEN + 4]);
    }

    #[test]
    fn input_is_split_into_push_packets_of_eight_bytes() {
        let packets = push_packets(b"0123456789");
        assert_eq!(packets, [*b"\x00\x0801234567", *b"\x00\x0289\0\0\0\0\0\0"]);
        assert!(push_packets(b"").is_empty());
    }
}
