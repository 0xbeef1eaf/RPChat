fn main() {
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_PATH");
    pkg_config::Config::new()
        .atleast_version("0.6")
        .probe("gtk-layer-shell-0")
        .expect("gtk-layer-shell-0 >= 0.6 is required to build rp-overlay-wlr");
}
