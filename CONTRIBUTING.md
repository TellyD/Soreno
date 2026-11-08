# Contributing to Soreno

Setup: [README](README.md). Repository guidelines (architecture, UI, tests,
commits, security): [AGENTS.md](AGENTS.md).

## Structure

- `src/components/`: React panels; `src/components/ui/`: reusable primitives,
  with colocated CSS and tests.
- `src/hooks/`: orchestration; `src/domain/`: pure rules; `src/data/`: Tauri
  calls; `src/settings/`, `src/theme/`, `src/notifications/`: app-wide providers.
- `src/i18n/locales/`: UI strings; every new string goes in both `en.ts` and
  `fr.ts`.
- `src/mobile/`: mobile web client (`npm run dev:mobile`, `build:mobile`).
- `src-tauri/src/`: `lib.rs` wires up Tauri, `app_state.rs` initializes state,
  `commands/` adapts IPC; the other modules hold business logic and persistence.
- `src-tauri/crates/`: terminal grid emulator, and mobile access (relay, server
  bridge `soreno-remote`, shared protocol).
- `scripts/`: WSL launchers, Windows portable build, relay, release and their
  tests.
- `docs/`: feature notes, [WSL development](docs/development-wsl.md),
  [release](docs/release.md) and changelogs (`docs/changelog/X.Y.Z.{en,fr}.md`).

## Conventions

TypeScript ESM, two spaces; Rust, four spaces. PascalCase for components and
types, camelCase for TypeScript functions and variables, snake_case in Rust. CSS
and TypeScript tests (`*.test.ts`, `*.test.tsx`) live next to the code they
cover; Rust tests go in an adjacent `*_tests.rs` module.

## Checks

```sh
npm test               # Vitest
npm run build          # TypeScript + Vite
npm run format:check   # Prettier on src/
npm run test:scripts   # launchers (sh, Bash, Node; no real Windows) + release self-test
cd src-tauri && cargo test && cargo fmt --check
```

Pick according to scope (see [AGENTS.md](AGENTS.md#checks)).
