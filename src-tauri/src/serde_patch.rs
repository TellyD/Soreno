use serde::{Deserialize, Deserializer};

/// Patch field: absent stays `None`, `null` becomes `Some(None)`, a value `Some(Some(value))`.
pub(crate) fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
