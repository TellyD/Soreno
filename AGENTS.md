# Repository guidelines

Soreno: Tauri 2 desktop app (React/TypeScript, Rust, SQLite) for notes and a workspace for CLI agents. Windows, macOS and Linux are first-class targets.

## Architecture

- Respect the layers, with no feature-first migration or Rust rewrite without a concrete need: `src/domain/` pure logic, `src/hooks/` orchestration, `src/data/` Tauri calls, `src/components/` panels, `src/components/ui/` canonical primitives. On the Rust side, `commands/` adapts IPC and the domain modules own persistence.
- Do not reintroduce shadcn scaffolding or a `button.tsx` alongside `Button.tsx`.
- The agent terminal is emulated in Rust (`src-tauri/crates/soreno-terminal-grid`); do not reintroduce a JavaScript emulator.
- Do not hand-edit generated output, including the Tauri schemas in `src-tauri/gen/`.
- Do not add a dependency when existing code is enough; UI icons via `lucide-react`, file type icons via `material-icon-theme` (`FileIcon`), no custom SVGs.

## Comments

Comment sparingly. No comment or doc comment that paraphrases the code, a function name or the context of the change. Keep them for non-obvious constraints (platform workaround, invariant, surprising choice), in one short line.

## UI

- Follow the conventions of existing views: typography, spacing, colors, borders, interactive states. No new local visual treatment without an explicit need, in particular no extra border or accent for an active state already shown by a background. Keep keyboard focus indicators.
- No `box-shadow`: use `outline`, `border`, a background or a structural indicator.
- Lucide icon size stays controllable through the `size` prop. The global `svg` CSS uses `width: var(--icon-size, auto); height: var(--icon-size, auto);`, with no other fallback. Set `--icon-size` only on a container that explicitly makes its icons uniform. In `Button`, `Input` and `Menu`, use their dedicated variables rather than a conflicting `size` prop.

## Checks

- Scale checks to the change: no full build, Rust tests, dev server, cross-platform matrix or localhost HTTP probe without a reason. Briefly mention a heavy check deliberately skipped.
- Local CSS tweak: review the diff, without `npm test`, build or Vite, unless TypeScript or shared logic is touched, a regression is likely or the user asks for it.
- Server reported ready by Vite/Tauri: no confirmation `HEAD`/`GET`, except to diagnose access.
- Command known to be blocked by the sandbox: run it directly with the required permission, or explain why it is skipped.
- Before submitting: `npm test`; `cargo test` from `src-tauri/` if Rust tests are added.
- Large Rust test module: move it to an adjacent `*_tests.rs` via `#[cfg(test)]` and `#[path]`, without making an API public to test it.

## Writing tests

- A permanent test must catch a plausible user-visible bug: behavior, boundaries, invariants, state transitions, precedence, errors, races, persistence, security. A bug fix keeps a test that failed before, when practical.
- Do not test: source code or CSS text; plain argument forwarding to a mock or a mock's return value; constants, defaults or serde derive output; CSS classes, icons, DOM structure or order, exact labels or exact delays; a path already covered elsewhere. Prefer roles, accessible states and observable effects.
- Test pure logic directly, with small data; a single integration case is enough to prove a component is wired. No full render per case of a matrix.
- Extend an existing test or case table before creating a new one. A one-off check goes in a throwaway script, not a permanent test.
- Synchronize async code with controlled promises, fake timers or explicit rendezvous, not `sleep` or duration thresholds.
- Clean up mocks with `vi.resetAllMocks()` then `vi.restoreAllMocks()`: since Vitest 4, `restoreAllMocks` alone no longer resets `vi.fn`.
- A test that breaks on a legitimate change because it pins an implementation detail is deleted or rewritten around behavior, never re-pinned.

## Commits and pull requests

- Never create a commit without an explicit request. A formatting instruction or a plan step is not permission.
- Pull request: user-visible change, commands run, database or Tauri capability changes, screenshots for UI.

## Communication

Address the user in their language. Review, fix and verification reports list the files touched and the commands actually run.

Do not estimate work in time (hours, days): the agent writes the code. Describe the scope instead (files and layers touched, what already exists, hard parts and risks).

## Security and platforms

- Do not commit local data, SQLite databases and their sidecars, `.env`, logs or machine-specific settings.
- Soreno is MIT-licensed: check a third-party component's license and rights before adding it, and keep its notices.
- Only widen Tauri capabilities when the feature requires it, and document it in the pull request.
- No direct dependency on PowerShell, `cmd.exe`, AppleScript, a specific shell, hard-coded OS paths or a single-platform API, except behind a small abstraction with tested Windows, macOS and Linux alternatives. Prefer Tauri plugins, the Rust standard library and cross-platform crates.
