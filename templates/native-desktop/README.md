# Native Desktop Template

Native macOS and Linux [GPUI](https://gpui.rs/) desktop app with system light and dark themes,
shared design tokens and fonts from `packages/gpui`, and standard application menus.

Run from the repo root:

```sh
mise install                                                   # installs Rust and cargo-packager
cargo run -p native-desktop                                    # debug build and run
cargo test --workspace --locked                                # headless GPUI window and font tests
cargo build -p native-desktop --release                        # release binary
cargo packager -p native-desktop --release                     # package .app into target/packager/
```
