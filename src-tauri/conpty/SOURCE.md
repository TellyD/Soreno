# Microsoft ConPTY redistributable

Unmodified Microsoft binaries, extracted from the official NuGet package
`Microsoft.Windows.Console.ConPTY` **1.24.260710001** (stable).
They stay paired: never update `conpty.dll` without its `OpenConsole.exe`.
The Microsoft MIT license is kept in `LICENSE`; it does not define Soreno's license.

Source: https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/1.24.260710001/microsoft.windows.console.conpty.1.24.260710001.nupkg

Package SHA-256: `175640566a3b59c4b132070ee96c2c77e5ab7edd2e92732a5eb3610bbf63d90e`.

In the NuGet ZIP, for each `x64`, `arm64`, `x86` architecture:
- `runtimes/win-<architecture>/native/conpty.dll` → `<architecture>/conpty.dll`
- `build/native/runtimes/<architecture>/OpenConsole.exe` → `<architecture>/OpenConsole.exe`

| File | SHA-256 |
| --- | --- |
| x64/conpty.dll | `39fba2713e2495117b1591ae8c32a3b904bea7aa66069cf7815e2844c76d75d8` |
| x64/OpenConsole.exe | `b7fd936c2668b87b9ecf7b3366dc6568afc1c6f981874cba3e955a1c35cf8160` |
| arm64/conpty.dll | `db3d173640b172bafd42d5b541b638a9aeec1c7d0e40dd636bf02822a32c912c` |
| arm64/OpenConsole.exe | `ed7622fd0d3bedc9ab9f122f5e58edf0def9e7999224f52dd395ba9f54edbe09` |
| x86/conpty.dll | `11c4d8b3015e593f9f9f6872500bd37a076517cb33092422571c0a28bbd25347` |
| x86/OpenConsole.exe | `7c199ea9db18c2f99e2ec2dc339a0fd4d8441adedf4589a0c7508bb492066c65` |

## Why bundle it

The system ConPTY can forward `CSI ?2026l` before the last characters of a
frame: the terminal then shows an incomplete footer, and moves it when its last
line arrives late. A native Windows/WSL test reproduced 8 incorrect frame ends
out of 8 with the system ConPTY, versus 0 out of 8 with this official pair.
No protocol or Pi setting change is needed.

The package declares Windows 10 build 17763 as the minimum. All three
architectures are shipped to allow offline Windows builds; native validation of
this fix was done on Windows x64, not on x86 or ARM64.

When updating, check the package hash, the Microsoft Authenticode signatures,
the `CreatePseudoConsole`, `ResizePseudoConsole` and `ClosePseudoConsole`
exports, then rerun the native synchronization, input, resize and close tests.
Reference sources are https://github.com/microsoft/terminal and
https://github.com/microsoft/terminal/issues/8698.
