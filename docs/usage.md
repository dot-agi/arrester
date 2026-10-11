# Using Arrester

This guide covers what opens a block, how Arrester checks calls, what you and Claude see, the options, the `/arrester` command, and the diagnostics.

Works with Claude Code 2.1.288 and later.

## What opens a block

| Guard | How Arrester sees it |
| --- | --- |
| A `PreToolUse` hook outside managed settings | The `classic.PreToolUse` event returns a deny. Where the settings hook events skip installed mods (see below), the tool's error text `PreToolUse:<Tool> hook error: [<hook>]: <reason>`, which a hook that exits with code 2 leaves. |
| A deny rule | The `tool.check` verdict is `deny` and names the rule. |
| The auto mode classifier | The `classic.PermissionDenied` event, or the error text `Permission for this action was denied by the Claude Code auto mode classifier. Reason: <reason>. If you have other tasks …`. Arrester keeps the reason only, up to `. If you have other tasks`. A denial without a classifier verdict opens no block. |
| You | The error text that starts `The user doesn't want to proceed with this tool use.` |

One blocked call opens one block, with an id such as `b1`. The block keeps the paths that the call would have touched, the strongest access to each (`destroy`, then `write`, then `read`), and a skeleton of the command with its flags. A recursive read or listing gives no path, because Arrester cannot know which file the guard objected to.

With managed settings on the machine, or with a Team or Enterprise sign-in, the settings hook events skip installed mods. There Arrester sees a hook block only in the error text. A hook that denies with JSON leaves only its own reason, so Arrester opens no block for it; use exit code 2 for hooks outside managed settings. Managed-settings hook denials end before Arrester runs and cannot be captured this way.

`/clear`, `/resume`, and `/branch` start a new conversation. Arrester's record goes with the old one: every block closes, the decisions are gone, and the next block is `b1` again.

## How a later call is checked

While at least one block is open, each tool call is analyzed before it runs. Arrester reads shell commands without running them: it follows `cd` as if it succeeds, variables set in the same command, `~` and `$HOME`, globs, comma braces such as `{a,b}`, symbolic links made in the same command, pipelines, `xargs`, `find -exec` and `-execdir`, `sh -c`, `bash -c`, `zsh -c`, `eval`, and heredocs, including inside `$(…)`. It reads `env -S` strings, honors `env -C`, and removes the runner prefixes `npx`, `bunx`, `pnpm exec`, `uv run`, and `poetry run`. Scripts and interpreter one-liners receive a best-effort scan; the known limits below apply.

Arrester judges a script by when it last changed. When a readable script changed after the oldest open block opened, or the same command writes its known text, Arrester scans it. Recognized effects count; unreadable code usually makes the call opaque. This scan has the script limits listed below. A script that changed before then is part of your setup, such as a virtual environment's `activate` or a plugin's helper: what a shell script of that age does still counts, but code in it that Arrester cannot read does not, and an interpreter script of that age is not scanned. A newer script that an older script runs is still checked as a newer script.

A call matches a block by one of four rules:

| Rule | A match |
| --- | --- |
| Target | Deletion matches any related blocked path. A write matches the same path for any blocked access, or an enclosing recursive write when the blocked access was a write. Reads match read blocks only. A write inside a folder whose deletion was blocked passes. The rule sees only the paths that a call names: a recursive search that names no folder, such as `rg pattern`, records no read, and a copy or link into a folder records a write to the folder only. A block from your own "No" is never matched this way. |
| Retry | The call repeats the blocked command with changed or added flags, or in another order, or holds the one command that the block had. For guard blocks, a retry that only drops flags passes, as does a Bash call that stays in the sandbox after a blocked call that left it. Your own "No" matches only the same command text, working folder, and relevant tool arguments. |
| Guard | The call reads or changes a user or project settings file, a regular file that a configured hook names by an absolute path, or Arrester's own folder; it changes an installed plugin; or it runs `claude` with `--settings`, `--bare`, `--safe-mode`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, or `--permission-mode bypassPermissions`, or runs `claude plugin disable`, `claude plugin uninstall`, or `claude plugin configure … --values-stdin`. These `claude` arguments count as written or through a value that Arrester resolves; an argument that does not resolve is not checked. Before `plugin`, Arrester skips each argument that can be an option or an option's value, so `claude --model opus plugin disable` counts. A search that only passes over guards, such as `grep -r` on the project, and a read of a plugin's skills do not count. Running or sourcing a guard script, such as `bash -v /guards/check.sh` or `. /guards/check.sh`, does not count as a read of it. |
| Opaque | The call runs code that Arrester cannot read: decoded or downloaded text piped to a shell, code or a program name whose value cannot be resolved, a deletion target that does not resolve, a script that cannot be read or is too long, code nested more than three levels deep, a command that names too many paths, an over-limit definite file operand, or exhausted path-comparison work. |

