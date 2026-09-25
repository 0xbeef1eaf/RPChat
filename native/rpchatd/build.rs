//! Compile the IPC guard's BPF LSM program (`src/bpf/ipc_guard.bpf.c`) so `ipcguard.rs` can
//! `include_bytes!` the object.
//!
//! The program is written in C because the Rust BPF target still needs a nightly toolchain and
//! this crate is built on stable. `clang` is the only extra build dependency; the kernel types
//! it needs are hand-written in `src/bpf/vmlinux.h`, so the object does not depend on the
//! building machine's kernel — it is relocated against the *running* kernel's BTF at load time.
//!
//! **A missing `clang` is not a build failure.** It produces an empty object, and a daemon
//! carrying one reports `ipcMediation: "none"` with the reason, the same as a kernel without
//! BPF LSM: the guard's other half still works and the residual list says what is missing.
//! Set `RP_REQUIRE_BPF=1` (CI and the release build do) to turn that into a hard error instead,
//! so a release never ships a daemon that quietly cannot mediate `connect()`.

use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = "src/bpf/ipc_guard.bpf.c";
const HEADER: &str = "src/bpf/vmlinux.h";
const OBJECT: &str = "ipc_guard.bpf.o";

fn main() {
    println!("cargo:rerun-if-changed={SOURCE}");
    println!("cargo:rerun-if-changed={HEADER}");
    println!("cargo:rerun-if-env-changed=CLANG");
    println!("cargo:rerun-if-env-changed=RP_REQUIRE_BPF");

    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR")).join(OBJECT);
    match compile(&out) {
        Ok(()) => {}
        Err(e) => {
            if std::env::var_os("RP_REQUIRE_BPF").is_some_and(|v| v != "0") {
                panic!("RP_REQUIRE_BPF is set and the IPC guard program did not build: {e}");
            }
            println!("cargo:warning=the IPC guard's BPF program was not built ({e}); this daemon will report ipcMediation \"none\"");
            // An empty object rather than no file: `ipcguard.rs` includes it unconditionally and
            // treats an empty one as "this build has no program", which is a state it has to
            // handle anyway (a kernel without BPF LSM reaches the same place).
            std::fs::write(&out, []).expect("cannot write the placeholder BPF object");
        }
    }
}

fn compile(out: &Path) -> Result<(), String> {
    let clang = std::env::var("CLANG").unwrap_or_else(|_| "clang".to_string());
    // `bpf_tracing.h` wants to know the target's register layout. Nothing this program uses
    // touches `PT_REGS_*`, but the header refuses to compile without one of these.
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => "x86",
        Ok("aarch64") => "arm64",
        Ok("riscv64") => "riscv",
        Ok("loongarch64") => "loongarch",
        Ok(other) => return Err(format!("no BPF target arch mapping for {other}")),
        Err(e) => return Err(e.to_string()),
    };
    let output = Command::new(&clang)
        .args([
            "-O2",
            "-g", // BTF, without which there is no CO-RE and the program cannot load
            "-Wall",
            "-Werror",
            "-target",
            "bpf",
            &format!("-D__TARGET_ARCH_{arch}"),
            "-c",
            SOURCE,
            "-o",
        ])
        .arg(out)
        .output()
        .map_err(|e| format!("{clang}: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{clang} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}
