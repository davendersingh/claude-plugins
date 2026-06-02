# Browser testing in QA (`browser` config)

Status: implemented 2026-06-02.

## What it adds

QA (the `crucible:tester` role) normally runs the repo's unit/integration suite + adversarial tests
and maps each acceptance criterion to observed output. With a `browser` config block, the Tester does
an **additional browser pass** for UI features — *additive*, never a replacement.

## Configuration

```jsonc
// crucible.config.json
"browser": {
  "enabled": true,
  "runner": "mcp",                          // "playwright" | "cypress" | "custom" | "mcp"
  "command": "npx playwright test {file}",  // command-runners only ({file} = the spec to run)
  "specDir": "e2e",                         // where E2E specs are written/found (command-runners)
  "startCommand": "npm run dev",            // optional: boot the app before the pass
  "url": "http://localhost:3000",           // base URL under test
  "appliesWhen": "ui",                      // "ui" (auto: diff touches uiGlobs) | "always"
  "uiGlobs": ["apps/web/", "app/", "components/"]
}
```
CLI overrides: `--browser` / `--no-browser`. Default = **disabled** (opt-in).

## When it runs

The Manager triggers the browser pass when: `browser.enabled` (or `--browser`) **and** not
`--no-browser` **and** (`appliesWhen == "always"` **or** the diff touches a `uiGlobs` path).

## Runner modes

| `runner` | behavior | best for |
|----------|----------|----------|
| `playwright` / `cypress` / `custom` | the Tester writes an E2E spec under `specDir` for each user-visible AC, then runs `command` (`{file}` substituted) via Bash; captures pass/fail + artifacts | repos that already have an E2E suite |
| `mcp` | the Tester boots the app (`startCommand`), waits for `url`, then drives a **live browser via the Playwright MCP** — navigate / click / fill / snapshot / screenshot — asserting each UI AC against the rendered page | repos with **no** E2E suite (e.g. Jest-only) |

The Tester carries the Playwright MCP tool patterns + `ToolSearch` in its tool list, so `mcp` mode
works when a Playwright MCP is connected.

## Gate & isolation

- Browser failures are **blocking** bugs (same QA gate); they loop to the Senior and are re-verified on
  fresh evidence.
- Anti-bias is unchanged: the Tester still sees only the AC + diff + run commands, never the
  implementer's reasoning or the reviewer's verdict.
- Each browser check is recorded in the test-story: *step → expected → observed + screenshot path*.

## Graceful skip

If `runner: mcp` but no Playwright MCP is connected, or the app `url` is unreachable after
`startCommand`, the Tester returns `browser: skipped (<reason>)` and the Manager surfaces it. **QA is
never blocked on missing browser tooling** — the unit/integration suite still gates as usual.

## Requirements

- `mcp` runner: a Playwright MCP connected to the session (e.g. the `playwright` plugin), plus a way to
  reach the app (`startCommand` + `url`, or an already-running server).
- command runners: the repo's E2E runner installed (`@playwright/test`, `cypress`, …).

## Notes / limits

- Live-browser (`mcp`) verification needs the app actually reachable — dev server up, plus any auth /
  seed data the flow requires. It is powerful but inherently more best-effort than a committed E2E
  suite; treat flakes as signal to add a proper E2E test.
- v1 runs the browser pass during **QA** (verification). Writing the E2E spec RED-first during the
  Senior's RED phase (full design-for-failure for UI) is a natural future extension.
