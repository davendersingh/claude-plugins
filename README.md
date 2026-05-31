# claude-plugins

A personal [Claude Code](https://claude.com/claude-code) plugin marketplace by
[@davendersingh](https://github.com/davendersingh).

## Add the marketplace

```bash
/plugin marketplace add davendersingh/claude-plugins
```

Then install any plugin below and restart your session so it loads.

## Plugins

### 🔥 crucible — design-for-failure feature pipeline

One Claude Code session orchestrates an **isolated-context subagent team** (manager / senior /
reviewer / tester) through a **spec-first RED→GREEN→review→QA→validate→PR** pipeline. Reviewer and
tester see only the diff + spec — never the implementer's reasoning — so review is unbiased. Gated or
leader autonomy; single feature or sprint batch. Repo-agnostic (auto-detects your test/lint/build
commands, or read them from `crucible.config.json`).

```bash
/plugin install crucible
/crucible "Add password-reset rate limiting"
```

Docs: [`crucible/README.md`](./crucible/README.md) · example config:
[`examples/crucible.config.example.json`](./examples/crucible.config.example.json)

## Layout

```
.claude-plugin/marketplace.json   # marketplace manifest (lists the plugins)
crucible/                         # the crucible plugin
examples/                         # example configs
```

## License

[MIT](./LICENSE)
