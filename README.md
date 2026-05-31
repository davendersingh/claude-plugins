<div align="center">

# 🔥 claude-plugins

**A curated [Claude Code](https://claude.com/claude-code) plugin marketplace by [@davendersingh](https://github.com/davendersingh).**

Opinionated, production-grade workflows that turn Claude Code into a disciplined engineering team.

![License: MIT](https://img.shields.io/badge/License-MIT-2ea44f.svg)
![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin%20marketplace-7C3AED)
![plugins](https://img.shields.io/badge/plugins-1-1f6feb)

</div>

---

## Quick start

```bash
/plugin marketplace add davendersingh/claude-plugins   # add this marketplace
/plugin install crucible                               # install a plugin
# restart your session so the plugin loads
```

---

## Plugins

### 🔥 `crucible` — design-for-failure feature pipeline

> Write the spec **first**, prove it **fails**, then make it pass. Ship reviewed, tested code — by an
> **unbiased** team, in one session.

One Claude Code session becomes the **Manager** and orchestrates three **isolated-context** subagents.
The reviewer and tester see only the **diff + spec** — never the implementer's reasoning — so their
judgment can't be biased by how the code was written.

```
 spec ─▶ RED (failing test first) ─▶ GREEN (make it pass) ─▶ review ─▶ QA ─▶ validate ─▶ PR
   │            │                          │                   │        │        │         │
 gate        prove fail                prove pass         diff+spec  AC+diff   local    you merge
                                                           only       only    matrix
```

| | |
|---|---|
| **Unbiased review** | reviewer + tester run in fresh contexts on artifacts, not intentions |
| **Spec-first, enforced** | a fail-open `PreToolUse` hook + RED-gate discipline keep code from outrunning its tests |
| **Two autonomy modes** | gated (pauses at the spec gate, you merge) or `--leader` (drives to a PR) |
| **Single or sprint** | one feature, or a whole dependency DAG with stacked PRs |
| **Repo-agnostic** | auto-detects your test/lint/typecheck/build commands, or reads `crucible.config.json` |

```bash
/plugin install crucible
/crucible "Add password-reset rate limiting"          # gated → opens a PR, you merge
/crucible --leader "Refactor the billing webhook"     # bounded autonomy to a PR
```

📖 [Full docs](./crucible/README.md) · ⚙️ [Example config](./examples/crucible.config.example.json)

---

## Why these plugins

Most AI coding loops let the same context write the code, grade the code, and declare victory — so the
grader is biased and "done" is a vibe. These plugins encode the opposite: **independent verification,
evidence-gated progress, and disciplines that fail loudly** when something is wrong.

## Repository layout

```
.claude-plugin/marketplace.json   # marketplace manifest (lists the plugins)
crucible/                         # the crucible plugin (commands, agents, skills, hooks, engine)
examples/                         # example configs
```

## Contributing / adding a plugin

Each plugin is a self-contained directory with its own `.claude-plugin/plugin.json`. Add the plugin
dir, list it in `.claude-plugin/marketplace.json`, and open a PR. Issues and ideas welcome.

## License

[MIT](./LICENSE) © Davender Singh
