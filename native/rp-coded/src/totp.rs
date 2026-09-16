//! RFC 6238 time-based one-time passwords, implemented here rather than pulled in as a
//! dependency: the daemon needs HMAC over SHA-1/256/512 and base32, nothing else, and every
//! crate that offers them drags in a random-number and time stack the daemon already has.
//!
//! Everything in this module is pure except [`random_secret`], which reads `/dev/urandom`.
//! The seal (`seal.rs`) owns the secret and the replay window; this module only turns a secret
//! and a counter into digits and back.

use std::fmt;
use std::fs::File;
use std::io::Read;

use sha2::{Digest, Sha256, Sha512};

/// Longest secret accepted (bytes, after base32 decoding). RFC 4226 asks for ≥ 16.
pub const MAX_SECRET_BYTES: usize = 64;
/// Shortest secret accepted (bytes). 128 bits, the RFC 4226 minimum.
pub const MIN_SECRET_BYTES: usize = 16;
/// What [`random_secret`] generates: 160 bits, the size every authenticator app handles.
pub const SECRET_BYTES: usize = 20;

/// Bounds on `period` (seconds per step). 30 is what every authenticator app assumes.
pub const MIN_PERIOD: u64 = 15;
pub const MAX_PERIOD: u64 = 300;
pub const DEFAULT_PERIOD: u64 = 30;
/// Steps accepted on each side of the current one, for clock drift. One step = ±30 s.
pub const DEFAULT_WINDOW: u32 = 1;
pub const MAX_WINDOW: u32 = 10;
pub const DEFAULT_DIGITS: u32 = 6;

/// Hash behind the HMAC. SHA-1 is the default because it is what an unconfigured authenticator
/// app assumes; SHA-256/512 are there for administrators whose app supports them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Algorithm {
    #[default]
    Sha1,
    Sha256,
    Sha512,
}

impl Algorithm {
    pub fn as_str(self) -> &'static str {
        match self {
            Algorithm::Sha1 => "SHA1",
            Algorithm::Sha256 => "SHA256",
            Algorithm::Sha512 => "SHA512",
        }
    }

    /// Block size of the hash, which is what HMAC pads the key to.
    fn block_size(self) -> usize {
        match self {
            Algorithm::Sha1 | Algorithm::Sha256 => 64,
            Algorithm::Sha512 => 128,
        }
    }

    fn digest(self, data: &[u8]) -> Vec<u8> {
        match self {
            Algorithm::Sha1 => sha1(data).to_vec(),
            Algorithm::Sha256 => Sha256::digest(data).to_vec(),
            Algorithm::Sha512 => Sha512::digest(data).to_vec(),
        }
    }
}

/// The parameters an authenticator app is enrolled with. Stored in the seal and reported (without
/// the secret) by `seal-status`, so a lost app can be re-enrolled with the same settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpConfig {
    #[serde(default)]
    pub algorithm: Algorithm,
    pub digits: u32,
    pub period: u64,
    pub window: u32,
}

impl Default for TotpConfig {
    fn default() -> Self {
        TotpConfig {
            algorithm: Algorithm::default(),
            digits: DEFAULT_DIGITS,
            period: DEFAULT_PERIOD,
            window: DEFAULT_WINDOW,
        }
    }
}

impl TotpConfig {
    /// Clamp everything into the supported ranges rather than refusing: these numbers come from
    /// a policy file whose author cannot see an error message.
    pub fn sanitised(self) -> TotpConfig {
        TotpConfig {
            algorithm: self.algorithm,
            digits: self.digits.clamp(6, 8),
            period: self.period.clamp(MIN_PERIOD, MAX_PERIOD),
            window: self.window.min(MAX_WINDOW),
        }
    }

    /// The time step a unix timestamp falls into.
    pub fn counter(self, unix_secs: u64) -> u64 {
        unix_secs / self.period.max(1)
    }
}

/// Why a code was not accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    /// Not the right number of digits, or not digits at all.
    Malformed,
    /// Correct shape, wrong code (or outside the drift window).
    Wrong,
    /// Right code, but it was already used — a replay of a code still inside its step.
    Replayed,
}

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VerifyError::Malformed => {
                write!(f, "the code must be the digits from your authenticator app")
            }
            VerifyError::Wrong => write!(f, "that code is not valid"),
            VerifyError::Replayed => write!(f, "that code was already used; wait for the next one"),
        }
    }
}

