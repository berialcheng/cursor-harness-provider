fn main() {
    let protoc = protoc_bin_vendored::protoc_bin_path().expect("vendored protoc");
    std::env::set_var("PROTOC", protoc);
    // A cached build-script binary may outlive a moved checkout. Cargo supplies
    // the current manifest directory at execution time; do not bake in a path.
    let manifest = std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory");
    let root = std::path::Path::new(&manifest).join("../..");
    let include = root.join("vendor/pi-cursor/proto");
    let proto = include.join("agent.proto");
    println!("cargo:rerun-if-changed={}", proto.display());
    prost_build::Config::new()
        .compile_protos(
            &[proto],
            &[
                include,
                protoc_bin_vendored::include_path().expect("protoc includes"),
            ],
        )
        .expect("Cursor protobuf generation");
}
