# Agent instructions: Arrester

Arrester is a Claude Code mod, plugin `arrester`. After a guard blocks a tool call, it stops later calls that reach the same result another way, or that read or change a guard, until the block expires or the user clears it. `README.md` and `docs/usage.md` describe the behavior.

## Install and update

Run these commands from a shell. Each `&&` runs the next step only when the step before it succeeds.

Install with Claude Code 2.1.296 or later. The part after the install turns on auto-update. It runs only when the install succeeds and the marketplace entry exists:

```sh
claude plugin install arrester --marketplace dot-agi/arrester --scope user --json \
  && f="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" \
  && jq -e --arg name arrester '.extraKnownMarketplaces[$name].source' "$f" > /dev/null \
  && tmp=$(mktemp "$f.XXXXXX") \
  && { jq --arg name arrester '.extraKnownMarketplaces[$name].autoUpdate = true' "$f" > "$tmp" && mv "$tmp" "$f" || { rm -f "$tmp"; false; }; }
```

Auto-update runs only in interactive sessions. In a headless job, update at the start, before the session that uses the mod:

```sh
claude plugin update arrester@arrester --json
```

Check the result. The first command prints the installed version. The second prints the latest release:

```sh
claude plugin list --json | jq -r '.[] | select(.id == "arrester@arrester") | "\(.version) enabled=\(.enabled)"' \
  && git ls-remote --tags --refs https://github.com/dot-agi/arrester 'arrester--v*' | sed 's/.*--v//' | sort -V | tail -n 1
```

- New code loads in the next session, or after `/reload-plugins`. An agent cannot type `/reload-plugins`, so start a new session.
- Running `install` again does not update. Use `update`.
- On a host with no SSH key for GitHub, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` in the environment of every `claude` command and session.
- The `mv` replaces the settings file, with mode 600. If `settings.json` is a symbolic link, edit its target instead.

## Layout

| Path | Holds |
| --- | --- |
| `.claude-plugin/plugin.json` | The manifest, the two options, and the state contract path |
| `.claude-plugin/marketplace.json` | The one-plugin marketplace |
| `hooks/hooks.json` | The name of the hooks module, `./register.ts` |
| `hooks/register.ts` | Every hook and every `$` call: block capture, the check of each call, the hold, the status line, `/arrester`, and the diagnostics |
| `hooks/analyze/paths.ts` | Lexical paths, globs, braces, and how an effect's path stands to a protected path |
| `hooks/analyze/lexer.ts` | The shell lexer |
| `hooks/analyze/programs.ts` | The program tables of the shell analysis |
| `hooks/analyze/shell.ts` | The shell walker: effects on paths, retry skeletons, and why some code cannot be read |
| `hooks/analyze/code.ts` | The interpreter code scan |
| `hooks/analyze/call.ts` | A call from each event input, and the analysis of each tool |
| `hooks/analyze/types.ts` | Types the analysis modules share |
| `hooks/journal.ts` | Pure transforms of the session journal: blocks, held calls, decisions, expiry, and targets |
| `hooks/guards.ts` | Guard paths and guard names |
| `hooks/match.ts` | The four matching rules: target, retry, guard, and opaque |
| `hooks/text.ts` | Every text: the reasons Claude reads, the question, transcript lines, the status line, `/arrester`, and the diagnostics |
| `types/index.d.ts` | The journal types and the `PluginState` contract |
| `tests/` | Local test files (`*.test.ts`) for the test kit, and the stubs in `tests/fixtures/`. Git does not track them |

## Commands

- Validate: `claude plugin validate .` (the marketplace) and `claude plugin validate .claude-plugin/plugin.json` (the plugin, its state contract, its hooks, and its `$` calls)
- Test: `claude plugin test .` (it needs at least one `*.test.ts` file under `tests/`)
- Type check: `npx -p typescript tsc -p .` (it needs `.claude-plugin/types/` and `tsconfig.json`; see CONTRIBUTING.md)

Run all of them after each change. All must pass.

## Rules

- Write every `$` call in full in `hooks/register.ts`, inside a hook or a top-level function of that file. Never pass `$` to an imported function, except `read` and `update` from `claude-code`. Never assign `$` or a part of it to a variable. `claude plugin validate` reads `$` calls from source and fails otherwise.
- Use the literal `{ plugin: 'arrester', key: 'journal' }` for `$.state`, and the literal `'HOME'` for `$.env.get`.
- Export every type in `types/index.d.ts`. `claude plugin validate` refuses a contract type without `export`.
- Keep the other modules under `hooks/` pure: no `$` and no I/O. The shell analysis reads a script only through the `readScript` function that it is given.
- Arrester only adds stops. Never allow a call, rewrite a call, answer a call with a result, or loosen a verdict.
- Bound the work of each analysis: count each expansion before it is built, and make the call opaque past a limit.
- Start every diagnostic with `arrester: <event>: `, then the cause.
- Add no network request, model call, process, or file write.
- In tests, stub every tool result, file, and setting. A test never runs a real command.
- Add no export, branch, or option that nothing uses.
- Style: two-space indent, no semicolons, single quotes, a one-line doc comment on each top-level function, named imports, extensionless relative imports, and `import type` for types.
- Keep `README.md` and `docs/usage.md` in step with the behavior.
