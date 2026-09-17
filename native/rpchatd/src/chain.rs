//! The **policy chain**: a hash-linked, signed sequence of policies, and the only way to change a
//! machine sealed in `chain` mode.
//!
//! The seal (`seal.rs`) can hold a machine in one of two mutually exclusive modes:
//!
//! - **`totp`** — a person with the enrolled authenticator app types a code, the policy becomes
//!   editable locally, and that is the way in.
//! - **`chain`** — there is no code and no local way in at all. The machine pins an Ed25519
//!   **public** key and the hash of the last link it applied; the only thing that can change its
//!   policy is a new link, signed by that key (or by a successor the chain itself introduced),
//!   whose `prev` is exactly the hash the machine is holding. Releasing the machine is also a
//!   link — one with `unseal: true` — so even letting go is an act the key authorises.
//!
//! The point of the hash link, over a plain serial number, is what an administrator can prove
//! after the fact: every link commits to the one before it, so a machine that is at link *n* has
//! verified a signature over each of the *n* links that got it there. A policy cannot be replayed
//! (its `prev` no longer matches), cannot be reordered, and cannot be quietly forked — two
//! different links claiming the same position produce different hashes, and only one of them can
//! continue the chain the machine is actually on.
//!
//! A chain file is what the machine fetches:
//!
//! ```jsonc
//! { "version": 1, "links": [ …, { "seq": 7, "prev": "<sha256 of link 6>", "policy": { … },
//!                                 "signature": { "alg": "ed25519", "value": "<base64>" } } ] }
//! ```
//!
//! The machine finds its own head in that list, verifies every link after it, and applies the
//! last. It does **not** have to have seen the intermediate links: a machine that was off for a
//! month catches up by walking the tail, checking each signature as it goes. Links before its head
//! are not re-verified — the head hash already commits to all of them.
//!
//! Signing is Ed25519 over `rpchat-chain/v1\n` followed by the link's canonical bytes (compact
//! JSON, object keys sorted, `signature` removed), which is exactly what `serde_json` writes for a
//! `Value` and what `JSON.stringify` writes over recursively sorted entries — so both ends agree
//! without either implementing a canonicalisation spec. `scripts/rp-policy-chain.mjs` is the
//! signing side; the daemon only ever verifies, and holds no private key of any kind.

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::seal::{base64_decode, base64_encode, sha256_hex};

/// Prefixed to the canonical bytes before signing; bumping it invalidates every old signature.
pub const SIGNING_PREFIX: &str = "rpchat-chain/v1";
/// The only signature algorithm, named in the document so a second one could be added later.
pub const SIGNATURE_ALG: &str = "ed25519";
/// Refuse absurd chain files before parsing them.
pub const MAX_CHAIN_BYTES: usize = 4 * 1024 * 1024;
/// Most links one file may carry. A machine that is further behind than this asks for a longer
/// window rather than trusting an unbounded walk.
pub const MAX_LINKS: usize = 1024;
/// An Ed25519 public key is 32 bytes and a signature 64.
pub const KEY_BYTES: usize = 32;
pub const SIGNATURE_BYTES: usize = 64;

/// The `signature` member of a link or a remote link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signed {
    pub alg: String,
    pub value: String,
    /// Which key this is, when an administrator names their keys. Checked when the machine pins one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
}

/// One link of the chain, as it arrives.
#[derive(Debug, Clone, PartialEq)]
pub struct Link {
    pub seq: u64,
    /// Hash of the previous link's canonical bytes; empty for the genesis link.
    pub prev: String,
    pub issued_at: String,
    /// The policy this link puts in force. Absent means "keep the one before" — a link that only
    /// rotates the key or unseals does not have to restate the policy.
    pub policy: Option<Value>,
    /// Rotation: from the next link on, signatures are checked against this key instead.
    pub next_key: Option<String>,
    /// `true` releases the machine: the seal is lifted and local changes are possible again.
    pub unseal: bool,
    pub signature: Signed,
    /// This link's own hash, which the next link's `prev` must equal.
    pub hash: String,
    /// The canonical bytes the signature covers, kept for verification.
    canonical: String,
}

/// Why a chain was not applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainError {
    TooLarge(usize),
    Malformed(String),
    /// The file parsed but carries no links.
    Empty,
    /// More links than [`MAX_LINKS`].
    TooManyLinks(usize),
    /// None of the links continues from where this machine is.
    NoContinuation {
        head: String,
    },
    /// A link's `prev` does not match the link before it in the file.
    Broken {
        seq: u64,
    },
    /// A link's `seq` is not one more than the link before it.
    OutOfOrder {
        seq: u64,
        expected: u64,
    },
    /// A signature is missing, malformed, made with an unknown algorithm, or does not verify.
    BadSignature {
        seq: u64,
        why: String,
    },
    /// A link names a key id this machine does not expect.
    WrongKey {
        seq: u64,
        named: String,
        expected: String,
    },
    /// A `nextKey` that is not an Ed25519 public key.
    BadKey {
        seq: u64,
    },
    /// The machine's pinned key is not a valid Ed25519 public key (a damaged seal).
    UnusableKey,
}