/// HMAC (RFC 2104) over `alg`.
pub fn hmac(alg: Algorithm, key: &[u8], msg: &[u8]) -> Vec<u8> {
    let block = alg.block_size();
    let mut padded = vec![0u8; block];
    if key.len() > block {
        let digest = alg.digest(key);
        padded[..digest.len()].copy_from_slice(&digest);
    } else {
        padded[..key.len()].copy_from_slice(key);
    }
    let mut inner = Vec::with_capacity(block + msg.len());
    let mut outer = Vec::with_capacity(block + 64);
    for b in &padded {
        inner.push(b ^ 0x36);
        outer.push(b ^ 0x5c);
    }
    inner.extend_from_slice(msg);
    let inner_digest = alg.digest(&inner);
    outer.extend_from_slice(&inner_digest);
    alg.digest(&outer)
}

/// Constant-time byte comparison, so a caller cannot learn a prefix from the timing.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// The RFC 4226 code for one counter value, zero-padded to `digits`.
pub fn code_at(secret: &[u8], counter: u64, cfg: TotpConfig) -> String {
    let cfg = cfg.sanitised();
    let mac = hmac(cfg.algorithm, secret, &counter.to_be_bytes());
    let offset = (mac[mac.len() - 1] & 0x0f) as usize;
    let binary = ((u32::from(mac[offset]) & 0x7f) << 24)
        | (u32::from(mac[offset + 1]) << 16)
        | (u32::from(mac[offset + 2]) << 8)
        | u32::from(mac[offset + 3]);
    let modulus = 10u32.pow(cfg.digits);
    format!("{:0width$}", binary % modulus, width = cfg.digits as usize)
}

/// Check `code` against the steps around `unix_secs`. `last_used` is the newest counter already
/// spent (`None` when nothing was); a code from that step or older is a replay even when it is
/// arithmetically correct, so watching someone type a code buys nothing.
///
/// Returns the counter the code belongs to, which the caller must persist as the new `last_used`.
pub fn verify(
    secret: &[u8],
    code: &str,
    unix_secs: u64,
    cfg: TotpConfig,
    last_used: Option<u64>,
) -> Result<u64, VerifyError> {
    let cfg = cfg.sanitised();
    let trimmed: String = code
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    if trimmed.len() != cfg.digits as usize || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return Err(VerifyError::Malformed);
    }
    let current = cfg.counter(unix_secs);
    let window = i64::from(cfg.window);
    let mut matched: Option<u64> = None;
    // Every candidate is compared, without an early exit, so the loop takes the same time
    // whichever step matched.
    for delta in -window..=window {
        let counter = match u64::try_from(current as i64 + delta) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let candidate = code_at(secret, counter, cfg);
        if constant_time_eq(candidate.as_bytes(), trimmed.as_bytes()) {
            matched = Some(counter);
        }
    }
    let counter = matched.ok_or(VerifyError::Wrong)?;
    if let Some(used) = last_used {
        if counter <= used {
            return Err(VerifyError::Replayed);
        }
    }
    Ok(counter)
}

/// `otpauth://totp/…` URI for enrolment (what a QR code encodes).
pub fn otpauth_uri(issuer: &str, label: &str, secret: &[u8], cfg: TotpConfig) -> String {
    let cfg = cfg.sanitised();
    let issuer = if issuer.trim().is_empty() {
        "rp-code"
    } else {
        issuer.trim()
    };
    let label = if label.trim().is_empty() {
        "policy"
    } else {
        label.trim()
    };
    format!(
        "otpauth://totp/{}:{}?secret={}&issuer={}&algorithm={}&digits={}&period={}",
        percent_encode(issuer),
        percent_encode(label),
        base32_encode(secret),
        percent_encode(issuer),
        cfg.algorithm.as_str(),
        cfg.digits,
        cfg.period
    )
}

