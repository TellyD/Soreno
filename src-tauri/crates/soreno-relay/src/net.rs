use std::{
    fs,
    io::{self, Read, Write},
    net::{IpAddr, Shutdown, TcpListener, TcpStream},
    os::{
        fd::{AsRawFd, RawFd},
        unix::{
            fs::{FileTypeExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::Path,
    time::Duration,
};

/// Its directory, which only the relay and Caddy can enter, is what keeps other accounts out.
const SOCKET_MODE: u32 = 0o660;

/// A TCP address, or a Unix socket for the phones behind Caddy.
pub enum Listener {
    Tcp(TcpListener),
    Unix(UnixListener),
}

impl Listener {
    /// `unix:<path>`, replacing the socket a previous run left there, or `address:port`.
    pub fn bind(address: &str) -> io::Result<Self> {
        let Some(path) = address.strip_prefix("unix:") else {
            return TcpListener::bind(address).map(Self::Tcp);
        };
        let path = Path::new(path);
        if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_socket()) {
            fs::remove_file(path)?;
        }
        let listener = UnixListener::bind(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(SOCKET_MODE))?;
        Ok(Self::Unix(listener))
    }

    pub fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        match self {
            Self::Tcp(listener) => listener.set_nonblocking(nonblocking),
            Self::Unix(listener) => listener.set_nonblocking(nonblocking),
        }
    }

    pub fn accept(&self) -> io::Result<Stream> {
        match self {
            Self::Tcp(listener) => listener.accept().map(|(stream, _)| Stream::Tcp(stream)),
            Self::Unix(listener) => listener.accept().map(|(stream, _)| Stream::Unix(stream)),
        }
    }
}

impl AsRawFd for Listener {
    fn as_raw_fd(&self) -> RawFd {
        match self {
            Self::Tcp(listener) => listener.as_raw_fd(),
            Self::Unix(listener) => listener.as_raw_fd(),
        }
    }
}

pub enum Stream {
    Tcp(TcpStream),
    Unix(UnixStream),
}

impl Stream {
    /// The peer's address, `None` over a Unix socket.
    pub fn peer_ip(&self) -> io::Result<Option<IpAddr>> {
        match self {
            Self::Tcp(stream) => stream.peer_addr().map(|address| Some(address.ip())),
            Self::Unix(_) => Ok(None),
        }
    }

    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        match self {
            Self::Tcp(stream) => stream.set_read_timeout(timeout),
            Self::Unix(stream) => stream.set_read_timeout(timeout),
        }
    }

    pub fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        match self {
            Self::Tcp(stream) => stream.set_write_timeout(timeout),
            Self::Unix(stream) => stream.set_write_timeout(timeout),
        }
    }

    pub fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        match self {
            Self::Tcp(stream) => stream.set_nonblocking(nonblocking),
            Self::Unix(stream) => stream.set_nonblocking(nonblocking),
        }
    }

    pub fn set_nodelay(&self, nodelay: bool) -> io::Result<()> {
        match self {
            Self::Tcp(stream) => stream.set_nodelay(nodelay),
            Self::Unix(_) => Ok(()),
        }
    }

    pub fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        match self {
            Self::Tcp(stream) => stream.shutdown(how),
            Self::Unix(stream) => stream.shutdown(how),
        }
    }
}

impl From<TcpStream> for Stream {
    fn from(stream: TcpStream) -> Self {
        Self::Tcp(stream)
    }
}

impl Read for Stream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Tcp(stream) => stream.read(buffer),
            Self::Unix(stream) => stream.read(buffer),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        match self {
            Self::Tcp(stream) => stream.write(buffer),
            Self::Unix(stream) => stream.write(buffer),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Tcp(stream) => stream.flush(),
            Self::Unix(stream) => stream.flush(),
        }
    }
}

impl AsRawFd for Stream {
    fn as_raw_fd(&self) -> RawFd {
        match self {
            Self::Tcp(stream) => stream.as_raw_fd(),
            Self::Unix(stream) => stream.as_raw_fd(),
        }
    }
}
