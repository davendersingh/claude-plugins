# Crucible — Validation discovery

Crucible validates a change against **the repo's own commands** at the RED, GREEN, and COMMIT gates.
It learns those commands two ways, in priority order:

1. **`crucible.config.json`** at the repo root (if present) — explicit, authoritative.
2. **Auto-detection** — inferred from the repo's manifests when there is no config.

The Manager prints the resolved commands and (in gated mode) confirms them before the first run.

> CI is not a safety net. CI may skip slow suites, be disabled for a target, or not exist. Crucible
> runs the **full local matrix** for every touched target at the COMMIT gate and treats fresh local
> output as the source of truth.

---

## 1. `crucible.config.json` (explicit, wins)

```jsonc
{
  "branchPrefix": "feat",                 // default "feat"
  "prTarget": "main",                     // default "main"
  "stateDir": ".crucible",                // runtime state dir (git-ignore it)
  "artifactsDir": "docs/crucible",        // where spec/story/plan/test-story/review land
  "implGlobs": ["src/", "lib/", "app/"],  // repo-relative prefixes the spec-first hook treats as
                                          //   "implementation" (blocked during RED). Default below.
  "validation": {
    "<target>": {                         // one entry per app/package/module ("." for single-package repos)
      "dir": ".",                         // where to run the commands (repo-relative)
      "testOne":   "<cmd with {file} placeholder>",
      "testAll":   "<cmd>",
      "lint":      "<cmd>",
      "typecheck": "<cmd>",
      "build":     "<cmd>"
    }
  }
}
```

Any field may be omitted; omit a command to skip that check for that target. `{file}` in `testOne`
is replaced with the spec/test path. See the marketplace `examples/` for a worked config.

`implGlobs` default (when unset): `["src/", "lib/", "app/", "apps/", "internal/", "pkg/", "cmd/"]`.

---

## 2. Auto-detection (when there is no config)

Detect each target from its manifest and use conventional commands. Prefer a manifest's own scripts
when they exist (e.g. a `test` / `lint` / `typecheck` / `build` script in `package.json`).

| Ecosystem | Detect | test (all) | test (one) | lint | typecheck | build |
|-----------|--------|-----------|-----------|------|-----------|-------|
| **Node/TS** | `package.json` | pkg `test` script / `npm test` | `npm test -- {file}` | `npm run lint` / eslint | `npm run typecheck` / `tsc --noEmit` | `npm run build` |
| **Bun** | `bun.lockb` | `bun run test` / `bun test` | `bun run test {file}` | pkg `lint` (biome/eslint) | pkg `typecheck` / `tsc --noEmit` | pkg `build` |
| **Ruby** | `Gemfile` + `.rspec` | `bundle exec rspec` | `bundle exec rspec {file}` | `bundle exec rubocop` (or `bin/rubocop`) | — | — |
| **Python** | `pyproject.toml` / `pytest.ini` | `pytest` | `pytest {file}` | `ruff check` / `flake8` | `mypy .` | — |
| **Go** | `go.mod` | `go test ./...` | `go test {pkg}` | `go vet ./...` / `golangci-lint run` | (compile) | `go build ./...` |
| **Rust** | `Cargo.toml` | `cargo test` | `cargo test {name}` | `cargo clippy` | (compile) | `cargo build` |

Monorepos: detect per workspace/package (e.g. one entry per `package.json` under a workspace root, or
per app directory) and validate only the targets a story touches.

Caveats worth surfacing to the human when detected:
- A build that **ignores** type/lint errors (e.g. a framework flag) → run the typecheck/lint step
  explicitly; don't rely on the build.
- A test job **disabled in CI** → the local run is the only signal; treat it as mandatory.

---

## 3. Test-vs-implementation classification (spec-first hook)

A path is a **spec/test** path (always editable, even during RED) if it matches any of:
`spec/`, `/specs/`, `/tests/`, `/__tests__/`, `*.test.[jt]sx?`, `*.spec.[jt]sx?`, `*_spec.rb`,
`*_test.rb`, `*_test.go`, `test_*.py`, `*_test.py`, `jest.*config.js`, `vitest*config.*`.

A path is **implementation** (blocked while phase ∈ intake|plan|red) if it is under one of the
`implGlobs` prefixes (config, or the default set) and is **not** a spec/test path. Everything else
(docs, config, the artifacts dir, the state dir) is always editable. The hook is **fail-open** — see
`scripts/hooks/crucible-spec-first-guard.sh`.
