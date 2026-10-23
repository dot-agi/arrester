// The shell analysis: what a command line does to which paths,
// the retry skeleton of each command, and why some of it cannot be read.
// Pure apart from io.readScript; it never runs anything.

import { scanCode } from './code'
import type { Dialect } from './code'
import { heredocWord, lex, spellingOf, TOO_LONG, UNPARSED, unknownSource, wordText } from './lexer'
import type { Part, Redirect, Token, Word } from './lexer'
import { absolute, basenameOf, dirnameOf, expandBraces, globMatch, hasGlob, isRemote, joinPath, looksLikePath, MAX_PATH, PATH_TOO_LONG, selectionKey, selectionNames, selectionPossible, splitGlob } from './paths'
import type { Meter } from './paths'
import { ALWAYS_RECURSIVE, ARCHIVE, ATTACHED, CLAUDE_OFF, CLAUDE_TOOLS, CODE_FIRST, CODE_FLAGS, COPY, DESTROY, family, GIT_SUB_VALUES, hasFlag, INTERPRETER, isDecoder, isKnown, KEYWORDS, LIST, MCP_RUNS, MODE_FIRST, PASS_THROUGH, PATHY, PATTERN_FIRST, PLUGIN_OFF, READ, RECURSIVE_FLAGS, RUNNERS, RUNUSER, SHELLS, TRIVIAL, UNLINKERS, valuesOf, WRAPPERS, WRITE } from './programs'
import type { Runner, Values } from './programs'
import type { Analysis, Context, Effect, EffectKind, Ignored, Io, Segment } from './types'

/** Why some code cannot be read. */
export const OPAQUE = {
  variableProgram: 'the command names its program with a variable',
  unresolvedDeletion: 'a deletion names its target through a value that Arrester cannot read',
  variableCode: 'code comes from a variable or a command substitution',
  unreadableStdin: 'a shell or interpreter runs code from a command that Arrester cannot read',
  decoded: 'a decoded or transformed text runs as code',
  scriptUnreadable: 'a script cannot be read',
  scriptTooLong: 'a script is too long to read',
  tooDeep: 'code nests deeper than Arrester reads',
  shellProgram: 'su or runuser names a shell that Arrester cannot read',
  tooMany: 'the call names too many paths to read',
  interrupted: 'the call was interrupted',
} as const

/** The bypass of a nested `claude` run, which does not inherit the open blocks. */
export const NESTED_SESSION = 'a nested session'

/** How deep `sh -c`, `eval`, command substitutions, and scripts may nest. */
const MAX_DEPTH = 3

/** The most values one word may resolve to, counted before they are built. */
const MAX_VALUES = 256

/** The most word values one analysis resolves in all. */
const MAX_TOTAL_VALUES = 16_384

/** The most effects one analysis keeps. */
export const MAX_EFFECTS = 256

/** The longest value one word may build, counted before it is built: the longest command Arrester reads. */
const MAX_TEXT = 100_000

/** The most work one analysis does, in characters read, characters built, and values copied; past it the analysis stops and is opaque. */
const MAX_WORK = 4_000_000

/** The most work that the code of 1.2.0 does for one call, across both walks: each token, word character, tree node, copied entry, queue step, and table lookup of rule A4, its second walk, the newer reading, the array rule, and the profile. Past it the analysis stops and is opaque. */
const NEW_WORK = 1_500_000

/** The longest call that the code of 1.2.0 reads: a longer call that needs the newer reading keeps the result of 1.1.3, which did not parse it, and a longer call that runs a function that it defines, which rule A4 walks a second time, is opaque. */
const NEW_LENGTH = 10_000

/** One word value: its text, whether it represents glob matches, and a pattern that preserves quoted wildcard positions. */
type Value = { selected?: true; text: string; glob: boolean; pattern?: string; globOptions?: Effect['globOptions']; selection?: Effect['selection'] }

/** A word as the walker sees it: its text as typed, and its values (undefined when it does not resolve); `upstream` marks an operand that reaches below its paths, as one that `xargs` or `find -exec` takes from what came before; `process` marks a process substitution, whose generated file name is unknown; `possible` holds, for a word that does not resolve, the values that the default or the alternate of a parameter operator gives it. */
type Operand = { raw: string; values: Value[] | undefined; upstream?: true; process?: true; possible?: Value[] }

/** The shell state one command line runs in; `reaching` names the variables bound to operands that reach below their paths; `possible` holds the possible values of a variable that has no known value, from an assignment of a parameter operator's default; `functions` holds the bodies of the functions defined so far and `named` the text of each alias; `arrays` holds the elements of each array whose expansions resolve, as `assignArray` says; `lost` marks a shell where `HOME` and `PWD` are unknown, as `forgetAssigned` says. The links made and the files written are on disk, so every copy shares them. */
type State = {
  status?: boolean
  terminated?: boolean
  shell?: string
  globOptions?: Effect['globOptions']
  noglob?: boolean
  globstar?: boolean
  positional?: readonly Operand[]
  execdir?: { root: string; selection: NonNullable<Effect['selection']> }
  cwd: string | undefined
  prev: string | undefined
  stack: readonly (string | undefined)[]
  vars: Map<string, Value[]>
  reaching: Set<string>
  exported: Set<string>
  removed: Set<string>
  emptyEnv: boolean
  aliases: Map<string, string>
  written: Map<string, string | undefined>
  functions: Map<string, Simple>
  named: Map<string, string>
  possible: Map<string, Value[]>
  arrays: Map<string, Operand[]>
  lost?: true
}

/** The printing options on a shell's command line, in order: `verbose` prints the code that the shell reads, and `xtrace` the commands that it runs. */
type Printing = { verbose?: boolean; xtrace?: boolean }

/** One command with its redirections and optional compound body; `definition` names the function that the command defines, or is empty for a name that is not plain text, and `exits` marks a function body that names `return` or `exit`. `arithmetic` marks a subshell whose `(` another `(` follows at once, as in `((`, as `arithmeticOf` says. `cases` holds the word and the branches of a `case`, each with its patterns, its body, and the operator that ends it. */
type Simple = { words: Word[]; redirects: Redirect[]; body?: Pipeline[]; subshell?: boolean; arithmetic?: true; branches?: { condition?: Pipeline[]; body: Pipeline[] }[]; definition?: string; exits?: true; loop?: { condition?: Pipeline[]; until?: boolean; name?: string; words?: Word[] }; cases?: { word: Word; clauses: { patterns: Word[]; body: Pipeline[]; end: string }[] } }

/** One pipeline and the operator that follows it. */
type Pipeline = { commands: Simple[]; negate: boolean; after: string }

/** A redirection, its resolved target, and for a heredoc or a here-string the text it gives. */
type Redirected = { redirect: Redirect; target: Operand; text?: { text: string; uncertain?: true } }

/** A descriptor's open destination, including inherited output streams and closed descriptors. */
type Destination = Redirected | 'stdout' | 'stderr' | undefined

/** What a command reads on stdin, and what it hands the next stage: nothing, literal text, a file's content, a listing of paths at or below `paths`, decoded text, or anything else, which `closed` marks as a stdin that `<&-` closed. */
type Stdin = { kind: 'none' } | { kind: 'literal'; text: string; uncertain?: true; positions?: number[] } | { kind: 'script'; path: string } | { kind: 'paths'; paths: Operand[]; separator: string } | { kind: 'decoder' } | { kind: 'other'; closed?: true }

const NONE: Stdin = { kind: 'none' }
const OTHER: Stdin = { kind: 'other' }
const CLOSED: Stdin = { kind: 'other', closed: true }
const DECODER: Stdin = { kind: 'decoder' }

/** The value of a variable that rule A4 made unknown, as `setUnknown` says: a join of two shells keeps it unknown, and an assignment replaces it. */
const UNKNOWN: Value[] = []

/** A command's flags and the values of its value-taking flags. */
type Options = { flags: string[]; given: Map<string, Operand[]>; ordered: { flag: string; value: Operand }[] }

/** A command's flags, its operands, the values of its value-taking flags, and where `--` split the operands. */
type Parsed = Options & { operands: Operand[]; split: number | undefined }

/** The values that the command substitutions of one command gave, per part, so a word that brace expansion copies walks each one once. */
type Substituted = Map<Part, string | undefined>

/** What one analysis collects while it walks. */
class Walk {
  readonly effects: Effect[] = []
  private readonly effectKeys = new Set<string>()
  readonly segments: Segment[] = []
  readonly home: string | undefined
  readonly io: Io
  opaque: string | undefined
  ignored: Ignored | undefined
  bypass: string | undefined
  /** The older script being walked: code in it that cannot be read does not count. */
  oldScript: string | undefined
  depth = 0
  /** How many word values the analysis has resolved so far. */
  values = 0
  /** How much work the analysis has done so far. */
  work = 0
  /** The aliases whose text is being walked, which do not expand again inside it. */
  readonly expanding = new Set<string>()
  /** Set once code that Arrester 1.1.3 did not parse parsed in the modern reading, which then reads all later code of the call, as `parseCommands` says. */
  modern = false
  /** How many scripts that the call wrote are being walked; their code keeps the reading of Arrester 1.1.3. */
  legacy = 0
  /** Set when code read as Arrester 1.1.3 read it ended a substitution at the `)` of a `case` pattern, which can hide the commands of the `case`; such a call that also needed the modern reading is opaque, as `walkCall` says. */
  cut = false
  /** Set when the walk met code that the narrow reading does not follow: an array form that does not resolve, outside an older script; a call of a function whose body is not walked; a `case` with a `;&` or `;;&` end; a command that a wrapper runs whose name is not literal text or is a builtin outside the profile; a read or a write of a file operand that does not resolve, or of a relative path in an unknown folder; or a loop that can read more than one line of literal input. Such a call that also needed the modern reading is opaque, as `walkCall` says. */
  unread = false
  /** The command trees that the walk parsed, outside an older script, which `walkCall` checks with `outsideProfile` once the call needs the modern reading. */
  readonly parsed: Pipeline[][] = []
  /** Set when a text that the walk parsed, outside an older script, holds `$'…'` or `$"…"`, which the profile does not hold. */
  quoting = false
  /** The names of the arrays that the code read so far assigns or declares; an expansion of one of them that does not resolve is opaque. */
  readonly arrayNames = new Set<string>()
  /** The arrays whose expansions resolve: each one that the call assigns one time, at its top level, with `NAME=( … )`, and changes nowhere, as `arraysOf` says. */
  readonly resolvable = new Set<string>()
  /** The top-level commands that assign the arrays in `resolvable`. */
  readonly assignments = new Set<Simple>()
  /** Every body that the code defines for each function name, for rule A4. */
  readonly bodies = new Map<string, Set<Simple>>()
  /** Set when a command calls a function that the code defines, so `analyzeShell` walks the call again. */
  calls = false
  /** Whether a call of a function makes unknown the variables that its body can assign, as `forgetAssigned` says; only the second walk does. */
  readonly forgets: boolean
  /** The work of the code of 1.2.0 so far, which both walks of a call share, as NEW_WORK says. */
  readonly meter: { used: number }
  /** The length of the text of the call, as NEW_LENGTH says. */
  length = 0

  constructor(home: string | undefined, io: Io, forgets = false, meter = { used: 0 }) {
    this.home = home
    this.io = io
    this.forgets = forgets
    this.meter = meter
  }

  /** Counts `units` of the work of the code of 1.2.0; past NEW_WORK the analysis stops and is opaque, as past MAX_WORK. */
  tick(units: number): boolean {
    this.meter.used += units
    if (this.meter.used <= NEW_WORK) return true
    this.opaque ??= OPAQUE.tooMany
    this.work = MAX_WORK + 1
    return false
  }

  /** Marks the analysis opaque, or inside an older script records what was not counted; the first reason stays. */
  fail(reason: string): void {
    if (this.oldScript === undefined) this.opaque ??= reason
    else this.ignored ??= { path: this.oldScript, reason }
  }

  /** Charges `units` of work; past MAX_WORK the analysis stops and is opaque, inside an older script too, since the rest of the call goes unread. The whole second walk, and the walk of code once the call needs the newer reading, is work of 1.2.0, so there each unit also counts on the meter. */
  charge(units: number): boolean {
    if (this.io.signal.aborted) {
      this.opaque ??= OPAQUE.interrupted
      this.work = MAX_WORK + 1
      return false
    }
    if ((this.forgets || this.modern) && !this.tick(units)) return false
    this.work += units
    if (this.work <= MAX_WORK) return true
    this.opaque ??= OPAQUE.tooMany
    return false
  }

  /** True once the work passed MAX_WORK. */
  isSpent(): boolean {
    return this.work > MAX_WORK
  }

  /** Counts `count` more word values; past MAX_TOTAL_VALUES the analysis is opaque. */
  count(count: number): boolean {
    this.values += count
    if (this.values <= MAX_TOTAL_VALUES) return true
    this.fail(OPAQUE.tooMany)
    return false
  }

  /** Keeps an effect, a `fullSearch` one apart from the same effect without the mark; past MAX_EFFECTS the analysis is opaque. */
  add(effect: Effect): void {
    const key = JSON.stringify([effect.path, effect.kind, effect.recursive, effect.entry, effect.glob, effect.globOptions?.dot === true, effect.globOptions?.nocase === true, selectionKey(effect.selection), ...(effect.fullSearch === true ? [true] : [])])
    if (!this.charge(key.length) || this.effectKeys.has(key)) return
    if (this.effects.length < MAX_EFFECTS) {
      this.effectKeys.add(key)
      this.effects.push(effect)
    }
    else this.fail(OPAQUE.tooMany)
  }
}

/** Everything a program handler reads. */
type Run = { walk: Walk; state: State; program: string; args: Operand[]; stdin: Stdin; find?: { starts: Operand[]; expression: FindTerm[] } }

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/
/** An assignment of one element of an array, `NAME[…]=` or `NAME[…]+=`. */
const ELEMENT = /^([A-Za-z_][A-Za-z0-9_]*)\[[^\]]*\]\+?=/
const ASSIGNERS = new Set(['export', 'declare', 'local', 'readonly'])
const DIRECTORY_CHANGERS = new Set(['cd', 'pushd', 'popd'])
const DEVICES = /^\/dev\/(null|stdout|stderr|tty|fd\/[0-9]+)$/
const DUPLICATE = /^([0-9]+|-)$/
const TRUNCATING = new Set(['>', '>|', '&>', '>&'])
const SYMBOLIC_MODE = /^[ugoa]*[-+=][rwxXst]*$/
const ESCAPED = /\\(x[0-9a-fA-F]|[0-7])|%b/
const GIT_GLOBAL_VALUES = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const MARK = /\uE000([0-9]+)\uE001/g
const MARKED = /[\uE000\uE001]/
const IN_PLACE_CLUSTER = /^-[A-Za-z]*[iI]$/
const CLAUDE_NAME = /^claude(?:-code)?$/i
const CLAUDE_VERSION = /\/claude\/versions\/[^/]+$/i

/** Analyzes one shell command line. A call that runs a function that it defines is walked a second time, where a call makes unknown the variables that its body can assign (rule A4); the effects of both walks count, and either one can make the call opaque, so the rule only adds stops. The retry skeletons are those of the first walk, which reads calls as Arrester 1.1.3 did. */
export async function analyzeShell(command: string, ctx: Context, io: Io): Promise<Analysis> {
  const walk = await walkCall(command, ctx, io, false)
  if (walk.calls && walk.opaque === undefined && !io.signal.aborted && command.length > NEW_LENGTH) walk.fail(TOO_LONG)
  else if (walk.calls && walk.opaque === undefined && !io.signal.aborted) {
    const second = await walkCall(command, ctx, io, true, walk.meter)
    for (const effect of second.effects) walk.add(effect)
    walk.opaque ??= second.opaque
    walk.ignored ??= second.ignored
    walk.bypass ??= second.bypass
  }
  return { effects: walk.effects, segments: walk.segments, opaque: walk.opaque, ignored: walk.ignored, bypass: walk.bypass }
}

/** One walk of a command line; with `forgets`, a call makes unknown the variables that its body can assign. A call that needed the modern reading is opaque with the reason of 1.1.3, which did not parse some of its code, when it holds a substitution that the reading of Arrester 1.1.3 ended at the `)` of a `case` pattern, code that the narrow reading does not follow, as `Walk.unread` says, or anywhere in the code that the walk parsed, a construct outside the minimal profile: `$'…'` or `$"…"` (`Walk.quoting`), a backslash-newline in the text of the call, or what `outsideProfile` finds. */
async function walkCall(command: string, ctx: Context, io: Io, forgets: boolean, meter?: { used: number }): Promise<Walk> {
  const walk = new Walk(ctx.home, io, forgets, meter)
  walk.length = command.length
  await runText(walk, command, freshState(ctx.cwd), NONE, true)
  if (walk.modern && (walk.cut || walk.unread || walk.quoting || command.includes('\\\n') || walk.parsed.some(commands => outsideProfile(walk, commands) !== undefined))) walk.fail(UNPARSED)
  return walk
}

/** A fresh shell with its folder and HOME inherited from the environment. */
function freshState(cwd: string | undefined): State {
  return { cwd, prev: undefined, stack: [], positional: [], vars: new Map(), reaching: new Set(), exported: new Set(['HOME']), removed: new Set(), emptyEnv: false, aliases: new Map(), written: new Map(), functions: new Map(), named: new Map(), possible: new Map(), arrays: new Map() }
}

/** A copy of the state for a subshell or nested code; the links made and the files written stay shared, as on disk. */
function fork(walk: Walk, state: State): State {
  if (!walk.charge(8 * (state.vars.size + state.reaching.size + state.exported.size + state.removed.size + state.functions.size + state.named.size + state.possible.size + state.arrays.size + 1))) return freshState(state.cwd)
  if (!walk.tick(1 + state.arrays.size)) return freshState(state.cwd)
  return { ...state, vars: new Map(state.vars), reaching: new Set(state.reaching), exported: new Set(state.exported), removed: new Set(state.removed), functions: new Map(state.functions), named: new Map(state.named), possible: new Map(state.possible), arrays: new Map(state.arrays) }
}

/** The state of a child process: exported variables and their possible values, the functions, and the shared files, in the current folder; arrays do not pass to it. */
function sharedFresh(walk: Walk, state: State): State {
  if (!walk.charge(state.exported.size + state.removed.size + state.functions.size + 1)) return freshState(state.cwd)
  const child = { ...freshState(state.cwd), execdir: state.execdir, aliases: state.aliases, written: state.written, removed: new Set(state.removed), emptyEnv: state.emptyEnv, functions: new Map(state.functions), ...(state.lost ? { lost: true as const } : {}) }
  child.exported = new Set(state.exported)
  if (!state.exported.has('HOME')) child.removed.add('HOME')
  for (const name of state.exported) {
    const value = state.vars.get(name)
    if (value !== undefined) child.vars.set(name, value)
    if (state.reaching.has(name)) child.reaching.add(name)
    const possible = state.possible.get(name)
    if (possible !== undefined) child.possible.set(name, possible)
  }
  return child
}

/** Reads and walks a piece of shell text; `top` marks the text of the call itself. */
async function runText(walk: Walk, text: string, state: State, input: Stdin = NONE, top = false): Promise<void> {
  if (!walk.charge(text.length)) return
  const commands = parseCommands(walk, modern => lex(text, modern), top)
  if (commands !== undefined) await runList(walk, commands, state, input)
}

/** The tokens of a piece of shell text, or why it cannot be read. */
type Lexed = ReturnType<typeof lex>

/** The commands of a piece of shell text, read as Arrester 1.1.3 read it, else in the modern reading, which adds `case` and arrays; undefined when neither reading parses, which fails with the reason of the 1.1.3 reading. Once a modern reading parsed, the call stopped on 1.1.3, so later code reads in the modern reading only. An older script and a script that the call wrote keep the 1.1.3 reading. Each tree that it returns outside an older script goes to `walk.parsed`. `tokens` gives the tokens of each reading; `top` marks the text of the call itself. */
function parseCommands(walk: Walk, tokens: (modern: boolean) => Lexed, top = false): Pipeline[] | undefined {
  const keeps = walk.oldScript !== undefined || walk.legacy > 0
  let reason: string | undefined
  if (keeps || !walk.modern) {
    const lexed = tokens(false)
    const commands = readCommands(lexed, false)
    if (typeof commands !== 'string') {
      if ('legacy' in lexed) walk.cut = true
      if (walk.oldScript === undefined) {
        walk.parsed.push(commands)
        if ('quoting' in lexed) walk.quoting = true
      }
      return commands
    }
    reason = commands
    if (keeps) {
      walk.fail(reason)
      return undefined
    }
  }
  if (walk.length > NEW_LENGTH) {
    walk.fail(reason ?? UNPARSED)
    return undefined
  }
  const lexed = tokens(true)
  if (!walk.tick(tokenWork(lexed))) return undefined
  const commands = readCommands(lexed, true)
  if (typeof commands === 'string') {
    walk.fail(reason ?? commands)
    return undefined
  }
  walk.modern = true
  arraysOf(walk, commands, top)
  walk.parsed.push(commands)
  if ('quoting' in lexed) walk.quoting = true
  return commands
}

/** The work of one reading of a text: one for each token, and the length of each word. */
function tokenWork(lexed: Lexed): number {
  if ('error' in lexed) return 1
  let work = 1
  for (const token of lexed.tokens) work += 1 + (token.type === 'word' ? wordText(token.word).length : 0)
  return work
}

/** The commands of the tokens in one reading, or why they do not parse. */
function readCommands(lexed: Lexed, modern: boolean): Pipeline[] | string {
  if ('error' in lexed) return lexed.error
  try { return new Commands(lexed.tokens, modern).list() }
  catch (error) { return error instanceof Error ? error.message : UNPARSED }
}

/** Walks code one level deeper; past MAX_DEPTH the analysis is opaque. */
async function nested(walk: Walk, text: string, state: State, input: Stdin = NONE): Promise<void> {
  if (walk.depth >= MAX_DEPTH) {
    walk.fail(OPAQUE.tooDeep)
    return
  }
  walk.depth += 1
  await runText(walk, text, state, input)
  walk.depth -= 1
}

/** An and-or list in progress: how many pipelines ran, whether only `&&` joined them so far, whether one that may not have run moved the folder. */
type List = { count: number; isPure: boolean; isMoved: boolean; operator?: '&&' | '||' }

/** A list that starts now. */
function newList(): List {
  return { count: 0, isPure: true, isMoved: false }
}

/** Keeps bounded variable alternatives when a conditional command may have been skipped; a variable that one side made unknown, as `setUnknown` says, stays unknown. Where only one side has values, the walk of 1.1.3 keeps them, and outside an older script that join marks the walk `unread`, or, once the call needs the newer reading, makes the variable unknown. */
function mergeVariables(walk: Walk, state: State, before: State): void {
  if (state.terminated) {
    Object.assign(state, before)
    state.terminated = before.terminated
    return
  }
  if (!walk.charge(state.vars.size + before.vars.size + state.removed.size + before.removed.size + state.exported.size + before.exported.size)) return
  const names = new Set([...state.vars.keys(), ...before.vars.keys(), ...state.removed, ...before.removed])
  for (const name of names) {
    if (state.vars.get(name) === UNKNOWN || before.vars.get(name) === UNKNOWN) {
      setUnknown(state, name)
      continue
    }
    const previous = variable(walk, before, name)
    const current = variable(walk, state, name)
    if (previous === current) continue
    if ((previous === undefined || current === undefined) && walk.oldScript === undefined) {
      if (walk.modern) {
        setUnknown(state, name)
        continue
      }
      walk.unread = true
    }
    const values = alternatives(walk, [...previous ?? [], ...current ?? []])
    if (values.length > MAX_VALUES) {
      walk.fail(OPAQUE.tooMany)
      return
    }
    if (values.length > 0) state.vars.set(name, values)
    if (before.reaching.has(name)) state.reaching.add(name)
  }
  for (const name of before.exported) state.exported.add(name)
  for (const name of state.removed) if (!before.removed.has(name)) state.removed.delete(name)
  if (!walk.charge(before.functions.size + before.named.size + before.possible.size)) return
  for (const [name, body] of before.functions) if (!state.functions.has(name)) state.functions.set(name, body)
  for (const [name, text] of before.named) if (!state.named.has(name)) state.named.set(name, text)
  for (const [name, values] of before.possible) {
    const merged = state.vars.has(name) ? [] : alternatives(walk, [...state.possible.get(name) ?? [], ...values])
    if (merged.length > 0 && merged.length <= MAX_VALUES) state.possible.set(name, merged)
  }
  if (state.positional !== before.positional) mergePositional(walk, state, before)
  state.globOptions = { dot: before.globOptions?.dot || state.globOptions?.dot, nocase: before.globOptions?.nocase || state.globOptions?.nocase }
  state.noglob = state.noglob && before.noglob
  state.globstar = state.globstar || before.globstar
  if (before.lost) state.lost = true
  if (walk.tick(1 + state.arrays.size)) for (const [name, elements] of state.arrays) if (before.arrays.get(name) !== elements) state.arrays.delete(name)
  state.status = undefined
}

/** Joins corresponding positional values; different argument counts stay unresolved until replaced. */
function mergePositional(walk: Walk, state: State, before: State): void {
  const current = state.positional
  const previous = before.positional
  state.positional = undefined
  if (current === undefined || previous === undefined || current.length !== previous.length) return
  if (!walk.charge(current.length)) return
  const merged: Operand[] = []
  for (const [index, arg] of current.entries()) {
    const prior = previous[index]!
    const values = arg.values === undefined || prior.values === undefined ? undefined : alternatives(walk, [...arg.values, ...prior.values])
    if ((values?.length ?? 0) > MAX_VALUES) {
      walk.fail(OPAQUE.tooMany)
      return
    }
    merged.push({ raw: arg.raw, values, upstream: arg.upstream || prior.upstream })
  }
  setPositional(walk, state, merged)
}

/** The builtins after which an array assignment parses, when a flag with `a` or `A` comes before it. */
const ARRAY_DECLARERS = new Set(['declare', 'local', 'typeset', 'readonly'])

/** The operators that end a `case` branch. */
const CASE_ENDS = [';;', ';&', ';;&']

/** Parses compound boundaries before execution, with a fixed nesting limit; with `modern`, it also parses `case`, and an array assignment parses only where `checkArrays` says, never in a `for` list, a `case` word or pattern, or a redirection. */
class Commands {
  private at = 0
  private depth = 0

  constructor(private readonly tokens: readonly Token[], private readonly modern = false) {}

  /** Returns an unquoted keyword or a control operator at the cursor. */
  private text(offset = 0): string {
    const token = this.tokens[this.at + offset]
    if (token?.type === 'op') return token.op === '\n' ? ';' : token.op
    return token?.type === 'word' && token.word.every(part => part.kind === 'text' && !part.quoted) ? wordText(token.word) : ''
  }

  /** Consumes a required delimiter, rejecting incomplete syntax. */
  private take(text: string): void {
    if (this.text() !== text) throw new Error(UNPARSED)
    this.at += 1
  }

  /** Reads a command list up to a compound delimiter. */
  list(stops: readonly string[] = []): Pipeline[] {
    if (++this.depth > 32) throw new Error(OPAQUE.tooDeep)
    const result: Pipeline[] = []
    while (this.at < this.tokens.length && !stops.includes(this.text())) {
      if (this.text() === ';') { this.at += 1; continue }
      let negate = false
      while (this.text() === '!') { negate = !negate; this.at += 1 }
      const commands = [this.command()]
      while (this.text() === '|' || this.text() === '|&') {
        this.at += 1
        while (this.tokens[this.at]?.type === 'op' && (this.tokens[this.at] as { op: string }).op === '\n') this.at += 1
        commands.push(this.command())
      }
      let after = ''
      if ([';', '&', '&&', '||'].includes(this.text())) {
        after = this.text()
        this.at += 1
      } else if (this.at < this.tokens.length && !stops.includes(this.text())) throw new Error(UNPARSED)
      result.push({ commands, negate, after })
    }
    this.depth -= 1
    return result
  }

  /** Reads one simple command, group, condition, or function definition. */
  private command(nesting = 0): Simple {
    if (nesting >= 32) throw new Error(OPAQUE.tooDeep)
    const command: Simple = { words: [], redirects: [] }
    const text = this.text()
    if ((text === 'function' && this.tokens[this.at + 1]?.type === 'word') || (text !== '' && this.text(1) === '(' && this.text(2) === ')')) {
      this.at += text === 'function' ? 1 : 0
      const name = this.text()
      this.at += 1
      if (this.text() === '(') { this.at += 1; this.take(')') }
      const start = this.at
      const body = this.command(nesting + 1)
      if (body.body === undefined) throw new Error(UNPARSED)
      return { ...body, definition: name, ...(this.tokens.slice(start, this.at).some(namesExit) ? { exits: true as const } : {}) }
    }
    if (text === '(' || text === '{') {
      const opening = this.tokens[this.at]
      this.at += 1
      command.body = this.list([text === '(' ? ')' : '}'])
      command.subshell = text === '('
      if (opening?.type === 'op' && opening.joined === true) command.arithmetic = true
      this.take(text === '(' ? ')' : '}')
    } else if (text === 'while' || text === 'until') {
      this.at += 1
      command.loop = { condition: this.list(['do']), until: text === 'until' }
      this.take('do')
      command.body = this.list(['done'])
      this.take('done')
    } else if (text === 'for') {
      this.at += 1
      const name = this.text()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(UNPARSED)
      this.at += 1
      while (this.text() === ';') this.at += 1
      command.loop = { name }
      if (this.text() === 'in') {
        this.at += 1
        command.loop.words = []
        while (this.tokens[this.at]?.type === 'word') {
          command.loop.words.push((this.tokens[this.at] as { type: 'word'; word: Word }).word)
          this.at += 1
        }
      }
      while (this.text() === ';') this.at += 1
      this.take('do')
      command.body = this.list(['done'])
      this.take('done')
    } else if (text === 'if') {
      command.branches = []
      do {
        this.at += 1
        const condition = this.list(['then'])
        this.take('then')
        command.branches.push({ condition, body: this.list(['elif', 'else', 'fi']) })
      } while (this.text() === 'elif')
      if (this.text() === 'else') {
        this.at += 1
        command.branches.push({ body: this.list(['fi']) })
      }
      this.take('fi')
    } else if (this.modern && text === 'case') command.cases = this.caseOf()
    else {
      while (this.at < this.tokens.length) {
        const token = this.tokens[this.at] as Token
        if (token.type === 'op') break
        if (token.type === 'word') command.words.push(token.word)
        else command.redirects.push(token.redirect)
        this.at += 1
      }
      if (command.words.length === 0 && command.redirects.length === 0) throw new Error(UNPARSED)
      if (this.modern) checkArrays(command.words)
    }
    while (this.tokens[this.at]?.type === 'redirect') {
      command.redirects.push((this.tokens[this.at] as { type: 'redirect'; redirect: Redirect }).redirect)
      this.at += 1
    }
    if (this.modern && [...command.loop?.words ?? [], ...command.redirects.map(redirect => redirect.target)].some(isArray)) throw new Error(UNPARSED)
    return command
  }

  /** Reads `case WORD in … esac` from the `case` at the cursor: newlines may come before `in` and between branches; each branch has patterns joined by `|`, with an optional `(` before them and a `)` after, a body, and `;;`, `;&`, or `;;&`, which the last branch may leave out before `esac`. */
  private caseOf(): NonNullable<Simple['cases']> {
    this.at += 1
    const word = this.tokens[this.at]
    if (word?.type !== 'word') throw new Error(UNPARSED)
    this.at += 1
    this.newlines()
    this.take('in')
    const clauses: NonNullable<Simple['cases']>['clauses'] = []
    for (;;) {
      this.newlines()
      if (this.text() === 'esac') break
      if (this.text() === '(') this.at += 1
      const patterns: Word[] = []
      for (;;) {
        const pattern = this.tokens[this.at]
        if (pattern?.type !== 'word') throw new Error(UNPARSED)
        patterns.push(pattern.word)
        this.at += 1
        if (this.text() !== '|') break
        this.at += 1
      }
      this.take(')')
      const body = this.list([...CASE_ENDS, 'esac'])
      const end = this.text()
      if (end !== 'esac' && !CASE_ENDS.includes(end)) throw new Error(UNPARSED)
      clauses.push({ patterns, body, end: end === 'esac' ? ';;' : end })
      if (end === 'esac') break
      this.at += 1
    }
    this.take('esac')
    if ([word.word, ...clauses.flatMap(clause => clause.patterns)].some(isArray)) throw new Error(UNPARSED)
    return { word: word.word, clauses }
  }

