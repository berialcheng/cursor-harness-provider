//! SHA-256 through ring's CPU-dispatched implementation, already linked for TLS.
//! RustCrypto sha2 0.10 accelerates aarch64 only with its optional asm crate.
#[derive(Clone)]
pub(crate) struct Sha256(ring::digest::Context);

impl Sha256 {
    pub(crate) fn new() -> Self {
        Self(ring::digest::Context::new(&ring::digest::SHA256))
    }
    pub(crate) fn update(&mut self, data: impl AsRef<[u8]>) {
        self.0.update(data.as_ref());
    }
    pub(crate) fn finalize(self) -> [u8; 32] {
        let mut digest = [0; 32];
        digest.copy_from_slice(self.0.finish().as_ref());
        digest
    }
    pub(crate) fn digest(data: impl AsRef<[u8]>) -> [u8; 32] {
        let mut hash = Self::new();
        hash.update(data);
        hash.finalize()
    }
}

#[cfg(test)]
mod tests {
    use super::Sha256;
    #[test]
    fn matches_fips_180_vectors_across_update_boundaries() {
        let hex = |digest: [u8; 32]| {
            digest
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        };
        assert_eq!(
            hex(Sha256::digest(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let message = b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
        let mut split = Sha256::new();
        for part in message.chunks(7) {
            split.update(part);
        }
        assert_eq!(
            hex(split.finalize()),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }
}
