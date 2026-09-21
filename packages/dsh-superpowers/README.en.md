# @zfdx123/dsh-superpowers

Brings the [obra/superpowers](https://github.com/obra/superpowers) software-development methodology to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): it registers 14 skills on `ctx.skills` (brainstorming, planning, TDD, systematic debugging, code review, and more) and injects the `using-superpowers` bootstrap as a system-prompt section, so it is present from the first request and survives context compaction. The skills are registered at runtime and never written to disk, so nothing is copied into `~/.dsh/skills` and no preset or profile skill directory has to change. This is version 1.0.0, targeting DSH `^0.1.6-alpha.1`.

## Installation

```sh
# The package on its own, from npm
dsh plugin --profile web add @zfdx123/dsh-superpowers

# The whole set (MCP manager, skills manager, memory, CodeGraph, hook ordering, session cleaner, Superpowers)
dsh plugin --profile web add @zfdx123/dsh-atelier

# Local development: install the dependency first — the config schema is a runtime dependency
cd /path/to/dsh-atelier/packages/dsh-superpowers && npm install
dsh plugin --profile web add link:/path/to/dsh-atelier/packages/dsh-superpowers
```

Stop and restart `dsh web` afterwards (bundles are not hot-reloaded). Replace `web` with `headless` or a custom profile name when installing for a different surface, then restart that surface instead.

## Quick start

Check that the plugin is present in the profile:

```sh
dsh --profile web --dump-config
```

The output should contain `id: superpowers` followed by `name: @zfdx123/dsh-superpowers`. Then start a new session and ask for a feature: the agent should explore first and respond with questions or a design instead of writing code immediately, and its tool calls should include `skill`.

If the bootstrap never arrives, check the session's preset — a preset whose persona owns the complete system prompt is the one case where it is absent by design, see [Limitations](#limitations).

## What it does

- Registers all 14 skills on `ctx.skills`. They appear in the skill catalog and load on demand through the native `skill` tool; nothing is ever written to `~/.dsh/skills`.
- Registers `using-superpowers` as the `superpowers:bootstrap` prompt section at order 50: after the persona prefix (0), before the plan policy (500) and the tool guidance (1000+). It is present on the first request and survives context compaction because it is part of the system prompt, not a one-off session message.
- On the first agent of a workspace, warns once when a project or preset skill shadows one of the bundled names, naming the copy the model will actually load (provider, source and path). It reports once because every subagent of a session shares the same composition and would only repeat the warning.
- Maps Claude Code-style tool names onto the DSH tool vocabulary: `Task` → `subagent`, `TodoWrite` → `todo_write`, `Bash`/`Read`/`Write`/`Edit`/`Glob`/`Grep` → their lowercase equivalents, and so on. The mapping also notes that this environment exposes no hook or slash-command API, so an instruction to install a hook or register a command should be carried out with those tools instead.
- Reaches both registries through `ctx` alone (`systemPrompt`, `skills`), so it never depends on a `@deepseek-ai/*` service package resolving from its own directory.

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
| `order` | `50` | Prompt order of the bootstrap section: after the persona prefix (0), before the plan policy (500) and the tool guidance (1000+). |

Every field is validated against the plugin's own schema (`@deepseek-ai/schemastery`) before it applies: a misspelled type fails the profile with the offending field named, instead of half-registering the plugin. With `bootstrap: false` the skills stay discoverable but stop self-triggering — the model uses them only when it decides to consult the catalog. The bootstrap section adds roughly 1.1k tokens (4,465 characters, measured) to the system prompt of each request; the section is static and stays within the cached prefix, and it is never appended as a new chat message on every turn, so `bootstrap: false` is exactly how that fixed prompt overhead is dropped.

## Requirements

- DeepSeek Harness `^0.1.6-alpha.1` (`engines.dsh`)
- Node `^22.19.0 || >=24.0.0`
- The peer `@deepseek-ai/cordis ^4.0.2`, plus the optional peers `@deepseek-ai/dsh-skill` and `@deepseek-ai/dsh-system-prompt` (both `^0.1.6-alpha.1`)
- One runtime dependency, `@deepseek-ai/schemastery` (the config schema): a registry install pulls it in, while a `link:` install needs `npm install` in the checkout first or the plugin fails to load

## Limitations

**A complete-persona preset drops the bootstrap section by design.** A preset can own the entire system prompt: when the preset's persona declares itself the complete prompt — the bundled `minimal` preset does, with `complete: true` — the prompt registry keeps that one section after assembly and drops every other section, including `superpowers:bootstrap`. The drop is silent, and dsh publishes no signal for it: a section's `complete` flag never leaves the registry, and a `system-prompt/assemble` listener cannot append prompt text to a scope that has one. The plugin therefore registers the section and documents the case rather than guessing.

Under such a preset:

- The bootstrap is not delivered, so the skills never self-trigger. The 14 skills are still registered on `ctx.skills`, but whether the model can reach them is the preset's decision, because the preset also decides which tools exist — `minimal` exposes only the persistent shell, so no `skill` tool is available there either.
- `bootstrap: true` cannot make the section appear, and `bootstrap: false` reports nothing: the section was never going to be delivered.

Use a preset whose persona is not complete to get the bootstrap. The limitation is pinned by an executable probe: `verify/src-02-complete-persona-shadow.mjs` mounts the real `SystemPrompt`, `SkillRegistry` and scope machinery, applies this plugin exactly as the loader does, and asserts that a scope with a complete persona delivers that section alone and that no `system-prompt/assemble` listener can put the text back; if the mechanism ever changes, the probe fails and says the documentation is stale.

## Testing

```sh
npm test                                         # node --test
node verify/dsh-compat.mjs                       # runtime and packaging contracts
node verify/src-01-doc-order-drift.mjs           # the documented order band vs the installed section orders
node verify/src-02-complete-persona-shadow.mjs   # the complete-persona mechanism above
```

`test/` ships in the published tarball, so `npm test` works from an installed copy as well as from a checkout. `verify/` holds maintainer-only probes: they are not published, and they need a local dsh installation (each takes another dsh's `package.json` path as its first argument; `src-01` takes the plugin root as its first instead).

## License

The skills under `skills/` are vendored unmodified from [obra/superpowers](https://github.com/obra/superpowers) v6.3.0 at commit [`b36e082`](https://github.com/obra/superpowers/commit/b36e0829c6d0140e93cfef2ca599b1b07d4a7797). The exact upstream version, commit and repository are recorded in `package.json`'s `superpowers` field. The optional visual companion in `brainstorming` loads an upstream-hosted logo containing the Superpowers version; it sends no project or prompt content. Set `SUPERPOWERS_DISABLE_TELEMETRY` to a true value to disable it.

Two MIT license notices apply: the adapter is © its contributors under [LICENSE](LICENSE), while the bundled skills are © Jesse Vincent and the Superpowers contributors under [LICENSE.superpowers](LICENSE.superpowers). The Chinese `README.md` is this package's primary document; this file is its English mirror.