The fixed settings guards are `~/.claude/settings.json` and the project’s `.claude/settings.json` and `.claude/settings.local.json`. Hook commands contribute regular files that they name by an absolute path, confirmed by a file lookup. Their working folders and unknown file types add no guard. Arrester expands `~`, `$HOME`, and `$CLAUDE_PROJECT_DIR` in a hook command; a hook with `args` gets only `$CLAUDE_PROJECT_DIR`. A relative path, such as `python3 .claude/hooks/guard.py`, adds no guard. Write `python3 "$CLAUDE_PROJECT_DIR"/.claude/hooks/guard.py` to guard that file. Quoted hook file names keep their spaces. A filename alone never makes a guard: fixtures named `managed-settings.json` or placed in `managed-settings.d` remain ordinary files unless a configured hook names them.

Arrester applies temporary prefix assignments and `env` overrides to the child command only. It does not keep a prefix assignment before `export` or another special built-in command, which some shells keep; see [Known limits](#known-limits). Child shells inherit exported variables, including when their code comes from a quoted heredoc. An assigned `HOME` stays exported until `unset` or `export -n` removes that status. Tilde paths and argumentless `cd` use the current shell’s tracked `HOME`. `env -S` resumes option parsing after splitting its string. Directory options keep their written order. The last `env -C` or `--chdir` wins, relative to that `env` invocation’s starting directory. `xargs` preserves replacement lines, default quoting, and explicit delimiters.

Consecutive assignments resolve in shell order, while command arguments use the values from before those assignments. Known `true` and `false` results, including through `eval` and pipeline negation with `!`, select the appropriate `&&`, `||`, or `if` branch. Unknown results retain both possible variable values. Scalar `+=` assignments append to tracked values. Literal `read` input binds named variables, including with `-r`, custom field separators, and heredocs. Successive reads consume successive records; separate input redirections keep separate positions. `printf -v` assigns supported literal string formats without producing output. A valid, supported assignment selects the success branch. Inactive branches and function definitions produce no effects. An executed `exit` or `exec` with a command stops later commands in that shell. The replacement command still counts. A child shell’s termination leaves its parent running. Known results from shell argument code, heredocs, and literal pipelines select the parent’s conditional branch. Assignments in a piped group or background command list stay out of the parent shell. Statically inactive `while` and `until` bodies and empty `for` bodies produce no effects. `unset`, `env -u`, and `env -i` remove tracked values. `env -S` keeps globs and braces literal. An exported variable with uncertain values makes the split string opaque; a known empty value stays empty.

`xargs -J` keeps ordinary word splitting and inserts arguments at the first standalone marker. Later markers and markers inside longer arguments stay literal. `xargs -I` checks each input item separately; `-n` preserves argument batches, and `-L` preserves logical-line batches. Blank input lines do not consume a line batch. Trailing blanks continue a logical line. Explicit delimiters, including NUL, preserve empty records between delimiters. `-r` and `--no-run-if-empty` suppress empty invocations. `-E` and `--eof` stop ordinary input at the given marker; explicit delimiters disable this marker. `find -exec` and `-execdir` distinguish separate calls ending in `\;` from batches ending in `+`. Find replacements retain their relative spelling; `-execdir` uses `./` names in the selected folder. All preceding conjunctive `-name` predicates must match the same candidate name. They and `-type f` narrow the affected paths, including through shell arguments and `xargs`. `-mindepth` and `-maxdepth` limit selected entries, including through shell arguments and `xargs`. Recursive commands can still affect contents below a selected directory. A selected regular file does not imply changes to descendants. Paths embedded into executable code remain unresolved when their selection cannot be preserved. Output from `find -exec` is unknown; it is not assumed to contain selected paths. Actions such as `-delete` suppress default path output.

Find predicate arguments remain data, even when they spell actions such as `-delete` or `-exec`. In a conjunction, `-false` suppresses later actions and their output.

Shell argument code inherits pipeline and heredoc input. `printf` keeps every data argument after its format, including values beginning with a dash. Unquoted `$@` and `$*` preserve positional order, with splitting and globbing inside each argument. With no positional parameters, quoted `"$@"` adds no argument; adjacent text and explicit empty quotes remain. Literal heredoc output can supply a variable through command substitution. Heredocs retain their final newline, and here-strings add one. Command substitution removes trailing newlines. Quoted `$*` joins arguments using the first character of `IFS`, the shell’s field separator; quoted `$@` keeps arguments separate. Numeric parameters include `${10}` and later arguments. Literal `shift` counts and `set --` update positional parameters without changing `$0`. Conditional changes retain possible values at each position. If argument counts differ, later use of the argument list is opaque until a literal `set --` replaces it. Unrelated commands remain readable.

Glob matching compares every path segment and preserves quoted wildcard characters. Standard character classes such as `[[:lower:]]` use ASCII (the basic 128-character set). Wildcards exclude leading dots unless the segment begins with a literal dot. Git retry identities include the resolved repository folder. For an unlink, real-path placement resolves the parent folder and preserves the final link entry.

Zsh `**/` matches zero or more directory levels within a bounded comparison. Ordinary `*` stays within one directory level. Find name predicates can match leading dots. Zsh scalar expansions stay whole and keep wildcard characters literal. Other shells split unquoted expansions on the tracked `IFS` characters. Unset `IFS` uses spaces, tabs, and newlines; empty `IFS` disables splitting. Conditional `IFS` values remain alternatives for splitting and quoted `$*` joining.

`git rm -n` and `git rm --dry-run` preview segments add no deletion or guard-retry finding. Surrounding commands, substitutions, and redirections still count. An identical preview that the user rejected still matches.

Shell syntax-check mode (`-n` or `-o noexec`) produces no effects from executing its code. Enabling `set -n` or `set -o noexec` inside noninteractive shell code suppresses subsequent commands in that shell. Substitutions and redirections evaluated by the outer shell still count. GitHub issue and pull request `--body` and `--title` values, including their short forms, remain data. `--body-file` and `-F` read local files unless their value is `-` for standard input. The words after `shuf -e` or `--echo` are data, not files. Its `-o` file still counts as a write, and its `--random-source` file as a read.

A bare `-` ends option parsing in `sh`, `bash`, `dash`, `ksh`, and `zsh`; a following operand still names a script. Without one, the shell reads stdin. Fish uses `-` as its stdin script operand. Unknown expansions in executable heredocs are opaque; unknown data-only heredocs stay data. A heredoc ends at the line that matches its delimiter as written, with only the quotes removed, so `<<${EOF}` ends at `${EOF}`. Any quoted part of the delimiter, as in `<<"$EOF"`, keeps the body literal. Redirections open from left to right before the command runs. Their paths keep the original directory, and output follows descriptor copies.

Interpreter scans associate path literals and access kinds with each recognized file operation. Ordinary filenames keep wildcard characters literal; recognized glob calls expand patterns. Tildes in interpreter path literals remain literal and resolve relative to the current folder. Printing a path alone adds no file effect; a file read nested inside a print call still counts. A copy call reads its source and writes its other paths. In a Python `shutil` copy, such as `shutil.copy`, the `src=` and `dst=` keywords name the source and the destination. Otherwise the source is the first argument. In other calls, such as `fs.copyFileSync`, `src = …` is an assignment, so the source stays the first argument. `fs.cpSync` reads its first argument and writes its second. In its later arguments, such as its options, only a nested file operation counts. A file operation on `Path(…)`, such as `.read_text()` or `.unlink()`, decides the access of that path, also inside another call, and also after `.resolve()`, `.absolute()`, or `.expanduser()`. A method that changes the path, such as `.with_name()` or `.joinpath()`, makes the original path count as a read, whatever follows it and whatever call is around it. When no method follows `Path(…)`, the path keeps the access of the call around it. So does a path that ends with `.resolve()`, `.absolute()`, or `.expanduser()`. When the path goes on after them, as in `.resolve().parent`, it counts as a read. When a method follows `Path(…)` directly, a path in the arguments of that method and of the methods after it, such as `'.x'` in `Path(…).with_suffix('.x')`, takes no write or deletion from the call around them. After a method that changes the path or after `.resolve()`, such a path counts as a read. A file operation, as one of those methods or inside their arguments, keeps its own access. `Path(…).open` writes when its first argument or its `mode=` value is a literal write mode.

A re-entered check cannot call the engine. It passes through when the cached block state is empty and refuses when blocks remain or their state is unknown. Ordinary checks still read session state.

The guard and opaque rules name the newest open block that is not a "No" of yours, and they do not apply while every open block is one.

A block that a target or retry match names is renewed: its `block_minutes` start again. A guard or opaque match alone renews no block.

## What you and Claude see

| Surface | What shows |
| --- | --- |
| The tool result | With `response: deny`, the reason that Claude reads (below). |
| The transcript | One dim line for each stop and each answered hold, such as `arrester: stopped Bash in agent a1b2: rm -r -- /w/d (workaround of b1: …)`. Claude does not read these lines. |
| The status line | `arrester: 1 open block`, or `arrester: 2 open blocks · 1 held`, while blocks are open. |
| The question dialog | With `response: hold`, the question below, with the options `Deny` and `Allow once`. |
| `/arrester` | The open blocks, the held calls, and the last ten decisions. |

The reason that Claude reads:

```
Arrester stopped this call. It looks like a workaround of a call that a guard blocked.
Blocked: b2, settings hook, 3 min ago: Bash `rm -rf /w/d`. Reason: <the guard's reason>
Match: it deletes or discards /w/d/sub, which is inside /w/d (blocked: destroy).
Do not try another way to get the same result. Stop, tell the user what was blocked and why, and wait for their instructions. The user can close this block with /arrester clear b2.
```

The question in hold mode:

```
Arrester held a Bash call in the main session. It may get the same result as block b2 (settings hook, 3 min ago: rm -rf /w/d).
Call: rm -r -- /w/d
Why: it deletes or discards /w/d (blocked: destroy).
Allow this call once?
```

The exact answer `Allow once`, selected or typed, runs the call through every guard again. A guard can still refuse it. `Deny`, any other typed answer, a dismissed dialog, and a `claude -p` run refuse the call.

## Options

| Option | Values | Default | What it does |
| --- | --- | --- | --- |
| `response` | `deny`, `hold` | `deny` | What Arrester does with a workaround. |
| `block_minutes` | 1 to 1440 | 30 | How long a block stays open after it opened or after the last retry or target match. |

A change in `/config` reloads the mod with the new values. A reload keeps the open blocks and drops the record of the calls that were held; the transcript names each one. Do not change the options while a hold dialog is open: Claude Code then decides what happens to the held call.

## The /arrester command

Claude Code adds `arrester:` before command results, transcript notices, and the status line. The table below shows command text before that prefix. Model-facing reasons and debug-only diagnostics retain their own names.

| Input | Result |
| --- | --- |
| `/arrester`, `/arrester status` | The status text. |
| `/arrester history [1-5]` | Shows ten retained decisions per page, newest page first, with clipped detail. |
| `/arrester clear` | Closes every open block: `Closed 2 blocks.` |
| `/arrester clear b2` | Closes block b2: `Closed block b2.` or `No open block b2.` |
| anything else | `Usage: /arrester, /arrester history [1-5], /arrester clear, or /arrester clear <id>` |

`/arrester` runs at once, even while Claude works. `clear` works only from your own prompt, Remote Control, or an SDK host; any other origin gets `/arrester clear needs the user at the prompt; this request came from <origin>.` An SDK host is the desktop app, the VS Code panel, `claude -p`, or a program of your own on the Agent SDK, and Arrester trusts it.

## In claude -p, the desktop app, and VS Code

- `claude -p`: blocks open and `deny` works as usual. `hold` refuses, because nobody can answer. Transcript lines reach the host as `ui_log` messages.
- The desktop app and the VS Code panel run the session as an SDK host. The deny reason in the tool result always shows, and the dialog works. The status line and the transcript lines may not show; use `/arrester`.

## Diagnostics

Each displayed diagnostic starts with `arrester: <event>:`. The host supplies the name on transcript rows. Lines marked "debug" go to the debug log only (`claude --debug`).

| Line | Meaning | What Arrester does |
| --- | --- | --- |
| `tool.call: could not check <tool> (…); refused it because 1 block is open` | The check failed while blocks were open. | Refuses the call. |
| `tool.call: could not check <tool> (…); refused it because the open blocks could not be read (…)` | Both the check and the fallback block-count read failed. The diagnostic includes both causes. | Refuses the call. |
| `tool.call: hook failed (…); no block was open, so the call went on` (debug) | The check failed and no block was open. | Lets the call run. |
| `<event>: could not record the block for <tool> (…); workarounds of it will not be caught` | A block could not be saved. | The guard's verdict stands. |
| `<event>: could not read <source> settings (…); hook files named there are not guarded` (debug) | A settings source could not be read. | The block opens without those hook files. |
| `<event>: could not read the script <path> (…)` (debug) | A script exists but is no regular file or cannot be read. | Treats the call as opaque, unless the script changed before the open blocks. |
| `<event>: could not resolve <path> (…); compared as written` (debug) | The file system refused a lookup. | Compares the path as written. |
| `command.run: /arrester failed (…)` | `/arrester` failed. | Prints the line. |
| `session.start: could not register /arrester (…)` | The command could not be added. | Keeps checking calls. |
| `<event>: could not refresh the status line (…)` (debug) | The status line could not be redrawn. | Tries again at the next change. |
| `tool.call: the hold got no answer (…); the call was refused` (debug) | The question was dismissed or could not be asked. | Refuses the call. |
| `classic.PermissionDenied: no classifier verdict (…); no block opened` (debug) | Auto mode refused without a verdict. | Opens no block. |
| `<event>: HOME is not set; ~ paths do not resolve; shell deletions may be stopped as unreadable` (debug) | `HOME` is not set. | Drops unresolved paths from target matching. An unresolved shell deletion is opaque and stops while a non-user block is open. |
| `tool.call: could not save the <action> record for <tool> (…); /arrester and the status line may not show it` | A stop or a hold could not be saved. | The stop, or your answer, stands. |
| `tool.call: <path> changed before the open blocks, so code in it that Arrester cannot read (…) was not counted` (debug) | An older script holds code that Arrester cannot read. | Lets that code pass. |
| `<event>: incomplete capture (…); some targets may be missing` | The blocked call exceeded an analysis limit or contained unreadable code. | Keeps the analyzed targets and reports the missing coverage. |
| `session.start: a reload ended the hold of <tool>: <call> (held for <ids>); Arrester did not decide that call` | The mod reloaded while a call was held. | Drops the held record. |

## Known limits

Arrester catches common retries after a block. It is not a sandbox and cannot recognize every shell rewrite.

Most of these limits apply while a block from a hook, deny rule, or auto mode classifier is open. In hold mode, `Allow once` still runs every guard. In deny mode, inspect the call and its block with `/arrester`; clear that specific block only if you intend to end its protection.

- **Pipeline failures (`pipefail`):** With `bash -o pipefail` or `set -o pipefail`, Arrester uses only the last pipeline command's result. It can miss a protected read after `||`, or falsely stop an `&&` branch that Bash would skip. Check these branches yourself and ask Claude to use explicit paths in separate calls after you approve the intended work.
- **Input inherited by command substitutions:** When `$(cat)` reads a path from the surrounding shell's heredoc, Arrester loses that input. A later read through the assigned variable can pass without an Arrester stop or warning. Ask Claude to state the path explicitly so you and the guards can check the intended read.
- **Command-substitution assignments:** Arrester loses the success or failure result of an assignment such as `p=$(true)` or `p=$(false)`. It can falsely stop a protected action after `||` or `&&` that the shell would skip. Inspect the conditional branch before choosing `Allow once` in hold mode.
- **Exit on failure (`errexit`):** With `bash -e` or `set -e`, Arrester can still check commands after a failure that would end the shell. It can falsely stop a later deletion that Bash would never run. Confirm that the failure exits the shell in that context before choosing `Allow once` in hold mode.
- **Pathname text helpers:** While a read block is open, `basename` or `dirname` on the protected path can trigger a false stop. On a guard file, they can also trigger a guard-file stop, although they only transform pathname text. Check that the whole call only handles text before choosing `Allow once` in hold mode.
- **Searches that name no folder:** A recursive search with no folder operand, such as `rg pattern`, `grep -r pattern`, `ag pattern`, or a Grep call without `path`, searches the current folder. Arrester records no read for it, so it can read a file under a read block in that folder without a stop or a warning. The same search with the folder named, such as `rg pattern /work`, stops. Ask Claude to name the search folder, and check searches without one yourself while a read block is open.
- **Copies into a folder:** When the destination of a copy or link is a folder, such as in `cp /work/staging/secret /work/` or `cp -t /work /work/staging/secret`, Arrester records a write to the folder only. It does not record the file that the copy makes there, so the copy can replace a file under a write or deletion block without a stop or a warning. Under a deletion block, a move or a recursive copy into the folder also passes. A destination that names the file, such as `/work/secret`, stops. Ask Claude to name the destination file, and check copies into the folder of a protected file yourself.
- **Running or sourcing a script:** Running or sourcing a script does not count as a read of the script file. Arrester checks the commands inside the script instead. So `bash -v /guards/check.sh`, which prints a guard script's text, and `. /guards/check.sh` pass without a guard stop. A script under a read block can be printed the same way without a target stop. `cat /guards/check.sh` and `bash -n /guards/check.sh` still stop. Check calls that run or source a guard script or a protected script yourself, especially with `-v` or `-x`.
- **Failed folder changes:** Arrester assumes that every `cd` or `pushd` succeeds. When the folder does not exist, the shell stays where it was, but Arrester resolves later relative paths in the missing folder. In `/work`, with `/work/secret` under a read block, `cd /missing || head secret` and `cd /missing; head secret` read `/work/secret` without a stop or a warning. A write or a deletion of `secret` there passes the same way. Ask Claude to use absolute paths after a `cd` that can fail, and check relative paths in such fallbacks yourself.
- **Prefix assignments that the shell keeps:** Arrester treats an assignment written before a command, such as `p=/work/secret export p`, as temporary. Some shells keep it. Bash keeps it before `export p` or `readonly p`, and `sh`, `dash`, and `ksh` keep it before any special built-in command, such as `export`, `eval`, `set`, or `:`. Arrester then does not know the value. With `/work/secret` under a read block, `sh -c 'p=/work/secret export p; head "$p"'` reads the file without a stop or a warning. A deletion through `$p` still stops as opaque. Ask Claude to write `export p=/work/secret`, or `p=/work/secret; export p`, which Arrester follows.
- **Relative names with a colon:** Arrester treats a command operand with a colon before its first slash as a remote target, such as `host:path` or a URL, and checks no file for it. So a relative file name such as `2026-10-11:notes.txt` or `dir:x/file` gets no check as an operand. In `/work`, with `/work/2026-10-11:notes.txt` under a block, `head 2026-10-11:notes.txt`, `cp /a 2026-10-11:notes.txt`, and `rm 2026-10-11:notes.txt` pass without a stop or a warning. A redirection such as `< 2026-10-11:notes.txt`, the name with `./`, and the absolute path still stop. Ask Claude to write such names with `./` or as absolute paths, and check colon names in shell commands yourself.
- **Repeated brace groups:** Arrester counts every word that brace expansion makes before it removes repeats. A word whose braces make more than 256 words is opaque, even when every word names the same path. For example, `cat /work/` followed by nine `{s,s}` groups makes 512 words that all name `/work/sssssssss`. While a block from a hook, rule, or classifier is open, such a call stops with the reason `the call names too many paths to read`. Ask Claude to write the path without repeated brace groups, or to split the call.

- A blocked recursive read or listing, such as `grep -r` or a Grep or Glob call, records no target, so the target rule never matches its block.
- Arrester reads paths only from Bash, Monitor, Read, Write, Edit, NotebookEdit, LSP, Grep, Glob, SendFile, and SendUserFile calls. A call of any other tool, such as an MCP tool, gives no paths, so the target and guard rules cannot match it.
- Your "No" matches only an identical call: the same command text, working folder, and relevant tool arguments. A command that differs by one character goes on to your guards. Tool input past the serialization limits gets no exact identity, so your "No" on such a call matches no retry.
- Managed-settings hook denials end before installed mods run, so Arrester cannot observe them. With managed settings on the machine, or with a Team or Enterprise sign-in, a hook that denies with JSON opens no block; a hook that blocks with exit code 2 does.
- An auto mode denial without a classifier verdict, such as when the classifier is unavailable, opens no block.
- Arrester reads a hook's deny when the denied call ends. It keeps this record for at most 64 tool calls in progress at once, in the main session and its subagents together. A call is in progress from its PreToolUse hooks until it ends, so long-running calls count. If 64 calls that started later are in progress before a denied call ends, Arrester drops the record of the denied call. A deny from a JSON hook or from another mod then opens no block; a hook that blocks with exit code 2 still opens one.
- The settings API does not give the locations of managed settings or a `--settings` file, so Arrester does not guard them.
- A hook file path must be absolute after Arrester expands `~`, `$HOME`, and `$CLAUDE_PROJECT_DIR`; a hook with `args` gets only `$CLAUDE_PROJECT_DIR`. A relative path, such as `python3 .claude/hooks/guard.py`, adds no guard. Write `python3 "$CLAUDE_PROJECT_DIR"/.claude/hooks/guard.py` to guard that file.
- Arrester drops the arguments of `source` and `.`, and it ignores shebang options. A script that the same command writes and then runs under another spelling, such as through a new link, can escape. A script path with a glob is opaque.
- An interpreter script that last changed before the oldest open block is not scanned, so it can read or change a blocked file without a stop. In an older shell script, code that Arrester cannot read does not count, including code past the command-length or nesting limit. At capture, every script read from disk counts as older, so a block on an interpreter script on disk records no targets from inside it.
- Arrester folds `..` as text before it resolves symbolic links. With `/work/link` pointing to `/outside/child`, `head /work/link/../secret` reads `/outside/secret`, but Arrester checks `/work/secret`, so a block on `/outside/secret` does not stop it. A relative `..` path after `cd` into a link has the same gap. A link that the same command makes is followed one step only, so a chain of new links can escape.
- Arrester compares letter case exactly. A glob after `shopt -s nocaseglob` or zsh `unsetopt CASE_GLOB` is the exception: it ignores case in every folder of its path, so in Bash, which keeps folder names case-sensitive, it can cause a false stop. On a file system that ignores case, such as the macOS default, `cat /work/SECRET` reads `/work/secret` without a stop or a warning. Check paths that differ from a blocked path only in letter case yourself.
- Brace expansion covers comma lists such as `{a,b}` only. A range such as `{1..3}` or `{a..c}` stays literal, so a path written with one can pass without a stop or a warning.
- Parameter operators such as `${p:-default}`, `${p#prefix}`, and `${#p}` are not resolved, and neither is command output that Arrester cannot know, such as `$(cat list)` or decoded text. Only a deletion whose target does not resolve is opaque. A read or a write of a path that does not resolve adds no effect, so it passes without a stop or a warning.
- Arrester skips the commands inside an arithmetic expansion `$((…))` or a parameter operator, not only their values. With `/work/secret` under a read block, `printf '%s\n' "$(( $(cat /work/secret) ))"` and `printf '%s\n' "${p:-$(cat /work/secret)}"` read the file without a stop or a warning. A deletion there, such as `x="${p:-$(rm /work/secret)}"`, passes the same way and is not opaque. A plain `$(cat /work/secret)` stops.
- A nested `claude` command can use other settings or perform work from a plain-language request, and it does not inherit the open blocks. Only the guard-changing flags and plugin commands listed above are recognized, and only in arguments that Arrester can resolve. A flag or subcommand that comes from a file, from unknown command output, or from a parameter operator such as `${mode:-bypassPermissions}` passes without a guard stop. So can a `plugin` subcommand after an argument that does not resolve.
- Interpreter code can compute paths, use bare file names or names with spaces, or hide literals behind comments and template expressions. The scan recognizes common file operations but does not interpret functions or computed values. Some functions imported under a bare name are not recognized, such as `copy` after `from shutil import copy`. It does not skip comments, so a file call in a comment can cause a false stop. In a chain of methods on `Path(…)`, Arrester stops following the chain at a subscript such as `[0]`, at grouping parentheses, or at a parenthesis inside a string argument. A path after that point can take the write or deletion of the call around it, so while a block is open a call such as `os.remove(Path('/w/d').read_text().split()[0].strip('/w/e'))` can stop although it does not touch `/w/e`.
- Arrester does not read the command of a `trap`. With `/work/secret` under a read block, `trap 'cat /work/secret' EXIT` passes without a stop or a warning, and the shell runs `cat /work/secret` when it exits. A handler for a signal, such as `INT`, passes the same way.
- Aliases, shell functions, unlisted runners, and unlisted program options can escape detection. Examples include `su -c`, `pipenv run`, `uvx`, file-valued `base64` and `sort` flags, `sed -Ei`, and `curl --data-urlencode name@file`.
- Compiled programs, remote commands, network targets, and Windows paths are outside detection.
- Loop bodies are scanned once with every possible value. `break`, `continue`, and changes in later iterations are not simulated, so a value that `break` skips can cause a false stop.
- Glob options that the shell already has when the command starts, glob options that Arrester does not track, and locale-specific character classes are unknown to Arrester. A glob that depends on them can pass without a stop or cause a false stop.
- In `find`, only `-name`, `-type f`, `-mindepth`, `-maxdepth`, and `-false` narrow the entries that an action reaches. Arrester ignores other tests, such as `-path` or `-iname`, and keeps the narrowing of the supported ones. With `!`, `-not`, `-o`, `,`, parentheses, or `-prune` before the action, it keeps only the depth bounds and drops `-name`, `-type f`, and `-false`, so it assumes that the action can reach every entry within those depths. These forms can cause a false stop.
- In code that `find -execdir` runs for an entry below a start path, `..` paths, a relative `cd`, a relative script, and `{}` inside a longer word, such as `x{}` or `{}.bak`, are opaque. `./{}` names the found entry and is checked like `{}`.
- `find` output that names entries below a start path and reaches `xargs` is opaque when `xargs` splits on another delimiter, such as `-print0` without `xargs -0`, or would split one found name into several words.
- When the file system refuses a lookup, Arrester compares the path as written and does not follow a link there.
- Past a limit in the [limits table](#limits), a call is opaque. It then stops while a block from a hook, rule, or classifier is open, even when it is safe. Examples are a file operand over 4,096 characters, more than 256 distinct path effects, and a glob comparison that exhausts its work budget.
- At most 50 blocks stay open. A new block past that closes the oldest one early; a transcript notice and the status name it.
- Arrester keeps the last 50 decisions. `/arrester` shows the last ten, each detail on one line of at most 600 characters. `/arrester history [1-5]` shows them ten per page, each clipped to 160 characters.
- A block keeps at most 256 flags per set and 65,536 bytes of flags in all. Past that, a retry with changed flags may not match; an identical retry still does. The transcript reports the overflow.

## Limits

| Item | Limit |
| --- | --- |
| Open blocks | 50; the oldest closes first, with a loss-of-protection notice. Status retains the latest eviction. |
| Paths kept per block | 256 distinct targets, matching the effect ceiling. Incomplete analysis is reported at capture and in `/arrester`. Status shows up to 32 abbreviated targets per block and counts the remainder. |
| Exact retry identity | A 71-byte SHA-256 digest of complete syntax-preserving input and context within serialization limits. |
| Input serialization | 64 nesting levels, 16,384 traversal entries, and 4,000,000 text-work units. Exhaustion makes the call opaque and omits its exact identity. |
| Flags kept per block and per command in it | 256 per set; 65,536 UTF-8 bytes total. Overflow is explicit and disables fuzzy retry matching for incomplete sets. |
| Command read | 100,000 characters, for a command and for each shell script; a longer one is opaque, or not counted inside an older script. |
| Script read | A regular file of at most 262,144 bytes; a longer one is opaque unless it changed before the open blocks, and a device or a pipe is not read. |
| Nesting of shell code, command substitutions, scripts, `xargs`, and `find -exec` | 3 levels; deeper code is opaque, or not counted inside an older script. |
| Compound shell syntax | 32 nested command lists or function headers; deeper syntax is opaque. |
| Values of one word, and of one call | 256 distinct alternatives and 16,384 resolved values; equivalent alternatives of variables and substitutions are deduplicated before products and joins. Past either, the call is opaque. |
| Words from brace expansion | 256 per word, counted before repeats are removed. Past it, the call is opaque, even when every word names the same path. |
| Paths that one call touches | 256 distinct effects; access, recursion, entry removal, glob, and selection remain separate. File lists scan at most 16,384 entries and 4,000,000 characters. |
| Effect paths placed per checked call (real-path lookups) | Every retained distinct path and entry mode, up to 256 effects; eight placements in flight. Repeated placements share a call-local result. |
| Tool calls in progress whose hook deny Arrester can read | 64 at once; past it the oldest record goes. A dropped record of a call that a JSON hook or another mod denied opens no block. |
| Captured call ids kept after clear or expiry | The most recent 100; an open block also prevents duplicate capture. |
| Expanded text | 100,000 characters per value; 4,000,000 work units per analysis for text and copies. Past a limit, the call is opaque. |
| Path length | 4,096 characters; longer definite file operands are explicitly opaque. This is an analysis limit, not a filesystem guarantee. |
| Glob comparisons | 65,536 work units per comparison; total comparison work is capped. Exhaustion is explicit uncertainty and can stop a call while a non-user block is open. |
| Decisions kept | 50; `/arrester` shows the last 10, each detail on one line of at most 600 characters. `/arrester history [1-5]` shows ten per page, clipped to 160 characters each. |
