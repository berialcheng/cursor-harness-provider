#![deny(clippy::unwrap_used)]
#[allow(clippy::large_enum_variant)] // prost-generated wire enums; do not rewrite schema types.
pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/agent.v1.rs"));
}
pub mod engine;
pub mod journal;
pub mod protocol;
pub mod transport;
pub mod types;

pub use engine::{Engine, RunningStream};
