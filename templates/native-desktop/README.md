# Native Desktop Template

Native macOS and Linux [GPUI](https://gpui.rs/) desktop app with system light and dark themes, and
shared design tokens and fonts from `packages/gpui`. Application menus are macOS-only; other
platforms use the keyboard shortcuts (`Ctrl+N`, `Ctrl+Q`).

Linux builds require `libfontconfig-dev`, `libxkbcommon-x11-dev`, `libwayland-dev`, and
`libx11-xcb-dev`.

Run from this directory:

```sh
mise install                             # installs cargo-packager (Rust comes from root mise.toml)
cargo run                                # debug build and run
cargo test --workspace --locked          # headless GPUI window and font tests
cargo build --release                    # release binary
cargo packager --release --formats app   # macOS .app bundle in ../../target/packager/ (repo root)
```