/// Minimal percent-encoding for the two free-text fields of the URI.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// RFC 4648 base32 without padding (what authenticator apps expect in a secret).
pub fn base32_encode(data: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for byte in data {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32_ALPHABET[((buffer >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(BASE32_ALPHABET[((buffer << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

/// Decode base32, ignoring case, spaces and `=` padding. `None` for any other character.
pub fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for c in text.chars() {
        if c == '=' || c.is_whitespace() || c == '-' {
            continue;
        }
        let value = BASE32_ALPHABET
            .iter()
            .position(|a| *a == c.to_ascii_uppercase() as u8)? as u32;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

/// A fresh secret from `/dev/urandom` (the daemon runs as root; there is always one).
pub fn random_secret() -> std::io::Result<Vec<u8>> {
    random_bytes(SECRET_BYTES)
}

/// `n` bytes from `/dev/urandom`.
pub fn random_bytes(n: usize) -> std::io::Result<Vec<u8>> {
    let mut buf = vec![0u8; n];
    File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(buf)
}

// ---------------------------------------------------------------------------
// SHA-1 (FIPS 180-4). Only needed because `sha2` does not carry it and SHA-1 is what an
// authenticator app defaults to; it is used for HMAC, never as a collision-resistant hash.
// ---------------------------------------------------------------------------

pub fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut message = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in message.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in chunk.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn sha1_matches_the_fips_examples() {
        assert_eq!(
            hex(&sha1(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(hex(&sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            hex(&sha1(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
        // A message longer than one block, to exercise the chunk loop.
        assert_eq!(
            hex(&sha1(&vec![b'a'; 1000])),
            "291e9a6c66994949b57ba5e650361e98fc36b1ba"
        );
    }

    #[test]
    fn hmac_matches_rfc_2202_and_4231() {
        // RFC 2202 test case 1 (HMAC-SHA1).
        assert_eq!(
            hex(&hmac(Algorithm::Sha1, &[0x0b; 20], b"Hi There")),
            "b617318655057264e28bc0b6fb378c8ef146be00"
        );
        // RFC 2202 test case 2, a key shorter than the block.
        assert_eq!(
            hex(&hmac(
                Algorithm::Sha1,
                b"Jefe",
                b"what do ya want for nothing?"
            )),
            "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79"
        );
        // RFC 4231 test case 2 (HMAC-SHA256 and -SHA512).
        assert_eq!(
            hex(&hmac(
                Algorithm::Sha256,
                b"Jefe",
                b"what do ya want for nothing?"
            )),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(
            hex(&hmac(Algorithm::Sha512, b"Jefe", b"what do ya want for nothing?")),
            "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737"
        );
        // A key longer than the block is hashed first (RFC 2202 test case 6).
        assert_eq!(
            hex(&hmac(
                Algorithm::Sha1,
                &[0xaa; 80],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "aa4ae5e15272d00e95705637ce8a3b55ed402112"
        );
    }

    /// RFC 6238 appendix B. The SHA-256/512 seeds there are the ASCII sequence repeated to the
    /// key length, not the SHA-1 seed.
    #[test]
    fn totp_matches_the_rfc_6238_vectors() {
        let seed1 = b"12345678901234567890".to_vec();
        let seed256: Vec<u8> = b"12345678901234567890123456789012".to_vec();
        let seed512: Vec<u8> =
            b"1234567890123456789012345678901234567890123456789012345678901234".to_vec();
        let cfg = |alg| TotpConfig {
            algorithm: alg,
            digits: 8,
            period: 30,
            window: 0,
        };
        for (time, sha1_code, sha256_code, sha512_code) in [
            (59u64, "94287082", "46119246", "90693936"),
            (1_111_111_109, "07081804", "68084774", "25091201"),
            (1_111_111_111, "14050471", "67062674", "99943326"),
            (1_234_567_890, "89005924", "91819424", "93441116"),
            (2_000_000_000, "69279037", "90698825", "38618901"),
            (20_000_000_000, "65353130", "77737706", "47863826"),
        ] {
            let c = cfg(Algorithm::Sha1);
            assert_eq!(
                code_at(&seed1, c.counter(time), c),
                sha1_code,
                "sha1 at {time}"
            );
            let c = cfg(Algorithm::Sha256);
            assert_eq!(
                code_at(&seed256, c.counter(time), c),
                sha256_code,
                "sha256 at {time}"
            );
            let c = cfg(Algorithm::Sha512);
            assert_eq!(
                code_at(&seed512, c.counter(time), c),
                sha512_code,
                "sha512 at {time}"
            );
        }
    }

    #[test]
    fn verify_accepts_the_current_step_and_the_drift_window() {
        let secret = b"12345678901234567890";
        let cfg = TotpConfig::default();
        let now = 1_700_000_000u64;
        let counter = cfg.counter(now);
        let code = code_at(secret, counter, cfg);
        assert_eq!(verify(secret, &code, now, cfg, None), Ok(counter));
        // The previous and next steps are accepted with the default window of 1.
        let earlier = code_at(secret, counter - 1, cfg);
        assert_eq!(verify(secret, &earlier, now, cfg, None), Ok(counter - 1));
        let later = code_at(secret, counter + 1, cfg);
        assert_eq!(verify(secret, &later, now, cfg, None), Ok(counter + 1));
        // Two steps away is outside it.
        let far = code_at(secret, counter + 2, cfg);
        assert_eq!(
            verify(secret, &far, now, cfg, None),
            Err(VerifyError::Wrong)
        );
    }

    #[test]
    fn verify_rejects_replays_and_malformed_input() {
        let secret = b"12345678901234567890";
        let cfg = TotpConfig::default();
        let now = 1_700_000_000u64;
        let counter = cfg.counter(now);
        let code = code_at(secret, counter, cfg);
        assert_eq!(
            verify(secret, &code, now, cfg, Some(counter)),
            Err(VerifyError::Replayed)
        );
        // A code older than the last one spent is a replay too, even inside the window.
        let earlier = code_at(secret, counter - 1, cfg);
        assert_eq!(
            verify(secret, &earlier, now, cfg, Some(counter)),
            Err(VerifyError::Replayed)
        );
        assert_eq!(
            verify(secret, "12345", now, cfg, None),
            Err(VerifyError::Malformed)
        );
        assert_eq!(
            verify(secret, "abcdef", now, cfg, None),
            Err(VerifyError::Malformed)
        );
        assert!(verify(secret, "000000", now, cfg, None).is_err());
        // Spaces and dashes people type are ignored.
        let spaced = format!("{} {}", &code[..3], &code[3..]);
        assert_eq!(verify(secret, &spaced, now, cfg, None), Ok(counter));
    }

    #[test]
    fn base32_round_trips_and_ignores_padding() {
        // RFC 4648 test vectors.
        assert_eq!(base32_encode(b"f"), "MY");
        assert_eq!(base32_encode(b"fo"), "MZXQ");
        assert_eq!(base32_encode(b"foobar"), "MZXW6YTBOI");
        assert_eq!(base32_decode("MZXW6YTBOI").unwrap(), b"foobar");
        assert_eq!(base32_decode("mzxw6ytboi").unwrap(), b"foobar");
        assert_eq!(base32_decode("MZXW 6YTB-OI======").unwrap(), b"foobar");
        assert_eq!(base32_decode("MZXW6YTB0I"), None);
        let secret = vec![1u8, 2, 3, 250, 99, 17, 200];
        assert_eq!(base32_decode(&base32_encode(&secret)).unwrap(), secret);
    }

    #[test]
    fn otpauth_uri_carries_the_parameters() {
        let uri = otpauth_uri(
            "Acme Ltd",
            "alice@host",
            b"12345678901234567890",
            TotpConfig::default(),
        );
        assert!(uri.starts_with(
            "otpauth://totp/Acme%20Ltd:alice%40host?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
        ));
        assert!(uri.contains("&issuer=Acme%20Ltd&algorithm=SHA1&digits=6&period=30"));
    }

    #[test]
    fn config_is_clamped_into_the_supported_ranges() {
        let cfg = TotpConfig {
            algorithm: Algorithm::Sha512,
            digits: 12,
            period: 1,
            window: 99,
        }
        .sanitised();
        assert_eq!(cfg.digits, 8);
        assert_eq!(cfg.period, MIN_PERIOD);
        assert_eq!(cfg.window, MAX_WINDOW);
    }

    #[test]
    fn random_secret_is_the_documented_size_and_not_constant() {
        let a = random_secret().expect("/dev/urandom");
        let b = random_secret().expect("/dev/urandom");
        assert_eq!(a.len(), SECRET_BYTES);
        assert_ne!(a, b);
    }
}
