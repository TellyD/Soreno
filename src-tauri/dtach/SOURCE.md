# dtach 0.9

Soreno bundles four `dtach` executables and deploys them to the SSH user's
cache. `dtach` remains a separate program, licensed under
GPL-2.0-or-later; its license is kept in `LICENSE`.

## Modification

`soreno-history.patch` modifies `master.c`: the master keeps the last MiB of the
program's output, even with no client, and replays it to every client that
attaches, wrapped in `ESC ] 5379 ; dtach-history-begin BEL` and
`ESC ] 5379 ; dtach-history-end BEL`. If the oldest output was dropped, the
replay starts at a line end and is preceded by the terminal modes (alternate
screen, mouse, bracketed paste, cursor…) still active. This lets Soreno rebuild
the history and screen of a reattached terminal, including what was displayed
while no client was connected.

Official source:
https://downloads.sourceforge.net/project/dtach/dtach/0.9/dtach-0.9.tar.gz

Source archive SHA-256:
`32e9fd6923c553c443fab4ec9c1f95d83fa47b771e6e1dafb018c567291492f3`

The corresponding source archive is included in `source/dtach-0.9.tar.gz`.
The binaries are rebuilt by `build.sh`, which applies the patch, with
Zig 0.14.1; from a Soreno installation, set `OUTPUT_DIR` to a writable folder.
The script pins the build date and uses static musl targets on Linux and
macOS 11 as the minimum version.

| Target | SHA-256 |
| --- | --- |
| `bin/linux-x86_64/dtach` | `a6b972cd858daf760401d76abb16c8cd11a65b32e15f2b3bb30533a8943943ab` |
| `bin/linux-aarch64/dtach` | `4da19a3b2b3b13459e833b21377e5abd3f2c4ea1c7ee3118a0ba831364345465` |
| `bin/macos-x86_64/dtach` | `f6e73b5196cb0177090a97223dd719221a9e7f96024fc3091da9e96d06ef71ba` |
| `bin/macos-arm64/dtach` | `6e83f66653dc9e47d2d9137bc17ee49a47db9ba5f44b8a4c629c509d8ce6ef74` |
