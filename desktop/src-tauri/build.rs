fn main() {
    println!("cargo:rerun-if-changed=../../public");
    tauri_build::build()
}
