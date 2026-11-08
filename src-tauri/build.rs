use std::{io, path::Path};

fn copy_if_changed(source: &Path, destination: &Path) -> io::Result<()> {
    let contents = std::fs::read(source)?;
    if std::fs::read(destination).is_ok_and(|existing| existing == contents) {
        return Ok(());
    }
    std::fs::create_dir_all(
        destination
            .parent()
            .expect("ConPTY destination has a parent"),
    )?;
    std::fs::write(destination, contents).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "cannot update {} from {} (the running app may be locking it): {error}",
                destination.display(),
                source.display()
            ),
        )
    })
}

fn copy_conpty_test_resources(out_dir: &Path) -> io::Result<()> {
    let profile_dir = out_dir.ancestors().nth(3).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("unexpected Cargo OUT_DIR: {}", out_dir.display()),
        )
    })?;
    let source = Path::new("conpty");
    let files = [
        "LICENSE",
        "SOURCE.md",
        "x64/conpty.dll",
        "x64/OpenConsole.exe",
        "arm64/conpty.dll",
        "arm64/OpenConsole.exe",
        "x86/conpty.dll",
        "x86/OpenConsole.exe",
    ];
    let destination = profile_dir.join("deps").join("conpty");
    for file in files {
        copy_if_changed(&source.join(file), &destination.join(file))?;
    }
    Ok(())
}

fn main() {
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=icons/icon.png");

    tauri_build::build();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let out_dir = std::env::var_os("OUT_DIR").expect("Cargo must set OUT_DIR");
        copy_conpty_test_resources(Path::new(&out_dir))
            .expect("failed to copy packaged ConPTY test resources");
    }
}
