use std::{
    io,
    os::{
        fd::{AsRawFd, IntoRawFd, RawFd},
        unix::net::UnixStream,
    },
    sync::atomic::{AtomicI32, Ordering},
};

static SIGNAL_FD: AtomicI32 = AtomicI32::new(-1);

/// Never drained once requested: every `poll` watching `fd()` keeps waking up.
pub struct Stop {
    read: UnixStream,
    write: UnixStream,
}

impl Stop {
    pub fn new() -> io::Result<Self> {
        let (read, write) = UnixStream::pair()?;
        write.set_nonblocking(true)?;
        Ok(Self { read, write })
    }

    pub fn request(&self) {
        let _ = io::Write::write(&mut &self.write, b".");
    }

    pub fn requested(&self) -> bool {
        let mut fd = libc::pollfd {
            fd: self.fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        unsafe { libc::poll(&mut fd, 1, 0) > 0 }
    }

    pub fn fd(&self) -> RawFd {
        self.read.as_raw_fd()
    }

    /// SIGTERM and SIGINT request the stop.
    pub fn on_signals(&self) -> io::Result<()> {
        // Leaked on purpose: a late signal must never write to a closed or reused descriptor.
        SIGNAL_FD.store(self.write.try_clone()?.into_raw_fd(), Ordering::Relaxed);
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        action.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
        action.sa_flags = libc::SA_RESTART;
        unsafe { libc::sigemptyset(&mut action.sa_mask) };
        for signal in [libc::SIGTERM, libc::SIGINT] {
            if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
}

/// Until one of `fds` is readable, or writable when asked, or `timeout` milliseconds (-1: none).
pub fn poll(fds: &[(RawFd, bool)], timeout: i32) {
    let mut fds: Vec<libc::pollfd> = fds
        .iter()
        .map(|&(fd, writing)| libc::pollfd {
            fd,
            events: libc::POLLIN | if writing { libc::POLLOUT } else { 0 },
            revents: 0,
        })
        .collect();
    unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
}

extern "C" fn on_signal(_: libc::c_int) {
    unsafe {
        let errno = *libc::__errno_location();
        libc::write(SIGNAL_FD.load(Ordering::Relaxed), b".".as_ptr().cast(), 1);
        *libc::__errno_location() = errno;
    }
}
