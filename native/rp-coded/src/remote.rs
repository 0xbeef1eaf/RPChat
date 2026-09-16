//! The policy blocks that describe **where a machine's policy comes from** (`remote`) and **which
//! packs it is meant to have** (`packs`), plus the signature that pins a pack.
//!
//! The mechanism behind `remote` is the policy chain in `chain.rs`: the app fetches the chain file
//! — it has the network stack, the proxy configuration and the user's session — and the daemon
//! verifies every link against the Ed25519 public key the machine pinned when its Remote Link was
//! pasted. The daemon holds no private key of any kind and does no networking, so neither a
//! patched app nor a local root can produce something it will accept.
//!
//! Packs are pinned the same way. A pack entry carries a **signature** rather than a bare
//! checksum, because a checksum only says "these are the bytes the policy named" — and on a
//! machine whose policy arrives over the network, whoever can change the policy can change the
//! checksum with it. A signature says "the administrator's key vouched for this pack", which is a
//! claim the machine can check against a key it already trusts. The signature covers the pack's
//! id, its version and the SHA-256 of its bytes together, so a signed pack cannot be re-labelled
//! as a different one:
//!
//! ```text
//! rp-code-pack/v1\n<id>\n<version or empty>\n<sha256 hex of the .rppack>
//! ```
//!
//! The app downloads and hashes; the daemon verifies. That keeps hundreds of megabytes off the
//! socket while leaving the decision with the side that holds the trusted key.

use serde::{Deserialize, Serialize};

use crate::chain::{parse_key, verify_detached};

/// Prefix of the string a pack signature covers.
pub const PACK_SIGNING_PREFIX: &str = "rp-code-pack/v1";
/// `remote.intervalMinutes` bounds and default.
pub const MIN_INTERVAL_MINUTES: u64 = 5;
pub const MAX_INTERVAL_MINUTES: u64 = 24 * 60;
pub const DEFAULT_INTERVAL_MINUTES: u64 = 60;
/// `packs.refreshMinutes` default (packs change far less often than a policy).
pub const DEFAULT_PACK_REFRESH_MINUTES: u64 = 360;
/// Most pack sources one policy may list.
pub const MAX_PACK_SOURCES: usize = 64;

/// `PolicyFile.remote`: where this machine's policy chain is published.
///
/// The *key* that signs the chain is not here — it is pinned in the seal by the Remote Link, so
/// that a policy cannot name the key that authorises it. This block only moves the address and
/// the schedule, both of which a signed link may legitimately change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemotePolicy {
    pub url: String,
    /// `false` stops the app fetching without removing the address. Default true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<u64>,
}

/// `PolicyFile.packs`: the packs this machine is meant to have, and where to get them.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PacksPolicy {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<PackSource>,
    /// Uninstall every pack that is not listed. Default false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remove_unlisted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_minutes: Option<u64>,
}

/// One pack the policy pins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackSource {
    /// The pack id the download must contain — checked after unpacking, so a swapped URL cannot
    /// install something else under this entry.
    pub id: String,
    pub url: String,
    /// The administrator's signature over this pack, base64 (see the module docs for what it
    /// covers). Required on a machine that has a Remote Link: without it the pack is only as
    /// trustworthy as the policy that named it, which on a managed machine arrived over the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// SHA-256 of the `.rppack` file, lower-case hex. Redundant once a signature is present (the
    /// signature covers this hash), and the only integrity check available on a machine with no
    /// key at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// The version to install. When absent, whatever the download contains is installed once and
    /// re-downloaded only when the checksum changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Effective `remote` settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteRules {
    pub url: String,
    pub enabled: bool,
    pub interval_minutes: u64,
}

impl RemoteRules {
    pub fn from_policy(remote: Option<&RemotePolicy>) -> Option<RemoteRules> {
        let remote = remote?;
        Some(RemoteRules {
            url: remote.url.clone(),
            enabled: remote.enabled.unwrap_or(true),
            interval_minutes: remote
                .interval_minutes
                .unwrap_or(DEFAULT_INTERVAL_MINUTES)
                .clamp(MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES),
        })
    }
}

/// Effective `packs` settings.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PackRules {
    pub sources: Vec<PackSource>,
    pub remove_unlisted: bool,
    pub refresh_minutes: u64,
}