impl std::fmt::Display for ChainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChainError::TooLarge(n) => write!(f, "the chain is {n} bytes; the limit is {MAX_CHAIN_BYTES}"),
            ChainError::Malformed(m) => write!(f, "the document is not a policy chain: {m}"),
            ChainError::Empty => write!(f, "the chain has no links"),
            ChainError::TooManyLinks(n) => write!(f, "the chain has {n} links; the limit is {MAX_LINKS}"),
            ChainError::NoContinuation { head } => write!(
                f,
                "no link continues from this machine's position ({}); publish a chain that includes it",
                if head.is_empty() { "the genesis" } else { &head[..head.len().min(16)] }
            ),
            ChainError::Broken { seq } => write!(f, "link {seq} does not follow the one before it"),
            ChainError::OutOfOrder { seq, expected } => write!(f, "link {seq} arrived where {expected} was expected"),
            ChainError::BadSignature { seq, why } => write!(f, "link {seq} is not properly signed: {why}"),
            ChainError::WrongKey { seq, named, expected } => write!(
                f,
                "link {seq} is signed with key {named:?}, but this machine expects {expected:?}"
            ),
            ChainError::BadKey { seq } => write!(f, "link {seq} names a successor key that is not an Ed25519 public key"),
            ChainError::UnusableKey => write!(f, "this machine's pinned key is not a valid Ed25519 public key"),
        }
    }
}

/// Where the machine is on its chain, and whose signatures it trusts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainContext<'a> {
    /// The pinned public key, base64. Signatures are checked against this one until a link rotates it.
    pub key: &'a str,
    /// The key id the links must name, when the Remote Link pinned one.
    pub key_id: Option<&'a str>,
    /// Hash of the last link applied; empty when the machine is at the genesis.
    pub head: &'a str,
    /// `seq` of the last link applied; 0 before the genesis.
    pub seq: u64,
}

/// What walking the chain produced.
#[derive(Debug, Clone, PartialEq)]
pub struct Applied {
    /// The policy of the newest link that carried one; `None` when no link in the walk did.
    pub policy: Option<Value>,
    /// The new head, seq and trusted key.
    pub head: String,
    pub seq: u64,
    pub key: String,
    /// The last link asked for the seal to be lifted.
    pub unseal: bool,
    /// How many links were verified in this walk (0 means the machine was already at the tip).
    pub applied: usize,
    /// Every key rotation the walk went through, oldest first, for the audit trail.
    pub rotations: Vec<String>,
}

