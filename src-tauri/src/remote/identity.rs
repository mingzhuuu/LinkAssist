use super::protocol::err;
use iroh::SecretKey;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

pub fn load_key(directory: &Path) -> Result<SecretKey, String> {
    fs::create_dir_all(directory).map_err(err)?;
    let path = directory.join("identity.key");
    if path.exists() {
        let bytes = unprotect(&fs::read(path).map_err(err)?)?;
        let key: [u8; 32] = bytes.try_into().map_err(|_| "Invalid remote identity")?;
        return Ok(SecretKey::from_bytes(&key));
    }
    let key = SecretKey::generate();
    write_private(&path, &protect(&key.to_bytes())?)?;
    Ok(key)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(err)?;
    file.write_all(bytes).map_err(err)?;
    file.sync_all().map_err(err)
}

pub fn load_pairing(directory: &Path) -> Result<Option<String>, String> {
    let path = directory.join("pairing.key");
    if !path.exists() { return Ok(None); }
    String::from_utf8(unprotect(&fs::read(path).map_err(err)?)?).map(Some).map_err(err)
}

pub fn save_pairing(directory: &Path, code: Option<&str>) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(err)?;
    let path = directory.join("pairing.key");
    if let Some(code) = code {
        let temporary = directory.join(format!("pairing-{}.tmp", uuid::Uuid::new_v4()));
        write_private(&temporary, &protect(code.as_bytes())?)?;
        if let Err(error) = fs::rename(&temporary, &path) {
            let _ = fs::remove_file(temporary);
            return Err(err(error));
        }
    } else if path.exists() { fs::remove_file(path).map_err(err)?; }
    Ok(())
}

#[cfg(windows)]
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows::Win32::{
        Foundation::{LocalFree, HLOCAL},
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // DPAPI owns output memory; it is copied and freed on both successful paths.
    unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .map_err(err)?;
        } else {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .map_err(err)?;
        }
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(result)
    }
}
#[cfg(windows)]
fn protect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    crypt(bytes, true)
}
#[cfg(windows)]
fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    crypt(bytes, false)
}
#[cfg(not(windows))]
fn protect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    Ok(bytes.to_vec())
}
#[cfg(not(windows))]
fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persistent_pairing_survives_reload_rotation_and_revocation() {
        let directory = std::env::temp_dir().join(format!("linkassist-pairing-{}", uuid::Uuid::new_v4()));
        assert_eq!(load_pairing(&directory).unwrap(), None);
        save_pairing(&directory, Some("first-code")).unwrap();
        assert_eq!(load_pairing(&directory).unwrap().as_deref(), Some("first-code"));
        #[cfg(windows)]
        assert_ne!(fs::read(directory.join("pairing.key")).unwrap(), b"first-code");
        save_pairing(&directory, Some("rotated-code")).unwrap();
        assert_eq!(load_pairing(&directory).unwrap().as_deref(), Some("rotated-code"));
        save_pairing(&directory, None).unwrap();
        assert_eq!(load_pairing(&directory).unwrap(), None);
        fs::remove_dir(directory).unwrap();
    }
}