  /** Skips newlines at the cursor. */
  private newlines(): void {
    while (this.tokens[this.at]?.type === 'op' && (this.tokens[this.at] as { op: string }).op === '\n') this.at += 1
  }
}

/** Checks that each array assignment of a simple command stands where the shell reads one: in a command of assignments only, or after `declare`, `local`, `typeset`, or `readonly` with a flag that holds `a` or `A`. */
function checkArrays(words: readonly Word[]): void {
  const leading = leadingAssignments(words)
  const program = wordText(words[leading] ?? [])
  let flagged = false
  for (const [index, word] of words.entries()) {
    if (word.some(part => part.kind === 'array') && leading !== words.length && !(index > leading && ARRAY_DECLARERS.has(program) && flagged)) throw new Error(UNPARSED)
    if (index > leading && /^-[A-Za-z]*[aA]/.test(wordText(word))) flagged = true
  }
}

/** Walks and-or lists while preserving skipped status and bounded variable alternatives. */
async function runList(walk: Walk, commands: readonly Pipeline[], state: State, input: Stdin): Promise<Stdin> {
  let list = newList()
  let output = NONE
  let pipelines = 0
  const parent = state
  for (let index = 0; index < commands.length; index += 1) {
    if (parent.terminated) break
    const pipeline = commands[index]!
    if (index === 0 || !['&&', '||'].includes(commands[index - 1]!.after)) {
      let end = index
      while (end + 1 < commands.length && ['&&', '||'].includes(commands[end]!.after)) end += 1
      if (!walk.charge(end - index + 1)) return OTHER
      state = commands[end]!.after === '&' ? fork(walk, parent) : parent
    }
    if (!walk.charge(1)) return OTHER
    const wanted = list.operator === undefined ? undefined : list.operator === '&&'
    if (!state.terminated && (wanted === undefined || state.status === undefined || state.status === wanted)) {
      const alternative = wanted !== undefined && state.status === undefined ? fork(walk, state) : undefined
      const before = state.cwd
      const positions = input.kind === 'literal' ? input.positions ?? [0] : []
      const produced = await runPipeline(walk, pipeline.commands, state, input)
      if (pipeline.negate && state.status !== undefined) state.status = !state.status
      if (alternative !== undefined) {
        if (input.kind === 'literal' && state.terminated) input.positions = positions
        else mergeInput(walk, input, positions)
        mergeVariables(walk, state, alternative)
      }
      output = pipelines++ === 0 ? produced : OTHER
      if (list.count > 0 && state.cwd !== before) {
        if (list.isPure) list.isMoved = true
        else state.cwd = undefined
      }
      list.count += 1
    }
    if (pipeline.after === '||') {
      list.operator = '||'
      list.isPure = false
      if (list.isMoved) state.cwd = undefined
      list.isMoved = false
    } else if (pipeline.after === '&&') list.operator = '&&'
    else {
      if (pipeline.after === '&') parent.status = true
      else if (list.isMoved) state.cwd = undefined
      list = newList()
    }
  }
  return output
}

/** Executes a group, a `case`, or an if branch, merging state only when a condition is unknown. */
async function runCompound(walk: Walk, command: Simple, state: State, input: Stdin): Promise<Stdin> {
  if (command.loop !== undefined) return runLoop(walk, command, state, input)
  if (command.cases !== undefined) return runCase(walk, command.cases, state, input)
  if (command.body !== undefined) {
    const scope = command.subshell ? fork(walk, state) : state
    const output = await runList(walk, command.body, scope, input)
    state.status = scope.status
    return output
  }
  const alternatives: State[] = []
  const positions: number[] = []
  let output = NONE
  let executed = false
  for (const branch of command.branches ?? []) {
    if (!walk.charge(1)) return OTHER
    if (branch.condition !== undefined) await runList(walk, branch.condition, state, input)
    else state.status = true
    if (state.terminated) break
    if (state.status === false) continue
    if (state.status === true) {
      output = await runList(walk, branch.body, state, input)
      executed = true
      break
    }
    const scope = fork(walk, state)
    const before = input.kind === 'literal' ? input.positions ?? [0] : []
    await runList(walk, branch.body, scope, input)
    if (input.kind === 'literal') {
      if (!scope.terminated && walk.charge(input.positions?.length ?? 1)) positions.push(...input.positions ?? [0])
      input.positions = before
    }
    alternatives.push(scope)
  }
  mergeInput(walk, input, positions)
  if (!executed && !state.terminated) state.status = true
  for (const alternative of alternatives) {
    if (alternative.terminated) continue
    mergeVariables(walk, state, alternative)
    if (state.cwd !== alternative.cwd) state.cwd = undefined
    output = OTHER
  }
  return output
}

/** Walks a `case`: the commands in its word and its patterns run, and a pattern is no path. Every branch counts, as a branch of an `if` whose condition is unknown does, each in a copy of the shell, and the copies join the shell where no pattern matched, as at an `if`. A branch that `;&` ends also starts the next branch, and one that `;;&` ends every later branch, so their shells join the start of those branches; the narrow reading does not follow the input that such a branch passes on, so such an end marks the walk `unread`. */
async function runCase(walk: Walk, cases: NonNullable<Simple['cases']>, state: State, input: Stdin): Promise<Stdin> {
  const cache: Substituted = new Map()
  await resolveWhole(walk, cases.word, state, cache)
  if (cases.clauses.some(clause => clause.end !== ';;')) walk.unread = true
  const ends: State[] = []
  const later: State[] = []
  const positions: number[] = []
  let next: State | undefined
  for (const clause of cases.clauses) {
    if (!walk.charge(1 + later.length) || !walk.tick(1 + later.length + clause.patterns.length)) return OTHER
    for (const pattern of clause.patterns) await resolveWhole(walk, pattern, state, cache)
    const scope = fork(walk, state)
    for (const other of next === undefined ? later : [...later, next]) {
      if (other.terminated) continue
      mergeVariables(walk, scope, other)
      if (scope.cwd !== other.cwd) scope.cwd = undefined
    }
    const before = input.kind === 'literal' ? input.positions ?? [0] : []
    await runList(walk, clause.body, scope, input)
    if (input.kind === 'literal') {
      if (!scope.terminated && walk.charge(input.positions?.length ?? 1)) positions.push(...input.positions ?? [0])
      input.positions = before
    }
    ends.push(scope)
    if (clause.end === ';;&') later.push(scope)
    next = clause.end === ';&' ? scope : undefined
  }
  mergeInput(walk, input, positions)
  state.status = true
  let output = NONE
  for (const end of ends) {
    if (end.terminated) continue
    mergeVariables(walk, state, end)
    if (state.cwd !== end.cwd) state.cwd = undefined
    output = OTHER
  }
  return output
}

/** The names of the positional and special parameters, which a call does not make unknown. */
const POSITIONAL = /^(?:[0-9]+|[@*#?$!-])$/

/** Runs the stages of one pipeline, handing each stage what the one before produced. Each stage of a longer pipeline runs in a subshell, and a folder change in the last stage leaves the folder unknown, since some shells run that stage in this one; for the same reason, rule A4 applies to each call of a function or an alias in the last stage, as `forgetAssigned` says. */
async function runPipeline(walk: Walk, commands: readonly Simple[], state: State, input: Stdin): Promise<Stdin> {
  const [only] = commands
  if (commands.length === 1 && only !== undefined) {
    return runSimple(walk, only, state, input)
  }
  let piped = input
  let isDecoded = false
  let last = state
  for (const command of commands) {
    if (!walk.charge(1)) return OTHER
    last = fork(walk, state)
    if (walk.isSpent()) return OTHER
    piped = await runSimple(walk, command, last, isDecoded ? DECODER : piped)
    isDecoded = isDecoded || piped.kind === 'decoder'
  }
  if (last.cwd !== state.cwd) state.cwd = undefined
  state.status = last.status
  if (walk.forgets) {
    const calls = changesOf(walk, [{ commands: commands.slice(-1), negate: false, after: '' }], noChanges(true)).calls
    forgetAssigned(walk, state, [...calls].filter(name => walk.bodies.has(name) || state.named.has(name)))
  }
  return piped
}

/** How many words at the front of a command assign variables, read from their text as typed. */
function leadingAssignments(words: readonly Word[]): number {
  const index = words.findIndex(word => !ASSIGNMENT.test(wordText(word)))
  return index < 0 ? words.length : index
}

/** `return` or `exit` as a name of its own anywhere in a text, also inside quotes or a substitution. */
const EXITS = /(?:^|[^A-Za-z0-9_])(?:return|exit)(?![A-Za-z0-9_])/

/** Whether a token names `return` or `exit` anywhere: in a word, a redirection's target, or a heredoc. */
function namesExit(token: Token): boolean {
  if (token.type === 'word') return EXITS.test(wordText(token.word))
  return token.type === 'redirect' && (EXITS.test(wordText(token.redirect.target)) || EXITS.test(token.redirect.heredoc?.text ?? ''))
}

/** Runs one simple command: assignments, wrappers, the program, and the redirections; returns what it hands the next stage. A function definition is kept for its calls, unless its body names `return` or `exit`, which forgets the name; every body stays known for rule A4, which `forgetAssigned` applies after a call in the second walk. A command whose program word names an alias also walks the alias text with the rest of the command. An array assignment walks as `assignArray` says. */
async function runSimple(walk: Walk, command: Simple, state: State, piped: Stdin): Promise<Stdin> {
  if (command.definition !== undefined) {
    if (command.definition !== '' && walk.tick(1)) {
      const bodies = walk.bodies.get(command.definition) ?? new Set<Simple>()
      bodies.add(command)
      walk.bodies.set(command.definition, bodies)
    }
    if (command.exits) state.functions.delete(command.definition)
    else if (command.definition !== '' && walk.charge(1)) state.functions.set(command.definition, { ...command, definition: undefined })
    state.status = true
    return NONE
  }
  const outer = state
  const original = command
  const cache: Substituted = new Map()
  let start = 0
  while (KEYWORDS.has(wordText(command.words[start] ?? []))) start += 1
  if (start > 0) command = { ...command, words: command.words.slice(start) }
  const leading = leadingAssignments(command.words)
  const alias = await expandAlias(walk, command, leading, state, piped)
  const isDeclaration = ASSIGNERS.has(wordText(command.words[leading] ?? []))
  const words: Operand[] = []
  for (const word of command.words.slice(leading)) {
    if (isArray(word)) {
      await assignArray(walk, original, word, state, cache)
      words.push({ raw: wordText(word), values: undefined })
    } else if (isDeclaration && ASSIGNMENT.test(wordText(word))) words.push(await resolveWhole(walk, word, state, cache))
    else for (const field of await resolveFields(walk, word, state, cache)) words.push(field)
  }
  const redirects: Redirected[] = []
  const descriptors = new Map<number, Destination>([[1, 'stdout'], [2, 'stderr']])
  const redirectState = { ...state }
  const redirectRun: Run = { walk, state: redirectState, program: textOf(words[0]), args: [], stdin: piped }
  for (const redirect of command.redirects) {
    const bound = await redirected(walk, redirect, state, cache)
    if (state.execdir === undefined) bound.target = mapOperand(bound.target, text => absolute(text, redirectState.cwd))
    // Descriptor numbers and device names are not relative filesystem paths.
    if (redirect.op === '>&' || redirect.op === '<&') bound.target = await resolveWhole(walk, redirect.target, state, cache)
    redirects.push(bound)
    openRedirect(redirectRun, bound, descriptors)
  }
  if (leading > 0 && words.length > 0) state = fork(walk, state)
  for (const word of command.words.slice(0, leading)) {
    if (isArray(word)) {
      await assignArray(walk, original, word, state, cache)
      continue
    }
    const setting = await resolveWhole(walk, word, state, cache)
    assign(walk, state, setting)
    if (words.length > 0) state.exported.add(ASSIGNMENT.exec(setting.raw)![1]!)
  }
  const stdin = stdinOf(redirects, state.cwd, piped) ?? piped
  if (command.body !== undefined || command.branches !== undefined || command.cases !== undefined) {
    const output = await runCompound(walk, command, state, stdin)
    finishRedirects(redirectRun, descriptors, output)
    return descriptors.get(1) === 'stdout' ? output : NONE
  }
  const result = await runCommand(walk, words, state, stdin)
  if (result.called !== undefined) {
    walk.calls = true
    if (walk.forgets) forgetAssigned(walk, outer, [result.called])
  }
  if (alias !== undefined && walk.forgets) forgetAssigned(walk, outer, [alias])
  if (state !== outer && ['read', 'printf'].includes(result.program)) {
    const temporary = new Set(command.words.slice(0, leading).map(word => ASSIGNMENT.exec(wordText(word))![1]))
    if (walk.charge(state.vars.size + outer.vars.size)) for (const name of new Set([...state.vars.keys(), ...outer.vars.keys()])) {
      if (temporary.has(name)) continue
      const values = state.vars.get(name)
      if (values === undefined) outer.vars.delete(name)
      else outer.vars.set(name, values)
      if (state.reaching.has(name)) outer.reaching.add(name)
      else outer.reaching.delete(name)
      if (!state.removed.has(name)) outer.removed.delete(name)
    }
  }
  outer.terminated = state.terminated
  outer.status = result.status ?? (result.program === 'false' ? false : result.program === 'true' || result.program === ':' || (words.length === 0 && cache.size === 0 && redirects.length === 0) ? true : undefined)
  redirectRun.program = result.program
  finishRedirects(redirectRun, descriptors, ['', ':', 'true', 'false'].includes(result.program) ? { kind: 'literal', text: '' } : result.output)
  return descriptors.get(1) === 'stdout' ? result.output : NONE
}

/** Whether a word is an array assignment, `NAME=( … )` or `NAME+=( … )`. */
function isArray(word: Word): boolean {
  return word.some(part => part.kind === 'array')
}

/** Walks an array assignment: its elements resolve now, as the words of a command do, so the commands in them run. The array keeps them, so `"${NAME[@]}"`, `${NAME[@]}`, `"${NAME[*]}"`, and `${NAME[*]}` resolve to them, only when `command` is the top-level command that assigns an array of `walk.resolvable` with `=`. Any other array has elements that Arrester does not know, so an expansion of it is opaque. The name has no known scalar value either. */
async function assignArray(walk: Walk, command: Simple, word: Word, state: State, cache: Substituted): Promise<void> {
  const match = ASSIGNMENT.exec(wordText(word))
  const array = word.find(part => part.kind === 'array')
  if (match === null || array?.kind !== 'array') return
  const name = match[1]!
  const elements: Operand[] = []
  if (!walk.tick(1 + array.elements.length)) return
  for (const element of array.elements) elements.push(...await resolveFields(walk, element, state, cache))
  walk.arrayNames.add(name)
  state.vars.delete(name)
  state.possible.delete(name)
  state.removed.delete(name)
  state.reaching.delete(name)
  if (match[2] === '' && walk.assignments.has(command) && walk.resolvable.has(name)) state.arrays.set(name, elements)
  else state.arrays.delete(name)
}

/** Records the arrays that a tree of commands assigns, declares with `-a` or `-A`, reads with `read -a`, `read -A`, `mapfile`, or `readarray`, sets with `set -A`, or assigns an element of; for the text of the call itself (`top`), also the arrays whose expansions resolve: an array that one top-level command of assignments only assigns with `NAME=( … )`, unconditionally, once, and with no `[key]=value` element, and that no other code of the call can assign, as `changesOf` counts. A command runs unconditionally when no `&&` or `||` comes before it, nothing runs it in the background or in a pipeline, and no `!` negates it. */
function arraysOf(walk: Walk, commands: readonly Pipeline[], top: boolean): void {
  visitCommands(walk, commands, command => {
    let leading = leadingAssignments(command.words)
    while (ELEMENT.test(wordText(command.words[leading] ?? []))) {
      walk.arrayNames.add(ELEMENT.exec(wordText(command.words[leading]!))![1]!)
      leading += 1
    }
    const program = wordText(command.words[leading] ?? [])
    const args = command.words.slice(leading + 1).map(word => wordText(word))
    const declares = ['mapfile', 'readarray'].includes(program) || ((ARRAY_DECLARERS.has(program) || program === 'read') && args.some(flag => /^-[A-Za-z]*[aA]/.test(flag)))
    for (const [index, word] of command.words.entries()) {
      const name = /^([A-Za-z_][A-Za-z0-9_]*)(?:\+?=|$)/.exec(wordText(word))?.[1]
      if (name !== undefined && (isArray(word) || (declares && index > leading))) walk.arrayNames.add(name)
    }
    if (['mapfile', 'readarray'].includes(program)) walk.arrayNames.add('MAPFILE')
    const set = program === 'set' ? args.findIndex(flag => /^[-+]A$/.test(flag)) : -1
    if (set >= 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(args[set + 1] ?? '')) walk.arrayNames.add(args[set + 1]!)
  })
  if (!top) return
  const candidates = new Map<string, Simple | undefined>()
  for (const [index, pipeline] of commands.entries()) {
    const [only] = pipeline.commands
    const isConditional = index > 0 && ['&&', '||'].includes(commands[index - 1]!.after)
    if (only === undefined || pipeline.commands.length > 1 || pipeline.negate || pipeline.after === '&' || isConditional) continue
    if (only.words.length === 0 || leadingAssignments(only.words) !== only.words.length || !walk.tick(commandWork(only))) continue
    for (const word of only.words) {
      const match = ASSIGNMENT.exec(wordText(word))
      const array = word.find(part => part.kind === 'array')
      if (match === null || array?.kind !== 'array' || match[2] === '+') continue
      const keyed = array.elements.some(element => /^\[[^\]]*\]\+?=/.test(wordText(element)))
      candidates.set(match[1]!, candidates.has(match[1]!) || keyed ? undefined : only)
    }
  }
  if (candidates.size === 0) return
  const changes = changesOf(walk, commands)
  if (changes.all) return
  for (const [name, command] of candidates) {
    if (command === undefined || changes.names.get(name) !== 1) continue
    walk.resolvable.add(name)
    walk.assignments.add(command)
  }
}

/** The work of reading one command again: one for the command, and one and the length of each word that the change reads in it: its words, the words of its loop header, the word and the patterns of its `case`, and the target and the heredoc of each redirection. */
function commandWork(command: Simple): number {
  let work = 1
  const words = [...command.words, ...command.loop?.words ?? [], ...command.cases === undefined ? [] : [command.cases.word, ...command.cases.clauses.flatMap(clause => clause.patterns)], ...command.redirects.map(redirect => redirect.target)]
  for (const word of words) work += 1 + wordText(word).length
  for (const redirect of command.redirects) work += 1 + (redirect.heredoc?.text.length ?? 0)
  return work
}

/** Calls `visit` for each command of a tree: the commands of each pipeline and of the compound bodies, conditions, loops, `case` branches, and function bodies in them, until the work runs out. */
function visitCommands(walk: Walk, commands: readonly Pipeline[], visit: (command: Simple) => void): void {
  const pending = commands.flatMap(pipeline => pipeline.commands)
  while (pending.length > 0) {
    const command = pending.pop()!
    const work = commandWork(command)
    if (!walk.charge(work) || !walk.tick(work)) return
    visit(command)
    const lists = [...command.body ?? [], ...command.loop?.condition ?? [], ...(command.branches ?? []).flatMap(branch => [...branch.condition ?? [], ...branch.body]), ...(command.cases?.clauses ?? []).flatMap(clause => clause.body)]
    for (const pipeline of lists) pending.push(...pipeline.commands)
  }
}

/** What code can assign: how many times it names each variable in an assignment, whether it can assign any variable, and the program words that it runs; with `exact`, only what it assigns in the shell that runs it, as `changesOf` says. `locals` names the variables that it declares as a function's own, as DECLARERS says. `shell` names the shell that runs the code, when it is bash or zsh, so its builtins count as that shell's do, as DECLARERS and NAMERS say. `getopts` assigns OPTARG, OPTIND, and only the operand after the option string, or each later operand when the option string is not literal text. */
type Changes = { names: Map<string, number>; all: boolean; calls: Set<string>; exact: boolean; locals: Set<string>; shell?: Shell }

/** No changes yet; `exact` and `shell` as `Changes` say. */
function noChanges(exact = false, shell?: Shell): Changes {
  return { names: new Map(), all: false, calls: new Set(), exact, locals: new Set(), ...(shell === undefined ? {} : { shell }) }
}

/** The names that the assignments and the arithmetic steps in a text assign, in one pass of linear time. An assignment is a name that no letter, digit, `_`, `$`, or `-` comes before, then white space, an optional subscript up to the next `]` with white space after it, an optional operator (`-`, `+`, `*`, `/`, `%`, `&`, `|`, `^`, `:`, `<<`, or `>>`), and `=` with no `=` after it, as in `NAME=`, `F[0]+=`, and `${NAME:=word}`. A step is such a name, with no `-` rule, before `++` or `--`, or `++` or `--`, white space, and a name. Each found form ends where the next search starts, so the text of a subscript that a found form holds counts no name. One pass from the end gives, for each position, the next `]` and the next character that is no white space, so a subscript or a run of white space costs constant work at each name. Assignments come first, then steps. */
function arithmeticNames(text: string): string[] {
  const length = text.length
  const close = new Int32Array(length + 1)
  const solid = new Int32Array(length + 1)
  close[length] = -1
  solid[length] = length
  for (let at = length - 1; at >= 0; at -= 1) {
    const code = text.charCodeAt(at)
    close[at] = code === 93 ? at : close[at + 1]!
    solid[at] = isSpace(code) ? solid[at + 1]! : at
  }
  const isStart = (at: number): boolean => at < length && isNameStart(text.charCodeAt(at))
  const nameEnd = (from: number): number => {
    let to = from
    while (to < length && isNamePart(text.charCodeAt(to))) to += 1
    return to
  }
  const afterSubscript = (from: number): number | undefined => {
    if (text[from] !== '[') return from
    const end = close[from]!
    return end < 0 ? undefined : solid[end + 1]!
  }
  const names: string[] = []
  for (let at = 0; at < length;) {
    if (!isStart(at) || (at > 0 && (isNamePart(text.charCodeAt(at - 1)) || text[at - 1] === '$' || text[at - 1] === '-'))) {
      at += 1
      continue
    }
    const end = nameEnd(at)
    const operator = afterSubscript(solid[end]!)
    let after: number | undefined
    if (operator !== undefined) {
      if ('-+*/%&|^:'.includes(text[operator] ?? '') && text[operator + 1] === '=' && text[operator + 2] !== '=') after = operator + 2
      else if ((text.startsWith('<<', operator) || text.startsWith('>>', operator)) && text[operator + 2] === '=' && text[operator + 3] !== '=') after = operator + 3
      else if (text[operator] === '=' && text[operator + 1] !== '=') after = operator + 1
    }
    if (after === undefined) at += 1
    else {
      names.push(text.slice(at, end))
      at = after
    }
  }
  for (let at = 0; at < length;) {
    if (isStart(at) && (at === 0 || !(isNamePart(text.charCodeAt(at - 1)) || text[at - 1] === '$'))) {
      const end = nameEnd(at)
      const step = afterSubscript(solid[end]!)
      if (step !== undefined && (text.startsWith('++', step) || text.startsWith('--', step))) {
        names.push(text.slice(at, end))
        at = step + 2
        continue
      }
    }
    if ((text.startsWith('++', at) || text.startsWith('--', at)) && isStart(solid[at + 2]!)) {
      const end = nameEnd(solid[at + 2]!)
      names.push(text.slice(solid[at + 2]!, end))
      at = end
      continue
    }
    at += 1
  }
  return names
}

/** A shell whose builtins rule A4 tells apart: bash, also as version 3.2, and zsh. Code that runs in another shell, or where the shell is not known, counts what the builtins of either assign. */
type Shell = 'bash' | 'zsh'

/** The shells that code with these changes can run in: the one that `bash -c` or `zsh -c` starts, else both. */
function shellsOf(changes: Changes): readonly Shell[] {
  return changes.shell === undefined ? ['bash', 'zsh'] : [changes.shell]
}

/** The signed option letters of a table entry, such as `-g +x`. */
function optionSet(text = ''): ReadonlySet<string> {
  return new Set(text.split(' ').filter(Boolean))
}

/** How one shell's builtin of the declare family reads its options, for rule A4, as the bash 5.3 `help` texts, zshbuiltins(1) of zsh 5.9, and replays in bash 5.3, bash 3.2, and zsh 5.9 show. Each field holds signed option letters. A word with a letter outside `valid` makes the builtin fail and assign nothing; with a letter of `none` it names functions or prints and assigns nothing; with one of `any` it can assign any variable through a name reference; with one of `patterns` its names are patterns, so it can assign any variable when it gives a value or converts. A declaration in a function body is the function's own unless `global` says that the builtin always declares globally or a letter of `globals` comes. A name without a value changes only with a letter of `converts`, as the second name after `-T`, which needs two, or with a letter of `widths` and a width; with `converting` it always changes, unless a letter of `keeps` comes. With `effective`, as in zsh, only the last of `-L` and `+L` counts for a letter L of `globals`, `converts`, `widths`, and `keeps`; else any of them counts. A letter of `any` counts only when its sign comes last. With a letter of `conflicts` after both signs the builtin fails. With `plusOperands`, a word that starts with `+` is an operand; with `digits`, an option word may hold a number. */
type Declarer = { valid: ReadonlySet<string>; none: ReadonlySet<string>; any: ReadonlySet<string>; patterns: ReadonlySet<string>; globals: ReadonlySet<string>; converts: ReadonlySet<string>; widths: ReadonlySet<string>; keeps: ReadonlySet<string>; conflicts: ReadonlySet<string>; global?: true; converting?: true; effective?: true; plusOperands?: true; digits?: true }

/** A Declarer from its letters as text. */
function declarer(entry: { valid: string; none?: string; any?: string; patterns?: string; globals?: string; converts?: string; widths?: string; keeps?: string; conflicts?: string; global?: true; converting?: true; effective?: true; plusOperands?: true; digits?: true }): Declarer {
  return { ...entry, valid: optionSet(entry.valid), none: optionSet(entry.none), any: optionSet(entry.any), patterns: optionSet(entry.patterns), globals: optionSet(entry.globals), converts: optionSet(entry.converts), widths: optionSet(entry.widths), keeps: optionSet(entry.keeps), conflicts: optionSet(entry.conflicts) }
}

/** The option letters of zsh `local`, after `-` or `+`, as zshbuiltins(1) lists them. */
const ZSH_LOCAL_LETTERS = [...'aAEFhHilLprRtuUxZ'].flatMap(letter => [`-${letter}`, `+${letter}`]).join(' ')

/** The builtins of the declare family in each shell, as Declarer says. */
const DECLARERS: Readonly<Record<Shell, ReadonlyMap<string, Declarer>>> = (() => {
  const bashDeclare = declarer({ valid: '-a -A -c -f -F -g -G -i -I -l -n -p -r -t -u -x +a +A +c +f +F +g +G +i +I +l +n +p +r +t +u +x', none: '-f -F -p +p', any: '-n', globals: '-g -G', conflicts: 'a A' })
  const bashExport = declarer({ valid: '-a -A -f -n -p', none: '-f', global: true, plusOperands: true })
  const zshConverts = { converts: '-a -A -E -F -i -l -u', widths: '-L -R -Z', effective: true as const, digits: true as const }
  const zshTypeset = declarer({ valid: '-a -A -E -f -F -g -h -H -i -k -l -L -m -p -r -R -t -T -u -U -x -z -Z +a +A +E +f +F +g +h +H +i +k +l +L +m +p +r +R +t +u +U +x +z +Z', none: '-f +f -p +p', patterns: '-m +m', globals: '-g -x +x', ...zshConverts })
  const zshExport = declarer({ valid: '-a -E -f -F -h -H -i -l -L -p -r -R -t -T -u -U -Z +a +E +f +F +h +H +i +l +L +p +r +R +t +u +U +Z', none: '-f +f -p +p', global: true, ...zshConverts })
  const zshReadonly = declarer({ valid: '-a -A -E -f -F -g -h -H -i -l -L -p -R -t -T -u -U -x -Z +a +A +E +f +F +g +h +H +i +l +L +p +R +t +u +U +x +Z', none: '-f +f -p +p', globals: '-g -x +x', ...zshConverts })
  const zshInteger = declarer({ valid: '-g -h -H -i -l -L -r -R -t -u -x -Z +g +h +H +i +l +L +r +R +t +u +x +Z', globals: '-g -x +x', converting: true, keeps: '+i', effective: true, digits: true })
  const zshFloat = declarer({ valid: '-E -F -g -h -H -l -L -r -R -t -u -x -Z +E +F +g +h +H +l +L +r +R +t +u +x +Z', globals: '-g -x +x', converting: true, keeps: '+E', effective: true, digits: true })
  return {
    bash: new Map([['declare', bashDeclare], ['typeset', bashDeclare], ['local', bashDeclare], ['export', bashExport], ['readonly', bashExport]]),
    zsh: new Map([['declare', zshTypeset], ['typeset', zshTypeset], ['local', declarer({ valid: ZSH_LOCAL_LETTERS, none: '-p +p', digits: true })], ['private', declarer({ valid: `${ZSH_LOCAL_LETTERS} -m +m`, none: '-p +p', patterns: '-m +m', digits: true })], ['export', zshExport], ['readonly', zshReadonly], ['integer', zshInteger], ['float', zshFloat]]),
  }
})()

/** How one shell's other builtin that names variables reads its arguments, for rule A4, from the same sources as DECLARERS. Each option field holds signed option letters. A word with a letter outside `valid`, when the entry has it, makes the builtin fail and assign nothing, and so does a letter of `none`. A letter of `takes` takes the rest of its word, or else the next word, as its value; the value of a letter of `named` names a variable that the builtin assigns, and that of a letter of `calls` a function that it runs in this shell. A letter of `any` lets it assign any variable, and so does a call without a letter of `listing`, when the entry has it. `operands` says which operands name variables that it assigns, `fixed` the variables that it always assigns, and `fallback` those that it assigns when no operand or option names one. With `strict`, a literal operand that is no name makes it fail: with `fail` it assigns nothing, and with `stop` only the names before that operand; with `prompt`, its first operand may end with `?` and a prompt, and an operand that is a number, which an option before it can take, names nothing. With `pids`, it also assigns NAME_PID for each NAME; with `plusOptions`, a word that starts with `+` holds options, else it is an operand. With `last`, only the last value of its `named` letters counts. With `words`, only those whole words are options, and any other word starts the operands; with `firstOnly`, only its first word can be an option; with `endsAtName`, its options end after a value of a `named` letter, and with `endsWith`, after the word that holds that letter. With `single`, more than one operand makes it fail; so does more than one with the letter `oneWith`, and with the letter `nameless` its operands name nothing. */
type Assigner = { valid?: ReadonlySet<string>; none: ReadonlySet<string>; takes: ReadonlySet<string>; named: ReadonlySet<string>; calls: ReadonlySet<string>; any: ReadonlySet<string>; listing?: ReadonlySet<string>; operands?: 'all' | 'first'; fixed: readonly string[]; fallback?: (letters: readonly string[]) => readonly string[]; strict?: 'fail' | 'stop'; prompt?: true; pids?: true; plusOptions?: true; last?: true; words?: ReadonlySet<string>; firstOnly?: true; endsAtName?: true; endsWith?: string; single?: true; oneWith?: string; nameless?: string }

/** An Assigner from its letters as text. */
function assigner(entry: { valid?: string; none?: string; takes?: string; named?: string; calls?: string; any?: string; listing?: string; operands?: 'all' | 'first'; fixed?: string; fallback?: (letters: readonly string[]) => readonly string[]; strict?: 'fail' | 'stop'; prompt?: true; pids?: true; plusOptions?: true; last?: true; words?: string; firstOnly?: true; endsAtName?: true; endsWith?: string; single?: true; oneWith?: string; nameless?: string }): Assigner {
  return { ...entry, valid: entry.valid === undefined ? undefined : optionSet(entry.valid), none: optionSet(entry.none), takes: optionSet(entry.takes), named: optionSet(entry.named), calls: optionSet(entry.calls), any: optionSet(entry.any), listing: entry.listing === undefined ? undefined : optionSet(entry.listing), fixed: [...optionSet(entry.fixed)], words: entry.words === undefined ? undefined : optionSet(entry.words) }
}

/** The other builtins that name or assign variables in each shell, as Assigner says. Every other builtin of SHELL_COMMANDS assigns no variable, apart from those of ASSIGNS_ANY and `eval`, `trap`, `alias`, `let`, `[[`, `getopts`, `emulate`, and `zstyle`, which `commandChanges` reads itself. */
const NAMERS: Readonly<Record<Shell, ReadonlyMap<string, Assigner>>> = (() => {
  const mapfile = assigner({ valid: '-C -c -d -n -O -s -t -u', takes: '-C -c -d -n -O -s -u', any: '-C', operands: 'first', fallback: () => ['MAPFILE'] })
  const folder = assigner({ fixed: 'OLDPWD' })
  const fc = assigner({ takes: '-e', listing: '-l' })
  const select = assigner({ valid: '', operands: 'first', fixed: 'REPLY' })
  const zshRead = { none: '-c -e -l', oneWith: '-A', operands: 'all' as const, strict: 'fail' as const, prompt: true as const, fallback: (letters: readonly string[]) => (letters.includes('-A') ? ['reply'] : ['REPLY']) }
  return {
    bash: new Map([
      ['read', assigner({ valid: '-a -d -e -E -i -n -N -p -r -s -t -u', takes: '-a -d -i -n -N -p -t -u', named: '-a', last: true, nameless: '-a', operands: 'all', strict: 'stop', fallback: () => ['REPLY'] })],
      ['mapfile', mapfile], ['readarray', mapfile],
      ['printf', assigner({ valid: '-v', takes: '-v', named: '-v', last: true })],
      ['wait', assigner({ valid: '-f -n -p', takes: '-p', named: '-p', last: true })],
      ['compgen', assigner({ valid: '-a -A -b -c -C -d -e -f -F -g -G -j -k -o -P -s -S -u -v -V -W -X', takes: '-A -C -F -G -o -P -S -V -W -X', named: '-V', calls: '-F', last: true })],
      ['unset', assigner({ valid: '-f -n -v', none: '-f', operands: 'all' })],
      ['enable', assigner({ takes: '-f', any: '-f' })],
      ['coproc', assigner({ operands: 'first', fixed: 'COPROC COPROC_PID', pids: true })],
      ['select', select], ['fc', fc], ['cd', folder], ['pushd', folder], ['popd', folder],
    ]),
    zsh: new Map([
      ['read', assigner({ valid: '-A -c -d -e -E -k -l -n -p -q -r -s -t -u -z', takes: '-d -u', ...zshRead })],
      ['getln', assigner({ valid: '-A -c -e -E -l -n', ...zshRead })],
      ['printf', assigner({ valid: '-v', words: '-v', takes: '-v', named: '-v', last: true })],
      ['print', assigner({ valid: '-a -b -c -C -D -e -E -f -i -l -m -n -N -o -O -P -r -R -s -S -u -v -x -X -z', none: '-e -E -s -S -z', takes: '-C -f -u -v -x -X', named: '-v', last: true, endsWith: '-R' })],
      ['set', assigner({ none: '-b -c -i -j -m -n -q -t -z -Z +b +c +j +q +z', takes: '-A +A -o +o', named: '-A +A', endsAtName: true, plusOptions: true })],
      ['vared', assigner({ valid: '-a -A -c -e -f -g -h -i -m -M -p -r -t', takes: '-f -i -M -m -p -r -t', operands: 'all', strict: 'fail', single: true })],
      ['zformat', assigner({ valid: '-a -f -F', takes: '-a -f -F', named: '-a -f -F', firstOnly: true })],
      ['strftime', assigner({ valid: '-n -q -r -s', takes: '-s', named: '-s' })],
      ['zstat', assigner({ valid: '-A -f -F -g -H -l -L -n -N -o -r -s -t -T', takes: '-A -f -F -H', named: '-A -H' })],
      ['unset', assigner({ valid: '-f -m -v', none: '-f', any: '-m', operands: 'all', strict: 'fail' })],
      ['foreach', assigner({ operands: 'first' })],
      ['select', select], ['fc', fc], ['cd', folder], ['chdir', folder], ['pushd', folder], ['popd', folder],
    ]),
  }
})()

/** The variables that `=~` in `[[` assigns in each shell. */
const MATCHES: Readonly<Record<Shell, readonly string[]>> = { bash: ['BASH_REMATCH'], zsh: ['MATCH', 'MBEGIN', 'MEND', 'match', 'mbegin', 'mend'] }

/** The builtins that can assign any variable in each shell: they run code that Arrester does not read at that point, load modules that add parameters, or name variables in ways that it does not follow. */
const ASSIGNS_ANY: Readonly<Record<Shell, ReadonlySet<string>>> = { bash: new Set(['source', '.']), zsh: new Set(['source', '.', 'r', 'zmodload', 'zparseopts', 'zregexparse']) }

/** The words before a program that run it in this shell. */
const PREFIXES = new Set(['builtin', 'command', 'time'])

/** The zsh precommand modifiers, which also run the program in this shell; `repeat` takes a count first. */
const ZSH_PREFIXES = new Set(['noglob', 'nocorrect', '-', 'repeat'])

/** The operators of `[[` whose operands are arithmetic, where an assignment can stand. */
const ARITHMETIC_TESTS = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])

