//! vozella-native: the only Rust in the product. Each module wraps one OS capability
//! behind a small N-API surface; the TypeScript side hides it behind ports.

use napi_derive::napi;

pub mod audio;
pub mod dpapi;
pub mod job;
pub mod windows_scan;

/// True when this build can capture audio, and use DPAPI.
#[napi]
pub fn platform_supported() -> bool {
    cfg!(windows)
}
