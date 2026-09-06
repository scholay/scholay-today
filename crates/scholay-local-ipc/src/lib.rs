//! User-local, non-network IPC. No credentials or database access in this crate.
use std::{
    io,
    path::{Path, PathBuf},
};

#[cfg(unix)]
mod native {
    use super::*;
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    pub type Stream = tokio::net::UnixStream;
    pub struct Listener(tokio::net::UnixListener);
    pub fn endpoint(dir: &Path) -> io::Result<PathBuf> {
        Ok(dir.join("agent.sock"))
    }
    pub async fn connect(path: &Path) -> io::Result<Stream> {
        Stream::connect(path).await
    }
    impl Listener {
        pub async fn bind(path: &Path) -> io::Result<Self> {
            if let Ok(meta) = std::fs::symlink_metadata(path) {
                if !meta.file_type().is_socket() || Stream::connect(path).await.is_ok() {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "Local bridge already exists",
                    ));
                }
                std::fs::remove_file(path)?;
            }
            let listener = tokio::net::UnixListener::bind(path)?;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
            Ok(Self(listener))
        }
        pub async fn accept(&mut self) -> io::Result<Stream> {
            loop {
                let (stream, _) = self.0.accept().await?;
                // A probe can disconnect before getpeereid on macOS. Ignore it
                // (and other users) without shutting down the healthy listener.
                if stream
                    .peer_cred()
                    .is_ok_and(|cred| cred.uid() == unsafe { libc::geteuid() })
                {
                    return Ok(stream);
                }
            }
        }
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use sha2::{Digest, Sha256};
    use tokio::net::windows::named_pipe::{
        ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree},
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            },
            GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    pub type Stream = NamedPipeClient;
    pub struct Listener {
        pending: NamedPipeServer,
        path: PathBuf,
    }

    fn current_sid() -> io::Result<String> {
        unsafe {
            let mut token = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut size = 0;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
            // TOKEN_USER contains pointers: keep the allocation pointer-aligned.
            let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                size,
                &mut size,
            );
            let error = io::Error::last_os_error();
            CloseHandle(token);
            if ok == 0 {
                return Err(error);
            }
            let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
            let mut text = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut len = 0;
            while *text.add(len) != 0 {
                len += 1;
            }
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
            LocalFree(text.cast());
            Ok(sid)
        }
    }
    pub fn endpoint(dir: &Path) -> io::Result<PathBuf> {
        let key = format!(
            "{}\n{}",
            current_sid()?,
            dir.to_string_lossy().to_lowercase()
        );
        let digest = format!("{:x}", Sha256::digest(key.as_bytes()));
        Ok(PathBuf::from(format!(
            r"\\.\pipe\scholay-tody-{}",
            &digest[..32]
        )))
    }
    fn create(path: &Path, first: bool) -> io::Result<NamedPipeServer> {
        // Protected DACL: only this Windows account. No Everyone/anonymous/network ACE.
        let descriptor: Vec<u16> = format!("D:P(A;;GA;;;{})", current_sid()?)
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            let mut sd = std::ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                descriptor.as_ptr(),
                1,
                &mut sd,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let mut attrs = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd,
                bInheritHandle: 0,
            };
            let result = ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(
                    path,
                    (&mut attrs as *mut SECURITY_ATTRIBUTES).cast(),
                );
            LocalFree(sd);
            result
        }
    }
    impl Listener {
        pub async fn bind(path: &Path) -> io::Result<Self> {
            Ok(Self {
                pending: create(path, true)?,
                path: path.into(),
            })
        }
        pub async fn accept(&mut self) -> io::Result<NamedPipeServer> {
            self.pending.connect().await?;
            // Keep an instance alive: another process cannot take over the name.
            let next = create(&self.path, false)?;
            Ok(std::mem::replace(&mut self.pending, next))
        }
    }
    pub async fn connect(path: &Path) -> io::Result<Stream> {
        if !path
            .to_string_lossy()
            .starts_with(r"\\.\pipe\scholay-tody-")
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Not a scholay local pipe",
            ));
        }
        for attempt in 0..40 {
            match ClientOptions::new().open(path) {
                Ok(stream) => return Ok(stream),
                Err(e) if e.raw_os_error() == Some(231) && attempt < 39 => {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                Err(e) => return Err(e),
            }
        }
        unreachable!()
    }
}
pub use native::{connect, endpoint, Listener, Stream};

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn local_round_trip_and_duplicate_server_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = endpoint(dir.path()).unwrap();
        assert_eq!(path, endpoint(dir.path()).unwrap());
        let mut listener = Listener::bind(&path).await.unwrap();
        assert!(Listener::bind(&path).await.is_err());
        let task = tokio::spawn(async move {
            loop {
                let mut stream = listener.accept().await.unwrap();
                let mut bytes = [0; 4];
                // Unix bind detection may have queued an empty probe.
                if stream.read_exact(&mut bytes).await.is_err() {
                    continue;
                }
                assert_eq!(&bytes, b"ping");
                stream.write_all(b"pong").await.unwrap();
                break;
            }
        });
        let mut stream = connect(&path).await.unwrap();
        stream.write_all(b"ping").await.unwrap();
        let mut bytes = [0; 4];
        stream.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"pong");
        task.await.unwrap();
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn remote_pipe_is_never_allowed() {
        assert!(connect(Path::new(r"\\remote\pipe\scholay-tody-test"))
            .await
            .is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn existing_regular_file_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = endpoint(dir.path()).unwrap();
        std::fs::write(&path, "keep").unwrap();
        assert!(Listener::bind(&path).await.is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "keep");
    }
}
