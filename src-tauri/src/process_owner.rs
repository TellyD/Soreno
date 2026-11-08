use std::{process::Command, time::Duration};

#[cfg(unix)]
pub(crate) struct ProcessOwner {
    process_group: Option<libc::pid_t>,
}

#[cfg(unix)]
impl ProcessOwner {
    pub(crate) fn configure(command: &mut Command) {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    pub(crate) fn new(child: &std::process::Child) -> std::io::Result<Self> {
        Ok(Self {
            process_group: Some(child.id() as libc::pid_t),
        })
    }

    pub(crate) fn terminate(&mut self, child: &mut std::process::Child, timeout: Duration) -> bool {
        let Some(process_group) = self.process_group.take() else {
            return matches!(child.try_wait(), Ok(Some(_)));
        };
        let killed = unsafe { libc::kill(-process_group, libc::SIGKILL) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let reaped = matches!(child.try_wait(), Ok(Some(_)));
            let group_gone = unsafe { libc::kill(-process_group, 0) } != 0
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
            if reaped && group_gone {
                return killed;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(windows)]
pub(crate) struct ProcessOwner {
    job: Option<std::os::windows::io::OwnedHandle>,
    #[cfg(test)]
    profile_job: Duration,
    #[cfg(test)]
    profile_snapshot: Duration,
    #[cfg(test)]
    profile_enumeration_resume: Duration,
}

#[cfg(windows)]
fn pss_thread_id(child: &std::process::Child) -> std::io::Result<(u32, Duration, Duration)> {
    use std::{mem::size_of, os::windows::io::AsRawHandle, time::Instant};
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::{
            Diagnostics::ProcessSnapshotting::{
                PssCaptureSnapshot, PssFreeSnapshot, PssWalkMarkerCreate, PssWalkMarkerFree,
                PssWalkSnapshot, HPSS, HPSSWALK, PSS_CAPTURE_THREADS, PSS_THREAD_ENTRY,
                PSS_WALK_THREADS,
            },
            Threading::GetCurrentProcess,
        },
    };

    let mut snapshot: HPSS = std::ptr::null_mut();
    let started = Instant::now();
    let capture_error = unsafe {
        PssCaptureSnapshot(
            child.as_raw_handle() as _,
            PSS_CAPTURE_THREADS,
            0,
            &mut snapshot,
        )
    };
    if capture_error != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(capture_error as i32));
    }
    let profile_snapshot = started.elapsed();
    let walk_started = Instant::now();
    let mut marker: HPSSWALK = std::ptr::null_mut();
    let result = (|| {
        let marker_error = unsafe { PssWalkMarkerCreate(std::ptr::null(), &mut marker) };
        if marker_error != ERROR_SUCCESS {
            return Err(std::io::Error::from_raw_os_error(marker_error as i32));
        }
        loop {
            let mut entry = PSS_THREAD_ENTRY::default();
            let walk_error = unsafe {
                PssWalkSnapshot(
                    snapshot,
                    PSS_WALK_THREADS,
                    marker,
                    &mut entry as *mut _ as _,
                    size_of::<PSS_THREAD_ENTRY>() as u32,
                )
            };
            if walk_error != ERROR_SUCCESS {
                return Err(std::io::Error::from_raw_os_error(walk_error as i32));
            }
            if entry.ProcessId == child.id() {
                return Ok(entry.ThreadId);
            }
        }
    })();
    let marker_error = if marker.is_null() {
        ERROR_SUCCESS
    } else {
        unsafe { PssWalkMarkerFree(marker) }
    };
    // PSS snapshots are owned by the capturing process, not by the target process.
    let free_error = unsafe { PssFreeSnapshot(GetCurrentProcess(), snapshot) };
    match result {
        Err(error) => Err(error),
        Ok(_) if marker_error != ERROR_SUCCESS => {
            Err(std::io::Error::from_raw_os_error(marker_error as i32))
        }
        Ok(_) if free_error != ERROR_SUCCESS => {
            Err(std::io::Error::from_raw_os_error(free_error as i32))
        }
        Ok(thread_id) => Ok((thread_id, profile_snapshot, walk_started.elapsed())),
    }
}

#[cfg(windows)]
impl ProcessOwner {
    pub(crate) fn configure(command: &mut Command) {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }

    pub(crate) fn new(child: &std::process::Child) -> std::io::Result<Self> {
        #[cfg(test)]
        use std::time::Instant;
        use std::{
            mem::size_of,
            os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        };
        use windows_sys::Win32::System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        };
        #[cfg(test)]
        let job_started = Instant::now();
        let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw_job.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        // OwnedHandle supplies the Send ownership needed when Codex stores the owner in a Mutex.
        let job = unsafe { OwnedHandle::from_raw_handle(raw_job as _) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle() as _,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
            || unsafe {
                AssignProcessToJobObject(job.as_raw_handle() as _, child.as_raw_handle() as _)
            } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        #[cfg(test)]
        let profile_job = job_started.elapsed();

        let (thread_id, profile_snapshot, profile_walk) = pss_thread_id(child)?;
        #[cfg(not(test))]
        let _ = (profile_snapshot, profile_walk);
        #[cfg(test)]
        let resume_started = Instant::now();
        let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) };
        if thread.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let previous_suspend_count = unsafe { ResumeThread(thread) };
        let resume_error = (previous_suspend_count == u32::MAX).then(std::io::Error::last_os_error);
        unsafe { windows_sys::Win32::Foundation::CloseHandle(thread) };
        if let Some(error) = resume_error {
            return Err(error);
        }
        Ok(Self {
            job: Some(job),
            #[cfg(test)]
            profile_job,
            #[cfg(test)]
            profile_snapshot,
            #[cfg(test)]
            profile_enumeration_resume: profile_walk + resume_started.elapsed(),
        })
    }

    pub(crate) fn terminate(&mut self, child: &mut std::process::Child, timeout: Duration) -> bool {
        use std::{os::windows::io::AsRawHandle, time::Instant};
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        let Some(job) = self.job.take() else {
            return matches!(child.try_wait(), Ok(Some(_)));
        };
        let terminated = unsafe { TerminateJobObject(job.as_raw_handle() as _, 1) } != 0;
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return terminated,
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(_) => return false,
            }
        }
        false
    }

    #[cfg(test)]
    pub(crate) fn job_handle(&self) -> windows_sys::Win32::Foundation::HANDLE {
        use std::os::windows::io::AsRawHandle;
        self.job
            .as_ref()
            .map(|job| job.as_raw_handle() as _)
            .unwrap_or(std::ptr::null_mut())
    }

    #[cfg(test)]
    pub(crate) fn profile_job(&self) -> Duration {
        self.profile_job
    }

    #[cfg(test)]
    pub(crate) fn profile_snapshot(&self) -> Duration {
        self.profile_snapshot
    }

    #[cfg(test)]
    pub(crate) fn profile_enumeration_resume(&self) -> Duration {
        self.profile_enumeration_resume
    }
}