/** What the commands of a tree can assign. By default, in this shell or in a subshell: each assignment and arithmetic step in their text, also in substitutions and in heredocs that the shell expands, `for` loop names, `{NAME}` before a redirection, the names that NAMES_VARIABLES and NAMED_BY_OPTION name, and the code that `eval`, `trap`, and `alias` give. A builtin of ASSIGNS_ANY, a name reference that `-n` declares, a name that is not literal text, a command whose program word is not literal text, which can run any builtin or function, and code that does not parse can assign any variable. With `exact`, as rule A4 counts, only what the commands assign in the shell that runs the tree, and no text that is data: the assignments before a program, `${NAME=word}` and `${NAME:=word}`, the assignments and steps of arithmetic (`$(( … ))`, `(( … ))`, `let`, and the arithmetic operands of `[[`), also in heredocs that the shell expands, `for` loop names, `{NAME}` before a redirection, the names of NAMES_VARIABLES, NAMED_BY_OPTION, and `getopts`, and the code of `eval` and `trap`, but not the text of an `alias` command, which runs only where the alias is used; the code of a subshell, a substitution, a stage of a pipeline before its last, a list in the background, and the body of a function that the tree defines does not count. */
function changesOf(walk: Walk, commands: readonly Pipeline[], changes: Changes = noChanges(), depth = 0): Changes {
  const visit = (command: Simple): void => commandChanges(walk, command, changes, depth)
  if (changes.exact) visitShell(walk, commands, visit)
  else visitCommands(walk, commands, visit)
  return changes
}

/** Calls `visit` for each command of a tree that runs in the shell that runs the tree, as `visitCommands` does, but without the bodies of subshells and of the functions that the tree defines, the stages of a pipeline before its last, and the lists that run in the background. */
function visitShell(walk: Walk, commands: readonly Pipeline[], visit: (command: Simple) => void): void {
  const pending: (readonly Pipeline[])[] = [commands]
  while (pending.length > 0) {
    const list = pending.pop()!
    let start = 0
    if (!walk.tick(list.length)) return
    for (const [index, pipeline] of list.entries()) {
      if (['&&', '||'].includes(pipeline.after)) continue
      const group = list.slice(start, index + 1)
      start = index + 1
      if (pipeline.after === '&') continue
      if (!walk.tick(group.length)) return
      for (const { commands: stages } of group) {
        const command = stages[stages.length - 1]
        if (command === undefined || command.definition !== undefined) continue
        const work = commandWork(command)
        if (!walk.charge(work) || !walk.tick(work)) return
        visit(command)
        if (command.subshell) continue
        pending.push(command.body ?? [], command.loop?.condition ?? [], ...(command.branches ?? []).flatMap(branch => [branch.condition ?? [], branch.body]), ...(command.cases?.clauses ?? []).map(clause => clause.body))
      }
    }
  }
}

/** Adds what one command of a tree can assign to `changes`, as `changesOf` says. */
function commandChanges(walk: Walk, command: Simple, changes: Changes, depth: number): void {
  const add = (name: string): void => {
    changes.names.set(name, (changes.names.get(name) ?? 0) + 1)
  }
  if (command.loop?.name !== undefined) add(command.loop.name)
  const words = [...command.words, ...command.loop?.words ?? [], ...command.cases === undefined ? [] : [command.cases.word, ...command.cases.clauses.flatMap(clause => clause.patterns)], ...command.redirects.map(redirect => redirect.target)]
  const heredocs = command.redirects.flatMap(redirect => (redirect.heredoc === undefined || redirect.heredoc.quoted ? [] : [redirect.heredoc.text]))
  if (changes.exact) {
    for (const word of words) expansionChanges(walk, word, add)
    for (const text of heredocs) {
      const read = walk.charge(text.length) ? heredocWord(text, true) ?? heredocWord(text) : undefined
      if (read === undefined) changes.all = true
      else expansionChanges(walk, read.word, add)
    }
    const arithmetic = arithmeticOf(command)
    if (arithmetic !== undefined) arithmeticChanges(walk, arithmetic, add)
  } else {
    const text = [...words.map(sourceText), ...heredocs].join(' ')
    if (!walk.charge(text.length) || !walk.tick(4 * text.length)) return
    for (const name of arithmeticNames(text)) add(name)
  }
  if (command.redirects.length > 0) for (const word of command.words) {
    const named = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(wordText(word))?.[1]
    if (named !== undefined) add(named)
  }
  const textAt = (index: number): string => wordText(command.words[index] ?? [])
  const shells = shellsOf(changes)
  if (!walk.tick(shells.length * (1 + command.words.length))) return
  let at = 0
  let runs = true
  while (at < command.words.length) {
    const text = textAt(at)
    const assigned = ASSIGNMENT.exec(text)?.[1] ?? ELEMENT.exec(text)?.[1]
    if (assigned !== undefined) {
      if (changes.exact) add(assigned)
      at += 1
    } else if (KEYWORDS.has(text)) at += 1
    else if (PREFIXES.has(text) || (ZSH_PREFIXES.has(text) && shells.includes('zsh'))) {
      if (text === 'command' && !shells.includes('bash')) runs = false
      at += text === 'repeat' ? 2 : 1
      while (PREFIXES.has(text) && textAt(at).length > 1 && textAt(at).startsWith('-')) {
        if (text === 'command' && /^-[A-Za-z]*[vV]/.test(textAt(at))) runs = false
        at += 1
      }
    } else break
  }
  const program = command.words[at]?.every(part => part.kind === 'text') === true ? textAt(at) : ''
  const args = command.words.slice(at + 1)
  const literal = (word: Word | undefined): boolean => word?.every(part => part.kind === 'text') === true
  if (program === '') {
    if (at < command.words.length) changes.all = true
    return
  }
  if (!runs) return
  changes.calls.add(program)
  if (shells.some(shell => ASSIGNS_ANY[shell].has(program))) changes.all = true
  else if (program === 'eval') {
    if (args.every(literal)) scanText(walk, args.map(wordText).join(' '), changes, depth)
    else changes.all = true
  } else if (program === 'trap') {
    const code = args.find(word => !['-p', '-l', '--'].includes(wordText(word)))
    if (code !== undefined && literal(code)) scanText(walk, wordText(code), changes, depth)
    else if (code !== undefined) changes.all = true
  } else if (program === 'alias' && !changes.exact) {
    for (const word of args) {
      if (!literal(word)) changes.all = true
      else if (wordText(word).includes('=')) scanText(walk, wordText(word).slice(wordText(word).indexOf('=') + 1), changes, depth)
    }
  } else if (program === 'let') {
    if (!args.every(literal)) changes.all = true
    else if (changes.exact) arithmeticChanges(walk, args.map(wordText).join(' '), add)
  } else if (program === '[[') {
    if (changes.exact) for (const [index, word] of args.entries()) {
      if (ARITHMETIC_TESTS.has(wordText(word))) arithmeticChanges(walk, [args[index - 1], args[index + 1]].map(operand => sourceText(operand ?? [])).join(' '), add)
      if (wordText(word) === '=~') for (const shell of shells) for (const name of MATCHES[shell]) add(name)
    }
  } else if (program === 'getopts') {
    if (/^-./.test(wordText(args[0] ?? [])) && wordText(args[0] ?? []) !== '--') return
    if (changes.exact) for (const name of ['OPTARG', 'OPTIND']) add(name)
    const operands = wordText(args[0] ?? []) === '--' ? args.slice(1) : args
    const named = operands[0]?.every(part => part.kind === 'text') !== false
    for (const word of operands.slice(1, named ? 2 : undefined)) nameIn(word, changes, add)
  } else if (program === 'emulate' && shells.includes('zsh')) {
    const mode = args.findIndex(word => !/^[-+]/.test(wordText(word)))
    const flag = args.findIndex(word => wordText(word) === '-c')
    const code = flag < 0 || args.slice(0, mode < 0 ? args.length : mode).some(word => !/^-R+$/.test(wordText(word))) ? undefined : args[flag + 1]
    if (code !== undefined && literal(code)) scanText(walk, wordText(code), changes, depth)
    else if (code !== undefined) changes.all = true
  } else if (program === 'zstyle' && shells.includes('zsh')) {
    const flag = wordText(args[0] ?? [])
    if (flag === '-e') changes.all = true
    else if (flag === '-g') nameIn(args[1], changes, add)
    else if (['-s', '-b', '-a'].includes(flag)) nameIn(args[3], changes, add)
  } else if (shells.some(shell => DECLARERS[shell].has(program))) declarationChanges(walk, program, args, changes, add)
  else for (const name of assignedBy(walk, program, args, changes)) add(name)
}

/** Rule A4 for one builtin of the declare family in each shell that the code can run in, as DECLARERS says: adds each name that it assigns, with a value or by a conversion, and records in `locals` each name that every such shell declares as the function's own. Outside rule A4, a declaration counts as global and every name counts. A name reference, a pattern, an option word that is not literal text, and a name that is not literal text can assign any variable. */
function declarationChanges(walk: Walk, program: string, args: readonly Word[], changes: Changes, add: (name: string) => void): void {
  const assigned = new Set<string>()
  let locals: Set<string> | undefined
  for (const shell of shellsOf(changes)) {
    const own = new Set<string>()
    const entry = DECLARERS[shell].get(program)
    if (entry !== undefined) declared(walk, entry, args, changes, assigned, own)
    if (!walk.tick(1 + own.size + (locals?.size ?? 0))) return
    locals = locals === undefined ? own : new Set([...locals].filter(name => own.has(name)))
  }
  for (const name of assigned) add(name)
  for (const name of locals ?? []) if (!assigned.has(name)) changes.locals.add(name)
}

/** What one shell's builtin of the declare family does with its operands, as `declarationChanges` says: adds to `assigned` the names that it assigns, and to `own` those that it declares as the function's own. Its options end at `--`, at `-`, and at its first operand. */
function declared(walk: Walk, entry: Declarer, args: readonly Word[], changes: Changes, assigned: Set<string>, own: Set<string>): void {
  const letters: string[] = []
  let digits = false
  let index = 0
  for (; index < args.length; index += 1) {
    const text = wordText(args[index]!)
    if (text === '--' || text === '-') {
      index += 1
      break
    }
    if (!/^[-+]/.test(text) || (text.startsWith('+') && entry.plusOperands === true)) break
    if (!args[index]!.every(part => part.kind === 'text')) {
      changes.all = true
      return
    }
    for (const letter of text.slice(1)) {
      if (entry.digits === true && /[0-9]/.test(letter)) digits = true
      else letters.push(`${text[0]}${letter}`)
    }
  }
  const operands = args.slice(index)
  if (!walk.tick(1 + 4 * letters.length + operands.length)) return
  const signed = new Set(letters)
  const ties = signed.has('-T')
  if (letters.some(letter => !entry.valid.has(letter) || entry.none.has(letter) || (entry.conflicts.has(letter.slice(1)) && signed.has(`${letter[0] === '-' ? '+' : '-'}${letter.slice(1)}`))) || (ties && operands.length < 2)) return
  const lastSign = new Map(letters.map(letter => [letter.slice(1), letter[0]]))
  const last = (letter: string): boolean => lastSign.get(letter.slice(1)) === letter[0]
  const holds = (set: ReadonlySet<string>): boolean => [...set].some(letter => (entry.effective === true ? last(letter) : signed.has(letter)))
  if ([...entry.any].some(last)) changes.all = true
  const patterns = letters.some(letter => entry.patterns.has(letter))
  const global = !changes.exact || entry.global === true || holds(entry.globals)
  const width = digits || /^[0-9]+$/.test(wordText(operands[0] ?? []))
  const converts = entry.converting === true ? !holds(entry.keeps) : holds(entry.converts) || (holds(entry.widths) && width)
  for (const [position, word] of operands.entries()) {
    const changed = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(wordText(word)) || converts || (ties && position === 1)
    if (patterns) {
      if (changed) changes.all = true
      continue
    }
    nameIn(word, changes, name => {
      if (!global) own.add(name)
      else if (!changes.exact || changed) assigned.add(name)
    })
  }
}

/** The options of a builtin of NAMERS, read as one shell reads them: the signed letters, the values of its `named` letters, the functions that its `calls` letters name, and the operands after the options; undefined when an option word is not literal text. Its options end at `--`, at a lone `-`, and at its first operand. */
function builtinOptions(entry: Assigner, args: readonly Word[]): { letters: string[]; named: (Word | undefined)[]; called: Word[]; operands: Word[]; fails?: true } | undefined {
  const letters: string[] = []
  const named: (Word | undefined)[] = []
  const called: Word[] = []
  let index = 0
  for (; index < args.length; index += 1) {
    const text = wordText(args[index]!)
    if (text === '--') {
      index += 1
      break
    }
    if (text.length < 2 || !(text.startsWith('-') || (text.startsWith('+') && entry.plusOptions === true)) || (entry.words !== undefined && !entry.words.has(text))) break
    if (!args[index]!.every(part => part.kind === 'text')) return undefined
    let ends = entry.firstOnly === true
    for (let at = 1; at < text.length; at += 1) {
      const letter = `${text[0]}${text[at]}`
      letters.push(letter)
      if (letter === entry.endsWith) ends = true
      if (!entry.takes.has(letter)) continue
      let value: Word | undefined = [{ kind: 'text', text: text.slice(at + 1), quoted: false }]
      if (at + 1 === text.length) {
        index += 1
        value = args[index]
        if (value === undefined) return { letters, named: [], called: [], operands: [], fails: true }
      }
      if (entry.named.has(letter)) {
        named.push(value)
        if (entry.endsAtName === true) ends = true
      }
      if (entry.calls.has(letter) && value !== undefined) called.push(value)
      break
    }
    if (ends) {
      index += 1
      break
    }
  }
  return { letters, named, called, operands: args.slice(index) }
}

/** The variables that a builtin of NAMERS assigns in each shell that the code can run in. It marks `changes` when the builtin can assign any variable, and adds the functions that it runs to the calls. */
function assignedBy(walk: Walk, program: string, args: readonly Word[], changes: Changes): Set<string> {
  const names = new Set<string>()
  for (const shell of shellsOf(changes)) {
    const entry = NAMERS[shell].get(program)
    if (entry === undefined) continue
    const options = builtinOptions(entry, args)
    if (!walk.tick(1 + 4 * (options?.letters.length ?? 0) + args.length)) break
    if (options === undefined) {
      changes.all = true
      continue
    }
    const { letters, named, called, operands } = options
    if (options.fails === true || letters.some(letter => (entry.valid !== undefined && !entry.valid.has(letter)) || entry.none.has(letter))) continue
    if (letters.some(letter => entry.any.has(letter)) || (entry.listing !== undefined && !letters.some(letter => entry.listing!.has(letter)))) {
      changes.all = true
      continue
    }
    for (const word of called) {
      if (word.every(part => part.kind === 'text')) changes.calls.add(wordText(word))
      else changes.all = true
    }
    if ((entry.single === true && operands.length > 1) || (entry.oneWith !== undefined && letters.includes(entry.oneWith) && operands.length > 1)) continue
    const words = entry.nameless !== undefined && letters.includes(entry.nameless) ? [] : entry.operands === 'all' ? operands : entry.operands === 'first' ? operands.slice(0, 1) : []
    const own: string[] = []
    for (const word of entry.last === true ? named.slice(-1) : named) nameIn(word, changes, name => own.push(name))
    let fails = false
    for (const [position, word] of words.entries()) {
      if (!word.every(part => part.kind === 'text')) nameIn(word, changes, name => own.push(name))
      else {
        const text = entry.prompt === true && position === 0 ? wordText(word).replace(/\?[^]*$/, '') : wordText(word)
        if (/^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?$/.test(text)) own.push(text.replace(/\[[^]*$/, ''))
        else if (entry.prompt === true && /^[0-9]+$/.test(text)) continue
        else if (entry.strict === 'stop') break
        else if (entry.strict === 'fail') fails = true
      }
    }
    if (fails) continue
    for (const name of own) {
      names.add(name)
      if (entry.pids === true) names.add(`${name}_PID`)
    }
    for (const name of entry.fixed) names.add(name)
    if (words.length === 0 && named.length === 0) for (const name of entry.fallback?.(letters) ?? []) names.add(name)
  }
  return names
}

/** Adds the variables that the expansions of a word assign in the shell that expands it: `${NAME=word}` and `${NAME:=word}`, and each assignment and step in an arithmetic expansion and in a `${…}` form that the lexer did not read, also inside the word of a parameter operator and in the elements of an array assignment. A substitution runs in a subshell and assigns none. */
function expansionChanges(walk: Walk, word: Word, add: (name: string) => void): void {
  if (!walk.tick(word.length)) return
  for (const part of word) {
    if (part.kind === 'param') {
      if (part.op === '=' || part.op === ':=') add(part.name)
      expansionChanges(walk, part.word, add)
    } else if (part.kind === 'array') for (const element of part.elements) expansionChanges(walk, element, add)
    else if (part.kind === 'unknown') arithmeticChanges(walk, unknownSource(part), add)
  }
}

/** Whether a UTF-16 code unit is white space, as `\s` in a regular expression without the `u` flag says. */
function isSpace(code: number): boolean {
  return (code >= 9 && code <= 13) || code === 32 || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff
}

/** Whether a UTF-16 code unit can start a shell name: an ASCII letter or `_`. */
function isNameStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
}

/** Whether a UTF-16 code unit can stand in a shell name: an ASCII letter, a digit, or `_`. */
function isNamePart(code: number): boolean {
  return isNameStart(code) || (code >= 48 && code <= 57)
}

/** Adds each assignment and arithmetic step that `arithmeticNames` finds in a text of arithmetic or of a `${…}` form. */
function arithmeticChanges(walk: Walk, text: string, add: (name: string) => void): void {
  if (!walk.charge(text.length) || !walk.tick(4 * text.length)) return
  for (const name of arithmeticNames(text)) add(name)
}

/** The text of `(( … ))`, which the parser reads as subshells, the outer one `arithmetic` since its `(` comes right before the next: the words and the redirection targets of the commands inside, at any depth, as typed; undefined for any other command, also for `( ( … ) )` with a space, which is two subshells. */
function arithmeticOf(command: Simple): string | undefined {
  if (!command.subshell || command.arithmetic !== true) return undefined
  const words: Word[] = []
  const pending = [...command.body ?? []]
  while (pending.length > 0) {
    for (const simple of pending.pop()!.commands) {
      words.push(...simple.words, ...simple.redirects.map(redirect => redirect.target))
      pending.push(...simple.body ?? [])
    }
  }
  return words.map(sourceText).join(' ')
}