/// Compact JSON with object keys sorted, which is what `serde_json` writes for a `Value`.
fn canonical(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// The bytes a link's signature covers: the link minus `signature`, canonically.
pub fn canonical_link(link: &Value) -> String {
    let mut value = link.clone();
    if let Some(object) = value.as_object_mut() {
        object.remove("signature");
    }
    canonical(&value)
}

/// The identity of a link: the SHA-256 of its canonical bytes. This is what the next link's
/// `prev` names and what the machine stores as its head.
pub fn link_hash(canonical_bytes: &str) -> String {
    sha256_hex(canonical_bytes.as_bytes())
}

/// The message signed for a link.
pub fn signing_message(canonical_bytes: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(SIGNING_PREFIX.len() + 1 + canonical_bytes.len());
    out.extend_from_slice(SIGNING_PREFIX.as_bytes());
    out.push(b'\n');
    out.extend_from_slice(canonical_bytes.as_bytes());
    out
}

/// Parse a base64 Ed25519 public key.
pub fn parse_key(key: &str) -> Option<VerifyingKey> {
    let bytes = base64_decode(key)?;
    let array: [u8; KEY_BYTES] = bytes.try_into().ok()?;
    VerifyingKey::from_bytes(&array).ok()
}

/// Verify a base64 signature over `message` exactly as given — no prefix is added here, so the
/// caller's message must already carry its own domain separator (a link's does through
/// [`signing_message`], a pack's through `remote::pack_message`).
pub fn verify_detached(key: &VerifyingKey, signature: &str, message: &[u8]) -> Result<(), String> {
    let Some(bytes) = base64_decode(signature) else {
        return Err("the value is not base64".into());
    };
    let array: [u8; SIGNATURE_BYTES] = bytes
        .try_into()
        .map_err(|_| format!("a signature is {SIGNATURE_BYTES} bytes"))?;
    let signature = Signature::from_bytes(&array);
    // `verify_strict` rejects the small-order and non-canonical public keys that make plain
    // `verify` malleable: a signature must be valid under exactly one key.
    key.verify_strict(message, &signature)
        .map_err(|_| "it does not match the key this machine pins".to_string())
}

/// Verify a link's or a Remote Link's signature over its canonical bytes.
pub fn verify_signature(
    key: &VerifyingKey,
    signature: &Signed,
    canonical_bytes: &str,
) -> Result<(), String> {
    if !signature.alg.eq_ignore_ascii_case(SIGNATURE_ALG) {
        return Err(format!(
            "unknown algorithm {:?} (this daemon does {SIGNATURE_ALG})",
            signature.alg
        ));
    }
    verify_detached(key, &signature.value, &signing_message(canonical_bytes))
}

/// Read one link out of its JSON.
fn parse_link(value: &Value) -> Result<Link, ChainError> {
    let object = value
        .as_object()
        .ok_or_else(|| ChainError::Malformed("a link is not an object".into()))?;
    let seq = match object.get("seq") {
        Some(Value::Number(n)) if n.is_u64() => n.as_u64().unwrap_or(0),
        _ => {
            return Err(ChainError::Malformed(
                "\"seq\" must be a non-negative integer".into(),
            ))
        }
    };
    let prev = match object.get("prev") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s))
            if s.is_empty() || (s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())) =>
        {
            s.to_lowercase()
        }
        Some(_) => {
            return Err(ChainError::Malformed(format!(
                "link {seq}: \"prev\" must be a sha-256 hex digest"
            )))
        }
    };
    let issued_at = match object.get("issuedAt") {
        None => String::new(),
        Some(Value::String(s)) if s.chars().count() <= 64 => s.clone(),
        Some(_) => {
            return Err(ChainError::Malformed(format!(
                "link {seq}: \"issuedAt\" must be a short string"
            )))
        }
    };
    let policy = match object.get("policy") {
        None | Some(Value::Null) => None,
        Some(p) if p.is_object() => Some(p.clone()),
        Some(_) => {
            return Err(ChainError::Malformed(format!(
                "link {seq}: \"policy\" must be an object"
            )))
        }
    };
    let next_key = match object.get("nextKey") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            return Err(ChainError::Malformed(format!(
                "link {seq}: \"nextKey\" must be a string"
            )))
        }
    };
    let unseal = match object.get("unseal") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => {
            return Err(ChainError::Malformed(format!(
                "link {seq}: \"unseal\" must be a boolean"
            )))
        }
    };
    let signature: Signed = match object.get("signature") {
        Some(s) => serde_json::from_value(s.clone()).map_err(|e| {
            ChainError::Malformed(format!("link {seq}: \"signature\" is malformed: {e}"))
        })?,
        None => return Err(ChainError::Malformed(format!("link {seq} is not signed"))),
    };
    let canonical_bytes = canonical_link(value);
    Ok(Link {
        seq,
        prev,
        issued_at,
        policy,
        next_key,
        unseal,
        signature,
        hash: link_hash(&canonical_bytes),
        canonical: canonical_bytes,
    })
}

/// Parse a chain file into its links, in file order.
pub fn parse_chain(text: &str) -> Result<Vec<Link>, ChainError> {
    if text.len() > MAX_CHAIN_BYTES {
        return Err(ChainError::TooLarge(text.len()));
    }
    let value: Value =
        serde_json::from_str(text).map_err(|e| ChainError::Malformed(e.to_string()))?;
    let links = match value.get("links") {
        Some(Value::Array(links)) => links.clone(),
        Some(_) => return Err(ChainError::Malformed("\"links\" is not an array".into())),
        // A single link on its own is accepted as a one-link chain: it is what an administrator
        // publishing by hand will reach for, and it walks identically.
        None if value.is_object() => vec![value.clone()],
        None => {
            return Err(ChainError::Malformed(
                "the top level is not an object".into(),
            ))
        }
    };
    if links.is_empty() {
        return Err(ChainError::Empty);
    }
    if links.len() > MAX_LINKS {
        return Err(ChainError::TooManyLinks(links.len()));
    }
    links.iter().map(parse_link).collect()
}

