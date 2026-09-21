# dsh-superpowers

English | [中文](README.zh.md)

dsh-superpowers adds [obra/superpowers](https://github.com/obra/superpowers) support to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It registers 14 skills for brainstorming, planning, TDD, debugging, and code review, and keeps the `using-superpowers` bootstrap active throughout the session.

## Contents

- [Installation](#installation)
- [What it does](#what-it-does)
- [Verification](#verification)
- [Configuration](#configuration)
- [Limitations](#limitations)
- [Overhead](#overhead)
- [Testing](#testing)
- [Requirements](#requirements)
- [Upstream and license](#upstream-and-license)

## Installation

Add the package to the profile as a local workspace dependency, then restart the surface:

```sh
cd E:/work/ai/dsh-superpowers && npm install   # the config schema is a runtime dependency
dsh plugin --profile web add link:E:/work/ai/dsh-superpowers
```

Stop and restart `dsh web` afterwards. Replace `web` with `headless` or a custom profile name when installing for a different surface, then restart that surface instead.

## What it does

- Registers all 14 Superpowers skills on `ctx.skills`. They appear in the skill catalog and load through the native `skill` tool. Nothing is copied into `~/.dsh/skills`.
- Adds the `using-superpowers` bootstrap as the `superpowers:bootstrap` prompt section at order 50. It is present on the first request and survives context compaction because it is part of the system prompt, not a one-off session message. A preset that owns the whole system prompt replaces it — see [Limitations](#limitations).
- Warns on the first agent of a workspace when a project or preset skill shadows one of the bundled names, naming the copy the model will load instead.
- Maps Claude Code-style tool names such as `Task`, `TodoWrite`, and `Bash`/`Read`/`Write`/`Edit` to their DeepSeek Harness equivalents. The mapping also notes that hooks and slash commands are not available.

## Verification

Check that the plugin is present in the profile:

```sh
dsh --profile web --dump-config
```

The output should contain `id: superpowers` followed by `name: @zfdx123/dsh-superpowers`.

Then start a new session and ask for a feature. The agent should explore first and respond with questions or a design instead of writing code immediately. Its tool calls should include `skill`.

If the bootstrap never arrives, check the session's preset: a preset whose persona owns the complete system prompt is the one case where it is absent by design — see [Limitations](#limitations).

## Configuration

Every field is optional. Override fields in the profile's own `cordis.patch.yml`:

```yaml
- id: superpowers
  config:
    bootstrap: false
```

| Field | Default | Description |
| --- | --- | --- |
| `skills` | `true` | Register the bundled skills on `ctx.skills`. |
| `bootstrap` | `true` | Register the `using-superpowers` prompt section. |
| `toolMapping` | `true` | Append the DeepSeek Harness tool mapping to the bootstrap section. |
| `order` | `50` | Place the bootstrap after the persona prefix (0), before the plan policy (500) and tool guidance (1000+). |

Every field is validated against the plugin's schema before it applies: a misspelled type fails the profile with the offending field named, instead of half-registering the plugin.

Setting `bootstrap: false` keeps the skills discoverable but stops them from self-triggering; the model will use them only when it decides to consult the catalog.

## Limitations

A preset can own the entire system prompt. When the preset's persona declares itself the complete prompt — the bundled `minimal` preset does, with `complete: true` — the prompt registry restores that one section after assembly and drops every other section, including `superpowers:bootstrap`. The drop is silent, and dsh publishes no signal for it: a section's `complete` flag never leaves the registry, and a `system-prompt/assemble` listener cannot append prompt text to a scope that has one. The plugin therefore registers the section and documents the case rather than guessing; `verify/src-02-complete-persona-shadow.mjs` pins the mechanism against the installed dsh.

Under such a preset:

- The bootstrap is not delivered, so the skills never self-trigger. The 14 skills are still registered on `ctx.skills`, but whether the model can reach them is the preset's decision, because the preset also decides which tools exist — `minimal` exposes only the persistent shell, so no `skill` tool is available there either.
- `bootstrap: true` cannot make the section appear, and `bootstrap: false` reports nothing: the section was never going to be delivered.

Use a preset whose persona is not complete to get the bootstrap.

## Overhead

The bootstrap adds roughly 1.1k tokens (4,465 characters) to the system prompt of each request. The section is static and stays within the cached prefix. It is not appended as a new chat message on every turn. Set `bootstrap: false` to keep the skills without the fixed prompt overhead.

## Testing

`npm test` runs the suite through `node --test`. `test/` ships in the published tarball, so the command works from an installed copy as well as from a checkout.

`verify/` holds maintainer-only probes that mount the real dsh service classes. They are not published, and they need a local dsh installation (pass its `package.json` path as the first argument to point at another one):

- `verify/dsh-compat.mjs` — every runtime and packaging contract this plugin depends on.
- `verify/src-01-doc-order-drift.mjs` — the documented prompt-order band against the installed section orders.
- `verify/src-02-complete-persona-shadow.mjs` — the complete-persona drop recorded under [Limitations](#limitations).

## Requirements

- DeepSeek Harness `0.1.0-rc.6` or newer
- Node.js 22.19+ or 24+
- One runtime dependency, `@deepseek-ai/schemastery`, which provides the config schema. A registry install pulls it in; a `link:` install needs `npm install` in the checkout first, or the plugin fails to load. Every other registry is reached through `ctx`.

## Upstream and license

The skills under `skills/` are vendored unmodified from [obra/superpowers](https://github.com/obra/superpowers) v6.3.0 at commit [`b36e082`](https://github.com/obra/superpowers/commit/b36e0829c6d0140e93cfef2ca599b1b07d4a7797). The exact upstream version and commit are recorded in `package.json`.

The optional visual companion in `brainstorming` loads an upstream-hosted logo containing the Superpowers version. It sends no project or prompt content. Set `SUPERPOWERS_DISABLE_TELEMETRY` to a true value to disable it.

Two MIT license notices apply: the adapter is © its contributors under [LICENSE](LICENSE), while the bundled skills are © Jesse Vincent and the Superpowers contributors under [LICENSE.superpowers](LICENSE.superpowers).