/** Adds the variable that an operand of a builtin names, such as `F`, `F[0]`, or `F=value`; an operand whose name is not literal text can name any variable. */
function nameIn(word: Word | undefined, changes: Changes, add: (name: string) => void): void {
  const [first] = word ?? []
  const literal = word?.every(part => part.kind === 'text') === true
  const name = first?.kind === 'text' ? (literal ? /^[A-Za-z_][A-Za-z0-9_]*/ : /^[A-Za-z_][A-Za-z0-9_]*(?=\[|\+?=)/).exec(first.text)?.[0] : undefined
  if (name !== undefined) add(name)
  else if (word !== undefined && !literal) changes.all = true
}

/** Adds what shell code given as text can assign, as `changesOf` says; code that does not parse, or nests past MAX_DEPTH, can assign any variable. */
function scanText(walk: Walk, text: string, changes: Changes, depth: number): void {
  if (depth >= MAX_DEPTH || !walk.charge(text.length) || !walk.tick(2 * (1 + text.length))) {
    changes.all = true
    return
  }
  const modern = readCommands(lex(text, true), true)
  const commands = typeof modern === 'string' ? readCommands(lex(text), false) : modern
  if (typeof commands === 'string') changes.all = true
  else changesOf(walk, commands, changes, depth + 1)
}

/** The text of a word for the change scan: its text as typed, quotes removed, with the source text of each arithmetic expansion and each `${…}` form that the lexer did not read. */
function sourceText(word: Word): string {
  return word.map(part => (part.kind === 'unknown' ? unknownSource(part) : part.kind === 'param' ? `\${${part.name}${part.op}${sourceText(part.word)}}` : part.kind === 'array' ? `(${part.elements.map(sourceText).join(' ')})` : wordText([part]))).join('')
}

/** The builtins of bash and zsh, also those of the zsh modules that zsh loads by itself, and the reserved words that can stand where a command name stands but that the profile does not hold as structure: `!`, `[[`, `time`, `select`, `coproc`, `function`, and zsh `repeat`, `foreach`, `nocorrect`, `noglob`, and `-`. The builtins of a zsh module that only `zmodload` loads, such as `rm` of `zsh/files`, are left out, since `zmodload` is not allowed either. */
const SHELL_COMMANDS = new Set([
  '.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen', 'complete', 'compopt', 'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false', 'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly', 'return', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
  '-', 'autoload', 'bindkey', 'bye', 'chdir', 'compadd', 'comparguments', 'compcall', 'compctl', 'compdescribe', 'compfiles', 'compgroups', 'compquote', 'comptags', 'comptry', 'compvalues', 'disable', 'echotc', 'echoti', 'emulate', 'float', 'functions', 'getln', 'integer', 'limit', 'nocorrect', 'noglob', 'print', 'private', 'pushln', 'r', 'rehash', 'sched', 'setopt', 'strftime', 'ttyctl', 'unfunction', 'unhash', 'unlimit', 'unsetopt', 'vared', 'whence', 'where', 'which', 'zcompile', 'zformat', 'zle', 'zmodload', 'zparseopts', 'zregexparse', 'zstat', 'zstyle',
  '!', '[[', ']]', 'time', 'select', 'coproc', 'function', 'repeat', 'foreach', 'end',
])

/** The builtins that a call that needs the newer reading may run, as `outsideProfile` says. */
const ALLOWED_BUILTINS = new Set(['echo', 'cd', 'true', 'false', ':'])

/** The special parameters that an expansion in double quotes may name in the profile: `$1` to `$9`, `$#`, `$?`, `$$`, `$!`, and `$@`. */
const PLAIN_SPECIALS = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', '#', '?', '$', '!', '@'])

/** The parameters that bash or zsh set or use by themselves: the shell variables of the bash manual, also those of the Bourne shell, and the parameters that zsh sets and uses, also those of its modules, of zle, and of its tables of aliases, functions, commands, and hooks. An assignment of one of them changes what the narrow reading does not follow: IFS how words split, PATH and CDPATH which program runs and where `cd` goes, HISTSIZE in zsh an arithmetic value, and PS4 code that `set -x` runs. */
const SPECIAL = new Set([
  'IFS', 'PS4', 'PROMPT4', '_', 'CDPATH', 'HOME', 'MAIL', 'MAILPATH', 'PATH', 'PS1', 'PS2',
  'BASH', 'BASHOPTS', 'BASHPID', 'BASH_ALIASES', 'BASH_ARGC', 'BASH_ARGV', 'BASH_ARGV0', 'BASH_CMDS', 'BASH_COMMAND', 'BASH_COMPAT', 'BASH_ENV', 'BASH_EXECUTION_STRING', 'BASH_LINENO', 'BASH_LOADABLES_PATH', 'BASH_MONOSECONDS', 'BASH_REMATCH', 'BASH_SOURCE', 'BASH_SUBSHELL', 'BASH_TRAPSIG', 'BASH_VERSINFO', 'BASH_VERSION', 'BASH_XTRACEFD', 'CHILD_MAX', 'COLUMNS', 'COMP_CWORD', 'COMP_KEY', 'COMP_LINE', 'COMP_POINT', 'COMP_TYPE', 'COMP_WORDBREAKS', 'COMP_WORDS', 'COMPREPLY', 'COPROC', 'DIRSTACK', 'EMACS', 'ENV', 'EPOCHREALTIME', 'EPOCHSECONDS', 'EUID', 'EXECIGNORE', 'FCEDIT', 'FIGNORE', 'FUNCNAME', 'FUNCNEST', 'GLOBIGNORE', 'GLOBSORT', 'GROUPS', 'histchars', 'HISTCMD', 'HISTCONTROL', 'HISTFILE', 'HISTFILESIZE', 'HISTIGNORE', 'HISTSIZE', 'HISTTIMEFORMAT', 'HOSTFILE', 'HOSTNAME', 'HOSTTYPE', 'IGNOREEOF', 'INPUTRC', 'INSIDE_EMACS', 'LANG', 'LC_ALL', 'LC_COLLATE', 'LC_CTYPE', 'LC_MESSAGES', 'LC_NUMERIC', 'LC_TIME', 'LINENO', 'LINES', 'MACHTYPE', 'MAILCHECK', 'MAPFILE', 'OLDPWD', 'OPTARG', 'OPTERR', 'OPTIND', 'OSTYPE', 'PIPESTATUS', 'POSIXLY_CORRECT', 'PPID', 'PROMPT_COMMAND', 'PROMPT_DIRTRIM', 'PS0', 'PS3', 'PWD', 'RANDOM', 'READLINE_ARGUMENT', 'READLINE_LINE', 'READLINE_MARK', 'READLINE_POINT', 'REPLY', 'SECONDS', 'SHELL', 'SHELLOPTS', 'SHLVL', 'SRANDOM', 'TIMEFORMAT', 'TMOUT', 'TMPDIR', 'UID', 'auto_resume',
  'ARGC', 'argv', 'status', 'pipestatus', 'CPUTYPE', 'EGID', 'ERRNO', 'GID', 'HOST', 'LOGNAME', 'signals', 'TRY_BLOCK_ERROR', 'TRY_BLOCK_INTERRUPT', 'TTY', 'TTYIDLE', 'USERNAME', 'VENDOR', 'ZSH_ARGZERO', 'ZSH_EVAL_CONTEXT', 'zsh_eval_context', 'ZSH_EXECUTION_STRING', 'ZSH_NAME', 'ZSH_PATCHLEVEL', 'zsh_scheduled_events', 'ZSH_SCRIPT', 'ZSH_SUBSHELL', 'ZSH_VERSION',
  'ARGV0', 'BAUD', 'cdpath', 'CORRECT_IGNORE', 'CORRECT_IGNORE_FILE', 'DIRSTACKSIZE', 'fignore', 'fpath', 'FPATH', 'HISTCHARS', 'HISTORY_IGNORE', 'KEYBOARD_HACK', 'KEYTIMEOUT', 'LISTMAX', 'mailpath', 'manpath', 'MANPATH', 'module_path', 'MODULE_PATH', 'NULLCMD', 'path', 'POSTEDIT', 'PROMPT', 'PROMPT2', 'PROMPT3', 'prompt', 'PROMPT_EOL_MARK', 'psvar', 'PSVAR', 'READNULLCMD', 'REPORTMEMORY', 'REPORTTIME', 'RPROMPT', 'RPS1', 'RPROMPT2', 'RPS2', 'SAVEHIST', 'SPROMPT', 'STTY', 'TERM', 'TERMINFO', 'TERMINFO_DIRS', 'TIMEFMT', 'TMPPREFIX', 'TMPSUFFIX', 'WORDCHARS', 'ZBEEP', 'ZDOTDIR', 'ZLE_LINE_ABORTED', 'ZLE_REMOVE_SUFFIX_CHARS', 'ZLE_RPROMPT_INDENT', 'ZLE_SPACE_SUFFIX_CHARS', 'LOGCHECK', 'WATCH', 'watch', 'WATCHFMT', 'ZLS_COLORS', 'ZLS_COLOURS', 'LISTPROMPT', 'MENUPROMPT', 'MENUSELECT',
  'MATCH', 'MBEGIN', 'MEND', 'match', 'mbegin', 'mend', 'reply', 'epochtime', 'errnos', 'sysparams', 'mapfile', 'langinfo', 'termcap', 'terminfo', 'BUFFER', 'CURSOR', 'LBUFFER', 'RBUFFER', 'WIDGET', 'KEYS', 'NUMERIC',
  'parameters', 'commands', 'functions', 'dis_functions', 'functions_source', 'dis_functions_source', 'builtins', 'dis_builtins', 'reswords', 'dis_reswords', 'options', 'patchars', 'dis_patchars', 'aliases', 'dis_aliases', 'galiases', 'dis_galiases', 'saliases', 'dis_saliases', 'modules', 'dirstack', 'history', 'historywords', 'jobdirs', 'jobtexts', 'jobstates', 'nameddirs', 'userdirs', 'usergroups', 'funcfiletrace', 'funcsourcetrace', 'funcstack', 'functrace',
  'chpwd_functions', 'precmd_functions', 'preexec_functions', 'periodic_functions', 'zshexit_functions', 'zshaddhistory_functions',
])

/** The first construct of a tree of commands outside the minimal profile, or undefined; `walkCall` makes a call that needs the modern reading opaque when the code that the walk parsed holds one. The profile: every simple command, at any depth, also in the code of each `$( )` and in an unquoted heredoc, has a command name that is literal text and that is no command of SHELL_COMMANDS but one of ALLOWED_BUILTINS; the structure is `case`, `if`, `for`, `while`, `until`, groups, pipelines, and lists, with no `!`; the tree defines no function and holds no `(( ))`; every expansion is one that `wordOutside` holds; each assignment, also as a `for` name, is `NAME=value`, `NAME=( … )`, or `NAME+=( … )` of a name that SPECIAL does not hold; and no redirection is `{name}`. Past MAX_DEPTH, nested code is outside the profile. */
function outsideProfile(walk: Walk, commands: readonly Pipeline[], depth = 0): string | undefined {
  for (const pipeline of commands) {
    if (pipeline.negate) return '!'
    for (const command of pipeline.commands) {
      const work = commandWork(command)
      if (!walk.charge(work) || !walk.tick(work)) return 'too much code'
      const nested = [...command.body ?? [], ...command.loop?.condition ?? [], ...(command.branches ?? []).flatMap(branch => [...branch.condition ?? [], ...branch.body]), ...(command.cases?.clauses ?? []).flatMap(clause => clause.body)]
      const found = commandOutside(walk, command, depth) ?? outsideProfile(walk, nested, depth)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** The construct of one command, apart from the commands in its body, outside the profile, as `outsideProfile` says, or undefined. The whole value of a scalar assignment, `NAME=` and one expansion, may be an unquoted expansion; every other word holds expansions only in double quotes. */
function commandOutside(walk: Walk, command: Simple, depth: number): string | undefined {
  if (command.definition !== undefined) return 'a function definition'
  if (arithmeticOf(command) !== undefined) return '(( ))'
  if (command.loop?.name !== undefined && SPECIAL.has(command.loop.name)) return command.loop.name
  if (command.redirects.length > 0 && command.words.some(word => /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(wordText(word)))) return '{name} redirection'
  const heredocs = command.redirects.flatMap(redirect => (redirect.heredoc === undefined || redirect.heredoc.quoted ? [] : [heredocWord(redirect.heredoc.text, true)?.word ?? []]))
  const cases = command.cases === undefined ? [] : [command.cases.word, ...command.cases.clauses.flatMap(clause => clause.patterns)]
  let at = 0
  for (; at < command.words.length; at += 1) {
    const word = command.words[at]!
    const match = ASSIGNMENT.exec(wordText(word))
    if (match === null) {
      if (ELEMENT.test(wordText(word))) return 'an element assignment'
      break
    }
    if (match[2] === '+' && !isArray(word)) return 'a scalar append'
    if (SPECIAL.has(match[1]!)) return match[1]!
    const [first, value] = word
    const whole = word.length === 2 && first?.kind === 'text' && !first.quoted && first.text === `${match[1]}=` && value !== undefined && value.kind !== 'text'
    const found = whole ? wordOutside(walk, [value], depth, true) : wordOutside(walk, word, depth)
    if (found !== undefined) return found
  }
  for (const word of [...command.words.slice(at), ...command.loop?.words ?? [], ...cases, ...command.redirects.map(redirect => redirect.target), ...heredocs]) {
    const found = wordOutside(walk, word, depth)
    if (found !== undefined) return found
  }
  const program = command.words[at]
  if (program === undefined) return undefined
  if (!program.every(part => part.kind === 'text')) return 'a command name that is not literal'
  const name = wordText(program)
  if (KEYWORDS.has(name) || (SHELL_COMMANDS.has(name) && !ALLOWED_BUILTINS.has(name))) return name
  return undefined
}

/** The expansion of one word outside the profile, or undefined. In double quotes it holds `"$name"`, `"${name}"`, the special parameters of PLAIN_SPECIALS, `"${name[@]}"` and `"${name[*]}"`, and `"$( )"` whose code the profile holds, read one level deeper; with `whole`, the word is the whole value of a scalar assignment and the expansion may stand unquoted. An unbraced `$name` must not come right before `[`, `:`, or `(`, as a zsh subscript, modifier, or glob qualifier does. Every other expansion is outside: one without double quotes, backticks, `${name:-word}`, `${#name}`, `${!name}`, a zsh flag, a subscript, an offset, `$*`, `$0`, arithmetic, also `$[ ]`, which the lexer leaves as text, and `<( )` or `>( )`. It reads the elements of an array assignment as words. */
function wordOutside(walk: Walk, word: Word, depth: number, whole = false): string | undefined {
  for (const [index, part] of word.entries()) {
    let found: string | undefined
    if (part.kind === 'text') {
      if (part.text.includes('$[')) found = '$[ ]'
    } else if (part.kind === 'array') for (const element of part.elements) found ??= wordOutside(walk, element, depth)
    else if ((part.kind === 'var' || part.kind === 'sub' || part.kind === 'elements') && !part.quoted && !whole) found = `an unquoted ${spellingOf(part) || 'expansion'}`
    else if (part.kind === 'var') {
      const next = word[index + 1]
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part.name) && !PLAIN_SPECIALS.has(part.name)) found = `$${part.name}`
      else if (!spellingOf(part).startsWith('${') && next?.kind === 'text' && /^[[:(]/.test(next.text)) found = `$${part.name}${next.text.charAt(0)}`
    } else if (part.kind === 'sub') {
      if (spellingOf(part).startsWith('`')) found = 'backticks'
      else if (depth >= MAX_DEPTH || !walk.charge(part.command.length) || !walk.tick(1 + part.command.length)) found = 'code nested too deep'
      else {
        const modern = readCommands(lex(part.command, true), true)
        const commands = typeof modern === 'string' ? readCommands(lex(part.command), false) : modern
        if (typeof commands !== 'string') found = outsideProfile(walk, commands, depth + 1)
      }
    } else if (part.kind === 'param') found = `\${${part.op === 'length' ? '#' : ''}${part.name}${part.op === 'length' ? '' : part.op}…}`
    else if (part.kind === 'unknown') found = unknownSource(part) || 'an expansion that Arrester does not read'
    else if (part.kind === 'process') found = `${part.isOutput ? '>' : '<'}( )`
    if (found !== undefined) return found
  }
  return undefined
}

/** Rule A4: after a call of each function or alias of `names` in this shell, each variable that a body of a called function can assign in this shell, as `changesOf` counts with `exact`, is unknown, as `setUnknown` says, so a deletion through it is opaque. The called functions are those of `names`, those that their bodies call, and those that the text of an alias of `names` calls; the alias text itself, and any other code, does not count, as on 1.1.3. A variable that a function body declares as its own, as `Changes` says, does not count for that body. An assignment of `HOME` or `PWD` makes only that one unknown. A body that can assign any variable makes every variable unknown, `HOME` and `PWD` too, except the variables that each such body declares as its own and that no other body can assign. A body that can assign any variable or runs `cd`, `pushd`, or `popd` leaves the folder and the previous folder unknown, and with `pushd` or `popd` the folder stack too. The positional parameters stay, since a call has its own. */
function forgetAssigned(walk: Walk, state: State, names: readonly string[]): void {
  const changes = noChanges(true)
  const spared = new Set<string>()
  const count = (own: Changes): void => {
    if (!walk.tick(1 + own.names.size + own.calls.size + own.locals.size)) return
    for (const [name, times] of own.names) if (!own.locals.has(name)) changes.names.set(name, (changes.names.get(name) ?? 0) + times)
    for (const program of own.calls) changes.calls.add(program)
    if (!own.all) return
    if (!changes.all) for (const name of own.locals) spared.add(name)
    else for (const name of spared) if (!own.locals.has(name)) spared.delete(name)
    changes.all = true
  }
  const seen = new Set<string>()
  const pending: string[] = []
  const enqueue = (program: string): void => {
    if (seen.has(program)) return
    seen.add(program)
    pending.push(program)
  }
  for (const name of names) enqueue(name)
  while (pending.length > 0 && !(changes.all && spared.size === 0)) {
    if (!walk.charge(1) || !walk.tick(3)) return
    const next = pending.pop()!
    const alias = state.named.get(next)
    if (alias !== undefined) {
      const calls = noChanges(true)
      scanText(walk, alias, calls, 0)
      for (const program of calls.calls) enqueue(program)
    }
    for (const body of walk.bodies.get(next) ?? []) {
      const own = changesOf(walk, [{ commands: [{ ...body, definition: undefined }], negate: false, after: '' }], noChanges(true, state.shell === 'bash' || state.shell === 'zsh' ? state.shell : undefined))
      count(own)
      for (const program of own.calls) enqueue(program)
    }
  }
  if (changes.all || [...changes.calls].some(program => DIRECTORY_CHANGERS.has(program) || program === 'chdir')) {
    state.cwd = undefined
    state.prev = undefined
    if (changes.all || changes.calls.has('pushd') || changes.calls.has('popd')) state.stack = [...state.stack.map(() => undefined), undefined]
  }
  if (!walk.charge(changes.all ? state.vars.size + state.possible.size + state.removed.size + state.reaching.size + state.arrays.size : changes.names.size)) return
  if (!walk.tick(1 + (changes.all ? state.vars.size + state.possible.size + state.removed.size + state.reaching.size + state.arrays.size : changes.names.size))) return
  const forgotten = changes.all ? [...state.vars.keys(), ...state.possible.keys(), ...state.removed, ...state.reaching, ...state.arrays.keys()].filter(name => !spared.has(name) || changes.names.has(name)) : [...changes.names.keys()]
  for (const name of forgotten) {
    if (POSITIONAL.test(name)) continue
    setUnknown(state, name)
  }
  if (changes.all) state.lost = true
}

/** Walks the text of the alias that a command's program word names, unquoted, with the command's other words and its redirections after it, one level deeper, in a copy of the shell and of its input, so the command still reads as it does without the alias; an alias does not expand again inside its own text. Returns the name of the alias when its text was walked, so rule A4 can reach the functions that it calls. */
async function expandAlias(walk: Walk, command: Simple, leading: number, state: State, piped: Stdin): Promise<string | undefined> {
  const word = command.words[leading]
  const name = word?.length === 1 && word[0]?.kind === 'text' && !word[0].quoted ? word[0].text : undefined
  const text = name === undefined || walk.expanding.has(name) ? undefined : state.named.get(name)
  if (name === undefined || text === undefined) return undefined
  if (walk.depth >= MAX_DEPTH) {
    walk.fail(OPAQUE.tooDeep)
    return undefined
  }
  if (!walk.charge(text.length)) return undefined
  const words = (list: readonly Word[]): Token[] => list.map(part => ({ type: 'word', word: part }))
  const commands = parseCommands(walk, modern => {
    const lexed = lex(text, modern)
    return 'error' in lexed ? lexed : { ...lexed, tokens: [...words(command.words.slice(0, leading)), ...lexed.tokens, ...words(command.words.slice(leading + 1)), ...command.redirects.map(redirect => ({ type: 'redirect' as const, redirect }))] }
  })
  if (commands === undefined) return undefined
  walk.expanding.add(name)
  walk.depth += 1
  await runList(walk, commands, fork(walk, state), copied(piped))
  walk.depth -= 1
  walk.expanding.delete(name)
  return name
}

/** Runs resolved command words, expanding each xargs invocation separately within the nesting and work limits; `called` names a function that the code defines, when the command calls one. A call of such a function whose body is not walked, as one that names `return` or `exit`, marks the walk `unread`. */
async function runCommand(walk: Walk, words: readonly Operand[], state: State, stdin: Stdin): Promise<{ program: string; output: Stdin; status?: boolean; called?: string }> {
  const stripped = stripWrappers(walk, words, state)
  const at = stripped.chdir === undefined ? stripped.state : { ...stripped.state, cwd: stripped.chdir.dir, execdir: undefined }
  if (stripped.chdir?.symbolic || (stripped.chdir !== undefined && state.execdir !== undefined && stripped.args.some(arg => arg.values?.some(value => value.selected)))) walk.fail(OPAQUE.variableCode)
  if (stripped.xargs !== undefined) {
    const xargs = stripped.xargs
    if (xargs.file !== undefined) addEffect({ walk, state: at, program: 'xargs', args: [], stdin }, xargs.file, 'read', false)
    if (walk.depth >= MAX_DEPTH) walk.fail(OPAQUE.tooDeep)
    else {
      const input = inputOf(walk, xargs, stdin)
      const batches = batchesOf(input, xargs)
      walk.depth += 1
      for (const batch of batches) {
        if (!walk.charge(stripped.args.length + batch.length)) break
        const args = xargsArgs(walk, stripped.args, xargs, batch)
        if (args !== undefined) await runCommand(walk, args, fork(walk, at), NONE)
      }
      walk.depth -= 1
    }
    if (stripped.replaces) state.terminated = true
    return { program: 'xargs', output: OTHER }
  }
  const [head, ...args] = stripped.args
  const word = head === undefined ? undefined : soleText(head)
  if (head !== undefined && word === undefined) walk.fail(OPAQUE.variableProgram)
  const run: Run = { walk, state: at, program: word === undefined ? '' : programOf(word, at.cwd), args, stdin }
  let status: boolean | undefined
  const body = word === undefined ? undefined : at.functions.get(word)
  if (body !== undefined) await callFunction(walk, body, args, at, stdin)
  else if (word !== undefined && walk.bodies.has(word)) walk.unread = true
  if (head !== undefined && word !== undefined) {
    addSegment(run)
    const result = await dispatch(run, head)
    if (typeof result === 'boolean') status = result
  }
  if (stripped.replaces) state.terminated = true
  return { program: run.program, output: produce(run), status, ...(word !== undefined && walk.bodies.has(word) ? { called: word } : {}) }
}

/** Walks the body of a function that a command calls, one level deeper, in a copy of the caller's shell with the call's arguments as its positional parameters and a copy of its input, so the call still reads as it does without the function. */
async function callFunction(walk: Walk, body: Simple, args: readonly Operand[], state: State, stdin: Stdin): Promise<void> {
  if (walk.depth >= MAX_DEPTH) {
    walk.fail(OPAQUE.tooDeep)
    return
  }
  const scope = fork(walk, state)
  setPositional(walk, scope, args)
  walk.depth += 1
  await runSimple(walk, body, scope, copied(stdin))
  walk.depth -= 1
}

/** A copy of a command's input that a walk can read without moving the original's position. */
function copied(stdin: Stdin): Stdin {
  return stdin.kind === 'literal' ? { ...stdin } : stdin
}

/** The program a command word names: its base name, or for a path to a program Arrester does not know, the script's absolute path. `claude` in any letter case, `claude-code`, and a `claude/versions/<version>` path name `claude`. */
function programOf(word: string, cwd: string | undefined): string {
  const name = basenameOf(word)
  const path = word.includes('/') ? (absolute(word, cwd) ?? word) : word
  if (CLAUDE_NAME.test(name) || CLAUDE_VERSION.test(path)) return 'claude'
  return word.includes('/') && !isKnown(name) ? path : name
}

/** Gives a command's operands their effects by the program's class, and walks or scans the code it runs. */
async function dispatch(run: Run, head: Operand): Promise<boolean | void> {
  const { program } = run
  if (program.includes('/')) await runScript(run, head, 'direct', run.args)
  else if (ASSIGNERS.has(program)) declare(run)
  else if (DIRECTORY_CHANGERS.has(program)) changeDir(run)
  else if (program === 'unset') {
    const parsed = parse(run.args, {})
    if (!hasFlag(parsed.flags, 'f')) for (const operand of parsed.operands) removeVariable(run.state, textOf(operand))
  }
  else if (program === 'shopt' || program === 'setopt' || program === 'unsetopt') globSettings(run)
  else if (program === 'shift' || program === 'set') return positionalChange(run)
  else if (program === 'alias') defineAliases(run)
  else if (program === 'su' || program === 'runuser') return switchUser(run)
  else if (program === 'read') return readVariables(run)
  else if (program === 'printf' && textOf(run.args[0]) === '-v') return printfVariable(run)
  else if (program === 'exit') {
    if (run.args.length > 1) return false
    run.state.terminated = true
    const code = soleText(run.args[0])
    return run.args.length === 0 ? run.state.status : code === undefined ? undefined : /^[+-]?\d+$/.test(code) && Number(code) % 256 === 0
  }
  else if (TRIVIAL.has(program)) return
  else if (LIST.has(program)) plain({ ...run, args: unbracketed(run) }, 'list')
  else if (READ.has(program)) plain(run, 'read')
  else if (WRITE.has(program)) plain(run, 'write')
  else if (DESTROY.has(program)) plain(run, 'destroy')
  else if (CODE_FIRST.has(program) || PATTERN_FIRST.has(program)) codeOrPatternFirst(run)
  else if (MODE_FIRST.has(program)) modeFirst(run)
  else if (COPY.has(program) || program === 'mv') copyOrMove(run)
  else if (program === 'ln') link(run)
  else if (program === 'tee') tee(run)
  else if (ARCHIVE.has(program)) archive(run)
  else if (program === 'dd') dd(run)
  else if (program === 'curl' || program === 'wget') fetch(run)
  else if (program === 'find') await find(run)
  else if (program === 'git') git(run)
  else if (program === 'gh') github(run)
  else if (program === 'claude') {
    run.walk.bypass ??= guardChange(run.walk, run.args) ?? nestedSession(run.args)
    unknownProgram(run)
  }
  else if (SHELLS.has(program)) return shell(run)
  else if (program === 'eval') return evaluate(run)
  else if (program === 'source' || program === '.') await sourced(run)
  else if (program === 'perl') await perl(run)
  else if (INTERPRETER.test(program)) await interpreter(run)
  else unknownProgram(run)
}

/** The arguments of a command, without the `]` that ends `[` or the `]]` that ends `[[`, which is no path. */
function unbracketed(run: Run): Operand[] {
  const closing = run.program === '[' ? ']' : run.program === '[[' ? ']]' : undefined
  return closing !== undefined && soleText(run.args.at(-1)) === closing ? run.args.slice(0, -1) : run.args
}

/** Consumes the remaining literal stream for programs that read to its end. */
function takeInput(input: Stdin): Stdin {
  if (input.kind !== 'literal') return input
  const positions = input.positions ?? [0]
  input.positions = [input.text.length]
  return positions.length === 1 ? { kind: 'literal', text: input.text.slice(positions[0]), uncertain: input.uncertain } : OTHER
}

/** Retains bounded stream positions when a conditional command may have consumed input. */
function mergeInput(walk: Walk, input: Stdin, positions: readonly number[]): void {
  if (input.kind !== 'literal' || positions.length === 0) return
  if (!walk.charge(positions.length + (input.positions?.length ?? 1))) return
  const merged = [...new Set([...positions, ...input.positions ?? [0]])]
  if (merged.length > MAX_VALUES) {
    walk.fail(OPAQUE.tooMany)
    input.uncertain = true
  } else input.positions = merged
}

/** Binds reads at each possible stream position and retains their remaining input. */
function readVariables(run: Run): boolean | undefined {
  const input = run.stdin
  if (input.kind !== 'literal' || (input.positions?.length ?? 1) < 2) return readRecord(run)
  const positions = input.positions!
  if (!run.walk.count(positions.length)) return
  const before = fork(run.walk, run.state)
  const remaining: number[] = []
  let status: boolean | undefined
  for (const [index, position] of positions.entries()) {
    const state = index === 0 ? run.state : fork(run.walk, before)
    const stdin = { ...input, positions: [position] }
    const result = readRecord({ ...run, state, stdin })
    remaining.push(...stdin.positions)
    if (index === 0) status = result
    else {
      if (status !== result) status = undefined
      mergeVariables(run.walk, run.state, state)
    }
    if (run.walk.isSpent()) return
  }
  input.positions = [...new Set(remaining)]
  return status
}

/** Consumes one literal record and binds scalar destinations, preserving escaped field separators. */
function readRecord(run: Run): boolean | undefined {
  const parsed = parse(run.args, { '-d': 1, '-n': 1, '-N': 1, '-p': 1, '-t': 1, '-u': 1, '-a': 1 }, true)
  const names = parsed.operands.length === 0 ? ['REPLY'] : parsed.operands.map(soleText)
  if (names.some(name => name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) return
  const delimiter = parsed.given.has('-d') ? soleText(parsed.given.get('-d')?.[0])?.slice(0, 1) : '\n'
  const supported = parsed.flags.every(flag => /^-[rs]+$/.test(flag) || ['-d', '-p'].includes(flag))
  const input = run.stdin.kind === 'literal' && !run.stdin.uncertain && supported && delimiter !== undefined ? run.stdin.text : undefined
  const raw = hasFlag(parsed.flags, 'r')
  let line: string | undefined
  let complete: boolean | undefined
  const escaped = new Set<number>()
  const start = run.stdin.kind === 'literal' ? run.stdin.positions?.[0] ?? 0 : 0
  if (input !== undefined && run.walk.charge(input.length - start)) {
    line = ''
    complete = false
    let i = start
    for (; i < input.length; i += 1) {
      const ch = input.charAt(i)
      if (ch === '\\' && !raw) {
        const next = input.charAt(++i)
        if (next === '\n') continue
        escaped.add(line.length)
        line += next
      } else if (ch === (delimiter || '\0')) {
        complete = true
        i += 1
        break
      } else line += ch
    }
    if (run.stdin.kind === 'literal') run.stdin.positions = [Math.min(i, input.length)]
  }
  const ifs = run.state.removed.has('IFS') ? undefined : variable(run.walk, run.state, 'IFS')
  if (ifs !== undefined && ifs.length !== 1) line = undefined
  if (!run.walk.charge(ifs?.[0]?.text.length ?? 0)) return
  const separators = new Set(ifs?.[0]?.text ?? ' \t\n')
  const fields: { start: number; end: number }[] = []
  let lastEnd = 0
  if (line !== undefined && parsed.operands.length > 0) {
    splitFields(line, separators, (start, end, keep) => {
      if (start !== end || keep) {
        if (fields.length < names.length) fields.push({ start, end })
        lastEnd = end
      }
    }, escaped)
  }
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i]!
    const field = fields[i]
    const text = line === undefined ? undefined : parsed.operands.length === 0 ? line : field === undefined ? '' : line.slice(field.start, i === names.length - 1 ? lastEnd : field.end)
    assign(run.walk, run.state, { raw: `${name}=`, values: text === undefined ? undefined : fixed(`${name}=${text}`).values })
  }
  return complete
}

/** Assigns bounded literal printf output without sending it to stdout. */
function printfVariable(run: Run): boolean | undefined {
  const name = soleText(run.args[1])
  if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return
  const args = run.args.slice(2).map(soleText)
  const text = args.length > 0 && args.every((arg): arg is string => arg !== undefined) ? printed(run.walk, args) : undefined
  assign(run.walk, run.state, { raw: `${name}=`, values: text === undefined ? undefined : fixed(`${name}=${text}`).values })
  return text === undefined ? undefined : true
}

/** `alias NAME=TEXT`: records the text of each alias; a definition that does not resolve to one text forgets the alias. */
function defineAliases(run: Run): void {
  for (const arg of run.args) {
    const definition = /^([^\s=/$`'"\\]+)=/.exec(soleText(arg) ?? arg.raw)
    if (definition === null) continue
    const text = soleText(arg)
    if (text === undefined) run.state.named.delete(definition[1]!)
    else run.state.named.set(definition[1]!, text.slice(definition[0].length))
  }
}

/** Tracks explicit glob options and noexec in the current shell only, in order, and in `printing`, when it is given, the verbose and xtrace options of a shell's command line; a `set` cluster that holds `o`, such as `-eo`, takes the next word as an option name, unless that word starts with `-` or `+`, as in bash. `set` reads options up to `--`, and except in fish up to `-` or up to its first word that is no option and no option name; in zsh and ksh it also stops at `+`. */
function globSettings(run: Run, printing?: Printing): void {
  if (run.program === 'shopt' && !run.args.some(arg => ['-s', '-u'].includes(textOf(arg)))) return
  let enabled = run.program !== 'unsetopt'
  let named = false
  const fish = run.state.shell === 'fish'
  for (const arg of run.args) {
    const text = textOf(arg)
    if (text === '--') break
    if (run.program === 'set' && !fish && text === '-') break
    if (run.program === 'set' && text === '+' && (run.state.shell === 'zsh' || run.state.shell === 'ksh')) break
    if (run.program === 'set' && /^[-+]/.test(text)) named = false
    if (text === '-s' || text === '-u') {
      enabled = text === '-s'
      continue
    }
    if (text === '-o' || text === '+o') {
      enabled = text === '-o'
      named = true
      continue
    }
    if (run.program === 'set' && /^[-+][a-zA-Z]+$/.test(text)) {
      if (text.includes('f')) run.state.noglob = text.startsWith('-')
      if (text.includes('n')) run.state.terminated = text.startsWith('-')
      if (printing !== undefined && text.includes('v')) printing.verbose = text.startsWith('-')
      if (printing !== undefined && text.includes('x')) printing.xtrace = text.startsWith('-')
      if (text.includes('o')) {
        enabled = text.startsWith('-')
        named = true
      }
      continue
    }
    if (run.program === 'set' && !named) {
      if (!fish && !/^[-+]/.test(text)) break
      continue
    }
    const name = text.replace(/_/g, '').toLowerCase()
    const options = { ...run.state.globOptions }
    if (name === 'dotglob' || name === 'globdots') options.dot = enabled ? true : undefined
    else if (name === 'nocaseglob') options.nocase = enabled ? true : undefined
    else if (name === 'caseglob') options.nocase = enabled ? undefined : true
    else if (name === 'globstar') run.state.globstar = enabled
    else if (name === 'noglob') run.state.noglob = enabled
    else if (name === 'glob') run.state.noglob = !enabled
    else if (run.program === 'set' && name === 'noexec') run.state.terminated = enabled
    else if (printing !== undefined && (name === 'verbose' || name === 'xtrace')) printing[name] = enabled
    run.state.globOptions = options
    named = false
  }
}

/** Applies literal positional changes without changing the shell's command name. */
function positionalChange(run: Run): boolean | undefined {
  const { state, args, walk } = run
  if (run.program === 'set') {
    globSettings(run)
    const split = args.findIndex(arg => soleText(arg) === '--')
    if (split >= 0) setPositional(walk, state, args.slice(split + 1))
    return split >= 0 ? true : undefined
  }
  const text = args.length === 0 ? '1' : soleText(args[0])
  if (text === undefined) {
    walk.fail(OPAQUE.variableCode)
    return
  }
  if (!/^\d+$/.test(text)) return false
  const count = Number(text)
  const positional = state.positional
  if (positional === undefined) {
    walk.fail(OPAQUE.variableCode)
    return
  }
  if (count <= positional.length) setPositional(walk, state, positional.slice(count))
  return count <= positional.length
}

/** Skips inactive loops and scans other loop bodies once with bounded variable alternatives. A `while` or `until` loop whose one pass reads literal input and leaves more of it unread marks the walk `unread`, since a later pass reads other values. */
async function runLoop(walk: Walk, command: Simple, state: State, input: Stdin): Promise<Stdin> {
  const loop = command.loop!
  const start = input.kind === 'literal' ? input.positions ?? [0] : undefined
  if (loop.condition !== undefined) {
    await runList(walk, loop.condition, state, input)
    if (state.terminated) return NONE
    if (state.status === loop.until) {
      state.status = true
      return NONE
    }
  } else {
    const words: Operand[] = []
    const cache: Substituted = new Map()
    if (loop.words === undefined) {
      if (state.positional === undefined) walk.fail(OPAQUE.variableCode)
      words.push(...state.positional ?? [])
    }
    else for (const word of loop.words) words.push(...await resolveFields(walk, word, state, cache))
    if (words.length === 0) {
      state.status = true
      return NONE
    }
    const count = words.reduce((sum, word) => sum + (word.values?.length ?? 1), 0)
    if (count > MAX_VALUES || !walk.charge(count)) {
      walk.fail(OPAQUE.tooMany)
      return OTHER
    }
    const name = loop.name!
    state.possible.delete(name)
    if (words.some(word => word.values === undefined)) state.vars.delete(name)
    else state.vars.set(name, words.flatMap(word => word.values ?? []))
    if (words.some(word => word.upstream)) state.reaching.add(name)
    else state.reaching.delete(name)
  }
  const before = fork(walk, state)
  const output = await runList(walk, command.body ?? [], state, input)
  if (loop.condition !== undefined && input.kind === 'literal' && start !== undefined) {
    const after = input.positions ?? [0]
    if (after.join() !== start.join() && after.some(position => position < input.text.length)) walk.unread = true
  }
  if (loop.condition !== undefined && before.status === undefined) {
    mergeVariables(walk, state, before)
    if (state.cwd !== before.cwd) state.cwd = undefined
  }
  state.status = undefined
  return output
}

/** `cd`, `pushd`, and `popd` move the current folder. */
function changeDir(run: Run): void {
  if (run.state.execdir !== undefined) {
    const destination = parse(run.args, {}).operands[0]
    run.state.execdir = undefined
    run.state.cwd = undefined
    if (!soleText(destination)?.startsWith('/')) {
      run.walk.fail(OPAQUE.variableCode)
      return
    }
  }
  const state = run.state
  run.walk.charge(state.stack.length)
  if (run.program === 'popd') {
    if (state.stack.length === 0) return
    state.prev = state.cwd
    state.cwd = state.stack[state.stack.length - 1]
    state.stack = state.stack.slice(0, -1)
    return
  }
  const target = run.args.find(operand => !textOf(operand).startsWith('-') || textOf(operand) === '-')
  if (run.program === 'pushd') state.stack = [...state.stack, state.cwd]
  if (target === undefined && (state.removed.has('HOME') || state.emptyEnv && !state.vars.has('HOME'))) return
  const next = target === undefined ? pathOf(state.cwd, { raw: '$HOME', values: variable(run.walk, state, 'HOME') }) : textOf(target) === '-' ? state.prev : pathOf(state.cwd, target)
  state.prev = state.cwd
  state.cwd = next
}

/** The absolute path an operand names in `cwd`; undefined unless it resolves to one path that is no glob. */
function pathOf(cwd: string | undefined, operand: Operand | undefined): string | undefined {
  const value = operand?.values?.length === 1 ? operand.values[0] : undefined
  return value === undefined || value.glob ? undefined : absolute(value.text, cwd)
}

/** A program whose operands all get one kind of effect; `base64` also reads its `-i` file, `base64` and `sort` write their `-o` file, other than `-`; `shuf` also writes its output file and reads its random source, and with `-e` its operands are words, not files. */
function plain(run: Run, kind: EffectKind): void {
  const parsed = parse(run.args, valuesOf(run.program))
  const recursive = isRecursive(run.program, parsed.flags)
  const isShuf = run.program === 'shuf'
  if (!isShuf || !hasFlag(parsed.flags, 'e', ['--echo'])) for (const operand of parsed.operands) addEffect(run, operand, kind, recursive)
  if (run.program === 'base64' || run.program === 'sort') {
    const files = (flags: readonly string[]): Operand[] => flags.flatMap(flag => parsed.given.get(flag) ?? []).filter(file => textOf(file) !== '-')
    if (run.program === 'base64') for (const file of files(['-i', '--input'])) addEffect(run, file, 'read', false)
    for (const file of files(['-o', '--output'])) addEffect(run, file, 'write', false)
  }
  if (!isShuf) return
  for (const file of [...parsed.given.get('-o') ?? [], ...parsed.given.get('--output') ?? []]) addEffect(run, file, 'write', false)
  for (const file of parsed.given.get('--random-source') ?? []) addEffect(run, file, 'read', false)
}

/** A program whose first operand is code or a pattern unless a flag gives it; flag files are read; `sed -i` and BSD `sed -I`, also in a cluster such as `-Ei`, write. A search with a pattern and no file searches the current folder. A recursive search that `isPartialSearch` does not find reads its operands as a `fullSearch`. */
function codeOrPatternFirst(run: Run): void {
  const isSed = run.program === 'sed'
  const args = isSed ? run.args.filter((operand, index) => !(textOf(operand) === '' && IN_PLACE_CLUSTER.test(textOf(run.args[index - 1])))) : run.args
  const parsed = parse(args, valuesOf(run.program))
  const { files, operands, hasCode } = codeOperands(parsed)
  const inPlace = isSed && (parsed.given.has('-i') || parsed.given.has('-I') || parsed.flags.some(flag => flag.startsWith('-i') || flag.startsWith('--in-place')))
  const recursive = isRecursive(run.program, parsed.flags)
  const fullSearch = recursive && PATTERN_FIRST.has(run.program) && !isPartialSearch(run.program, parsed)
  for (const file of files) addEffect(run, file, 'read', false)
  for (const operand of operands) addEffect(run, operand, inPlace ? 'write' : 'read', recursive, true, true, fullSearch)
  if (PATTERN_FIRST.has(run.program) && hasCode && operands.length === 0) searchHere(run, parsed)
}

/** The files a program whose first operand is code or a pattern reads through its flags, its operands after that first one, or all of them when a flag gives the code or the pattern, and whether it has the code or the pattern. */
function codeOperands(parsed: Parsed): { files: Operand[]; operands: Operand[]; hasCode: boolean } {
  const files = ['-f', '--file', '--from-file'].flatMap(flag => parsed.given.get(flag) ?? [])
  const isGiven = files.length > 0 || ['-e', '--regexp', '--expression'].some(flag => parsed.given.has(flag))
  return { files, operands: parsed.operands.slice(isGiven ? 0 : 1), hasCode: isGiven || parsed.operands.length > 0 }
}

/** The grep programs that search the current folder only with `-r` or `-R`, also when stdin holds data. */
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'ugrep'])

/** Flags with which a search program prints something else and searches no file. */
const NO_SEARCH = ['--files', '--type-list', '--help', '--version']

/** The rg flags that pick the files that a search reads by a glob or a type. */
const RG_FILTERS = ['-g', '--glob', '--iglob', '-t', '-T', '--type', '--type-not', '--type-add']

/** The rg flags that leave files out by an ignore file or a size limit: a search with one reads only part of a folder that it names, and still counts as a read of the current folder when it names none. */
const RG_LIMITS = ['--ignore-file', '--ignore-file-case-insensitive', '--max-filesize']

/** The long flags of grep and ugrep that pick the files that a search reads by a name, a glob, a type, or an ignore file; grep refuses the ones it does not have. */
const GREP_FILTERS = ['--include', '--exclude', '--exclude-dir', '--exclude-from', '--include-dir', '--include-from', '--include-fs', '--exclude-fs', '--glob', '--iglob', '--file-extension', '--file-type', '--file-magic', '--ignore-files']

/** The long flags of ag that pick no files; every other long flag, such as `--ignore` or a file type such as `--js`, picks the files that a search reads. */
const AG_OPTIONS = new Set(['--ackmate', '--affinity', '--no-affinity', '--noaffinity', '--after', '--all-text', '--all-types', '--before', '--break', '--no-break', '--nobreak', '--case-sensitive', '--color', '--no-color', '--nocolor', '--color-line-number', '--color-match', '--color-path', '--color-win-ansi', '--column', '--context', '--count', '--debug', '--depth', '--filename', '--no-filename', '--nofilename', '--files-with-matches', '--files-without-matches', '--fixed-strings', '--follow', '--no-follow', '--nofollow', '--group', '--no-group', '--nogroup', '--heading', '--no-heading', '--noheading', '--help', '--hidden', '--ignore-case', '--invert-match', '--line-numbers', '--list-file-types', '--literal', '--match', '--max-count', '--mmap', '--no-mmap', '--nommap', '--multiline', '--no-multiline', '--nomultiline', '--numbers', '--no-numbers', '--nonumbers', '--pager', '--no-pager', '--nopager', '--no-recurse', '--norecurse', '--null', '--only-matching', '--one-device', '--parallel', '--passthrough', '--passthru', '--print0', '--print-all-files', '--print-long-lines', '--recurse', '--search-binary', '--search-files', '--search-zip', '--silent', '--skip-vcs-ignores', '--smart-case', '--stats', '--stats-only', '--unrestricted', '--version', '--vimgrep', '--width', '--word-regexp', '--workers'])

/** The short flags that pick the files that a search reads, also in a cluster: `-O`, `-t`, `-g`, and `-M` for ugrep, and `-G`, `-g`, and `-p` for ag. */
const SHORT_FILTERS: ReadonlyMap<string, RegExp> = new Map([['ugrep', /^-[A-Za-z0-9]*[OtgM]/], ['ag', /^-[A-Za-z0-9]*[Ggp]/]])

/** Every entry below the current folder whose path has no hidden name, which rg and ag search by default. */
const VISIBLE: Operand = { raw: '**/*', values: [{ text: '**/*', glob: true }] }

/** A search with a pattern that names no file: grep, egrep, fgrep, and ugrep with `-r` read the whole current folder. rg and ag read it when their stdin holds no data, all of it when a flag shows hidden names, else only its visible entries. A narrow search reads no folder. The read is a `fullSearch` unless `isPartialSearch` finds the search. */
function searchHere(run: Run, parsed: Parsed): void {
  if (isNarrow(run.program, parsed)) return
  const fullSearch = !isPartialSearch(run.program, parsed)
  if (GREPS.has(run.program)) {
    if (hasFlag(parsed.flags, 'rR', ['--recursive', '--dereference-recursive'])) addEffect(run, fixed('.'), 'read', true, true, true, fullSearch)
    return
  }
  const { stdin } = run
  const isEmpty = stdin.kind === 'none' || (stdin.kind === 'script' && stdin.path === '/dev/null') || (stdin.kind === 'other' && stdin.closed === true)
  if (!isEmpty) return
  addEffect(run, showsHidden(run.program, parsed) ? fixed('.') : VISIBLE, 'read', true, true, true, fullSearch)
}

/** Whether a search is narrow: a flag makes it print something else, such as `--files`, it has a file filter, or it limits its depth. */
function isNarrow(program: string, parsed: Parsed): boolean {
  return parsed.flags.some(flag => NO_SEARCH.includes(flag)) || isFiltered(program, parsed) || isShallow(program, parsed)
}

/** Whether a search reads only some files below its folders, or none: it is narrow, or it is rg with an ignore file or a size limit. */
function isPartialSearch(program: string, parsed: Parsed): boolean {
  return isNarrow(program, parsed) || (program === 'rg' && parsed.flags.some(flag => RG_LIMITS.includes(flag)))
}

/** Whether a search picks the files that it reads: rg by a glob or a type, grep and ugrep by a name, a glob, a type, or an ignore file, and ag by a pattern, an ignore rule, or a file type. */
function isFiltered(program: string, parsed: Parsed): boolean {
  if (program === 'rg') return RG_FILTERS.some(flag => parsed.given.has(flag))
  const short = SHORT_FILTERS.get(program)
  return parsed.flags.some(flag => (flag.startsWith('--') ? (program === 'ag' ? !AG_OPTIONS.has(flag) : GREP_FILTERS.includes(flag)) : short?.test(flag) === true))
}

/** A ugrep digit flag that limits the depth, such as `-1`, `-rn2`, or `-3,5`, with no letter before it that takes the rest of the word as a value, such as `-J4`. */
const UGREP_DEPTH = /^-[A-IL-MO-PR-Ya-z]*[0-9]/

/** Whether a search limits how deep it goes: rg with `-d`, `--max-depth`, or `--maxdepth`, ag with `-n`, `--norecurse`, or a last `--depth` of zero or more, as `-1` sets no limit, and ugrep with `--depth` or a digit flag; grep's digit flags give context lines. */
function isShallow(program: string, parsed: Parsed): boolean {
  if (program === 'rg') return parsed.given.has('-d') || parsed.flags.some(flag => flag === '--max-depth' || flag === '--maxdepth')
  if (program === 'ag') return hasFlag(parsed.flags, 'n', ['--norecurse', '--no-recurse']) || /^[0-9]+$/.test(textOf(parsed.given.get('--depth')?.slice(-1)[0]))
  return program === 'ugrep' && parsed.flags.some(flag => flag === '--depth' || UGREP_DEPTH.test(flag))
}

/** Whether rg or ag searches hidden names: `--hidden`, `-.` for rg, and two `-u` for rg, one for ag. */
function showsHidden(program: string, parsed: Parsed): boolean {
  const short = parsed.flags.filter(flag => /^-[^-]/.test(flag))
  const unrestricted = short.reduce((count, flag) => count + [...flag].filter(letter => letter === 'u').length, 0) + parsed.flags.filter(flag => flag === '--unrestricted').length
  if (parsed.flags.includes('--hidden') || unrestricted >= (program === 'rg' ? 2 : 1)) return true
  return program === 'rg' && short.some(flag => flag.includes('.'))
}

/** `chmod`, `chown`, `chgrp`: the first operand is the mode or owner unless `--reference` gives it. */
function modeFirst(run: Run): void {
  const isSymbolic = run.program === 'chmod' && SYMBOLIC_MODE.test(textOf(run.args[0]))
  const parsed = parse(isSymbolic ? run.args.slice(1) : run.args, valuesOf(run.program))
  const recursive = isRecursive(run.program, parsed.flags)
  for (const operand of parsed.operands.slice(isSymbolic || parsed.given.has('--reference') ? 0 : 1)) addEffect(run, operand, 'write', recursive)
}

/** `cp`, `install`, `rsync`, `scp`, and `mv`: sources and one destination. */
function copyOrMove(run: Run): void {
  const parsed = parse(run.args, valuesOf(run.program))
  const directory = parsed.given.get('-t')?.[0] ?? parsed.given.get('--target-directory')?.[0]
  const sources = directory === undefined ? parsed.operands.slice(0, -1) : parsed.operands
  const destination = directory ?? (parsed.operands.length > 1 ? parsed.operands[parsed.operands.length - 1] : undefined)
  const isMove = run.program === 'mv'
  const recursive = isMove || isRecursive(run.program, parsed.flags)
  for (const source of sources) addEffect(run, source, isMove ? 'destroy' : 'read', recursive)
  if (destination === undefined) return
  const deletes = run.program === 'rsync' && parsed.flags.some(flag => flag.startsWith('--delete'))
  addEffect(run, destination, deletes ? 'destroy' : 'write', recursive)
  if ((COPY_AS_FILE.has(run.program) && hasFlag(parsed.flags, 'T', ['--no-target-directory'])) || (run.program === 'install' && hasFlag(parsed.flags, 'd', ['--directory'])) || keepsEntries(run.program, parsed)) return
  const isRsync = run.program === 'rsync'
  const whole = (run.program === 'cp' && parsed.flags.includes('--parents')) || (isRsync && hasFlag(parsed.flags, 'R', ['--relative']))
  for (const source of sources) addEffect(run, entryIn(run.walk, destination, source, isRsync, whole), 'write', recursive, false, false)
}

/** The copy programs whose `-T` makes the destination the file itself, not a folder to copy into; `ln` checks its own. */
const COPY_AS_FILE = new Set(['cp', 'mv', 'install'])

/** Whether a copy, move, or link into a folder replaces no entry that is there, or changes nothing: `cp` and `mv` with a last `--update=` of `none` or `none-fail`, else with `-n` or `--no-clobber`, and with no `-f` or `-i`; rsync with `-n`, `--dry-run`, or `--ignore-existing`; and `ln` without `-f`, `-i`, `-b`, `-F`, or `-S`. */
function keepsEntries(program: string, parsed: Parsed): boolean {
  if (program === 'rsync') return hasFlag(parsed.flags, 'n', ['--dry-run', '--ignore-existing'])
  if (program === 'ln') return !hasFlag(parsed.flags, 'fibF', ['--force', '--interactive', '--backup']) && !parsed.given.has('-S') && !parsed.given.has('--suffix')
  if (program !== 'cp' && program !== 'mv') return false
  const update = parsed.given.get('--update')?.slice(-1)[0]
  const skips = update === undefined ? hasFlag(parsed.flags, 'n', ['--no-clobber']) : ['none', 'none-fail'].includes(textOf(update))
  return skips && !hasFlag(parsed.flags, 'fi', ['--force', '--interactive'])
}

/** The entry that a copy, move, or link of `source` makes when `folder` is a folder: the folder joined with the source's last name, or with its whole path for `cp --parents` and `rsync -R`. A glob last name, a remote word, a dot name, a found entry, and an rsync source with a final slash give none; a glob folder gives a glob entry. A folder or a source that does not resolve takes its possible values, and the entries are then possible ones, charged to the work budget before they are built. */
function entryIn(walk: Walk, folder: Operand, source: Operand, isRsync: boolean, whole = false): Operand {
  if (source.upstream === true || source.process === true) return { raw: '', values: [] }
  const places = folder.values ?? folder.possible ?? []
  const sources = source.values ?? source.possible ?? []
  const isPossible = folder.values === undefined || source.values === undefined
  if (isPossible && !walk.charge(places.length * sources.length)) return { raw: '', values: [] }
  const values = places.flatMap(place => sources.flatMap(value => {
    const trimmed = value.text.replace(/\/+$/, '')
    const name = basenameOf(trimmed)
    const relative = !whole ? name : isRsync && trimmed.includes('/./') ? trimmed.slice(trimmed.lastIndexOf('/./') + 3) : trimmed.replace(/^\/+/, '')
    const skip = (value.glob && hasGlob(whole ? relative : name)) || value.selected === true || value.selection !== undefined || place.text === '' || isRemote(place.text) || isRemote(value.text) || ['', '.', '..'].includes(name) || (isRsync && value.text.endsWith('/')) || (place.glob && hasGlob(relative)) || place.selected === true || place.selection !== undefined
    if (skip) return []
    const base = (place.pattern ?? place.text).replace(/\/+$/, '')
    return [{ text: `${place.text.replace(/\/+$/, '')}/${relative}`, glob: place.glob, ...(place.glob && place.pattern !== undefined ? { pattern: `${base}/${relative}` } : {}), ...(place.globOptions === undefined ? {} : { globOptions: place.globOptions }) }]
  }))
  return isPossible ? { raw: '', values: undefined, possible: values } : { raw: '', values }
}

/** `ln`: the link name is written and its target listed; `ln -s TARGET NAME` makes NAME an alias of TARGET. A link into a folder that can replace an entry also writes the entry it makes there, and `ln -f TARGET` alone makes `./<name>`. */
function link(run: Run): void {
  const parsed = parse(run.args, valuesOf('ln'))
  const directory = parsed.given.get('-t')?.[0] ?? parsed.given.get('--target-directory')?.[0]
  const hasName = directory === undefined && parsed.operands.length > 1
  const targets = hasName ? parsed.operands.slice(0, -1) : parsed.operands
  const name = directory ?? (hasName ? parsed.operands[parsed.operands.length - 1] : undefined)
  const replaces = !keepsEntries('ln', parsed)
  for (const target of targets) addEffect(run, target, 'list', false)
  if (name === undefined) {
    if (targets.length === 1 && replaces) addEffect(run, entryIn(run.walk, fixed('.'), targets[0]!, false), 'write', false, false, false)
    return
  }
  addEffect(run, name, 'write', false)
  if (replaces && !hasFlag(parsed.flags, 'T', ['--no-target-directory'])) for (const target of targets) addEffect(run, entryIn(run.walk, name, target, false), 'write', false, false, false)
  const linkPath = hasName && targets.length === 1 ? pathOf(run.state.cwd, name) : undefined
  const targetText = soleText(targets[0])
  if (linkPath === undefined || targetText === undefined || !hasFlag(parsed.flags, 's', ['--symbolic'])) return
  const place = joinPath(alias(run.walk, run.state, dirnameOf(linkPath)), basenameOf(linkPath))
  run.state.aliases.set(place, joinPath(dirnameOf(place), targetText))
}

/** `tee`: writes each file, and remembers literal text it writes from a heredoc; with `-a` it appends, so the file's whole text stays unknown. */
function tee(run: Run): void {
  const parsed = parse(run.args, {})
  const isAppend = hasFlag(parsed.flags, 'a', ['--append'])
  for (const operand of parsed.operands) {
    addEffect(run, operand, 'write', false)
    if (run.stdin.kind === 'literal' && !run.stdin.uncertain && !isAppend) remember(run, operand, run.stdin.text)
  }
}

/** Records the whole text that a command wrote into the files an operand names. */
function remember(run: Run, operand: Operand, text: string): void {
  for (const path of pathTexts(run, operand)) run.state.written.set(path, text)
}

/** A program Arrester does not know: each operand that looks like a path gets `write`. */
function unknownProgram(run: Run): void {
  pathOperands(run, run.args.filter(operand => !textOf(operand).startsWith('-')))
}

/** GitHub issue and pull request prose stays data; body files are read. */
function github(run: Run): void {
  if (!['pr', 'issue'].includes(textOf(run.args[0]))) {
    unknownProgram(run)
    return
  }
  const parsed = parse(run.args, { '-b': 1, '--body': 1, '-t': 1, '--title': 1, '-F': 1, '--body-file': 1 })
  for (const file of [...parsed.given.get('-F') ?? [], ...parsed.given.get('--body-file') ?? []]) {
    if (textOf(file) !== '-') addEffect(run, file, 'read', false)
  }
  pathOperands(run, parsed.operands)
}

/** Gives `write` to the operands that look like paths, and to every operand an `xargs` stage took from upstream. */
function pathOperands(run: Run, operands: readonly Operand[]): void {
  for (const operand of operands) {
    if (operand.upstream === true || operand.values?.some(value => looksLikePath(value.text)) === true) addEffect(run, operand, 'write', false, false)
  }
}

/** One piece of a word's value: its text, whether word splitting applies to it, whether glob characters in it are live, and whether it stands for the names that a glob matched; `fields` holds the fields that an unquoted parameter operator's word already split into, and then `text` is them joined by blanks. */
type Piece = { text: string; split: boolean; live: boolean; matches: boolean; pattern?: string; boundary?: boolean; globOptions?: Effect['globOptions']; selected?: true; selection?: Effect['selection']; fields?: Value[] }

/** Resolves a word the way a command's arguments are: brace expansion, then tilde, variables, and command substitutions, then splitting of unquoted expansions on blanks and globbing; a word can give no operand or several. */
async function resolveFields(walk: Walk, word: Word, state: State, cache: Substituted): Promise<Operand[]> {
  const raw = wordText(word)
  const [only] = word
  if (word.length === 1 && only?.kind === 'process') {
    await substitution(walk, only.command, state, only.isOutput ? OTHER : NONE)
    return [{ raw, values: [], process: true }]
  }
  if (word.length === 1 && only?.kind === 'elements') return elementFields(walk, only, state, cache, raw)
  const alternatives = bracesOf(word)
  if (alternatives === undefined) return [tooMany(walk, raw)]
  const operands: Operand[] = []
  for (const alternative of alternatives) {
    const results = await expand(walk, alternative, state, cache, true)
    if (results !== undefined) settle(state, results)
    if (results !== undefined && results.length === 1) for (const field of results[0] as Value[]) operands.push(reaching(alternative, state, { raw, values: [field] }))
    else if (results !== undefined) {
      const width = Math.max(0, ...results.map(fields => fields.length))
      for (let i = 0; i < width; i += 1) {
        const values = [...new Map(results.flatMap(fields => {
          const value = fields[i]
          return value === undefined ? [] : [[JSON.stringify(value), value] as const]
        })).values()]
        operands.push(reaching(alternative, state, { raw, values }))
      }
    }
    else operands.push({ raw, values: undefined, ...await possibleOf(walk, alternative, state, cache, true) })
  }
  return operands
}

/** The operands of a word that is one of `"${NAME[@]}"`, `${NAME[@]}`, `"${NAME[*]}"`, and `${NAME[*]}`, for an array whose elements Arrester knows: quoted `@` gives each element as it is; quoted `*` joins them with the first character of `IFS`, as quoted `$*` does; unquoted, each element splits and globs, as unquoted `$@` does. An element that does not resolve stays one operand that does not resolve. Any other expansion does not resolve, and is opaque as `unresolvedArray` says. */
async function elementFields(walk: Walk, part: Extract<Part, { kind: 'elements' }>, state: State, cache: Substituted, raw: string): Promise<Operand[]> {
  const elements = state.arrays.get(part.name)
  if (elements === undefined) {
    unresolvedArray(walk, part.name)
    return [{ raw, values: undefined }]
  }
  if (!walk.count(elements.reduce((sum, element) => sum + (element.values?.length ?? 1), 0)) || !walk.charge(elements.length + 1) || !walk.tick(elements.length + 1)) return [{ raw, values: undefined }]
  if (part.quoted && !part.joined) return elements.map(element => ({ ...element }))
  const scope = fork(walk, state)
  if (part.quoted) {
    setPositional(walk, scope, elements)
    return (await resolveFields(walk, [{ kind: 'var', name: '*', quoted: true }], scope, cache)).map(field => ({ ...field, raw }))
  }
  const fields: Operand[] = []
  for (const element of elements) {
    if (element.values === undefined) {
      fields.push({ ...element })
      continue
    }
    setPositional(walk, scope, [element])
    for (const field of await resolveFields(walk, [{ kind: 'var', name: '@', quoted: false }], scope, cache)) fields.push({ ...field, raw })
  }
  return fields
}

/** Applies the shell's glob settings to the values of a word: `**` matches one folder outside zsh and `globstar`, `noglob` turns globs off, and the glob options join each glob. */
function settle(state: State, results: readonly Value[][]): void {
  if (state.shell !== 'zsh' && !state.globstar) for (const fields of results) for (const value of fields) {
    const pattern = (value.pattern ?? value.text).replace(/(^|\/)\*\*(?=\/)/g, '$1*')
    if (value.glob && pattern !== value.text) value.pattern = pattern
  }
  for (const fields of results) for (const value of fields) {
    if (state.noglob) value.glob = false
    else if (value.glob && state.globOptions !== undefined) value.globOptions = { ...value.globOptions, ...state.globOptions }
  }
}

/** The possible values of a word that does not resolve, when a parameter operator or a variable with possible values is in it: the word's values with each such part taking its possible values. */
async function possibleOf(walk: Walk, word: Word, state: State, cache: Substituted, isFields: boolean): Promise<{ possible?: Value[] }> {
  if (!word.some(part => part.kind === 'param' || (part.kind === 'var' && state.possible.has(part.name)))) return {}
  const results = await expand(walk, word, state, cache, isFields, true)
  if (results === undefined) return {}
  settle(state, results)
  return { possible: alternatives(walk, results.flat()) }
}

/** Resolves a word whole, with no brace expansion, splitting, or globbing, as an assignment, a here-string, and a heredoc are. */
async function resolveWhole(walk: Walk, word: Word, state: State, cache: Substituted): Promise<Operand> {
  const raw = wordText(word)
  const values = (await expand(walk, word, state, cache, false))?.flat()
  return reaching(word, state, { raw, values, ...(values === undefined ? await possibleOf(walk, word, state, cache, false) : {}) })
}

/** The operand, marked as reaching below its paths when a variable in the word does. */
function reaching(word: Word, state: State, operand: Operand): Operand {
  return word.some(part => (part.kind === 'var' || part.kind === 'param') && state.reaching.has(part.name)) ? { ...operand, upstream: true } : operand
}

/** The words that brace expansion makes of a word: only unquoted literal text expands, and each other part stands in the expansion as one mark; undefined past MAX_VALUES words. */
function bracesOf(word: Word): Word[] | undefined {
  const live = word.flatMap(part => (part.kind === 'text' && !part.quoted ? [part.text] : []))
  if (!live.some(text => text.includes('{')) || live.some(text => MARKED.test(text))) return [word]
  const template = word.map((part, index) => (part.kind === 'text' && !part.quoted ? part.text : `\uE000${index}\uE001`)).join('')
  return expandBraces(template, MAX_VALUES)?.map(text => {
    const parts: Word = []
    let last = 0
    for (const match of text.matchAll(MARK)) {
      if (match.index > last) parts.push({ kind: 'text', text: text.slice(last, match.index), quoted: false })
      parts.push(word[Number(match[1])] as Part)
      last = match.index + match[0].length
    }
    if (last < text.length) parts.push({ kind: 'text', text: text.slice(last), quoted: false })
    return parts
  })
}

/** The values that each combination of a word's choices gives, as fields or whole; with `possible`, a part that does not resolve takes its possible values. Every command substitution in the word is walked, even when another part leaves it unresolved. The values are counted and their size charged before they are built; undefined when the word does not resolve or passes a limit, which is opaque. */
async function expand(walk: Walk, word: Word, state: State, cache: Substituted, isFields: boolean, possible = false): Promise<Value[][] | undefined> {
  const usesSeparator = word.some(part => part.kind === 'var' && part.name === '*' && part.quoted || isFields && (part.kind === 'sub' || (part.kind === 'var' || part.kind === 'param') && state.shell !== 'zsh') && !part.quoted)
  const separators = !usesSeparator || state.removed.has('IFS') ? undefined : variable(walk, state, 'IFS')
  const results: Value[][] = []
  let count = 0
  for (const separator of separators ?? [{ text: ' \t\n' }]) {
    const expanded = await expandWithSeparator(walk, word, state, cache, isFields, separator.text, possible)
    if (expanded === undefined) return undefined
    count += expanded.reduce((sum, fields) => sum + Math.max(1, fields.length), 0)
    if (count > MAX_VALUES) return failed(walk)
    results.push(...expanded)
  }
  return results
}

/** Expands a word using one field separator for both splitting and positional joining; with `splitText`, its unquoted literal text splits too, as the word of an unquoted parameter operator does. */
async function expandWithSeparator(walk: Walk, word: Word, state: State, cache: Substituted, isFields: boolean, ifs: string, possible = false, splitText = false): Promise<Value[][] | undefined> {
  const choices = (await piecesOf(walk, word, state, cache, ifs, isFields, possible, splitText))?.map(options => alternatives(walk, options))
  if (choices === undefined || walk.isSpent()) return undefined
  let combos = 1
  for (const options of choices) {
    combos *= options.length
    if (combos > MAX_VALUES) return failed(walk)
  }
  let longest = 0
  let size = 0
  for (const options of choices) {
    let widest = 0
    let total = 0
    for (const piece of options) {
      const length = piece.text.length + (piece.boundary ? 1 : 0)
      widest = Math.max(widest, length)
      total += length
    }
    longest += widest
    if (options.length > 0) size += (total * combos) / options.length
  }
  if (longest > MAX_TEXT) return failed(walk)
  if (!walk.charge(size * 4 + combos * word.length + ifs.length)) return undefined
  const separators = new Set(ifs)
  let fieldsPerCombo = 1
  if (isFields) for (const options of choices) {
    let extra = 0
    for (const piece of options) {
      extra = Math.max(extra, (piece.boundary ? 1 : 0) + (piece.split ? splitFields(piece.text, separators) - 1 : 0) + Math.max(0, (piece.fields?.length ?? 1) - 1))
    }
    fieldsPerCombo += extra
  }
  const fieldBound = combos * fieldsPerCombo
  if (fieldBound > MAX_VALUES) return failed(walk)
  if (!walk.count(fieldBound)) return undefined
  const results: Value[][] = []
  const index = choices.map(() => 0)
  for (let combo = 0; combo < combos; combo += 1) {
    results.push(combine(choices.map((options, k) => options[index[k] as number] as Piece), isFields, separators))
    for (let k = choices.length - 1; k >= 0; k -= 1) {
      index[k] = (index[k] as number) + 1
      if ((index[k] as number) < (choices[k] as Piece[]).length) break
      index[k] = 0
    }
  }
  return results
}

/** The choices of each part of a word; undefined when a part does not resolve. With `possible`, a variable without a value takes its possible values and a parameter operator on it the values of its word; with `splitText`, unquoted literal text splits. A part that expands an array of the code is opaque here, since `elementFields` reads the only forms that resolve. */
async function piecesOf(walk: Walk, word: Word, state: State, cache: Substituted, ifs: string, isFields: boolean, possible: boolean, splitText: boolean): Promise<Piece[][] | undefined> {
  const choices: Piece[][] = []
  let isResolved = true
  for (const [index, part] of word.entries()) {
    if (part.kind === 'text') {
      let texts: (string | undefined)[] = [part.text]
      if (index === 0 && !part.quoted && tilde(part.text, undefined) === undefined) {
        const homes = state.removed.has('HOME') || state.emptyEnv && !state.vars.has('HOME') ? undefined : variable(walk, state, 'HOME')
        if (!walk.charge((homes?.length ?? 1) * part.text.length + (homes?.reduce((sum, home) => sum + home.text.length, 0) ?? 0))) return undefined
        texts = (homes ?? [undefined]).map(home => tilde(part.text, home?.text))
      }
      if (texts.some(text => text === undefined)) isResolved = false
      else choices.push(texts.map(text => ({ text: text!, split: splitText && !part.quoted, live: !part.quoted, matches: false })))
    } else if (walk.arrayNames.has(nameOf(part) ?? '') || arrayOf(part) !== undefined) {
      unresolvedArray(walk, nameOf(part)!)
      isResolved = false
    } else if (part.kind === 'var') {
      if (part.name === '@' || part.name === '*') {
        if (state.positional === undefined) {
          walk.fail(OPAQUE.variableCode)
          isResolved = false
          continue
        }
        const join = part.name === '*' && part.quoted
        const separator = ifs.slice(0, 1)
        if (join && state.positional.length === 0) choices.push([{ text: '', split: false, live: false, matches: false }])
        for (const [at, operand] of state.positional.entries()) {
          if (join && at > 0) choices.push([{ text: separator, split: false, live: false, matches: false }])
          if (operand.values === undefined) isResolved = false
          else choices.push(operand.values.map(value => ({ text: value.text, split: !part.quoted && state.shell !== 'zsh', live: !part.quoted && state.shell !== 'zsh', matches: value.glob, pattern: value.pattern, boundary: at > 0 && !join, selected: value.selected, selection: value.selection, globOptions: value.globOptions })))
        }
        continue
      }
      const values = variable(walk, state, part.name) ?? (possible ? state.possible.get(part.name) : undefined)
      if (values === undefined) isResolved = false
      else choices.push(valuePieces(values, !part.quoted && state.shell !== 'zsh'))
    } else if (part.kind === 'param') {
      const pieces = await parameter(walk, part, state, cache, ifs, isFields, possible)
      if (pieces === undefined) isResolved = false
      else choices.push(pieces)
    } else if (part.kind === 'sub') {
      if (!cache.has(part)) cache.set(part, await substitution(walk, part.command, state, NONE))
      const value = cache.get(part)
      if (value === undefined) isResolved = false
      else choices.push([{ text: value, split: !part.quoted, live: !part.quoted && state.shell !== 'zsh', matches: false }])
    } else {
      if (part.kind === 'process' && !cache.has(part)) cache.set(part, await substitution(walk, part.command, state, part.isOutput ? OTHER : NONE))
      isResolved = false
    }
  }
  return isResolved ? choices : undefined
}

/** The name of the variable or the array that a part expands, if any; for an unknown part of the 1.1.3 reading, the array that its source text names, as in `${NAME[@]}`. */
function nameOf(part: Part): string | undefined {
  if (part.kind === 'unknown') return arrayOf(part)
  return part.kind === 'var' || part.kind === 'param' || part.kind === 'elements' ? part.name : undefined
}

/** The array that a part expands with an array form, `${NAME[…]…}` with an optional `#` or `!`, in either reading; undefined for any other part. */
function arrayOf(part: Part): string | undefined {
  if (part.kind === 'elements') return part.name
  return part.kind === 'unknown' ? part.name ?? /^\$\{[#!]?([A-Za-z_][A-Za-z0-9_]*)\[/.exec(unknownSource(part))?.[1] : undefined
}

/** An expansion of the array `name` that does not resolve. When the code assigns `name` as an array, the call is opaque, also in an older script, since the array comes from the call. Any other array form outside an older script is opaque in a call that needs the modern reading, as on 1.1.3, which did not parse it: at once when the walk already read such code, else through `Walk.unread`. In a call that 1.1.3 parses, the form keeps the 1.1.3 rule and does not resolve. */
function unresolvedArray(walk: Walk, name: string): void {
  if (walk.arrayNames.has(name)) walk.opaque ??= UNPARSED
  else if (walk.oldScript === undefined && walk.modern) walk.fail(UNPARSED)
  else if (walk.oldScript === undefined) walk.unread = true
}

/** The pieces of a variable's values; `split` when the expansion is unquoted outside zsh, so it splits and its glob characters are live. */
function valuePieces(values: readonly Value[], split: boolean): Piece[] {
  return values.map(value => ({ text: value.text, split, live: split, matches: value.glob, pattern: value.pattern, selected: value.selected, selection: value.selection, globOptions: value.globOptions }))
}

/** The parameter operators that give a default, or assign one. */
const DEFAULTS = new Set(['-', ':-', '=', ':='])

/** The parameter operators that give an alternate. */
const ALTERNATES = new Set(['+', ':+'])

/** The choices of a parameter operator over a variable's tracked values: `-` gives the word when the variable is unset, and `:-` also when it is empty; `=` and `:=` also assign it; `+` and `:+` give the word in the other cases, else nothing; `#` and `##` remove a literal prefix, `%` and `%%` a literal suffix; `length` gives the length of a value that is no glob or found entry. The word, and the command substitutions in it, run only when the shell can expand it. For a variable without a value, the part does not resolve, and with `possible` it takes the values of its word, beside a default's possible values of the variable. Undefined when the part does not resolve. */
async function parameter(walk: Walk, part: Extract<Part, { kind: 'param' }>, state: State, cache: Substituted, ifs: string, isFields: boolean, possible: boolean): Promise<Piece[] | undefined> {
  const { name, op } = part
  const split = !part.quoted && state.shell !== 'zsh'
  const values = name === '@' || name === '*' ? undefined : variable(walk, state, name)
  const set = name === '@' || name === '*' ? undefined : isSet(walk, state, name)
  if (op === 'length') {
    if (values === undefined || values.some(value => value.glob || value.selected || value.selection !== undefined) || !walk.charge(values.reduce((sum, value) => sum + value.text.length, 0))) return undefined
    return values.map(value => ({ text: String([...value.text].length), split: false, live: false, matches: false }))
  }
  const colon = op.startsWith(':')
  const empty = (value: Value): boolean => set === false || (colon && value.text === '')
  if (!DEFAULTS.has(op) && !ALTERNATES.has(op)) return affix(walk, part, values, state, cache, ifs)
  const assigns = op.endsWith('=')
  if (ALTERNATES.has(op)) {
    const uses = values === undefined || values.some(value => !empty(value))
    const word = uses ? await wordPieces(walk, part.word, state, cache, ifs, possible, isFields && split) : []
    if (values === undefined && set !== true && !possible) return undefined
    if (word === undefined) return undefined
    return [...values?.some(empty) === true ? [{ text: '', split, live: false, matches: false }] : [], ...word]
  }
  if (values === undefined && set === true && !colon) return undefined
  const kept = (values ?? []).filter(value => !empty(value))
  const uses = values === undefined || values.some(empty)
  if (!uses) return valuePieces(kept, split)
  if (!assigns) {
    const word = await wordPieces(walk, part.word, state, cache, ifs, possible, isFields && split)
    if (values === undefined) return possible && word !== undefined ? [...valuePieces(state.possible.get(name) ?? [], split), ...word] : undefined
    return word === undefined ? undefined : [...valuePieces(kept, split), ...word]
  }
  const assigned = (await expandWithSeparator(walk, part.word, state, cache, false, ifs, possible))?.flat()
  if (!possible && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    const all = values === undefined || assigned === undefined ? undefined : alternatives(walk, [...kept, ...assigned])
    const known = all !== undefined && all.length > MAX_VALUES ? failed(walk) : all
    const word = assigned ?? (await expandWithSeparator(walk, part.word, state, cache, false, ifs, true))?.flat()
    const others = values === undefined ? state.possible.get(name) ?? [] : kept
    assign(walk, state, { raw: `${name}=`, values: known?.map(value => ({ ...value, text: `${name}=${value.text}` })), ...(known === undefined && word !== undefined ? { possible: alternatives(walk, [...others, ...word]).map(value => ({ ...value, text: `${name}=${value.text}` })) } : {}) })
  }
  if (values === undefined) return possible && assigned !== undefined ? valuePieces([...state.possible.get(name) ?? [], ...assigned], split) : undefined
  return assigned === undefined ? undefined : valuePieces([...kept, ...assigned], split)
}

/** The choices of `#`, `##`, `%`, or `%%` over a variable's tracked values that are no globs or found entries: the pattern word always runs, and a pattern that resolves to one text with no glob, escape, or group character removes that literal prefix or suffix; undefined otherwise. */
async function affix(walk: Walk, part: Extract<Part, { kind: 'param' }>, values: readonly Value[] | undefined, state: State, cache: Substituted, ifs: string): Promise<Piece[] | undefined> {
  const pattern = (await expandWithSeparator(walk, part.word, state, cache, false, ifs))?.flat()
  const literal = pattern?.length === 1 ? pattern[0]!.text : undefined
  if (values === undefined || values.some(value => value.glob || value.selected || value.selection !== undefined) || literal === undefined || /[*?[\\(]/.test(literal) || !walk.charge(values.reduce((sum, value) => sum + value.text.length, 0))) return undefined
  const isPrefix = part.op.startsWith('#')
  const strip = (text: string): string => (isPrefix ? (text.startsWith(literal) ? text.slice(literal.length) : text) : text.endsWith(literal) ? text.slice(0, text.length - literal.length) : text)
  return valuePieces(values.map(value => ({ ...value, text: strip(value.text) })), !part.quoted && state.shell !== 'zsh')
}

/** The pieces of a parameter operator's word: each whole value, or with `split` the fields of each, its quoted text kept whole; undefined when the word does not resolve. */
async function wordPieces(walk: Walk, word: Word, state: State, cache: Substituted, ifs: string, possible: boolean, split: boolean): Promise<Piece[] | undefined> {
  const results = await expandWithSeparator(walk, word, state, cache, split, ifs, possible, split)
  return results?.map(fields => (split ? { text: fields.map(field => field.text).join(' '), fields, split: false, live: false, matches: false } : { text: fields[0]?.text ?? '', split: false, live: false, matches: false }))
}

/** Whether a variable or a positional parameter is set: a missing positional parameter and a removed variable are unset; undefined when Arrester does not know. */
function isSet(walk: Walk, state: State, name: string): boolean | undefined {
  if (/^[0-9]+$/.test(name) && Number(name) > 0 && state.positional !== undefined) return Number(name) <= state.positional.length
  if (state.vars.has(name)) return state.vars.get(name) === UNKNOWN ? undefined : true
  if (state.removed.has(name) || (state.emptyEnv && name === 'HOME')) return false
  return variable(walk, state, name) === undefined ? undefined : true
}

/** Counts IFS fields before allocation, optionally emitting their ranges and required empty fields. */
function splitFields(text: string, separators: ReadonlySet<string>, emit?: (start: number, end: number, keep: boolean) => void, escaped?: ReadonlySet<number>): number {
  if (separators.size === 0) {
    emit?.(0, text.length, text !== '')
    return 1
  }
  let count = 1
  let start = 0
  const separates = (at: number): boolean => separators.has(text.charAt(at)) && !escaped?.has(at)
  for (let i = 0; i < text.length; i += 1) {
    if (!separates(i)) continue
    const end = i
    while (separates(i) && /[ \t\n]/.test(text.charAt(i))) i += 1
    const keep = separates(i)
    if (keep) i += 1
    while (separates(i) && /[ \t\n]/.test(text.charAt(i))) i += 1
    emit?.(start, end, keep)
    count += 1
    start = i
    i -= 1
  }
  emit?.(start, text.length, false)
  return count
}

/** The values one combination of pieces gives: whole, one value; as fields, the words that splitting the unquoted expansions on IFS makes, each a glob when a live glob character is in it. */
function combine(pieces: readonly Piece[], isFields: boolean, separators: ReadonlySet<string>): Value[] {
  if (!isFields) return pieces.length === 0 ? [{ text: '', glob: false }] : combine(pieces.map(piece => ({ ...piece, text: (piece.boundary ? ' ' : '') + piece.text, boundary: false, split: false, live: false, fields: undefined })), true, separators)
  const fields: Value[] = []
  let text = ''
  let glob = false
  let pattern = ''
  let hasField = false
  let selected: true | undefined
  let selection: Effect['selection']
  let globOptions: Effect['globOptions']
  const end = (): void => {
    if (hasField) fields.push({ text, glob, ...(selected ? { selected } : {}), ...(glob && pattern !== text ? { pattern } : {}), ...(selection === undefined ? {} : { selection }), ...(globOptions === undefined ? {} : { globOptions }) })
    text = ''
    glob = false
    pattern = ''
    hasField = false
    selected = undefined
    selection = undefined
    globOptions = undefined
  }
  for (const piece of pieces) {
    if (piece.boundary) end()
    const words: { text: string; keep: boolean; value?: Value }[] = []
    if (piece.fields !== undefined) for (const value of piece.fields) words.push({ text: value.text, keep: true, value })
    else if (piece.split) splitFields(piece.text, separators, (start, end, keep) => words.push({ text: piece.text.slice(start, end), keep }))
    else words.push({ text: piece.text, keep: true })
    for (const [k, field] of words.entries()) {
      if (k > 0) end()
      const part = field.text
      if (part === '' && !field.keep) continue
      text += part
      const literal = part.replace(/[*?[]/g, ch => `[${ch}]`)
      pattern += field.value !== undefined ? (field.value.glob ? field.value.pattern ?? part : literal) : piece.pattern ?? (piece.live || piece.matches ? part : literal)
      hasField = true
      glob = glob || (field.value !== undefined ? field.value.glob : piece.matches || (piece.live && hasGlob(part)))
      selected ??= piece.selected
      selection ??= piece.selection
      globOptions ??= piece.globOptions
    }
  }
  end()
  return fields
}

/** A word that resolves to too many values: it stays unresolved and the analysis is opaque. */
function tooMany(walk: Walk, raw: string): Operand {
  walk.fail(OPAQUE.tooMany)
  return { raw, values: undefined }
}

/** Values past a limit: none are built, and the analysis is opaque. */
function failed(walk: Walk): undefined {
  walk.fail(OPAQUE.tooMany)
  return undefined
}

/** An unquoted leading `~` (or `NAME=~`) with the home folder; undefined when the home folder is unknown. */
function tilde(text: string, home: string | undefined): string | undefined {
  const match = /^([A-Za-z_][A-Za-z0-9_]*=)?~(?=\/|$)/.exec(text)
  if (match === null) return text
  return home === undefined ? undefined : `${match[1] ?? ''}${home}${text.slice(match[0].length)}`
}

/** The values of a positional parameter or variable, with inherited `HOME` and tracked `PWD`, unless the shell `lost` them. */
function variable(walk: Walk, state: State, name: string): Value[] | undefined {
  if (/^[0-9]+$/.test(name) && Number(name) > 0 && state.positional !== undefined) {
    const index = Number(name) - 1
    return index < state.positional.length ? state.positional[index]?.values : [{ text: '', glob: false }]
  }
  const values = state.vars.get(name)
  if (values !== undefined) return values === UNKNOWN ? undefined : values
  if (state.removed.has(name) || (state.emptyEnv && name === 'HOME')) return [{ text: '', glob: false }]
  if (state.lost) return undefined
  if (name === 'HOME' && walk.home !== undefined) return [{ text: walk.home, glob: false }]
  return name === 'PWD' && state.cwd !== undefined ? [{ text: state.cwd, glob: false }] : undefined
}

/** Walks the command of `$(…)`, `<(…)`, or `>(…)` once, one level deeper, in a subshell whose first command reads `input`; its value is known literal output with trailing newlines removed. */
async function substitution(walk: Walk, command: string, state: State, input: Stdin): Promise<string | undefined> {
  if (command.trim() === 'pwd') return state.cwd
  if (walk.depth >= MAX_DEPTH) {
    walk.fail(OPAQUE.tooDeep)
    return undefined
  }
  if (!walk.charge(command.length)) return undefined
  const commands = parseCommands(walk, modern => lex(command, modern))
  if (commands === undefined) return undefined
  walk.depth += 1
  const inner = fork(walk, state)
  if (inner.arrays.size > 0) {
    const changes = changesOf(walk, commands)
    if (changes.all) inner.arrays.clear()
    else for (const name of changes.names.keys()) inner.arrays.delete(name)
  }
  const output = await runList(walk, commands, inner, input)
  walk.depth -= 1
  return output.kind === 'literal' && !output.uncertain ? output.text.replace(/\n+$/, '') : undefined
}

/** Assigns a scalar value, bounding the alternatives and text of append assignments before building them; a value that does not resolve keeps the possible values of its word, and an append to a variable that `setUnknown` made unknown keeps it unknown. */
function assign(walk: Walk, state: State, operand: Operand): boolean {
  const match = ASSIGNMENT.exec(operand.raw)
  if (match === null) return false
  const name = match[1]!
  const assigned = mapOperand(operand, text => text.slice(match[0].length))
  let values = assigned.values
  if (match[2] === '+' && state.vars.get(name) === UNKNOWN) {
    setUnknown(state, name)
    return true
  }
  if (match[2] === '+') {
    const previous = variable(walk, state, name)
    if (previous === undefined || values === undefined) {
      values = undefined
    } else {
      const count = previous.length * values.length
      const longest = Math.max(0, ...previous.map(value => value.text.length)) + Math.max(0, ...values.map(value => value.text.length))
      const size = previous.reduce((sum, value) => sum + value.text.length, 0) * values.length + values.reduce((sum, value) => sum + value.text.length, 0) * previous.length
      if (count > MAX_VALUES || longest > MAX_TEXT || !walk.count(count) || !walk.charge(size + count)) {
        walk.fail(OPAQUE.tooMany)
        values = undefined
      } else values = previous.flatMap(left => values!.map(right => ({ text: left.text + right.text, glob: false })))
    }
  }
  state.removed.delete(name)
  if (values === undefined) state.vars.delete(name)
  else state.vars.set(name, values)
  const possible = values === undefined && match[2] !== '+' ? assigned.possible : undefined
  if (possible === undefined) state.possible.delete(name)
  else state.possible.set(name, possible)
  if (operand.upstream === true) state.reaching.add(name)
  else state.reaching.delete(name)
  return true
}

/** Makes a variable unknown, also through a later join with a shell where it is known, until an assignment replaces it; it has no possible values and names no array that resolves. */
function setUnknown(state: State, name: string): void {
  state.vars.set(name, UNKNOWN)
  state.possible.delete(name)
  state.removed.delete(name)
  state.reaching.delete(name)
  state.arrays.delete(name)
}

/** Removes a variable and its export status, including built-in fallback values. */
function removeVariable(state: State, name: string): void {
  state.vars.delete(name)
  state.possible.delete(name)
  state.reaching.delete(name)
  state.exported.delete(name)
  state.removed.add(name)
}

/** Sets declared variables and records which ones a child process inherits. */
function declare(run: Run): void {
  const parsed = parse(run.args, {})
  const exports = run.program === 'export' || hasFlag(parsed.flags, 'x')
  for (const operand of parsed.operands) {
    assign(run.walk, run.state, operand)
    const name = ASSIGNMENT.exec(operand.raw)?.[1] ?? textOf(operand)
    if (exports && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      if (hasFlag(parsed.flags, 'n')) run.state.exported.delete(name)
      else run.state.exported.add(name)
    }
  }
}

/** What a command line runs once its wrappers are gone: the words from the program on, the `xargs` options when one runs it, and the folder that a `-C` or `--chdir` option set. */
type Stripped = { state: State; args: Operand[]; replaces?: true; xargs?: Xargs; chdir?: { dir: string | undefined; symbolic: boolean } }

/** The options of an `xargs` command, separating line replacement from insertion at one argument. */
type Xargs = { noEmpty: boolean; end?: string; replace?: string; insert?: string; file?: Operand; delimiter?: string; batch?: number; lines?: number }

/** An xargs operand with its logical input line, when the input is literal. */
type InputItem = Operand & { line?: number }

/** The npm options that run `npm exec` in workspace folders, which Arrester does not know. */
const NPM_WORKSPACES = ['-w', '--workspace', '--workspaces', '--ws', '--include-workspace-root', '--iwr']

/** Removes wrappers (`sudo`, `env`, `timeout`, `xargs`, `runuser -u`, …), runners (`uv run`, `npx`, …), and keywords from the front of a command. A wrapper or runner that runs its command through a shell (`watch`, `npx -c`) gives `sh -c` with that command as code. `npm exec` with a workspace option stays as written. A command, as the program or behind a wrapper, whose name is not literal text or is a command of SHELL_COMMANDS outside ALLOWED_BUILTINS marks the walk `unread`. */
function stripWrappers(walk: Walk, words: readonly Operand[], state: State): Stripped {
  let rest = words
  let i = 0
  let chdir: { dir: string | undefined; symbolic: boolean } | undefined
  let envBase: { dir: string | undefined; symbolic: boolean } | undefined
  let splitEnv = false
  let inShell = true
  let replaces: true | undefined
  for (;;) {
    if (!walk.charge(rest.length - i)) return { state, replaces, args: [], chdir }
    const head = rest[i]
    if (head === undefined) return { state, replaces, args: [], chdir }
    if (KEYWORDS.has(head.raw)) {
      i += 1
      continue
    }
    const name = basenameOf(textOf(head))
    if (/[$`]/.test(head.raw) || (SHELL_COMMANDS.has(name) && !ALLOWED_BUILTINS.has(name))) walk.unread = true
    if (name === 'command' && ['-v', '-V'].includes(textOf(rest[i + 1]))) return { state, replaces, args: [], chdir }
    const user = name === 'runuser' ? optionsOf(walk, rest, i + 1, RUNUSER.values, 0, undefined).given : undefined
    const wrapper = WRAPPERS.get(name) ?? (user?.has('-u') || user?.has('--user') ? RUNUSER : undefined)
    const runner = wrapper === undefined ? RUNNERS.get(name) : undefined
    if (wrapper === undefined && runner === undefined) return { state, replaces, args: rest.slice(i), chdir }
    if (name === 'env') {
      state = fork(walk, state)
      if (!splitEnv) envBase = chdir ?? { dir: state.cwd, symbolic: state.execdir !== undefined }
    }
    splitEnv = false
    const options = wrapper === undefined ? runnerOptions(walk, rest, i, runner as Runner) : optionsOf(walk, rest, i + 1, wrapper.values, wrapper.operands, name === 'env' ? state : undefined)
    if (options === undefined || (name === 'npm' && NPM_WORKSPACES.some(flag => options.flags.includes(flag) || options.given.has(flag)))) return { state, replaces, args: rest.slice(i), chdir }
    if (name === 'exec' && inShell && options.end < rest.length) replaces = true
    if (!['exec', 'command', 'builtin'].includes(name)) inShell = false
    const directoryFlags = wrapper?.chdir ?? runner?.chdir ?? []
    for (const { flag, value } of options.ordered) {
      if (directoryFlags.includes(flag)) {
        const base = name === 'env' ? envBase : chdir ?? { dir: state.cwd, symbolic: state.execdir !== undefined }
        chdir = { dir: pathOf(base?.dir, value), symbolic: !textOf(value).startsWith('/') && base?.symbolic === true }
      }
    }
    if (name === 'xargs') return { state, replaces, args: rest.slice(options.end), xargs: xargsOf(options), chdir }
    const code = (runner?.code ?? []).flatMap(flag => options.given.get(flag) ?? [])[0]
    if (code !== undefined) return { state, replaces, args: shellCode([code]), chdir }
    const isShell = name === 'watch' ? !hasFlag(options.flags, 'x', ['--exec']) : (runner?.shell ?? []).some(flag => options.flags.includes(flag))
    if (isShell) return { state, replaces, args: shellCode(rest.slice(options.end)), chdir }
    const split = options.given.get('-S')?.[0] ?? options.given.get('--split-string')?.[0]
    const command = runner?.isPackage === true ? rest.slice(options.end).map((word, k) => (k === 0 ? packageProgram(word) : word)) : rest.slice(options.end)
    splitEnv = name === 'env' && split !== undefined
    rest = splitEnv && split !== undefined ? [fixed('env'), ...splitWords(walk, split, state), ...command] : command
    i = 0
  }
}

/** A wrapper's options from `start`, up to the command it runs, and the index where that command starts; `env` sets each `NAME=value` it meets. */
function optionsOf(walk: Walk, words: readonly Operand[], start: number, values: Values, operands: number, env: State | undefined): Options & { end: number } {
  const options: Options = { flags: [], given: new Map(), ordered: [] }
  let i = start
  let left = operands
  while (i < words.length) {
    const word = words[i] as Operand
    const text = textOf(word)
    if (text === '--') return { ...options, end: i + 1 }
    if (env !== undefined && (text === '-' || text === '--ignore-environment' || /^-[A-Za-z]*i[A-Za-z]*$/.test(text))) {
      env.vars.clear()
      env.possible.clear()
      env.reaching.clear()
      env.exported.clear()
      env.emptyEnv = true
      if (text === '-') {
        i += 1
        continue
      }
    }
    if (env !== undefined && assign(walk, env, word)) {
      env.exported.add(ASSIGNMENT.exec(word.raw)![1]!)
      i += 1
    } else if (text.startsWith('-') && text !== '-') {
      i = option(words, i, values, options)
      if (env !== undefined) for (const flag of ['-u', '--unset']) {
        for (const operand of options.given.get(flag) ?? []) removeVariable(env, textOf(operand))
        options.given.delete(flag)
      }
      if (env !== undefined && (options.given.has('-S') || options.given.has('--split-string'))) break
    }
    else if (left > 0) {
      left -= 1
      i += 1
    } else break
  }
  return { ...options, end: i }
}

/** A runner's options around its subcommand, up to the command it runs; undefined when it names a subcommand that runs none, as `uv pip install`. */
function runnerOptions(walk: Walk, words: readonly Operand[], at: number, runner: Runner): (Options & { end: number }) | undefined {
  const before = optionsOf(walk, words, at + 1, runner.values, 0, undefined)
  if (runner.subs.length === 0) return before
  const sub = runner.subs.map(text => text.split(' ')).find(parts => parts.every((part, k) => textOf(words[before.end + k]) === part))
  if (sub === undefined) return undefined
  const after = optionsOf(walk, words, before.end + sub.length, runner.values, 0, undefined)
  const given = new Map(before.given)
  for (const [flag, values] of after.given) given.set(flag, [...(given.get(flag) ?? []), ...values])
  return { flags: [...before.flags, ...after.flags], given, ordered: [...before.ordered, ...after.ordered], end: after.end }
}

/** The program a package runner starts for a package word: the package's own name, without its scope or version. */
function packageProgram(word: Operand): Operand {
  const text = soleText(word)
  if (text === undefined || (!text.startsWith('@') && !text.slice(1).includes('@'))) return word
  const at = text.lastIndexOf('@')
  const name = at > 0 ? text.slice(0, at) : text
  return fixed(basenameOf(name))
}

/** `sh -c` with the words joined by blanks as its code; the code does not resolve when a word does not. */
function shellCode(words: readonly Operand[]): Operand[] {
  const texts = textsOf(words)
  const raw = words.map(word => word.raw).join(' ')
  return [fixed('sh'), fixed('-c'), texts === undefined ? { raw, values: undefined } : { raw, values: [{ text: texts.join(' '), glob: false }] }]
}

/** Splits an env command string into literal arguments, with env quoting, escapes, and exported variable expansion. */
function splitWords(walk: Walk, operand: Operand, state: State): Operand[] {
  const text = soleText(operand)
  if (text === undefined) {
    walk.fail(OPAQUE.variableCode)
    return []
  }
  if (!walk.charge(text.length)) return []
  const words: Operand[] = []
  let word = ''
  let quote = ''
  let active = false
  const end = (): boolean => {
    if (active) {
      if (words.length >= MAX_VALUES || !walk.count(1)) {
        walk.fail(OPAQUE.tooMany)
        return false
      }
      words.push(fixed(word))
    }
    word = ''
    active = false
    return true
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i)
    if (ch === quote) quote = ''
    else if ((ch === '"' || ch === "'") && quote === '') {
      quote = ch
      active = true
    } else if (ch === '\\' && quote !== "'") {
      const next = text.charAt(++i)
      if (next === 'c' && quote === '') break
      if (next === '_' && quote === '') {
        if (!end()) return []
        continue
      }
      const escaped: Readonly<Record<string, string>> = { f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', _: ' ', '#': '#', '$': '$', '"': '"', "'": "'", '\\': '\\' }
      const value = escaped[next]
      if (value === undefined) {
        walk.fail(UNPARSED)
        return []
      }
      word += value
      active = true
    } else if (ch === '$' && quote !== "'") {
      const match = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(text.slice(i + 1))
      if (match === null) {
        walk.fail(UNPARSED)
        return []
      }
      const name = match[1] as string
      const values = state.exported.has(name) ? variable(walk, state, name) : undefined
      if (state.exported.has(name) && (values?.length !== 1 || values[0]?.glob)) {
        walk.fail(OPAQUE.variableCode)
        return []
      }
      const value = values?.[0]?.text ?? ''
      if (word.length + value.length > MAX_TEXT || !walk.charge(value.length)) {
        walk.fail(OPAQUE.tooMany)
        return []
      }
      word += value
      active = active || value !== ''
      i += match[0].length
    } else if (ch === '#' && quote === '' && !active) break
    else if (/\s/.test(ch) && quote === '') { if (!end()) return [] }
    else {
      word += ch
      active = true
    }
  }
  if (quote !== '') {
    walk.fail(UNPARSED)
    return []
  }
  return end() ? words : []
}

/** The `xargs` options a command runs under; a bare `-i` or `--replace` replaces `{}`. */
function xargsOf(options: Options): Xargs {
  const named = ['-I', '-i', '--replace'].flatMap(flag => options.given.get(flag) ?? [])[0]
  const replace = named === undefined ? (options.flags.includes('--replace') ? '{}' : undefined) : textOf(named) || '{}'
  const insert = soleText(options.given.get('-J')?.at(-1))
  const delimiter = options.flags.some(flag => flag === '--null' || /^-[A-Za-z]*0[A-Za-z]*$/.test(flag)) ? '\0' : soleText(options.given.get('-d')?.[0] ?? options.given.get('--delimiter')?.[0])
  const count = Number(soleText(options.given.get('-n')?.at(-1) ?? options.given.get('--max-args')?.at(-1)))
  const lines = Number(soleText(options.given.get('-L')?.at(-1) ?? options.given.get('--max-lines')?.at(-1)))
  const batch = replace !== undefined ? 1 : Number.isSafeInteger(count) && count > 0 ? count : undefined
  const end = soleText(options.given.get('-E')?.at(-1) ?? options.given.get('--eof')?.at(-1))
  return { noEmpty: hasFlag(options.flags, 'r', ['--no-run-if-empty']) || replace !== undefined || insert !== undefined || Number.isSafeInteger(lines) && lines > 0, end, replace, insert, batch, lines: Number.isSafeInteger(lines) && lines > 0 ? lines : undefined, file: options.given.get('-a')?.[0] ?? options.given.get('--arg-file')?.[0], delimiter }
}

/** Builds one xargs invocation, with line replacement or insertion at the first standalone marker after the program. */
function xargsArgs(walk: Walk, words: readonly Operand[], options: Xargs, items: readonly Operand[]): Operand[] | undefined {
  if (options.replace !== undefined) return bindItems(walk, words, options.replace, items)
  const index = options.insert === undefined ? -1 : words.findIndex((word, at) => at > 0 && soleText(word) === options.insert)
  if (index < 0) return [...words, ...items]
  return [...words.slice(0, index), ...items, ...words.slice(index + 1)]
}

/** Divides input by argument or logical-line count, keeping each invocation's positional parameters separate. */
function batchesOf(items: readonly InputItem[], options: Xargs): Operand[][] {
  const batches: Operand[][] = []
  let batch: Operand[] = []
  let firstLine = 0
  for (const item of items) {
    if (batch.length > 0 && ((options.batch !== undefined && batch.length >= options.batch) || (options.lines !== undefined && item.line !== undefined && item.line - firstLine >= options.lines))) {
      batches.push(batch)
      batch = []
    }
    if (batch.length === 0) firstLine = item.line ?? 0
    batch.push(item)
  }
  if (batch.length > 0 || batches.length === 0 && !options.noEmpty) batches.push(batch)
  return batches
}

/** The items `xargs` reads: the words of literal text, the paths a listing names (which reach below them), or one item it cannot read. */
function inputOf(walk: Walk, xargs: Xargs, stdin: Stdin): InputItem[] {
  if (xargs.file === undefined) stdin = takeInput(stdin)
  if (xargs.file === undefined && stdin.kind === 'none') return []
  if (xargs.file === undefined && stdin.kind === 'paths') {
    if (stdin.paths.every(path => !path.upstream && path.values?.every(value => !value.glob))) {
      const values = stdin.paths.flatMap(path => path.values ?? [])
      const size = values.reduce((sum, value) => sum + value.text.length + stdin.separator.length, 0)
      if (size > MAX_TEXT || !walk.charge(size)) return [tooMany(walk, '{}')]
      return inputOf(walk, xargs, { kind: 'literal', text: values.map(value => value.text + stdin.separator).join('') })
    }
    const delimiter = xargs.delimiter?.replace(/\\([ntr0\\])/g, (_, ch: string) => ({ n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\' })[ch] ?? ch)
    if ((delimiter ?? '\n') !== stdin.separator) {
      walk.fail(OPAQUE.unreadableStdin)
      return [{ raw: '{}', values: undefined, upstream: true }]
    }
    const items: InputItem[] = []
    for (const path of stdin.paths) {
      for (const value of path.values ?? []) {
        const words = xargsWords(value.text + stdin.separator, xargs)
        const names = selectionNames(value.selection).map(name => xargsWords(name + stdin.separator, xargs))
        if (words === undefined || words.length !== 1 || names.some(name => name === undefined || name.length !== 1) || !walk.charge(value.text.length) || !walk.count(words.length)) {
          walk.fail(OPAQUE.unreadableStdin)
          return [{ raw: '{}', values: undefined, upstream: true }]
        }
        for (const word of words) items.push({ ...path, raw: word.text, values: [{ ...value, text: word.text, selection: names.length === 0 ? value.selection : { ...value.selection, names: names.map(name => name![0]!.text) } }], line: items.length })
      }
    }
    return items
  }
  if (xargs.file !== undefined || stdin.kind !== 'literal' || stdin.uncertain) return [{ raw: '{}', values: undefined, upstream: true }]
  if (!walk.charge(stdin.text.length)) return []
  const words = xargsWords(stdin.text, xargs)
  if (words === undefined) {
    walk.fail(OPAQUE.unreadableStdin)
    return [{ raw: '{}', values: undefined, upstream: true }]
  }
  if (words.length > MAX_VALUES || !walk.count(words.length)) return [tooMany(walk, '{}')]
  return words.map(word => ({ ...fixed(word.text), line: word.line }))
}

/** Splits xargs input by a literal delimiter, or by unquoted blanks and newlines with replacement lines kept whole. */
function xargsWords(text: string, options: Xargs): { text: string; line: number }[] | undefined {
  if (options.delimiter !== undefined) {
    const delimiter = options.delimiter.replace(/\\([ntr0\\])/g, (_, ch: string) => ({ n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\' })[ch] ?? ch)
    if (delimiter.length !== 1) return undefined
    const records = text === '' ? [] : text.split(delimiter)
    if (text.endsWith(delimiter)) records.pop()
    return records.map((text, line) => ({ text, line }))
  }
  if (text.includes('\0')) return undefined
  const words: { text: string; line: number }[] = []
  let line = 0
  let nonempty = false
  let word = ''
  let quote = ''
  let active = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i)
    if (quote !== '') {
      if (ch === quote) quote = ''
      else word += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      active = true
    } else if (ch === '\\') {
      if (++i === text.length) return undefined
      word += text.charAt(i)
      active = true
    } else if (ch === '\n' || (options.replace === undefined && /[ \t]/.test(ch))) {
      if (active) {
        if (options.end && word === options.end) return words
        words.push({ text: word, line })
        nonempty = true
      }
      word = ''
      active = false
      if (ch === '\n' && nonempty && !/[ \t]/.test(text.charAt(i - 1))) {
        line += 1
        nonempty = false
      }
    } else if (active || !/[ \t]/.test(ch)) {
      word += ch
      active = true
    }
  }
  if (quote !== '') return undefined
  if (active && (!options.end || word !== options.end)) words.push({ text: word, line })
  return words
}

/** The words with each one that is `mark` replaced by the items, and `mark` inside a longer word replaced by the text of each item, as `find -exec` and `xargs -I` do. The values are counted and their size charged before they are built; undefined past a limit. */
function bindItems(walk: Walk, words: readonly Operand[], mark: string, items: readonly Operand[]): Operand[] | undefined {
  const texts = items.flatMap(item => item.values ?? [])
  const isKnown = items.every(item => item.values !== undefined)
  let count = 0
  let size = 0
  for (const word of words) {
    const text = textOf(word)
    if (text === mark) count += items.length
    else if (text.includes(mark) && word.values !== undefined) {
      if (word.values.length * texts.length > MAX_VALUES) {
        tooMany(walk, word.raw)
        return undefined
      }
      count += word.values.length * texts.length
      for (const value of word.values) {
        const marks = value.text.split(mark).length - 1
        for (const item of texts) {
          const length = value.text.length + marks * (item.text.length - mark.length)
          if (length > MAX_TEXT) {
            tooMany(walk, word.raw)
            return undefined
          }
          size += length
        }
      }
    }
  }
  if (!walk.count(count) || !walk.charge(size)) return undefined
  return words.flatMap(word => {
    const text = textOf(word)
    if (text === mark) return items
    if (!text.includes(mark)) return [word]
    if (isKnown && word.values?.every(value => value.text.endsWith(mark) && /^(?:\.\/)+$/.test(value.text.slice(0, -mark.length)))) {
      return word.values.flatMap(value => items.map(item => ({ ...item, ...mapOperand(item, path => value.text.slice(0, -mark.length) + path) })))
    }
    if (isKnown && word.values !== undefined && items.some(item => item.upstream)) {
      if (word.values.every(value => value.text.endsWith(mark) && value.text.indexOf(mark) === value.text.length - mark.length)) {
        return word.values.flatMap(value => items.map(item => ({ ...item, ...mapOperand(item, path => value.text.slice(0, -mark.length) + path) })))
      }
      walk.fail(OPAQUE.variableCode)
      return [{ raw: word.raw, values: undefined }]
    }
    if (!isKnown || word.values === undefined) return [{ raw: word.raw, values: undefined }]
    return [{ raw: word.raw, values: word.values.flatMap(value => texts.map(item => ({ text: value.text.split(mark).join(item.text), glob: value.glob || item.glob }))) }]
  })
}

/** Reads the option word at `i` into `options`: a long flag with or without `=value`, or a short cluster whose first value-taking letter takes the rest of the word, or else the next words. Returns the index after the option and its values. */
function option(words: readonly Operand[], i: number, values: Values, options: Options): number {
  const word = words[i] as Operand
  const text = textOf(word)
  const give = (flag: string, value: Operand): void => {
    options.ordered.push({ flag, value })
    const given = options.given.get(flag)
    if (given === undefined) options.given.set(flag, [value])
    else given.push(value)
  }
  const take = (flag: string, count: number): number => {
    let next = i + 1
    for (let k = 0; k < count && next < words.length; k += 1) {
      give(flag, words[next] as Operand)
      next += 1
    }
    return next
  }
  if (text.startsWith('--')) {
    const equals = text.indexOf('=')
    if (equals < 0) {
      options.flags.push(text)
      return take(text, values[text] ?? 0)
    }
    const flag = text.slice(0, equals)
    options.flags.push(flag)
    give(flag, mapOperand(word, value => value.slice(value.indexOf('=') + 1)))
    return i + 1
  }
  for (let k = 1; k < text.length; k += 1) {
    if (!/[A-Za-z0-9]/.test(text.charAt(k))) break
    const flag = `${text.charAt(0)}${text.charAt(k)}`
    const count = values[`-${text.charAt(k)}`] ?? 0
    if (count === 0) continue
    options.flags.push(text.slice(0, k + 1))
    if (k + 1 < text.length || count === ATTACHED) {
      give(flag, mapOperand(word, value => value.slice(k + 1)))
      return i + 1
    }
    return take(flag, count)
  }
  options.flags.push(text)
  return i + 1
}

/** Splits arguments into flags and operands; value-taking flags keep their values in `given`. With `stopAtOperand`, every word after the first operand is an operand, as a shell or an interpreter reads the words after its code or script. With `plus`, a word that starts with `+` is a flag too, as a shell reads `+e` or `+o NAME`, and its value is kept under its own sign, such as `+o`; a bare `+` is a flag with no letters, or with `plus` set to `end` an operand, as a bare `-` is. */
function parse(args: readonly Operand[], values: Values, stopAtOperand = false, plus?: 'flag' | 'end'): Parsed {
  const parsed: Parsed = { flags: [], operands: [], given: new Map(), ordered: [], split: undefined }
  let i = 0
  while (i < args.length) {
    const arg = args[i] as Operand
    const text = textOf(arg)
    if (parsed.split !== undefined || !(text.startsWith('-') || (plus !== undefined && text.startsWith('+'))) || text === '-' || (plus === 'end' && text === '+') || (stopAtOperand && parsed.operands.length > 0)) {
      parsed.operands.push(arg)
      i += 1
    } else if (text === '--') {
      parsed.split = parsed.operands.length
      i += 1
    } else i = option(args, i, values, parsed)
  }
  return parsed
}

/** The operand with each text, possible ones too, mapped by `pick`; a text that `pick` drops resolves to nothing. */
function mapOperand(operand: Operand, pick: (text: string) => string | undefined): Operand {
  const map = (list: readonly Value[] | undefined): Value[] | undefined => list?.flatMap(value => {
    const text = pick(value.text)
    return text === undefined ? [] : [{ ...value, text, ...(value.pattern === undefined ? {} : { pattern: pick(value.pattern) }) }]
  })
  const possible = map(operand.possible)
  return { raw: pick(operand.raw) ?? operand.raw, values: map(operand.values), ...(possible === undefined ? {} : { possible }) }
}

/** An operand with one known text. */
function fixed(text: string): Operand {
  return { raw: text, values: [{ text, glob: false }] }
}

/** The text of an operand that resolves to exactly one value. */
function soleText(operand: Operand | undefined): string | undefined {
  return operand?.values?.length === 1 ? operand.values[0]?.text : undefined
}

/** The text a word gives a program to read as a flag or a name: its one value, else the word as typed. */
function textOf(operand: Operand | undefined): string {
  return soleText(operand) ?? operand?.raw ?? ''
}

/** The texts of all the operands; undefined when one does not resolve. */
function textsOf(operands: readonly Operand[]): string[] | undefined {
  const texts: string[] = []
  for (const operand of operands) {
    if (operand.values === undefined) return undefined
    for (const value of operand.values) texts.push(value.text)
  }
  return texts
}

/** True when the program reaches below its operands, always or by its flags. */
function isRecursive(program: string, flags: readonly string[]): boolean {
  const recursiveFlags = RECURSIVE_FLAGS.get(program)
  return ALWAYS_RECURSIVE.has(program) || (recursiveFlags !== undefined && hasFlag(flags, recursiveFlags.letters, recursiveFlags.longs))
}

/** Adds the effect of one operand; a `destroy` effect whose operand does not resolve makes the analysis opaque, and another effect marks the walk `unread`, outside an older script, and takes the operand's possible values, if any, and is not remembered; so does a relative path in an unknown folder. Unlinking removes the final directory entry, so its last segment stays as written. A write is remembered as a file the command wrote unless `remember` is false. A `fullSearch` marks the effect `fullSearch`. */
function addEffect(run: Run, operand: Operand, kind: EffectKind, recursive: boolean, definite = true, remember = true, fullSearch = false): void {
  if (operand.values === undefined) {
    if (kind === 'destroy') run.walk.fail(OPAQUE.unresolvedDeletion)
    else {
      if (run.walk.oldScript === undefined) run.walk.unread = true
      if (operand.possible !== undefined) addEffect(run, { raw: operand.raw, values: operand.possible, upstream: operand.upstream }, kind, recursive, false, false, fullSearch)
    }
    return
  }
  for (const value of operand.values) {
    if (value.selected && !/^(?:\.\/)*\.$/.test(value.text)) {
      run.walk.fail(OPAQUE.variableCode)
      continue
    }
    if (value.text === '' || isRemote(value.text)) continue
    if (run.state.execdir !== undefined && !value.text.startsWith('/')) {
      const { root, selection } = run.state.execdir
      if (value.selected) {
        const base = splitGlob(root)
        run.walk.add({ path: base?.path ?? root, glob: base?.glob, kind, recursive: true, selection: { ...selection, descend: recursive } })
      } else if (value.text.split('/').includes('..')) run.walk.fail(OPAQUE.variableCode)
      else {
        const base = splitGlob(root)
        run.walk.add({ path: base?.path ?? root, glob: base?.glob, globOptions: value.globOptions, kind, recursive, selection: { ...selection, parentOperand: value.pattern ?? value.text, parentGlob: value.glob || undefined, descend: recursive } })
      }
      continue
    }
    const path = absolute(value.text, run.state.cwd)
    if (path !== undefined && path.length > MAX_PATH) {
      if (definite) run.walk.fail(PATH_TOO_LONG)
      continue
    }
    if (path === undefined) {
      if (kind === 'destroy') run.walk.fail(OPAQUE.unresolvedDeletion)
      else if (run.walk.oldScript === undefined) run.walk.unread = true
      continue
    }
    const reaches = recursive || operand.upstream === true
    const isLinkItself = kind === 'destroy' && UNLINKERS.has(run.program) && !value.text.endsWith('/')
    const aliased = isLinkItself ? joinPath(alias(run.walk, run.state, dirnameOf(path)), basenameOf(path)) : alias(run.walk, run.state, path)
    const pattern = value.pattern === undefined ? aliased : alias(run.walk, run.state, absolute(value.pattern, run.state.cwd) ?? value.pattern)
    const globbed = value.glob ? splitGlob(pattern) : undefined
    run.walk.add({ path: globbed?.path ?? aliased, glob: globbed?.glob, ...(value.globOptions === undefined ? {} : { globOptions: value.globOptions }), kind, recursive: reaches, ...(isLinkItself && globbed === undefined ? { entry: true as const } : {}), ...(value.selection === undefined ? {} : { selection: { ...value.selection, descend: recursive } }), ...(fullSearch ? { fullSearch: true as const } : {}) })
    if (kind === 'write' && remember) run.state.written.set(aliased, undefined)
  }
}

/** A path with one symbolic link made in this command followed, choosing the longest matching prefix. */
function alias(walk: Walk, state: State, path: string): string {
  if (!walk.charge(state.aliases.size)) return path
  let best: [string, string] | undefined
  for (const entry of state.aliases) {
    const [name] = entry
    if ((path === name || path.startsWith(`${name}/`)) && (best === undefined || name.length > best[0].length)) best = entry
  }
  return best === undefined ? path : best[1] + path.slice(best[0].length)
}

/** The absolute paths an operand names, aliases followed. */
function pathTexts(run: Run, operand: Operand): string[] {
  return (operand.values ?? []).flatMap(value => {
    const path = absolute(value.text, run.state.cwd)
    return path === undefined ? [] : [alias(run.walk, run.state, path)]
  })
}

/** Adds the retry skeleton of one command, the program and its sorted operands with paths made absolute, and its flags; a `find -exec` command has a segment of its own. */
function addSegment(run: Run): void {
  if (TRIVIAL.has(run.program) || LIST.has(run.program)) return
  const git = run.program === 'git' ? gitGlobals(run.args, run.state.cwd) : undefined
  const isPathy = PATHY.has(run.program)
  const base = git === undefined ? run.state.cwd : git.dir
  const find = run.program === 'find' ? findParts(run) : undefined
  const args = git?.rest ?? (find === undefined ? run.args : [...find.starts, ...find.expression.filter(term => !FIND_EXEC.has(term.flag)).flatMap(term => [fixed(term.flag), ...term.args])])
  const words = args.filter(operand => !textOf(operand).startsWith('-') || textOf(operand) === '-').flatMap(operand => skeletonWords(operand, isPathy, base))
  const identity = git === undefined ? [] : [`cwd:${JSON.stringify(base ?? '?')}`]
  const preview = git !== undefined && textOf(git.rest[0]) === 'rm' && hasFlag(parse(git.rest.slice(1), GIT_SUB_VALUES.get('rm') ?? {}).flags, 'n', ['--dry-run'])
  run.walk.segments.push({ ...(preview ? { preview: true as const } : {}), skeleton: [`sh:${run.program}`, ...identity, ...words.sort()].join(' '), flags: flagsOf(args) })
}

/** The flags before any `--`, sorted and each once: a short cluster as its letters (`-rf` gives `-f` and `-r`), a long flag without its `=value`. */
function flagsOf(args: readonly Operand[]): string[] {
  const end = args.findIndex(operand => textOf(operand) === '--')
  const flags = (end < 0 ? args : args.slice(0, end)).map(textOf).filter(text => text.startsWith('-') && text !== '-')
  const split = flags.flatMap(text => (/^-[A-Za-z]{2,}$/.test(text) ? [...text.slice(1)].map(letter => `-${letter}`) : [text.split('=')[0] ?? text]))
  return [...new Set(split)].sort()
}

/** The skeleton words of one operand: absolute paths for path operands, collapsed blanks for others, the raw text when it does not resolve. */
function skeletonWords(operand: Operand, isPathy: boolean, base: string | undefined): string[] {
  if (operand.values === undefined) return [operand.raw]
  return operand.values.map(value => {
    if (!isRemote(value.text) && (isPathy || looksLikePath(value.text))) return absolute(value.text, base) ?? value.text
    return value.text.replace(/\s+/g, ' ')
  })
}

/** Git's global options: the folder that `-C` and `--work-tree` set, and the words from the subcommand on. */
function gitGlobals(args: readonly Operand[], cwd: string | undefined): { dir: string | undefined; rest: Operand[] } {
  let dir = cwd
  let i = 0
  while (i < args.length) {
    const text = textOf(args[i])
    if (!text.startsWith('-')) break
    if (text === '-C' || text === '--work-tree') dir = pathOf(dir, args[i + 1])
    else if (text.startsWith('--work-tree=')) dir = pathOf(dir, mapOperand(args[i] as Operand, value => value.slice('--work-tree='.length)))
    i += GIT_GLOBAL_VALUES.has(text) ? 2 : 1
  }
  return { dir, rest: args.slice(i) }
}

/** The redirections of a command: a heredoc's or a here-string's text, read now, so the command substitutions in an unquoted heredoc run; and each target resolved, which must be one word. */
async function redirected(walk: Walk, redirect: Redirect, state: State, cache: Substituted): Promise<Redirected> {
  const raw = wordText(redirect.target)
  if (redirect.heredoc !== undefined) return { redirect, target: { raw, values: undefined }, text: await heredocText(walk, redirect.heredoc, state) }
  if (redirect.op === '<<<') {
    const target = await resolveWhole(walk, redirect.target, state, cache)
    const text = soleText(target)
    return { redirect, target, text: text === undefined ? undefined : { text: `${text}\n` } }
  }
  const fields = await resolveFields(walk, redirect.target, state, cache)
  const [only] = fields
  return { redirect, target: fields.length === 1 && only !== undefined ? only : { raw, values: undefined } }
}

/** The text a heredoc gives: a quoted delimiter keeps the body as it is; an unquoted one expands it, so its command substitutions run, and preserves unresolved fragments as uncertain input. The body reads as other code does, as `parseCommands` says. */
async function heredocText(walk: Walk, heredoc: { text: string; quoted: boolean }, state: State): Promise<{ text: string; uncertain?: true } | undefined> {
  if (heredoc.quoted) return { text: heredoc.text }
  if (!walk.charge(heredoc.text.length)) return undefined
  const keeps = walk.oldScript !== undefined || walk.legacy > 0
  let read = heredocWord(heredoc.text, walk.modern && !keeps)
  if (read?.legacy) walk.cut = true
  if (read === undefined && !keeps && !walk.modern && walk.length <= NEW_LENGTH) {
    read = heredocWord(heredoc.text, true)
    if (read !== undefined) walk.modern = true
  }
  if (read === undefined) {
    walk.fail(UNPARSED)
    return undefined
  }
  const fragments: string[] = []
  let uncertain = false
  const cache: Substituted = new Map()
  for (const part of read.word) {
    const text = soleText(await resolveWhole(walk, [part], state, cache))
    if (text === undefined) uncertain = true
    else fragments.push(text)
  }
  return { text: fragments.join(''), ...(uncertain ? { uncertain: true } : {}) }
}

/** Opens one bound redirection before later target expansions and tracks descriptor copies. */
function openRedirect(run: Run, bound: Redirected, descriptors: Map<number, Destination>): void {
  const { redirect, target } = bound
  const { op, fd } = redirect
  const text = textOf(target)
  if ((op === '>&' || op === '<&') && DUPLICATE.test(text)) {
    descriptors.set(fd, descriptors.get(Number(text)))
    return
  }
  if (op === '<<' || op === '<<-' || op === '<<<') return
  if (op !== '<') {
    descriptors.set(fd, bound)
    if (op.startsWith('&') || op === '>&') descriptors.set(2, bound)
  }
  if (target.process !== undefined || DEVICES.test(text)) return
  if (op === '<' || op === '<>') addEffect(run, target, 'read', false)
  if (op === '<') return
  const empty = ['', ':', 'true', 'false'].includes(run.program)
  addEffect(run, target, empty && TRUNCATING.has(op) ? 'destroy' : 'write', false)
  if (TRUNCATING.has(op)) remember(run, target, '')
}

/** Records output only at its final descriptor destination, using the directory bound before execution. */
function finishRedirects(run: Run, descriptors: ReadonlyMap<number, Destination>, produced: Stdin): void {
  const stdout = descriptors.get(1)
  const stderr = descriptors.get(2)
  const quietError = ['', ':', 'true', 'false', 'printf', 'echo'].includes(run.program)
  if (typeof stderr === 'object' && !quietError) for (const path of pathTexts(run, stderr.target)) run.state.written.set(path, undefined)
  if (typeof stdout !== 'object' || stdout.target.process || DEVICES.test(textOf(stdout.target))) return
  const known = produced.kind === 'literal' && !produced.uncertain && (stdout !== stderr || quietError) && TRUNCATING.has(stdout.redirect.op)
  for (const path of pathTexts(run, stdout.target)) run.state.written.set(path, known ? produced.text : undefined)
}

/** The stdin a command's own redirections give it, from the last one that applies to descriptor 0: a heredoc's or a here-string's text, a file that `<` reads, an unreadable stream from a process substitution, or a stream that `<&-` closed. */
function stdinOf(redirects: readonly Redirected[], cwd: string | undefined, piped: Stdin): Stdin | undefined {
  let stdin: Stdin | undefined
  for (const { redirect, target, text } of redirects) {
    if (redirect.fd !== 0) continue
    if (redirect.heredoc !== undefined || redirect.op === '<<<') stdin = text === undefined ? OTHER : { kind: 'literal', ...text }
    else if (redirect.op === '<' || redirect.op === '<>') {
      const source = codeStdin(target, cwd)
      if (source.kind === 'script' && STDIN_PATHS.has(source.path)) stdin ??= piped
      else stdin = source
    }
    else if (redirect.op === '<&') stdin = textOf(target) === '-' ? CLOSED : OTHER
  }
  return stdin
}

/** What reading an operand as a file gives: an unreadable process stream, or a file's content. */
function codeStdin(target: Operand, cwd: string | undefined): Stdin {
  if (target.process !== undefined) return OTHER
  const path = pathOf(cwd, target)
  return path === undefined ? OTHER : { kind: 'script', path }
}

/** What a command hands the next pipeline stage: decoded text, the text `echo` or `printf` prints, a file that `cat` reads, a listing of the paths a lister names, the lines a filter passes on, or anything else. */
function produce(run: Run): Stdin {
  if (run.program === 'read') return NONE
  if (run.program === 'printf' && textOf(run.args[0]) === '-v') return NONE
  const parsed = parse(run.args, valuesOf(run.program), run.program === 'printf')
  if (run.program === 'echo') {
    const end = run.args.findIndex(arg => !/^-[neE]+$/.test(textOf(arg)))
    const count = end < 0 ? run.args.length : end
    parsed.flags = run.args.slice(0, count).map(textOf)
    parsed.operands = run.args.slice(count)
  }
  if (isDecoder(run.program, parsed.flags)) return DECODER
  if (run.program === 'echo' || run.program === 'printf') {
    const texts = textsOf(parsed.operands)
    if (texts === undefined) return OTHER
    if (run.program === 'printf') {
      const text = printed(run.walk, texts)
      return text === undefined ? DECODER : { kind: 'literal', text }
    }
    const decodes = hasFlag(parsed.flags, 'e') && texts.some(text => ESCAPED.test(text))
    const text = texts.join(' ')
    return decodes ? DECODER : { kind: 'literal', text: (hasFlag(parsed.flags, 'e') ? text.replace(/\\n/g, '\n') : text) + (hasFlag(parsed.flags, 'n') ? '' : '\n') }
  }
  if (run.program === 'tee') return run.stdin
  if (run.program === 'find') {
    const { starts, expression } = findParts(run)
    const bounds = findBounds(expression)
    const onlyStarts = bounds.maxDepth === 0
    const actions = expression.filter((term, index) => {
      if (!FIND_EXEC.has(term.flag) && !['-printf', '-ls'].includes(term.flag)) return true
      if (!run.walk.charge(index + 1)) return true
      return selectedStarts(run.walk, starts, findSelection(expression.slice(0, index), bounds), onlyStarts).length > 0
    })
    if (actions.some(term => FIND_EXEC.has(term.flag) || ['-printf', '-ls'].includes(term.flag))) return OTHER
    const print = actions.findIndex(term => ['-print', '-print0'].includes(term.flag))
    if (print < 0 && expression.some(term => term.flag === '-delete' || FIND_PRINTS.has(term.flag) || FIND_EXEC.has(term.flag) || ['-printf', '-ls'].includes(term.flag))) return NONE
    const selected = selectedStarts(run.walk, starts, findSelection(print < 0 ? actions : actions.slice(0, print), bounds), onlyStarts)
    return selected.length === 0 ? NONE : listed(selected, !onlyStarts, actions[print]?.flag === '-print0' ? '\0' : '\n')
  }
  if (LIST.has(run.program)) return listed(parsed.operands)
  if (PATTERN_FIRST.has(run.program)) {
    const files = codeOperands(parsed).operands
    if (hasFlag(parsed.flags, 'lL', ['--files-with-matches', '--files-without-match', '--files'])) return listed(files)
    return files.length === 0 && run.stdin.kind !== 'literal' ? run.stdin : OTHER
  }
  if (run.program === 'cat') {
    if (parsed.flags.length > 0) return OTHER
    if (parsed.operands.length === 0) return takeInput(run.stdin)
    const [file] = parsed.operands
    if (parsed.operands.length !== 1 || file === undefined) return OTHER
    const input = codeStdin(file, run.state.cwd)
    return input.kind === 'script' && STDIN_PATHS.has(input.path) ? takeInput(run.stdin) : input
  }
  return PASS_THROUGH.has(run.program) && parsed.operands.length === 0 && run.stdin.kind !== 'literal' ? run.stdin : OTHER
}

/** Formats literal printf text with string slots and ordinary separators, charging repetitions before building output. */
function printed(walk: Walk, texts: readonly string[]): string | undefined {
  const [format = '', ...args] = texts
  const tokens = /%[%s]|\\[nrt0\\]/g
  const plain = format.replace(tokens, '')
  if (plain.includes('%') || plain.includes('\\')) return undefined
  const slots = [...format.matchAll(tokens)].filter(match => match[0] === '%s').length
  const repeats = slots === 0 ? 1 : Math.max(1, Math.ceil(args.length / slots))
  if (!walk.charge(format.length * repeats + args.reduce((sum, arg) => sum + arg.length, 0))) return undefined
  let at = 0
  let output = ''
  for (let i = 0; i < repeats; i += 1) {
    output += format.replace(tokens, token => {
      if (token === '%s') return args[at++] ?? ''
      return ({ '%%': '%', '\\n': '\n', '\\r': '\r', '\\t': '\t', '\\0': '\0', '\\\\': '\\' })[token] ?? token
    })
  }
  return output
}

/** A listing of the paths at or below the operands, or of the current folder when there are none; anything else when an operand does not resolve. */
function listed(operands: readonly Operand[], recursive = true, separator = '\n'): Stdin {
  if (operands.some(operand => operand.values === undefined)) return OTHER
  const paths = (operands.length === 0 ? [fixed('.')] : operands).map(operand => ({ ...operand, ...(recursive ? { upstream: true as const } : {}) }))
  return { kind: 'paths', paths, separator }
}

const FIND_LEADING = new Set(['-H', '-L', '-P'])
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const FIND_IN_FOLDER = new Set(['-execdir', '-okdir'])
const FIND_ENDS = new Set([';', '+'])
const FIND_ARGUMENT = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-lname', '-ilname', '-regex', '-iregex', '-regextype', '-type', '-xtype', '-user', '-group', '-uid', '-gid', '-perm', '-size', '-links', '-inum', '-samefile', '-newer', '-anewer', '-cnewer', '-amin', '-cmin', '-mmin', '-atime', '-ctime', '-mtime', '-used', '-mindepth', '-maxdepth', '-fstype', '-printf', '-fprint', '-fprint0', '-fls'])
const FIND_PRINTS = new Set(['-fprint', '-fprint0', '-fprintf', '-fls'])
const CURL_READS = ['-T', '--upload-file', '-K', '--config']
const CURL_WRITES = ['-o', '--output', '--output-dir', '-D', '--dump-header', '-c', '--cookie-jar']
const CURL_DATA = ['-d', '--data', '--data-binary', '--data-urlencode', '--json']
const CURL_FORMS = ['-F', '--form']
const WGET_READS = ['--post-file', '--body-file', '-i', '--input-file']
const WGET_WRITES = ['-O', '--output-document', '-P', '--directory-prefix', '-o', '--output-file']
const FORM_FILE = /=[@<]([^;]+)/
/** The file of a `--data-urlencode` value `@file` or `name@file`. */
const URLENCODED_FILE = /^[^=@]*@(.+)$/

/** `tar`, `zip`, and `unzip`: what creating, extracting, or listing an archive reads and writes. */
function archive(run: Run): void {
  const first = run.args[0]
  const isBundled = run.program === 'tar' && first !== undefined && /^[A-Za-z]+$/.test(textOf(first))
  const parsed = parse(isBundled ? [mapOperand(first, text => `-${text}`), ...run.args.slice(1)] : run.args, valuesOf(run.program))
  const [archived, ...files] = parsed.operands
  if (run.program === 'zip') {
    if (archived !== undefined) addEffect(run, archived, 'write', false)
    for (const file of files) addEffect(run, file, 'read', hasFlag(parsed.flags, 'r', ['--recurse-paths']))
  } else if (run.program === 'unzip') {
    if (archived !== undefined) addEffect(run, archived, 'read', false)
    if (!hasFlag(parsed.flags, 'lt')) addEffect(run, parsed.given.get('-d')?.[0] ?? fixed('.'), 'write', true)
  } else tar(run, parsed)
}

/** `tar`: creating (`c`, `r`, `u`) reads the files, extracting (`x`) writes the folder, listing (`t`) reads the archive that `-f` names. */
function tar(run: Run, parsed: Parsed): void {
  const file = parsed.given.get('-f')?.[0] ?? parsed.given.get('--file')?.[0]
  const folder = parsed.given.get('-C')?.[0] ?? parsed.given.get('--directory')?.[0]
  const inFolder: Run = folder === undefined ? run : { ...run, state: { ...run.state, cwd: pathOf(run.state.cwd, folder) } }
  if (hasFlag(parsed.flags, 'x', ['--extract', '--get'])) {
    if (file !== undefined) addEffect(run, file, 'read', false)
    addEffect(inFolder, fixed('.'), 'write', true)
  } else if (hasFlag(parsed.flags, 'cru', ['--create', '--append', '--update'])) {
    if (file !== undefined) addEffect(run, file, 'write', false)
    for (const source of parsed.operands) addEffect(inFolder, source, 'read', true)
  } else if (file !== undefined) addEffect(run, file, 'read', false)
}

/** `dd`: `if=` names a file it reads and `of=` a file it writes. */
function dd(run: Run): void {
  for (const operand of run.args) {
    const key = textOf(operand).slice(0, 3)
    if (key === 'if=' || key === 'of=') addEffect(run, mapOperand(operand, text => text.slice(3)), key === 'if=' ? 'read' : 'write', false)
  }
}

/** `curl` and `wget`: the files they send and the files they save; `--data-urlencode` sends the file of `@file` and `name@file`, the other data flags of `@file`. */
function fetch(run: Run): void {
  const parsed = parse(run.args, valuesOf(run.program))
  const given = (flags: readonly string[]): Operand[] => flags.flatMap(flag => parsed.given.get(flag) ?? [])
  const isCurl = run.program === 'curl'
  for (const value of given(isCurl ? CURL_READS : WGET_READS)) fetched(run, value, 'read')
  for (const value of given(isCurl ? CURL_WRITES : WGET_WRITES)) fetched(run, value, 'write')
  if (!isCurl) return
  for (const flag of CURL_DATA) for (const value of parsed.given.get(flag) ?? []) fetched(run, mapOperand(value, text => (flag === '--data-urlencode' ? URLENCODED_FILE.exec(text)?.[1] : text.startsWith('@') && text !== '@-' ? text.slice(1) : undefined)), 'read')
  for (const value of given(CURL_FORMS)) fetched(run, mapOperand(value, text => FORM_FILE.exec(text)?.[1]), 'read')
}

/** One file that `curl` or `wget` reads or writes; `-` is stdin or stdout, no file. */
function fetched(run: Run, operand: Operand, kind: EffectKind): void {
  if (textOf(operand) !== '-') addEffect(run, operand, kind, false)
}

/** `find`'s start paths, with its leading options skipped, and the expression after them. */
function findParts(run: Run): { starts: Operand[]; expression: FindTerm[] } {
  if (run.find !== undefined) return run.find
  const args = run.args
  let at = 0
  while (at < args.length) {
    const text = textOf(args[at])
    if (text === '-D') at += 2
    else if (FIND_LEADING.has(text) || /^-O[0-9]$/.test(text)) at += 1
    else break
  }
  const rest = args.slice(at)
  const split = rest.findIndex(operand => /^[-(!,)]/.test(textOf(operand)))
  const given = split < 0 ? rest : rest.slice(0, split)
  run.find = { starts: given.length > 0 ? given : [fixed('.')], expression: findTerms(split < 0 ? [] : rest.slice(split)) }
  return run.find
}

/** One find operator and its arguments, kept separate from neighboring operators. */
type FindTerm = { flag: string; args: Operand[]; grouped?: boolean }

/** Parses find argument counts once so predicate values cannot become actions or operators. */
function findTerms(args: readonly Operand[]): FindTerm[] {
  const terms: FindTerm[] = []
  for (let i = 0; i < args.length; i += 1) {
    const flag = textOf(args[i])
    const start = i + 1
    if (FIND_EXEC.has(flag)) {
      i = start
      while (i < args.length && !FIND_ENDS.has(textOf(args[i]))) i += 1
      terms.push({ flag, args: args.slice(start, i), grouped: textOf(args[i]) === '+' })
    } else {
      const count = flag === '-fprintf' ? 2 : FIND_ARGUMENT.has(flag) || /^-newer[acmBt][acmBt]$/.test(flag) ? 1 : 0
      terms.push({ flag, args: args.slice(start, start + count) })
      i += count
    }
  }
  return terms
}

/** Keeps common conjunctive find predicates before an action; boolean alternatives do not narrow its candidates. */
function findSelection(tests: readonly FindTerm[], bounds: NonNullable<Effect['selection']>): Effect['selection'] {
  const hasBounds = bounds.minDepth !== undefined || bounds.maxDepth !== undefined
  if (tests.some(term => ['!', '-not', '-o', '-or', '(', ')', ',', '-prune'].includes(term.flag))) return hasBounds ? bounds : undefined
  if (tests.some(term => term.flag === '-false')) return { ...bounds, minDepth: 1, maxDepth: 0 }
  const names = new Set<string>()
  let file: true | undefined
  for (const { flag, args } of tests) {
    if (flag === '-name') {
      const name = soleText(args[0])
      if (name !== undefined) names.add(name)
    }
    else if (flag === '-type' && textOf(args[0]) === 'f') file = true
  }
  return names.size === 0 && file === undefined && !hasBounds ? undefined : { ...bounds, names: [...names], file }
}

/** Carries find predicates with each substituted path, including through shell positional parameters. */
function selectedStarts(walk: Walk, starts: readonly Operand[], selection: Effect['selection'], onlyStarts: boolean): Operand[] {
  if ((selection?.minDepth ?? 0) > (selection?.maxDepth ?? Infinity)) return []
  const meter: Meter = { steps: 0, limit: MAX_WORK - walk.work }
  const possible = selectionPossible(selection, meter)
  if (possible === false) {
    walk.charge(meter.steps)
    return []
  }
  if (possible === 'uncertain') walk.fail('find name comparison exceeded its work budget')
  const count = starts.reduce((sum, start) => sum + (start.values?.length ?? 1), 0)
  const names = selectionNames(selection)
  if (!walk.charge(count * (1 + (onlyStarts ? names.reduce((sum, name) => sum + name.length, 0) : 0)))) return []
  const selected = starts.map(start => ({ ...start, values: start.values?.filter(value => {
    if (!onlyStarts) return true
    const matched = value.glob
      ? selectionPossible({ names: [...names, basenameOf(value.pattern ?? value.text)] }, meter)
      : names.every(name => {
        const match = globMatch(name, basenameOf(value.text), meter, true)
        if (match === 'uncertain') walk.fail('find name comparison exceeded its work budget')
        return match !== false
      })
    if (matched === 'uncertain') walk.fail('find name comparison exceeded its work budget')
    return matched !== false
  }).map(value => ({ ...value, selection: onlyStarts && !value.glob ? undefined : selection })) }))
  walk.charge(meter.steps)
  return selected
}

/** Reads global find depth bounds, excluding arguments of executed commands. */
function findBounds(expression: readonly FindTerm[]): NonNullable<Effect['selection']> {
  const bounds: NonNullable<Effect['selection']> = {}
  for (const { flag, args } of expression) {
    if (flag !== '-mindepth' && flag !== '-maxdepth') continue
    const value = soleText(args[0])
    if (value !== undefined && /^\d+$/.test(value)) bounds[flag === '-mindepth' ? 'minDepth' : 'maxDepth'] = Math.min(Number(value), MAX_PATH)
  }
  return bounds
}

/** `find`: its start paths, and what `-delete`, `-exec`, and `-fprint` do with what it finds. */
async function find(run: Run): Promise<void> {
  const { starts, expression } = findParts(run)
  const bounds = findBounds(expression)
  const onlyStarts = bounds.maxDepth === 0
  let isActed = false
  for (let i = 0; i < expression.length; i += 1) {
    const { flag: text, args, grouped } = expression[i]!
    if (text === '-delete') {
      if (!run.walk.charge(i + 1)) return
      isActed = true
      for (const start of selectedStarts(run.walk, starts, findSelection(expression.slice(0, i), bounds), onlyStarts)) addEffect(run, { ...start, upstream: onlyStarts ? undefined : true }, 'destroy', false)
    } else if (FIND_PRINTS.has(text) && args[0] !== undefined) {
      addEffect(run, args[0], 'write', false)
    } else if (FIND_EXEC.has(text)) {
      if (!run.walk.charge(i + 1)) return
      isActed = true
      await execute(run, args, selectedStarts(run.walk, starts, findSelection(expression.slice(0, i), bounds), onlyStarts), FIND_IN_FOLDER.has(text), onlyStarts, grouped === true)
    }
  }
  if (!isActed) for (const start of starts) addEffect(run, start, 'list', true)
}

/** Runs a find command in the caller's folder or each starting entry's parent, preserving explicit wrapper directories. */
async function execute(run: Run, words: readonly Operand[], starts: readonly Operand[], isInFolder: boolean, onlyStarts: boolean, grouped: boolean): Promise<void> {
  if (run.walk.depth >= MAX_DEPTH) {
    run.walk.fail(OPAQUE.tooDeep)
    return
  }
  if (isInFolder && !onlyStarts) {
    if (starts.some(start => start.values === undefined)) run.walk.fail(OPAQUE.variableCode)
    for (const start of starts) for (const value of start.values ?? []) {
      if (!run.walk.count(1) || !run.walk.charge(words.length + value.text.length)) return
      const root = absolute(value.text, run.state.cwd)
      if (root === undefined) {
        run.walk.fail(OPAQUE.variableCode)
        continue
      }
      const selection = value.selection ?? {}
      if ((selection.minDepth ?? 0) === 0 && (selectionNames(selection).every(name => globMatch(name, basenameOf(root), undefined, true) !== false))) {
        await execute(run, words, [{ ...start, values: [{ ...value, selection: undefined }] }], true, true, grouped)
      }
      if ((selection.maxDepth ?? Infinity) < 1) continue
      const state = fork(run.walk, run.state)
      state.execdir = { root, selection: { ...selection, minDepth: Math.max(1, selection.minDepth ?? 0) } }
      state.cwd = root
      const item: Operand = { raw: '{}', values: [{ text: './.', glob: false, selected: true, selection }], upstream: true }
      const bound = bindItems(run.walk, words, '{}', [item])
      if (bound === undefined) return
      run.walk.depth += 1
      await runCommand(run.walk, bound, state, NONE)
      run.walk.depth -= 1
    }
    return
  }
  const count = starts.reduce((sum, start) => sum + (start.values?.length ?? 1), 0)
  if (count > MAX_VALUES || !run.walk.count(count) || !run.walk.charge(count * 2)) {
    run.walk.fail(OPAQUE.tooMany)
    return
  }
  const items = starts.flatMap(start => {
    const values = start.values?.map(value => ({ ...start, values: [value] })) ?? [start]
    return values.map(value => ({ ...value, ...(onlyStarts ? {} : { upstream: true as const }) }))
  })
  const invocations: { folder: string | undefined; items: Operand[] }[] = []
  const groups = new Map<string | undefined, Operand[]>()
  for (const item of items) {
    const paths = pathTexts(run, item)
    const folders = isInFolder ? [...new Set(paths.flatMap(path => onlyStarts ? [dirnameOf(path)] : [dirnameOf(path), path]))] : [run.state.cwd]
    if (folders.length === 0) folders.push(undefined)
    for (const folder of folders) {
      const replacement = isInFolder ? { ...item, ...mapOperand(item, text => `./${onlyStarts || folder !== absolute(text, run.state.cwd) ? basenameOf(text) : '.'}`) } : item
      const previous = grouped ? groups.get(folder) : undefined
      if (previous !== undefined) previous.push(replacement)
      else {
        const batch = [replacement]
        groups.set(folder, batch)
        invocations.push({ folder, items: batch })
      }
    }
  }
  for (const invocation of invocations) {
    if (!run.walk.charge(words.length + invocation.items.length + 1)) return
    const state = fork(run.walk, run.state)
    state.cwd = invocation.folder
    const bound = bindItems(run.walk, words, '{}', invocation.items)
    if (bound === undefined) return
    run.walk.depth += 1
    await runCommand(run.walk, bound, state, NONE)
    run.walk.depth -= 1
  }
}

/** `git`: the subcommands that delete or discard work, read in the folder that `-C` names. */
function git(run: Run): void {
  const { dir, rest } = gitGlobals(run.args, run.state.cwd)
  const [sub, ...args] = rest
  if (sub === undefined) return
  const name = textOf(sub)
  const at: Run = { ...run, state: { ...run.state, cwd: dir } }
  const parsed = parse(args, GIT_SUB_VALUES.get(name) ?? {})
  const folder = [fixed('.')]
  const destroy = (operands: readonly Operand[]): void => {
    for (const operand of operands) addEffect(at, operand, 'destroy', true)
  }
  const isForced = hasFlag(parsed.flags, 'f', ['--force'])
  if (name === 'clean' && isForced && !hasFlag(parsed.flags, 'n', ['--dry-run'])) destroy(parsed.operands.length > 0 ? parsed.operands : folder)
  else if (name === 'rm' && !parsed.flags.includes('--cached') && !hasFlag(parsed.flags, 'n', ['--dry-run'])) for (const operand of parsed.operands) addEffect(at, operand, 'destroy', hasFlag(parsed.flags, 'r'))
  else if (name === 'mv') copyOrMove({ ...at, program: 'mv', args })
  else if (name === 'checkout') destroy(isForced ? folder : parsed.split === undefined ? parsed.operands.filter(operand => textOf(operand) === '.') : parsed.operands.slice(parsed.split))
  else if (name === 'restore' && (!hasFlag(parsed.flags, 'S', ['--staged']) || hasFlag(parsed.flags, 'W', ['--worktree']))) destroy(parsed.operands)
  else if (name === 'reset' && parsed.flags.includes('--hard')) destroy(folder)
  else if (name === 'stash' && (parsed.operands[0] === undefined || ['push', 'save'].includes(textOf(parsed.operands[0])))) destroy(folder)
}

/** The flag or `plugin` (or `plugins`) subcommand of a `claude` command line that can turn guards off, from each argument as typed and each value it resolves to; undefined when no alternative has one. Before `plugin` and its subcommand, an argument that can be an option, or the value of the option before it, is skipped. */
function guardChange(walk: Walk, args: readonly Operand[]): string | undefined {
  if (!walk.charge(args.reduce((sum, arg) => sum + 1 + (arg.values?.length ?? 0), 0))) return undefined
  const words = args.map(arg => [...new Set([arg.raw, ...(arg.values ?? []).map(value => value.text)])])
  for (const [index, texts] of words.entries()) {
    for (const word of texts) {
      const flag = word.split('=')[0] ?? word
      if (CLAUDE_OFF.has(flag)) return flag
      if (word === '--permission-mode=bypassPermissions' || (word === '--permission-mode' && words[index + 1]?.includes('bypassPermissions') === true)) return '--permission-mode bypassPermissions'
    }
  }
  const stdin = words.some(texts => texts.includes('--values-stdin'))
  // Positions come from resolved values; the typed text stands in only for an argument that does not resolve.
  const resolved = args.map(arg => arg.values === undefined ? [arg.raw] : [...new Set(arg.values.map(value => value.text))])
  let open = true
  let plugin = false
  for (const [index, texts] of resolved.entries()) {
    if (plugin) {
      const off = texts.find(word => PLUGIN_OFF.has(word)) ?? (stdin && texts.includes('configure') ? 'configure' : undefined)
      if (off !== undefined) return `plugin ${off}`
    }
    const skips = texts.some(word => word.startsWith('-')) || (resolved[index - 1]?.some(word => /^-[^=]+$/.test(word) && word !== '--') ?? false)
    plugin = (plugin && skips) || (open && (texts.includes('plugin') || texts.includes('plugins')))
    open &&= skips
    if (!open && !plugin) return undefined
  }
  return undefined
}

/** NESTED_SESSION when a `claude` command line runs a nested session, which does not inherit the open blocks: any first word but a version or help flag or a tool subcommand, `mcp serve` and the `mcp add` forms, and a first word or an `mcp` or `plugin` subcommand that does not resolve. */
function nestedSession(args: readonly Operand[]): string | undefined {
  const [first, sub] = args
  const words = first?.values?.map(value => value.text) ?? []
  if (words.length === 0 || words.some(word => !CLAUDE_TOOLS.has(word))) return NESTED_SESSION
  if (sub === undefined || !words.some(word => word === 'mcp' || word === 'plugin' || word === 'plugins')) return undefined
  return sub.values === undefined || (words.includes('mcp') && sub.values.some(value => MCP_RUNS.has(value.text))) ? NESTED_SESSION : undefined
}

/** How a runner reads a script: as shell text, as interpreter code, or, run directly, by its first line. */
type Language = 'shell' | 'code' | 'direct'

/** Paths that name the reader's own stdin: a script there is the code on stdin. */
const STDIN_PATHS = new Set(['/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'])

/** A script's text, whether the file last changed before the oldest open block opened, and whether the call wrote the text. */
type Script = { text: string; isOld: boolean; written?: true }

/** Reads a script that a command runs and walks or scans it. A script path with a glob in it cannot be read. A sourced script shares `scope`, the caller's state. */
async function runScript(run: Run, operand: Operand, language: Language, args: readonly Operand[], scope?: State): Promise<void> {
  const path = pathOf(run.state.cwd, operand)
  if (run.state.execdir !== undefined && !textOf(operand).startsWith('/')) {
    run.walk.fail(OPAQUE.scriptUnreadable)
    return
  }
  if (path === undefined) {
    run.walk.fail(OPAQUE.scriptUnreadable)
    return
  }
  if (STDIN_PATHS.has(path)) {
    await stdinCode(run, language === 'code' ? 'code' : 'shell', args)
    return
  }
  const script = await scriptText(run, path)
  if (script === undefined) return
  const read = language === 'direct' ? languageOf(script.text) : language
  if (read === undefined) pathOperands(run, args)
  else if (read === 'shell') await walkScript(run.walk, script, path, scope ?? scriptState(run.walk, run.state, path, args))
  else {
    const dialect = dialectOf(language === 'direct' ? runnerOf(script.text) ?? '' : run.program)
    if (!script.isOld) {
      const outer = run.walk.oldScript
      run.walk.oldScript = undefined
      scanInto(run, script.text, dialect)
      run.walk.oldScript = outer
    } else if (run.walk.io.capture !== true) scanOld(run, script.text, path, dialect)
  }
}

/** Scans an older interpreter script at check time for definite file operations only; code in it that Arrester cannot read does not count, and a script past the remaining work budget is not scanned and is recorded as not counted. */
function scanOld(run: Run, code: string, path: string, dialect: Dialect | undefined): void {
  const walk = run.walk
  if (walk.work + code.length > MAX_WORK) {
    walk.ignored ??= { path, reason: OPAQUE.tooMany }
    return
  }
  const outer = walk.oldScript
  walk.oldScript = path
  scanInto(run, code, dialect, true)
  walk.oldScript = outer
}

/** The state a script run as a new process starts from: `$0` its path, and the positional parameters its arguments. */
function scriptState(walk: Walk, state: State, path: string, args: readonly Operand[]): State {
  const fresh = sharedFresh(walk, state)
  setName(fresh, fixed(path))
  setPositional(walk, fresh, args)
  return fresh
}

/** A script's text: what this command wrote into it, or the file as `io.readScript` reads it; undefined when there is none or it cannot be read, which is opaque unless the file is older than the open blocks, also when an older script runs it. */
async function scriptText(run: Run, path: string): Promise<Script | undefined> {
  const walk = run.walk
  if (path.length > MAX_PATH) {
    walk.fail(PATH_TOO_LONG)
    return undefined
  }
  if (run.state.written.has(path)) {
    const written = run.state.written.get(path)
    if (written === undefined) walk.opaque ??= OPAQUE.scriptUnreadable
    return written === undefined ? undefined : { text: written, isOld: false, written: true }
  }
  if (walk.io.signal.aborted) {
    walk.fail(OPAQUE.interrupted)
    return undefined
  }
  const read = await walk.io.readScript(path)
  if (read === 'missing') return undefined
  if ('text' in read) return read
  if (read.isOld) walk.ignored ??= { path, reason: read.unreadable }
  else walk.opaque ??= read.unreadable
  return undefined
}

/** Walks a shell script one level deeper; in an older script, code that cannot be read is recorded and does not count. A newer script that an older one runs does not inherit that exemption. An older script and a script that the call wrote keep the reading of Arrester 1.1.3, as `parseCommands` says. */
async function walkScript(walk: Walk, script: Script, path: string, state: State): Promise<void> {
  const outer = walk.oldScript
  walk.oldScript = script.isOld ? outer ?? path : undefined
  if (script.written) walk.legacy += 1
  await nested(walk, script.text, state)
  if (script.written) walk.legacy -= 1
  walk.oldScript = outer
}

/** The language of a script run directly, from its first line: `#!` with a shell or an interpreter, also through `env`; undefined for anything else. */
function languageOf(text: string): 'shell' | 'code' | undefined {
  const name = runnerOf(text)
  if (name === undefined) return undefined
  if (SHELLS.has(name)) return 'shell'
  return INTERPRETER.test(name) ? 'code' : undefined
}

/** The name of the program that the `#!` line of a script names, also through `env`; undefined without a `#!` line. */
function runnerOf(text: string): string | undefined {
  const end = text.indexOf('\n')
  const line = end < 0 ? text : text.slice(0, end)
  if (!line.startsWith('#!')) return undefined
  const [runner = '', ...rest] = line.slice(2).trim().split(/\s+/)
  return basenameOf(basenameOf(runner) === 'env' ? (rest.find(word => !word.startsWith('-') && !word.includes('=')) ?? '') : runner)
}

/** The comment dialect of code that `program` runs: Python for python, JavaScript for node, bun, and deno, and none for the others. */
function dialectOf(program: string): Dialect | undefined {
  const name = family(program)
  if (name === 'python') return 'python'
  return name === 'node' || name === 'bun' || name === 'deno' ? 'js' : undefined
}

/** Sets positional parameters from bounded arguments, retaining variable bindings for conditional joins and path reach. */
function setPositional(walk: Walk, state: State, args: readonly Operand[]): void {
  if (!walk.charge(state.vars.size + args.reduce((sum, arg) => sum + 1 + (arg.values?.length ?? 0), 0))) return
  state.positional = args
  for (const key of state.vars.keys()) {
    if (!/^(?:[1-9][0-9]*|[@*])$/.test(key)) continue
    state.vars.set(key, [{ text: '', glob: false }])
    state.reaching.delete(key)
  }
  const bind = (key: string, values: Value[], reaches: boolean): void => {
    state.vars.set(key, values)
    if (reaches) state.reaching.add(key)
  }
  for (const [index, arg] of args.entries()) {
    if (arg.values === undefined) state.vars.delete(String(index + 1))
    else bind(String(index + 1), arg.values, arg.upstream === true)
  }
  if (args.some(arg => arg.values === undefined)) {
    state.vars.delete('@')
    state.vars.delete('*')
    return
  }
  for (const key of ['@', '*']) bind(key, args.flatMap(arg => arg.values ?? []), args.some(arg => arg.upstream === true))
}

/** Sets `$0` to the operand, or leaves it unset when there is none. */
function setName(state: State, name: Operand | undefined): void {
  state.vars.delete('0')
  state.reaching.delete('0')
  if (name?.values === undefined) return
  state.vars.set('0', name.values)
  if (name.upstream === true) state.reaching.add('0')
}

/** `su` and `runuser` without `-u`: the code of `-c`, `--command`, or `--session-command` runs in a shell with the words after USER (and a leading `-`) as the shell's arguments, as su passes them; with no such code the shell reads those words alone. The shell is `sh`, or the one that `-s` names; a `-s` that names no shell is opaque. A login form, `-`, `-l`, or `--login`, which su reads also after USER, starts in a home folder that Arrester does not know, so it reads as a program that Arrester does not know. */
async function switchUser(run: Run): Promise<boolean | void> {
  const options = parse(run.args, valuesOf(run.program))
  if (textOf(options.operands[0]) === '-' || hasFlag(options.flags, 'l', ['--login'])) {
    unknownProgram(run)
    return
  }
  const parsed = parse(run.args, valuesOf(run.program), true)
  const operands = textOf(parsed.operands[0]) === '-' ? parsed.operands.slice(1) : parsed.operands
  const named = [...parsed.given.get('-s') ?? [], ...parsed.given.get('--shell') ?? []].at(-1)
  const program = named === undefined ? 'sh' : basenameOf(soleText(named) ?? '')
  if (!SHELLS.has(program)) {
    run.walk.fail(OPAQUE.shellProgram)
    return
  }
  const code = ['-c', '--command', '--session-command'].flatMap(flag => parsed.given.get(flag) ?? []).at(-1)
  return shell({ ...run, program, args: code === undefined ? operands.slice(1) : [fixed('-c'), code, ...operands.slice(1)] })
}

/** `sh`, `bash`, and the other shells: `-c` code with `$0` and the positional parameters after it, code from stdin, or a script with its arguments. A shell with a verbose or xtrace option on its command line prints its script file, so it also reads that file, and only that file; fish's `-v` prints its version. Every shell but fish reads an option that starts with `+` as the `-` form turned off, in order, and `+c` as `-c`. Bash reads stdin after `+s`, as after `-s`; in dash, zsh, and ksh the last of `-s` and `+s` wins, so after `+s` they run the script; `sh` can be bash or dash, so when the two differ both count. A bare `+` ends the options in zsh and ksh, as a bare `-` does, and bash and dash skip it. */
async function shell(run: Run): Promise<boolean | void> {
  const fish = run.program === 'fish'
  const parsed = parse(run.args, valuesOf(run.program), true, fish ? undefined : ['zsh', 'ksh'].includes(run.program) ? 'end' : 'flag')
  const command = hasFlag(parsed.flags.map(flag => flag.replace(/^\+/, '-')), 'c')
  const signs = parsed.flags.filter(flag => /^[-+][A-Za-z]*s/.test(flag)).map(flag => flag.charAt(0))
  const asBash = signs.length > 0
  const asDash = signs.at(-1) === '-'
  const fromStdin = run.program === 'bash' ? asBash : asDash
  const both = run.program === 'sh' && asBash && !asDash
  if (['-', '+'].includes(textOf(parsed.operands[0])) && parsed.split === undefined && !command && !fish) parsed.operands.shift()
  const [first, ...rest] = parsed.operands
  const state = sharedFresh(run.walk, run.state)
  state.shell = run.program
  const names = parsed.ordered.filter(({ flag }) => flag === '-o' || flag === '+o').map(({ value }) => value)
  const settings = parsed.flags.flatMap(flag => {
    const word = fixed(flag === '--verbose' ? '-v' : flag === '--xtrace' ? '-x' : flag)
    return /^[-+][A-Za-z]*o$/.test(flag) && names.length > 0 ? [word, names.shift() as Operand] : [word]
  })
  const printing: Printing = {}
  globSettings({ ...run, state, program: 'set', args: settings }, printing)
  for (const { flag, value } of parsed.ordered) {
    if (flag === '-O' || flag === '+O') globSettings({ ...run, state, program: 'shopt', args: [fixed(flag === '-O' ? '-s' : '-u'), value] })
  }
  if (state.terminated) {
    if (!command && first !== undefined) addEffect(run, first, 'read', false)
    return
  }
  if (command) {
    const code = soleText(first)
    if (code === undefined) {
      run.walk.fail(OPAQUE.variableCode)
      return
    }
    setName(state, rest[0])
    setPositional(run.walk, state, rest.slice(1))
    await nested(run.walk, code, state, run.stdin)
    return state.status
  } else if (fish && textOf(first) === '-') return stdinCode(run, 'shell', rest, state)
  else if (first === undefined || fromStdin) return stdinCode(run, 'shell', parsed.operands, state)
  else {
    if (both) await stdinCode(run, 'shell', parsed.operands, fork(run.walk, state))
    setName(state, first)
    setPositional(run.walk, state, rest)
    if (!fish && (printing.verbose || printing.xtrace)) addEffect(run, first, 'read', false)
    await runScript(run, first, 'shell', rest, state)
  }
}

/** Walks or scans the code that a shell or an interpreter reads on stdin. */
async function stdinCode(run: Run, language: 'shell' | 'code', args: readonly Operand[], scope?: State): Promise<boolean | void> {
  const stdin = takeInput(run.stdin)
  if (run.state.execdir !== undefined && stdin.kind === 'script') {
    run.walk.fail(OPAQUE.scriptUnreadable)
    return
  }
  if (stdin.kind === 'none') return
  if (stdin.kind === 'decoder') run.walk.fail(OPAQUE.decoded)
  else if (stdin.kind === 'script') {
    if (!STDIN_PATHS.has(stdin.path)) {
      if (scope !== undefined) {
        setName(scope, undefined)
        setPositional(run.walk, scope, args)
      }
      await runScript(run, fixed(stdin.path), language, args, scope)
    }
  }
  else if (stdin.kind !== 'literal' || stdin.uncertain) run.walk.fail(OPAQUE.unreadableStdin)
  else if (language === 'code') scanInto(run, stdin.text, dialectOf(run.program))
  else {
    const state = scope ?? sharedFresh(run.walk, run.state)
    state.shell = run.program
    setName(state, undefined)
    setPositional(run.walk, state, args)
    await nested(run.walk, stdin.text, state)
    return state.status
  }
}

/** `eval`: its operands joined with spaces run in this shell. */
async function evaluate(run: Run): Promise<boolean | void> {
  const texts = textsOf(run.args)
  if (texts === undefined) {
    run.walk.fail(OPAQUE.variableCode)
    return
  }
  const text = texts.join(' ')
  const lexed = lex(text)
  if (!('error' in lexed) && lexed.tokens.length === 0) return true
  await nested(run.walk, text, run.state)
  return run.walk.opaque === undefined ? run.state.status : undefined
}

/** `source` and `.`: the script runs in this shell, so it shares the state. */
async function sourced(run: Run): Promise<void> {
  const [file] = run.args
  if (file !== undefined) await runScript(run, file, 'shell', [], run.state)
}

/** `python`, `node`, `ruby`, `php`, `bun`, and `deno`: code from a flag, from stdin, or from a script; the operands after it that look like paths get `write`. */
async function interpreter(run: Run): Promise<void> {
  const name = family(run.program)
  const hasSubcommand = name === 'deno' || name === 'bun'
  const parsed = parse(run.args, valuesOf(name), !hasSubcommand)
  const codes = (CODE_FLAGS.get(name) ?? []).flatMap(flag => parsed.given.get(flag) ?? [])
  const script = name === 'php' ? parsed.given.get('-f')?.[0] : undefined
  const [first, ...rest] = parsed.operands
  if (hasSubcommand && (textOf(first) === 'run' || textOf(first) === 'eval')) {
    const [file, ...args] = rest
    if (textOf(first) === 'eval') scanOperand(run, file)
    else if (file !== undefined) await runScript(run, file, 'code', args)
    pathOperands(run, args)
  } else if (codes.length > 0 || parsed.given.has('-m') || script !== undefined) {
    for (const code of codes) scanOperand(run, code)
    if (script !== undefined) await runScript(run, script, 'code', parsed.operands)
    pathOperands(run, parsed.operands)
  } else {
    if (first === undefined || textOf(first) === '-') await stdinCode(run, 'code', rest)
    else await runScript(run, first, 'code', rest)
    pathOperands(run, rest)
  }
}

/** `perl`: `-e` code, a script, or code from stdin; with `-i` (alone, with a suffix, or in a cluster such as `-pi`) it edits its file operands in place. */
async function perl(run: Run): Promise<void> {
  const parsed = parse(run.args, valuesOf('perl'), true)
  const codes = (CODE_FLAGS.get('perl') ?? []).flatMap(flag => parsed.given.get(flag) ?? [])
  const [first, ...rest] = parsed.operands
  for (const code of codes) scanOperand(run, code)
  if (codes.length === 0) {
    if (first === undefined || textOf(first) === '-') await stdinCode(run, 'code', rest)
    else await runScript(run, first, 'code', rest)
  }
  const isInPlace = hasFlag(parsed.flags, 'i')
  for (const file of codes.length > 0 ? parsed.operands : rest) addEffect(run, file, isInPlace ? 'write' : 'read', false)
}

/** Scans code given as an operand; code that does not resolve is opaque. */
function scanOperand(run: Run, operand: Operand | undefined): void {
  const code = soleText(operand)
  if (code === undefined) run.walk.fail(OPAQUE.variableCode)
  else scanInto(run, code, dialectOf(run.program))
}

/** Adds the effects of interpreter code, its comments read in `dialect`; with `definiteOnly`, only those of definite file operations, at most MAX_EFFECTS. A file the code changes is no longer known text for a later script run. */
function scanInto(run: Run, code: string, dialect: Dialect | undefined, definiteOnly = false): void {
  if (!run.walk.charge(code.length)) return
  const scanned = scanCode(code, run.state.cwd, { dialect, definiteOnly })
  if (scanned.opaque !== undefined) run.walk.fail(scanned.opaque)
  for (const effect of definiteOnly ? scanned.effects.slice(0, MAX_EFFECTS) : scanned.effects) {
    run.walk.add(effect)
    if (effect.kind !== 'read' && effect.glob === undefined) run.state.written.set(effect.path, undefined)
  }
}

/** Deduplicates alternatives only, preserving ordered arguments and all expansion metadata. */
function alternatives<T extends Value | Piece>(walk: Walk, values: readonly T[]): T[] {
  const seen = new Set<string>()
  const kept: T[] = []
  for (const value of values) {
    const key = JSON.stringify([Object.entries(value).filter(([key]) => key !== 'selection' && key !== 'globOptions').sort(([a], [b]) => a.localeCompare(b)), value.globOptions?.dot === true, value.globOptions?.nocase === true, selectionKey(value.selection)])
    if (!walk.charge(key.length)) return []
    if (!seen.has(key)) {
      seen.add(key)
      kept.push(value)
    }
  }
  return kept
}