/// Walk a chain from where the machine is to the end, verifying every link on the way.
///
/// Links at or before the machine's head are skipped, not re-verified: the head is the hash of a
/// link the machine already checked, and that hash commits to everything behind it.
pub fn apply(text: &str, ctx: &ChainContext<'_>) -> Result<Applied, ChainError> {
    let links = parse_chain(text)?;
    let mut key = parse_key(ctx.key).ok_or(ChainError::UnusableKey)?;
    let mut key_b64 = ctx.key.to_string();

    // Find where we join. At the genesis that is the first link with no `prev`; otherwise the
    // link whose `prev` is the hash we are holding.
    let start = links
        .iter()
        .position(|l| l.prev == ctx.head)
        .ok_or_else(|| {
            // Already at the tip is not a failure: the last link's own hash being our head means
            // there is simply nothing new.
            ChainError::NoContinuation {
                head: ctx.head.to_string(),
            }
        });
    let start = match start {
        Ok(start) => start,
        Err(e) => {
            if links.iter().any(|l| l.hash == ctx.head) {
                return Ok(Applied {
                    policy: None,
                    head: ctx.head.to_string(),
                    seq: ctx.seq,
                    key: key_b64,
                    unseal: false,
                    applied: 0,
                    rotations: Vec::new(),
                });
            }
            return Err(e);
        }
    };

    let mut head = ctx.head.to_string();
    let mut seq = ctx.seq;
    let mut policy = None;
    let mut unseal = false;
    let mut rotations = Vec::new();
    let mut applied = 0usize;

    for link in &links[start..] {
        let expected = seq + 1;
        if link.seq != expected {
            return Err(ChainError::OutOfOrder {
                seq: link.seq,
                expected,
            });
        }
        if link.prev != head {
            return Err(ChainError::Broken { seq: link.seq });
        }
        if let (Some(expected_id), Some(named)) = (ctx.key_id, link.signature.key_id.as_deref()) {
            if named != expected_id {
                return Err(ChainError::WrongKey {
                    seq: link.seq,
                    named: named.to_string(),
                    expected: expected_id.to_string(),
                });
            }
        }
        verify_signature(&key, &link.signature, &link.canonical)
            .map_err(|why| ChainError::BadSignature { seq: link.seq, why })?;
        // The link is authentic: take what it says.
        if let Some(p) = &link.policy {
            policy = Some(p.clone());
        }
        unseal = link.unseal;
        if let Some(next) = &link.next_key {
            let parsed = parse_key(next).ok_or(ChainError::BadKey { seq: link.seq })?;
            // The rotation is authorised by the key that signed *this* link, which is what keeps
            // the chain verifiable end to end: every handover is itself signed by the outgoing key.
            key = parsed;
            key_b64 = next.clone();
            rotations.push(next.clone());
        }
        head = link.hash.clone();
        seq = link.seq;
        applied += 1;
    }

    Ok(Applied {
        policy,
        head,
        seq,
        key: key_b64,
        unseal,
        applied,
        rotations,
    })
}

/// A **Remote Link**: the base64 blob an administrator hands out, which points a machine at its
/// chain and pins the key that signs it. Self-signed by that key, so a blob mangled or swapped in
/// transit is refused rather than trusted because it arrived in the right paste box.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLink {
    pub version: u32,
    /// Where the chain is published.
    pub url: String,
    /// The Ed25519 public key, base64, that every link must be signed with.
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<u64>,
    /// Free text shown in Settings → System, so a person can see whose link they pasted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_by: Option<String>,
    /// The seal mode this link establishes. `chain` (the default) means there is no local code at
    /// all; `totp` keeps the authenticator app as the way in and uses the chain only for updates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    pub signature: Signed,
}

/// Why a Remote Link was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkError {
    NotBase64,
    Malformed(String),
    BadKey,
    BadSignature(String),
    BadUrl(String),
    BadMode(String),
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LinkError::NotBase64 => write!(f, "that is not a Remote Link: it is not base64"),
            LinkError::Malformed(m) => write!(f, "that is not a Remote Link: {m}"),
            LinkError::BadKey => write!(f, "the key in the link is not an Ed25519 public key"),
            LinkError::BadSignature(m) => {
                write!(f, "the link is not signed by the key it carries: {m}")
            }
            LinkError::BadUrl(m) => write!(f, "{m}"),
            LinkError::BadMode(m) => write!(
                f,
                "the link asks for an unknown mode {m:?} (expected \"chain\" or \"totp\")"
            ),
        }
    }
}

