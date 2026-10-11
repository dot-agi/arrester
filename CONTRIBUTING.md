# Contributing to Arrester

This guide covers setup, the checks, and how to send a change.

## Setup

1. Install Claude Code 2.1.288 or later, and Node.js for the type check.
2. Clone the repository: `git clone https://github.com/dot-agi/arrester`, then `cd arrester`.
3. Load the mod once with `claude --plugin-dir .`, then quit. Claude Code writes `.claude-plugin/types/` (the mods API types) and `tsconfig.json`. Both are in `.gitignore`.

## Checks

Run all four before you send a change. All four must pass.

```
claude plugin validate .
claude plugin validate .claude-plugin/plugin.json
claude plugin test .
npx -p typescript tsc -p .
```

- `claude plugin validate .` checks the marketplace manifest. `claude plugin validate .claude-plugin/plugin.json` checks the plugin manifest, the state contract, the hooks module, and every `$` call.
- `claude plugin test .` runs the `*.test.ts` files under `tests/` against the engine's own `$`, with stubs for tool results, files, settings, and the clock. The repository does not track tests. Keep yours in a local `tests/` folder, out of your commits. They import `test`, `expect`, and `mock` from `claude-code/testing`, and they can import the pure modules under `hooks/` directly. With no test file, the command stops with `no *.test.ts or *.test.tsx`.
- `tsc` checks the types against `.claude-plugin/types/`.

## Making a change

- Write a failing test first in your local `tests/` folder. Test the shell analysis, the matching rules, the journal, and each user path that the change touches. Then change the code.
- Keep every `$` call in `hooks/register.ts`. AGENTS.md gives the rules.
- Give each new failure path a diagnostic, `arrester: <event>: <cause>`.
- Add no network request, model call, process, or file write.
- Add no export, branch, or option that nothing uses.
- Update `README.md` and `docs/usage.md` when behavior changes.

## Sending a change

1. Fork the repository and create a branch.
2. Make the change and test it locally. Run the four checks.
3. Open a pull request. Say what changed, why, and how you tested it.

To report a bug, give the steps that cause it and the `arrester:` lines from `claude --debug`.