impl PackRules {
    pub fn from_policy(packs: Option<&PacksPolicy>) -> PackRules {
        match packs {
            None => PackRules {
                sources: Vec::new(),
                remove_unlisted: false,
                refresh_minutes: DEFAULT_PACK_REFRESH_MINUTES,
            },
            Some(p) => PackRules {
                sources: p.sources.clone(),
                remove_unlisted: p.remove_unlisted.unwrap_or(false),
                refresh_minutes: p
                    .refresh_minutes
                    .unwrap_or(DEFAULT_PACK_REFRESH_MINUTES)
                    .clamp(MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES),
            },
        }
    }
}

/// A URL the daemon will let the app fetch from: HTTPS anywhere, or plain HTTP on the loopback
/// (which is how the smoke tests and an on-box management agent serve it).
pub fn validate_url(url: &str, what: &str) -> Result<(), String> {
    if url.len() > 2048 {
        return Err(format!("{what} is longer than 2048 characters"));
    }
    if url
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '\\')
    {
        return Err(format!(
            "{what} must not contain spaces, quotes or control characters"
        ));
    }
    if let Some(rest) = url.strip_prefix("https://") {
        if rest.is_empty() {
            return Err(format!("{what} has no host"));
        }
        return Ok(());
    }
    if let Some(rest) = url.strip_prefix("http://") {
        let host = rest.split(['/', ':']).next().unwrap_or("");
        if host == "127.0.0.1" || host == "localhost" || host == "[::1]" {
            return Ok(());
        }
        return Err(format!(
            "{what} must be https:// (plain http is only allowed on 127.0.0.1)"
        ));
    }
    Err(format!("{what} must be an https:// URL"))
}

/// Validate a `remote` block.
pub fn validate_remote(remote: &RemotePolicy) -> Result<(), String> {
    validate_url(&remote.url, "remote.url")?;
    if let Some(i) = remote.interval_minutes {
        if !(MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&i) {
            return Err(format!(
                "remote.intervalMinutes must be between {MIN_INTERVAL_MINUTES} and {MAX_INTERVAL_MINUTES}"
            ));
        }
    }
    Ok(())
}

/// Validate a `packs` block.
pub fn validate_packs(packs: &PacksPolicy) -> Result<(), String> {
    if packs.sources.len() > MAX_PACK_SOURCES {
        return Err(format!(
            "packs.sources has more than {MAX_PACK_SOURCES} entries"
        ));
    }
    let mut seen: Vec<&str> = Vec::new();
    for source in &packs.sources {
        // The same id pattern the pack format uses (`@rp/shared`): lower-case, dots and dashes.
        if source.id.is_empty()
            || source.id.chars().count() > 64
            || !source.id.chars().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.' || c == '_'
            })
        {
            return Err(format!(
                "packs.sources[].id must be a pack id (lower-case letters, digits, -, . and _); got {:?}",
                source.id
            ));
        }
        if seen.contains(&source.id.as_str()) {
            return Err(format!("packs.sources lists {:?} twice", source.id));
        }
        seen.push(&source.id);
        validate_url(&source.url, &format!("packs.sources[{}].url", source.id))?;
        if let Some(sha) = &source.sha256 {
            if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(format!(
                    "packs.sources[{}].sha256 must be 64 hex characters",
                    source.id
                ));
            }
        }
        if let Some(signature) = &source.signature {
            if crate::seal::base64_decode(signature)
                .map(|b| b.len() != crate::chain::SIGNATURE_BYTES)
                .unwrap_or(true)
            {
                return Err(format!(
                    "packs.sources[{}].signature must be a base64 Ed25519 signature",
                    source.id
                ));
            }
        }
        if let Some(v) = &source.version {
            if v.is_empty() || v.chars().count() > 64 {
                return Err(format!(
                    "packs.sources[{}].version must be 1..64 characters",
                    source.id
                ));
            }
        }
    }
    if let Some(r) = packs.refresh_minutes {
        if !(MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&r) {
            return Err(format!(
                "packs.refreshMinutes must be between {MIN_INTERVAL_MINUTES} and {MAX_INTERVAL_MINUTES}"
            ));
        }
    }
    Ok(())
}

/// The exact string a pack signature covers (see the module docs).
pub fn pack_message(id: &str, version: Option<&str>, sha256: &str) -> String {
    format!(
        "{PACK_SIGNING_PREFIX}\n{id}\n{}\n{}",
        version.unwrap_or(""),
        sha256.to_lowercase()
    )
}