/// Decode and check a pasted Remote Link. The signature must be by the key the link itself
/// carries: that proves the blob arrived intact, not that the key is one you should trust —
/// deciding *that* is the person pasting it, which is why replacing a link is gated.
pub fn parse_remote_link(blob: &str) -> Result<RemoteLink, LinkError> {
    let trimmed: String = blob.trim().chars().filter(|c| !c.is_whitespace()).collect();
    if trimmed.is_empty() {
        return Err(LinkError::NotBase64);
    }
    let bytes = base64_decode(&trimmed).ok_or(LinkError::NotBase64)?;
    let text = String::from_utf8(bytes)
        .map_err(|_| LinkError::Malformed("it does not decode to text".into()))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|e| LinkError::Malformed(e.to_string()))?;
    let link: RemoteLink =
        serde_json::from_value(value.clone()).map_err(|e| LinkError::Malformed(e.to_string()))?;
    if link.version != 1 {
        return Err(LinkError::Malformed(format!(
            "unsupported version {}",
            link.version
        )));
    }
    crate::remote::validate_url(&link.url, "the link's url").map_err(LinkError::BadUrl)?;
    if let Some(mode) = &link.mode {
        if mode != "chain" && mode != "totp" {
            return Err(LinkError::BadMode(mode.clone()));
        }
    }
    let key = parse_key(&link.key).ok_or(LinkError::BadKey)?;
    verify_signature(&key, &link.signature, &canonical_link(&value))
        .map_err(LinkError::BadSignature)?;
    Ok(link)
}

