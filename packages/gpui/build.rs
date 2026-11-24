use std::{env, fs, path::PathBuf};

const FONTS: &[(&str, &str)] = &[
    ("EBGaramond.woff2", "EBGaramond.ttf"),
    ("EBGaramond-Italic.woff2", "EBGaramond-Italic.ttf"),
    ("Inter.woff2", "Inter.ttf"),
    ("Inter-Italic.woff2", "Inter-Italic.ttf"),
];

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let fonts_dir = manifest_dir.join("../svelte/static/fonts");

    for (source_name, destination_name) in FONTS {
        let source_path = fonts_dir.join(source_name);
        println!("cargo:rerun-if-changed={}", source_path.display());

        let woff2 = fs::read(&source_path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", source_path.display()));
        let ttf = wuff::decompress_woff2(&woff2).unwrap_or_else(|error| {
            panic!("failed to decompress {}: {error:?}", source_path.display())
        });
        fs::write(out_dir.join(destination_name), ttf)
            .unwrap_or_else(|error| panic!("failed to write {destination_name}: {error}"));
    }
}
