//! Windows Credential Manager. No plaintext fallback and no credential logging.
use windows::{
    core::{HRESULT, HSTRING, PWSTR},
    Win32::{Foundation::ERROR_NOT_FOUND, Security::Credentials::*},
};

pub fn read(target: &str) -> Result<Option<Vec<u8>>, ()> {
    unsafe {
        let mut pointer = std::ptr::null_mut();
        match CredReadW(
            &HSTRING::from(target),
            CRED_TYPE_GENERIC,
            None,
            &mut pointer,
        ) {
            Ok(()) => {
                let credential = &mut *pointer;
                let len = credential.CredentialBlobSize as usize;
                let value = if len > 2560 || (len > 0 && credential.CredentialBlob.is_null()) {
                    Err(())
                } else if len == 0 {
                    Ok(Some(vec![]))
                } else {
                    let blob = std::slice::from_raw_parts_mut(credential.CredentialBlob, len);
                    let value = blob.to_vec();
                    blob.fill(0);
                    Ok(Some(value))
                };
                CredFree(pointer.cast());
                value
            }
            Err(e) if e.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) => Ok(None),
            Err(_) => Err(()),
        }
    }
}
pub fn save(target: &str, bytes: &[u8]) -> Result<(), ()> {
    if bytes.is_empty() || bytes.len() > 2560 {
        return Err(());
    }
    let mut name: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
    let mut username: Vec<u16> = "scholay-tody".encode_utf16().chain(Some(0)).collect();
    let mut blob = bytes.to_vec();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(name.as_mut_ptr()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: PWSTR(username.as_mut_ptr()),
        ..Default::default()
    };
    let result = unsafe { CredWriteW(&credential, 0) }.map_err(|_| ());
    blob.fill(0);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolated_credential_round_trip() {
        let name = format!("scholay-tody.test.{}", uuid::Uuid::new_v4());
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                unsafe {
                    let _ = CredDeleteW(&HSTRING::from(self.0.as_str()), CRED_TYPE_GENERIC, None);
                }
            }
        }
        let _cleanup = Cleanup(name.clone());
        assert_eq!(read(&name), Ok(None));
        save(&name, b"synthetic-test-token").unwrap();
        assert_eq!(read(&name).unwrap().unwrap(), b"synthetic-test-token");
        assert!(save(&name, &vec![1; 2561]).is_err());
        assert_eq!(read(&name).unwrap().unwrap(), b"synthetic-test-token");
    }
}
