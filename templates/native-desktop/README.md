# Native Desktop Template

Native macOS and Linux [GPUI](https://gpui.rs/) desktop app with system light and dark themes, and
shared design tokens, fonts, and components from `packages/gpui`. Application menus are macOS-only;
other platforms use the keyboard shortcuts (`Ctrl+N`, `Ctrl+Q`).

Linux builds require `libfontconfig-dev` and `libxkbcommon-x11-dev`.

Run from this directory:

```sh
mise install                             # installs cargo-packager (Rust comes from root mise.toml)
cargo run                                # debug build and run
cargo test --workspace --locked          # headless GPUI window, font, and component tests
cargo build --release                    # release binary
cargo packager --release --formats app   # macOS .app bundle in ../../target/packager/ (repo root)
```