/// Why a downloaded pack was not accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackError {
    /// The policy does not pin a pack with this id.
    Unknown(String),
    /// The download's hash is not the one the policy pins.
    Checksum { expected: String, got: String },
    /// The machine has a key, so a pack must be signed, and this one is not.
    Unsigned(String),
    /// The signature does not check out against the key this machine pins.
    BadSignature(String),
    /// The machine has no key to check a signature against.
    NoKey,
}

impl std::fmt::Display for PackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PackError::Unknown(id) => write!(f, "this machine's policy does not pin a pack called {id:?}"),
            PackError::Checksum { expected, got } => write!(
                f,
                "the download hashes to {}…, but the policy pins {}…",
                &got[..got.len().min(16)],
                &expected[..expected.len().min(16)]
            ),
            PackError::Unsigned(id) => write!(
                f,
                "pack {id:?} carries no signature, and this machine only installs packs its administrator signed"
            ),
            PackError::BadSignature(m) => write!(f, "the pack's signature does not check out: {m}"),
            PackError::NoKey => write!(f, "pack {:?} is signed, but this machine pins no key to check it against", ""),
        }
    }
}

/// Decide whether a downloaded pack may be installed.
///
/// `key` is the machine's pinned chain key, when it has one. With a key, a signature is
/// **required**: a managed machine's policy arrives over the network, so a checksum in it proves
/// only that the policy and the pack agree, not that either came from the administrator. Without
/// a key the checksum is the only thing there is, and it is used.
pub fn verify_pack(source: &PackSource, sha256: &str, key: Option<&str>) -> Result<(), PackError> {
    let got = sha256.to_lowercase();
    if let Some(expected) = &source.sha256 {
        let expected = expected.to_lowercase();
        if expected != got {
            return Err(PackError::Checksum { expected, got });
        }
    }
    let Some(key) = key else {
        // No key on this machine: nothing can be verified beyond the checksum above, and a
        // signature that cannot be checked is not a reason to refuse a pack the local policy
        // named — the local policy is already trusted on an unlinked machine.
        return Ok(());
    };
    let Some(signature) = &source.signature else {
        return Err(PackError::Unsigned(source.id.clone()));
    };
    let key = parse_key(key).ok_or(PackError::NoKey)?;
    verify_detached(
        &key,
        signature,
        pack_message(&source.id, source.version.as_deref(), &got).as_bytes(),
    )
    .map_err(PackError::BadSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::tests::TestKey;
    use crate::seal::{base64_encode, sha256_hex};

    fn source(id: &str, sha: Option<&str>, signature: Option<&str>) -> PackSource {
        PackSource {
            id: id.into(),
            url: "https://example.com/p.rppack".into(),
            sha256: sha.map(str::to_string),
            signature: signature.map(str::to_string),
            version: None,
        }
    }

    #[test]
    fn urls_must_be_https_or_loopback_http() {
        assert!(validate_url("https://example.com/policy.json", "u").is_ok());
        assert!(validate_url("http://127.0.0.1:8080/p.json", "u").is_ok());
        assert!(validate_url("http://localhost/p.json", "u").is_ok());
        assert!(validate_url("http://example.com/p.json", "u").is_err());
        assert!(validate_url("file:///etc/passwd", "u").is_err());
        assert!(validate_url("https://example.com/a b", "u").is_err());
        assert!(validate_url("https://", "u").is_err());
    }

    #[test]
    fn remote_and_packs_blocks_are_validated() {
        let remote = RemotePolicy {
            url: "https://example.com/p.json".into(),
            enabled: None,
            interval_minutes: Some(1),
        };
        assert!(validate_remote(&remote)
            .unwrap_err()
            .contains("intervalMinutes"));
        let ok = RemotePolicy {
            interval_minutes: Some(60),
            ..remote
        };
        assert!(validate_remote(&ok).is_ok());

        let packs = PacksPolicy {
            sources: vec![source("luna", Some(&"a".repeat(64)), None)],
            ..Default::default()
        };
        assert!(validate_packs(&packs).is_ok());
        let bad = PacksPolicy {
            sources: vec![source("Luna!", None, None)],
            ..Default::default()
        };
        assert!(validate_packs(&bad)
            .unwrap_err()
            .contains("must be a pack id"));
        let short_sha = PacksPolicy {
            sources: vec![source("luna", Some("abc"), None)],
            ..Default::default()
        };
        assert!(validate_packs(&short_sha).unwrap_err().contains("64 hex"));
        let twice = PacksPolicy {
            sources: vec![source("luna", None, None), source("luna", None, None)],
            ..Default::default()
        };
        assert!(validate_packs(&twice).unwrap_err().contains("twice"));
        let bad_sig = PacksPolicy {
            sources: vec![source("luna", None, Some("not base64!!"))],
            ..Default::default()
        };
        assert!(validate_packs(&bad_sig)
            .unwrap_err()
            .contains("Ed25519 signature"));
    }

    #[test]
    fn rules_apply_the_documented_defaults() {
        let remote = RemotePolicy {
            url: "https://example.com/p.json".into(),
            enabled: None,
            interval_minutes: None,
        };
        let rules = RemoteRules::from_policy(Some(&remote)).unwrap();
        assert!(rules.enabled);
        assert_eq!(rules.interval_minutes, DEFAULT_INTERVAL_MINUTES);
        assert_eq!(RemoteRules::from_policy(None), None);

        let packs = PackRules::from_policy(None);
        assert!(packs.sources.is_empty() && !packs.remove_unlisted);
        assert_eq!(packs.refresh_minutes, DEFAULT_PACK_REFRESH_MINUTES);
    }

    /// The signature covers id, version and hash together, so the message is pinned here the way
    /// the chain's is: the app-side signer has to produce exactly this.
    #[test]
    fn the_pack_message_binds_the_id_the_version_and_the_bytes() {
        assert_eq!(
            pack_message("luna", Some("1.2.0"), "AABB"),
            "rp-code-pack/v1\nluna\n1.2.0\naabb"
        );
        assert_eq!(
            pack_message("luna", None, "aabb"),
            "rp-code-pack/v1\nluna\n\naabb"
        );
    }

    #[test]
    fn a_machine_with_a_key_installs_only_what_that_key_signed() {
        let key = TestKey::from_seed(3);
        let bytes = b"a pack file";
        let hash = sha256_hex(bytes);
        let signature = base64_encode(&key.sign_raw(pack_message("luna", None, &hash).as_bytes()));
        let signed = source("luna", None, Some(&signature));
        assert_eq!(verify_pack(&signed, &hash, Some(&key.public())), Ok(()));

        // Unsigned is refused on a machine that has a key.
        let unsigned = source("luna", Some(&hash), None);
        assert!(matches!(
            verify_pack(&unsigned, &hash, Some(&key.public())),
            Err(PackError::Unsigned(_))
        ));
        // Signed by somebody else.
        let other = TestKey::from_seed(4);
        let forged = base64_encode(&other.sign_raw(pack_message("luna", None, &hash).as_bytes()));
        assert!(matches!(
            verify_pack(
                &source("luna", None, Some(&forged)),
                &hash,
                Some(&key.public())
            ),
            Err(PackError::BadSignature(_))
        ));
        // A signature for a different pack id cannot be re-labelled onto this one.
        let elsewhere = base64_encode(&key.sign_raw(pack_message("other", None, &hash).as_bytes()));
        assert!(matches!(
            verify_pack(
                &source("luna", None, Some(&elsewhere)),
                &hash,
                Some(&key.public())
            ),
            Err(PackError::BadSignature(_))
        ));
        // Different bytes than the ones signed for.
        assert!(matches!(
            verify_pack(&signed, &sha256_hex(b"other bytes"), Some(&key.public())),
            Err(PackError::BadSignature(_))
        ));
    }

    #[test]
    fn a_machine_without_a_key_falls_back_to_the_checksum() {
        let bytes = b"a pack file";
        let hash = sha256_hex(bytes);
        assert_eq!(
            verify_pack(&source("luna", Some(&hash), None), &hash, None),
            Ok(())
        );
        assert!(matches!(
            verify_pack(&source("luna", Some(&"b".repeat(64)), None), &hash, None),
            Err(PackError::Checksum { .. })
        ));
        // A checksum is checked before the signature either way, so a pinned hash that does not
        // match is refused whatever key is around.
        let key = TestKey::from_seed(3);
        assert!(matches!(
            verify_pack(
                &source("luna", Some(&"b".repeat(64)), None),
                &hash,
                Some(&key.public())
            ),
            Err(PackError::Checksum { .. })
        ));
        // With neither a checksum nor a key there is nothing to check, and nothing is claimed.
        assert_eq!(
            verify_pack(&source("luna", None, None), &hash, None),
            Ok(())
        );
    }
}