/// The blob for a link: canonical JSON, base64. What an administrator hands out, and what the
/// tests build to paste back in.
#[cfg_attr(not(test), allow(dead_code))]
pub fn encode_remote_link(value: &Value) -> String {
    base64_encode(canonical(value).as_bytes())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use serde_json::json;

    /// A deterministic Ed25519 key pair for the tests, signing exactly as the Node tool does.
    pub struct TestKey {
        signing: ed25519_dalek::SigningKey,
    }

    impl TestKey {
        pub fn from_seed(seed: u8) -> TestKey {
            TestKey {
                signing: ed25519_dalek::SigningKey::from_bytes(&[seed; 32]),
            }
        }

        pub fn public(&self) -> String {
            base64_encode(self.signing.verifying_key().as_bytes())
        }

        /// Sign an arbitrary message — what a pack signature covers.
        pub fn sign_raw(&self, message: &[u8]) -> [u8; SIGNATURE_BYTES] {
            use ed25519_dalek::Signer;
            self.signing.sign(message).to_bytes()
        }

        /// Sign `value` (a link or a Remote Link) and return it with its `signature` member.
        pub fn sign(&self, value: &Value, key_id: Option<&str>) -> Value {
            use ed25519_dalek::Signer;
            let canonical_bytes = canonical_link(value);
            let signature = self.signing.sign(&signing_message(&canonical_bytes));
            let mut out = value.clone();
            out.as_object_mut().unwrap().insert(
                "signature".into(),
                match key_id {
                    Some(id) => json!({ "alg": SIGNATURE_ALG, "value": base64_encode(&signature.to_bytes()), "keyId": id }),
                    None => json!({ "alg": SIGNATURE_ALG, "value": base64_encode(&signature.to_bytes()) }),
                },
            );
            out
        }
    }

    /// Build a chain, linking each hash to the next. `signers[i]` signs `links[i]`, so a test
    /// spells out who signed what rather than inferring it — which is the thing under test when
    /// a key rotates.
    pub fn chain_of(signers: &[&TestKey], links: Vec<Value>) -> (Value, Vec<String>) {
        assert_eq!(signers.len(), links.len(), "one signer per link");
        let mut out = Vec::new();
        let mut hashes = Vec::new();
        let mut prev = String::new();
        for (signer, mut link) in signers.iter().zip(links) {
            link.as_object_mut()
                .unwrap()
                .insert("prev".into(), json!(prev));
            let signed = signer.sign(&link, None);
            let hash = link_hash(&canonical_link(&signed));
            prev = hash.clone();
            hashes.push(hash);
            out.push(signed);
        }
        (json!({ "version": 1, "links": out }), hashes)
    }

    /// The common case: one key signs the whole chain.
    fn signed_by(key: &TestKey, links: Vec<Value>) -> (Value, Vec<String>) {
        let signers = vec![key; links.len()];
        chain_of(&signers, links)
    }

    fn link(seq: u64, managed_by: &str) -> Value {
        json!({ "seq": seq, "issuedAt": "2026-09-16T09:00:00Z", "policy": { "version": 1, "managedBy": managed_by } })
    }

    fn ctx<'a>(key: &'a str, head: &'a str, seq: u64) -> ChainContext<'a> {
        ChainContext {
            key,
            key_id: None,
            head,
            seq,
        }
    }

    #[test]
    fn a_genesis_link_is_applied_and_becomes_the_head() {
        let key = TestKey::from_seed(1);
        let (chain, hashes) = signed_by(&key, vec![link(1, "Acme IT")]);
        let applied = apply(&chain.to_string(), &ctx(&key.public(), "", 0)).unwrap();
        assert_eq!(applied.seq, 1);
        assert_eq!(applied.head, hashes[0]);
        assert_eq!(applied.applied, 1);
        assert_eq!(applied.policy.unwrap()["managedBy"], json!("Acme IT"));
        assert!(!applied.unseal);
        assert_eq!(applied.key, key.public());
    }

    #[test]
    fn a_machine_that_is_behind_walks_the_tail_and_verifies_every_link() {
        let key = TestKey::from_seed(1);
        let (chain, hashes) = signed_by(
            &key,
            vec![
                link(1, "one"),
                link(2, "two"),
                link(3, "three"),
                link(4, "four"),
            ],
        );
        // At the genesis: everything is verified and the last policy wins.
        let all = apply(&chain.to_string(), &ctx(&key.public(), "", 0)).unwrap();
        assert_eq!(all.applied, 4);
        assert_eq!(all.seq, 4);
        assert_eq!(all.policy.unwrap()["managedBy"], json!("four"));
        // Joining in the middle verifies only what came after.
        let some = apply(&chain.to_string(), &ctx(&key.public(), &hashes[1], 2)).unwrap();
        assert_eq!(some.applied, 2);
        assert_eq!(some.head, hashes[3]);
        // Already at the tip: nothing to do, and not an error.
        let none = apply(&chain.to_string(), &ctx(&key.public(), &hashes[3], 4)).unwrap();
        assert_eq!(none.applied, 0);
        assert_eq!(none.head, hashes[3]);
        assert_eq!(none.policy, None);
    }

    #[test]
    fn a_link_signed_by_another_key_is_refused() {
        let key = TestKey::from_seed(1);
        let other = TestKey::from_seed(2);
        let (chain, _) = signed_by(&other, vec![link(1, "Evil Corp")]);
        assert!(matches!(
            apply(&chain.to_string(), &ctx(&key.public(), "", 0)),
            Err(ChainError::BadSignature { seq: 1, .. })
        ));
    }

    #[test]
    fn an_edited_link_is_refused_even_though_the_chain_is_otherwise_intact() {
        let key = TestKey::from_seed(1);
        let (chain, _) = signed_by(&key, vec![link(1, "one"), link(2, "two")]);
        let tampered = chain.to_string().replace("\"two\"", "\"mine now\"");
        assert!(matches!(
            apply(&tampered, &ctx(&key.public(), "", 0)),
            Err(ChainError::BadSignature { seq: 2, .. })
        ));
    }

    #[test]
    fn a_replayed_or_reordered_chain_does_not_apply() {
        let key = TestKey::from_seed(1);
        let (chain, hashes) =
            signed_by(&key, vec![link(1, "one"), link(2, "two"), link(3, "three")]);
        // A machine at link 3 is offered the same file again: nothing new, no error.
        let again = apply(&chain.to_string(), &ctx(&key.public(), &hashes[2], 3)).unwrap();
        assert_eq!(again.applied, 0);
        // A file that stops before the machine's position cannot walk it backwards.
        let (older, _) = signed_by(&key, vec![link(1, "one")]);
        assert!(matches!(
            apply(&older.to_string(), &ctx(&key.public(), &hashes[2], 3)),
            Err(ChainError::NoContinuation { .. })
        ));
        // A link whose `prev` points at something else entirely is not a continuation.
        let forged = json!({ "version": 1, "links": [ key.sign(&json!({ "seq": 4, "prev": "0".repeat(64), "policy": { "version": 1 } }), None) ] });
        assert!(matches!(
            apply(&forged.to_string(), &ctx(&key.public(), &hashes[2], 3)),
            Err(ChainError::NoContinuation { .. })
        ));
    }

    #[test]
    fn a_gap_in_the_middle_of_the_file_is_refused() {
        let key = TestKey::from_seed(1);
        let (chain, _) = signed_by(&key, vec![link(1, "one"), link(2, "two"), link(3, "three")]);
        let mut links = chain["links"].as_array().unwrap().clone();
        links.remove(1);
        let gappy = json!({ "version": 1, "links": links });
        // Link 3's `prev` names link 2, which is no longer there: the walk stops rather than
        // trusting a chain it cannot follow.
        let err = apply(&gappy.to_string(), &ctx(&key.public(), "", 0)).unwrap_err();
        assert!(
            matches!(
                err,
                ChainError::OutOfOrder {
                    seq: 3,
                    expected: 2
                }
            ),
            "{err}"
        );
    }

    #[test]
    fn a_rotation_is_signed_by_the_outgoing_key_and_the_next_link_by_the_new_one() {
        let first = TestKey::from_seed(1);
        let second = TestKey::from_seed(2);
        let mut rotating = link(1, "before");
        rotating
            .as_object_mut()
            .unwrap()
            .insert("nextKey".into(), json!(second.public()));
        // The rotating link is signed by the outgoing key; the one after it by the successor.
        let (chain, _) = chain_of(&[&first, &second], vec![rotating, link(2, "after")]);
        let applied = apply(&chain.to_string(), &ctx(&first.public(), "", 0)).unwrap();
        assert_eq!(
            applied.key,
            second.public(),
            "the machine now trusts the successor"
        );
        assert_eq!(applied.rotations, vec![second.public()]);
        assert_eq!(applied.policy.unwrap()["managedBy"], json!("after"));
        // The successor cannot sign the link that introduces it: that would let a stolen key
        // introduce itself.
        let mut self_introducing = link(1, "before");
        self_introducing
            .as_object_mut()
            .unwrap()
            .insert("nextKey".into(), json!(second.public()));
        let (bad, _) = signed_by(&second, vec![self_introducing]);
        assert!(matches!(
            apply(&bad.to_string(), &ctx(&first.public(), "", 0)),
            Err(ChainError::BadSignature { .. })
        ));
    }

    #[test]
    fn a_link_may_unseal_the_machine_or_leave_the_policy_alone() {
        let key = TestKey::from_seed(1);
        let mut release = json!({ "seq": 2, "issuedAt": "t", "unseal": true });
        release
            .as_object_mut()
            .unwrap()
            .insert("prev".into(), json!(""));
        let (chain, _) = signed_by(&key, vec![link(1, "Acme IT"), release]);
        let applied = apply(&chain.to_string(), &ctx(&key.public(), "", 0)).unwrap();
        assert!(applied.unseal);
        // The release link carried no policy, so the one before it still stands.
        assert_eq!(applied.policy.unwrap()["managedBy"], json!("Acme IT"));
    }

    #[test]
    fn key_ids_are_checked_when_the_machine_pins_one() {
        let key = TestKey::from_seed(1);
        let signed = key.sign(
            &json!({ "seq": 1, "prev": "", "policy": { "version": 1 } }),
            Some("acme-2026"),
        );
        let chain = json!({ "version": 1, "links": [signed] }).to_string();
        let public = key.public();
        let mut c = ctx(&public, "", 0);
        c.key_id = Some("acme-2027");
        assert!(matches!(
            apply(&chain, &c),
            Err(ChainError::WrongKey { .. })
        ));
        c.key_id = Some("acme-2026");
        assert!(apply(&chain, &c).is_ok());
    }

    #[test]
    fn malformed_chains_are_named_not_guessed() {
        let key = TestKey::from_seed(1);
        assert!(matches!(
            parse_chain("not json"),
            Err(ChainError::Malformed(_))
        ));
        assert!(matches!(
            parse_chain(r#"{"version":1,"links":[]}"#),
            Err(ChainError::Empty)
        ));
        assert!(matches!(
            parse_chain(r#"{"version":1,"links":5}"#),
            Err(ChainError::Malformed(_))
        ));
        assert!(matches!(
            parse_chain(&"x".repeat(MAX_CHAIN_BYTES + 1)),
            Err(ChainError::TooLarge(_))
        ));
        // A link without a signature is not a link.
        let unsigned = json!({ "version": 1, "links": [ { "seq": 1, "prev": "", "policy": {} } ] });
        assert!(
            matches!(parse_chain(&unsigned.to_string()), Err(ChainError::Malformed(m)) if m.contains("not signed"))
        );
        // A single link on its own is a one-link chain.
        let single = key.sign(
            &json!({ "seq": 1, "prev": "", "policy": { "version": 1 } }),
            None,
        );
        assert_eq!(parse_chain(&single.to_string()).unwrap().len(), 1);
        // An unusable pinned key is reported rather than treated as a signature failure.
        assert_eq!(
            apply(&single.to_string(), &ctx("not-a-key", "", 0)),
            Err(ChainError::UnusableKey)
        );
    }

    #[test]
    fn a_remote_link_round_trips_and_must_be_signed_by_the_key_it_carries() {
        let key = TestKey::from_seed(7);
        let body = json!({
            "version": 1,
            "url": "https://policies.example.com/chain.json",
            "key": key.public(),
            "keyId": "acme-2026",
            "intervalMinutes": 30,
            "managedBy": "Acme IT",
            "mode": "chain",
        });
        let blob = encode_remote_link(&key.sign(&body, None));
        let link = parse_remote_link(&blob).unwrap();
        assert_eq!(link.url, "https://policies.example.com/chain.json");
        assert_eq!(link.key, key.public());
        assert_eq!(link.mode.as_deref(), Some("chain"));
        assert_eq!(link.managed_by.as_deref(), Some("Acme IT"));
        // Whitespace from a copy and paste is tolerated.
        assert!(parse_remote_link(&format!("  {}\n{}  ", &blob[..10], &blob[10..])).is_ok());

        // Signed by somebody else's key.
        let other = TestKey::from_seed(8);
        let forged = encode_remote_link(&other.sign(&body, None));
        assert!(matches!(
            parse_remote_link(&forged),
            Err(LinkError::BadSignature(_))
        ));
        // Edited after signing.
        let edited = encode_remote_link(&{
            let mut signed = key.sign(&body, None);
            signed
                .as_object_mut()
                .unwrap()
                .insert("url".into(), json!("https://evil.example.com/chain.json"));
            signed
        });
        assert!(matches!(
            parse_remote_link(&edited),
            Err(LinkError::BadSignature(_))
        ));
        // Not base64, not JSON, a plain http url, a bad mode, a key that is not a key.
        assert_eq!(parse_remote_link("!!!!"), Err(LinkError::NotBase64));
        assert!(matches!(
            parse_remote_link(&base64_encode(b"hello")),
            Err(LinkError::Malformed(_))
        ));
        let http = json!({ "version": 1, "url": "http://policies.example.com/c.json", "key": key.public() });
        assert!(matches!(
            parse_remote_link(&encode_remote_link(&key.sign(&http, None))),
            Err(LinkError::BadUrl(_))
        ));
        let bad_mode = json!({ "version": 1, "url": "https://x/c.json", "key": key.public(), "mode": "sideways" });
        assert!(matches!(
            parse_remote_link(&encode_remote_link(&key.sign(&bad_mode, None))),
            Err(LinkError::BadMode(_))
        ));
        let bad_key = json!({ "version": 1, "url": "https://x/c.json", "key": "nope" });
        assert!(matches!(
            parse_remote_link(&encode_remote_link(&key.sign(&bad_key, None))),
            Err(LinkError::BadKey)
        ));
    }

    /// The cross-language contract. `apps/desktop/src/main/system/chain-author.ts` — the app an
    /// administrator actually signs with — produces exactly these bytes for this key and this
    /// link, and its own test pins the same values. If either side's canonicalisation drifts,
    /// every chain an administrator publishes would verify for them and be refused on every
    /// machine, which is the sort of thing that is discovered far too late.
    #[test]
    fn a_link_signed_by_the_app_verifies_here() {
        // The Ed25519 key whose seed is 32 bytes of 0x01.
        let key = TestKey::from_seed(1);
        assert_eq!(key.public(), "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=");
        let link =
            json!({ "seq": 1, "prev": "", "policy": { "version": 1, "managedBy": "Acme IT" } });
        let canonical = canonical_link(&link);
        assert_eq!(
            canonical,
            r#"{"policy":{"managedBy":"Acme IT","version":1},"prev":"","seq":1}"#
        );
        assert_eq!(
            link_hash(&canonical),
            "c0b2270f827b16d302b19afec2713a349c4d4ec02814e6fbbc6fcb3cbd7795e6"
        );
        // The signature the app produced for it, verified by the daemon's own code path.
        let signature = Signed {
            alg: SIGNATURE_ALG.into(),
            value: "9WbRZ75BlBq3uuVzxGROCsK6UuB95mTnoepPKnQ+BwGV+Myw1yS80VJuiE7iX7Yl9LxhhvGQym50Xlexg+8iAw==".into(),
            key_id: None,
        };
        let mut signed = link.clone();
        signed.as_object_mut().unwrap().insert(
            "signature".into(),
            serde_json::to_value(&signature).unwrap(),
        );
        let chain = json!({ "version": 1, "links": [signed] }).to_string();
        let applied = apply(&chain, &ctx(&key.public(), "", 0)).expect("the app's link verifies");
        assert_eq!(applied.seq, 1);
        assert_eq!(
            applied.head,
            "c0b2270f827b16d302b19afec2713a349c4d4ec02814e6fbbc6fcb3cbd7795e6"
        );
        assert_eq!(applied.policy.unwrap()["managedBy"], json!("Acme IT"));
    }

    #[test]
    fn the_canonical_form_does_not_depend_on_key_order() {
        let a: Value =
            serde_json::from_str(r#"{"seq":1,"prev":"","policy":{"version":1,"managedBy":"x"}}"#)
                .unwrap();
        let b: Value =
            serde_json::from_str(r#"{"policy":{"managedBy":"x","version":1},"prev":"","seq":1}"#)
                .unwrap();
        assert_eq!(canonical_link(&a), canonical_link(&b));
        assert_eq!(
            link_hash(&canonical_link(&a)),
            link_hash(&canonical_link(&b))
        );
        // And the `signature` member is never part of what is signed.
        let key = TestKey::from_seed(1);
        assert_eq!(canonical_link(&key.sign(&a, None)), canonical_link(&a));
    }
}
