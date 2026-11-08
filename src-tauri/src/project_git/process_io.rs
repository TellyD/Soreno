#[cfg(windows)]
use std::sync::Arc;
use std::{
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const IO_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[cfg(windows)]
struct WindowsIoState {
    handle: std::sync::Mutex<Option<usize>>,
}

#[cfg(windows)]
struct WindowsStream<S> {
    stream: Option<S>,
    state: Arc<WindowsIoState>,
}

#[cfg(windows)]
impl<S> Drop for WindowsStream<S> {
    fn drop(&mut self) {
        let mut handle = self
            .state
            .handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *handle = None;
        drop(self.stream.take());
    }
}

pub(super) struct IoThread<T> {
    receiver: Receiver<std::io::Result<T>>,
    join: Option<JoinHandle<()>>,
    #[cfg(windows)]
    state: Arc<WindowsIoState>,
}

impl<T> IoThread<T> {
    pub(super) fn receive(
        &mut self,
        deadline: Instant,
    ) -> Result<std::io::Result<T>, RecvTimeoutError> {
        let result = self
            .receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()));
        if !matches!(result, Err(RecvTimeoutError::Timeout)) {
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }
        result
    }

    #[cfg(windows)]
    fn cancel_blocking_io(&self) {
        let handle = self
            .state
            .handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(handle) = *handle {
            unsafe {
                windows_sys::Win32::System::IO::CancelIoEx(
                    handle as windows_sys::Win32::Foundation::HANDLE,
                    std::ptr::null(),
                );
            }
        }
    }

    #[cfg(not(windows))]
    fn cancel_blocking_io(&self) {}
}

impl<T> Drop for IoThread<T> {
    fn drop(&mut self) {
        self.cancel_blocking_io();
        if self.join.as_ref().is_some_and(|join| join.is_finished()) {
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }
    }
}

#[cfg(not(windows))]
pub(super) fn spawn_io<S: Send + 'static, T: Send + 'static>(
    mut stream: S,
    task: impl FnOnce(&mut S) -> std::io::Result<T> + Send + 'static,
) -> IoThread<T> {
    let (sender, receiver) = mpsc::channel();
    let join = thread::spawn(move || {
        let _ = sender.send(task(&mut stream));
    });
    IoThread {
        receiver,
        join: Some(join),
    }
}

#[cfg(windows)]
pub(super) fn spawn_io<S, T>(
    stream: S,
    task: impl FnOnce(&mut S) -> std::io::Result<T> + Send + 'static,
) -> IoThread<T>
where
    S: std::os::windows::io::AsRawHandle + Send + 'static,
    T: Send + 'static,
{
    let state = Arc::new(WindowsIoState {
        handle: std::sync::Mutex::new(Some(stream.as_raw_handle() as usize)),
    });
    let worker_state = Arc::clone(&state);
    let (sender, receiver) = mpsc::channel();
    let join = thread::spawn(move || {
        let mut stream = WindowsStream {
            stream: Some(stream),
            state: worker_state,
        };
        let result = task(stream.stream.as_mut().unwrap());
        drop(stream);
        let _ = sender.send(result);
    });
    IoThread {
        receiver,
        join: Some(join),
        state,
    }
}

#[derive(Debug)]
pub(super) struct Captured {
    pub(super) bytes: Vec<u8>,
    pub(super) truncated: bool,
}

fn append_capture(bytes: &mut Vec<u8>, truncated: &mut bool, buffer: &[u8], limit: usize) {
    let remaining = limit.saturating_sub(bytes.len());
    bytes.extend_from_slice(&buffer[..buffer.len().min(remaining)]);
    *truncated |= buffer.len() > remaining;
}

#[cfg(test)]
pub(super) fn drain(mut stream: impl Read, limit: usize) -> std::io::Result<Captured> {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut buffer = [0; 16 * 1024];
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        append_capture(&mut bytes, &mut truncated, &buffer[..read], limit);
    }
    Ok(Captured { bytes, truncated })
}

#[cfg(unix)]
fn set_nonblocking(descriptor: std::os::fd::RawFd) -> std::io::Result<()> {
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn drain_pipe(
    stream: &mut (impl Read + std::os::fd::AsRawFd),
    limit: usize,
    cancelled: &AtomicBool,
) -> std::io::Result<Captured> {
    set_nonblocking(stream.as_raw_fd())?;
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut buffer = [0; 16 * 1024];
    loop {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        let mut descriptor = libc::pollfd {
            fd: stream.as_raw_fd(),
            events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
            revents: 0,
        };
        let polled = unsafe {
            libc::poll(
                &mut descriptor,
                1,
                IO_POLL_INTERVAL.as_millis() as libc::c_int,
            )
        };
        if polled < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if polled == 0 {
            continue;
        }
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => append_capture(&mut bytes, &mut truncated, &buffer[..read], limit),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(Captured { bytes, truncated })
}

#[cfg(windows)]
pub(super) fn drain_pipe(
    stream: &mut impl Read,
    limit: usize,
    cancelled: &AtomicBool,
) -> std::io::Result<Captured> {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut buffer = [0; 16 * 1024];
    while !cancelled.load(Ordering::Acquire) {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        append_capture(&mut bytes, &mut truncated, &buffer[..read], limit);
    }
    Ok(Captured { bytes, truncated })
}

#[cfg(unix)]
pub(super) fn write_pipe(
    stream: &mut (impl Write + std::os::fd::AsRawFd),
    input: &[u8],
    cancelled: &AtomicBool,
) -> std::io::Result<()> {
    set_nonblocking(stream.as_raw_fd())?;
    let mut written = 0;
    while written < input.len() && !cancelled.load(Ordering::Acquire) {
        let mut descriptor = libc::pollfd {
            fd: stream.as_raw_fd(),
            events: libc::POLLOUT | libc::POLLHUP | libc::POLLERR,
            revents: 0,
        };
        let polled = unsafe {
            libc::poll(
                &mut descriptor,
                1,
                IO_POLL_INTERVAL.as_millis() as libc::c_int,
            )
        };
        if polled < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if polled > 0 {
            match stream.write(&input[written..]) {
                Ok(0) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WriteZero,
                        "impossible d’écrire vers Git",
                    ));
                }
                Ok(count) => written += count,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn write_pipe(
    stream: &mut impl Write,
    input: &[u8],
    cancelled: &AtomicBool,
) -> std::io::Result<()> {
    for chunk in input.chunks(16 * 1024) {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        stream.write_all(chunk)?;
    }
    Ok(())
}

pub(super) fn stop_io<T>(task: &mut IoThread<T>, deadline: Instant) -> bool {
    loop {
        task.cancel_blocking_io();
        match task.receive((Instant::now() + IO_POLL_INTERVAL).min(deadline)) {
            Ok(_) | Err(RecvTimeoutError::Disconnected) => return true,
            Err(RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
            Err(RecvTimeoutError::Timeout) => return false,
        }
    }
}
