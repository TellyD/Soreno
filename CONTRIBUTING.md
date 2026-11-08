# Contributing to Soreno

Setup: [README](README.md). Repository guidelines (architecture, UI, tests,
commits, security): [AGENTS.md](AGENTS.md).

## Structure

- `src/components/`: React panels; `src/components/ui/`: reusable primitives,
  with colocated CSS and tests.
- `src/hooks/`: orchestration; `src/domain/`: pure rules; `src/data/`: Tauri
  calls.
- `src-tauri/src/`: `lib.rs` wires up Tauri, `app_state.rs` initializes state,
  `commands/` adapts IPC; the other modules hold business logic and persistence.
- `scripts/`: WSL launchers, Windows portable build, relay, release and their
  tests.

## Conventions

TypeScript ESM, two spaces; Rust, four spaces. PascalCase for components and
types, camelCase for TypeScript functions and variables, snake_case in Rust. CSS
and tests (`*.test.ts`, `*.test.tsx`) live next to the code they cover.

## Checks

```sh
npm test               # Vitest
npm run build          # TypeScript + Vite
npm run format:check   # Prettier on src/
npm run test:scripts   # launchers (sh, Bash, Node; no real Windows) + release self-test
cd src-tauri && cargo test && cargo fmt --check
```

Pick according to scope (see [AGENTS.md](AGENTS.md#checks)).
