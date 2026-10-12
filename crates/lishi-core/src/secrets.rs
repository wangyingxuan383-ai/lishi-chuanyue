//! Platform-independent secret storage contract. Secrets never implement
//! serialization or cloning, and their debug output is always redacted.

use std::error::Error;
use std::fmt;

use zeroize::Zeroizing;

pub const MAX_SECRET_BYTES: usize = 8192;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SecretSlot(String);

impl SecretSlot {
    pub fn new(value: &str) -> Result<Self, SecretStoreError> {
        if !(1..=64).contains(&value.len())
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err(SecretStoreError::InvalidSlot);
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

pub struct SecretValue(Zeroizing<String>);

impl SecretValue {
    /// Validation preserves the supplied token exactly; it never trims input.
    /// Rejected values are also cleared when the zeroizing wrapper is dropped.
    pub fn new(value: String) -> Result<Self, SecretStoreError> {
        let value = Zeroizing::new(value);
        if !(1..=MAX_SECRET_BYTES).contains(&value.len())
            || value
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
        {
            return Err(SecretStoreError::InvalidSecret);
        }
        Ok(Self(value))
    }

    /// Only trusted internal adapters and provider calls should use this method.
    pub fn expose_secret(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretValue([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretStoreError {
    InvalidSlot,
    InvalidSecret,
    Unavailable,
    Corrupted,
    KeyUnavailable,
    IoError,
}

impl fmt::Display for SecretStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidSlot => "Secret slot is invalid.",
            Self::InvalidSecret => "Secret value is invalid.",
            Self::Unavailable => "Secret store is unavailable.",
            Self::Corrupted => "Protected secret data is invalid.",
            Self::KeyUnavailable => "The platform protection key is unavailable.",
            Self::IoError => "Secret store file operation failed.",
        })
    }
}

impl Error for SecretStoreError {}

pub trait SecretStore: Send + Sync {
    fn save(&self, slot: &SecretSlot, value: &SecretValue) -> Result<(), SecretStoreError>;
    fn load(&self, slot: &SecretSlot) -> Result<Option<SecretValue>, SecretStoreError>;
    fn delete(&self, slot: &SecretSlot) -> Result<(), SecretStoreError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_allow_only_bounded_ascii_identifiers_without_normalization() {
        for identifier in ["model-api", "research_api", "A", "a", &"x".repeat(64)] {
            let slot = SecretSlot::new(identifier).expect("accept valid slot");
            assert_eq!(slot.as_str(), identifier);
        }
        for identifier in [
            "",
            ".",
            "../model",
            "model/api",
            "model\\api",
            "model api",
            "模型",
            &"x".repeat(65),
        ] {
            assert_eq!(
                SecretSlot::new(identifier),
                Err(SecretStoreError::InvalidSlot)
            );
        }
        assert_ne!(SecretSlot::new("A").unwrap(), SecretSlot::new("a").unwrap());
    }

    #[test]
    fn secret_validation_counts_utf8_bytes_and_rejects_whitespace_or_control() {
        let boundary =
            SecretValue::new("x".repeat(MAX_SECRET_BYTES)).expect("accept byte boundary");
        assert_eq!(boundary.expose_secret().len(), MAX_SECRET_BYTES);
        let unicode = SecretValue::new("中".repeat(MAX_SECRET_BYTES / 3))
            .expect("accept Unicode below byte cap");
        assert_eq!(unicode.expose_secret().len(), MAX_SECRET_BYTES - 2);
        for invalid in [
            String::new(),
            "x".repeat(MAX_SECRET_BYTES + 1),
            "中".repeat(MAX_SECRET_BYTES / 3 + 1),
            " leading".into(),
            "trailing ".into(),
            "inter nal".into(),
            "token\tvalue".into(),
            "token\nvalue".into(),
            "token\0value".into(),
            "token\u{a0}value".into(),
            "token\u{7f}value".into(),
        ] {
            assert!(matches!(
                SecretValue::new(invalid),
                Err(SecretStoreError::InvalidSecret)
            ));
        }
    }

    #[test]
    fn debug_and_errors_do_not_disclose_the_secret() {
        let token = "isolated-fake-probe-token";
        let value = SecretValue::new(token.into()).expect("create test secret");
        assert_eq!(format!("{value:?}"), "SecretValue([REDACTED])");
        assert_eq!(value.expose_secret(), token);
        for error in [
            SecretStoreError::InvalidSlot,
            SecretStoreError::InvalidSecret,
            SecretStoreError::Unavailable,
            SecretStoreError::Corrupted,
            SecretStoreError::KeyUnavailable,
            SecretStoreError::IoError,
        ] {
            assert!(!error.to_string().contains(token));
            assert!(error.source().is_none());
        }
    }
}
