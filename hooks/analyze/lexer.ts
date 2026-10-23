// The shell lexer: words as parts, control operators, redirections with
// their file descriptors, and heredoc bodies, in one left-to-right scan with
// no backtracking regular expression. Pure: no `$`.

/** One piece of a shell word; `quoted` marks an expansion inside double quotes, which is neither split nor globbed. A `param` part is a parameter operator: `-`, `=`, or `+`, each also with `:`, `#`, `##`, `%`, or `%%` with its word, or `length` for `${#name}`. The modern reading also gives an `array` part, the `( … )` of an array assignment with its elements as words; an `elements` part, `${name[@]}`, or with `joined` `${name[*]}`; and an `unknown` part that names the array of every other `${name[…]…}` form. */
export type Part =
  | { kind: 'text'; text: string; quoted: boolean }
  | { kind: 'var'; name: string; quoted: boolean }
  | { kind: 'param'; name: string; op: string; word: Word; quoted: boolean }
  | { kind: 'sub'; command: string; quoted: boolean }
  | { kind: 'process'; command: string; isOutput: boolean }
  | { kind: 'array'; elements: Word[] }
  | { kind: 'elements'; name: string; joined: boolean; quoted: boolean }
  | { kind: 'unknown'; name?: string }

/** A shell word: its parts in order. */
export type Word = Part[]

/** A redirection: its operator, the file descriptor it applies to, its target, and its heredoc body once the lexer has read it. */
export type Redirect = { op: string; fd: number; target: Word; heredoc?: { text: string; quoted: boolean } }

/** One token of a command line; `joined` marks a `(` that another `(` follows at once, as in `((`, which the shell reads as arithmetic, unlike `( (`; in the modern reading also across backslash-newlines, which the shell removes first. */
export type Token =
  | { type: 'word'; word: Word }
  | { type: 'op'; op: string; joined?: true }
  | { type: 'redirect'; redirect: Redirect }

/** The tokens of a command line, or why it cannot be read; `legacy` marks a reading that ended a substitution at the `)` of a `case` pattern, as `Lexer.legacy` says, and `quoting` a text that holds `$'…'` or `$"…"`, as `Lexer.quoting` says. */
type Lexed = { tokens: Token[]; legacy?: true; quoting?: true } | { error: string }

/** The longest command Arrester reads. */
const MAX_COMMAND = 100_000
/** How deep command substitutions may nest inside one another before the command counts as unreadable. */
const MAX_NESTING = 32
export const TOO_LONG = 'the command is too long to read'
/** Why a command that does not parse cannot be read. */
export const UNPARSED = 'the command does not parse'

const CONTROL = ['&&', '||', ';;', '|&', '&', '|', ';', '(', ')']
/** The control operators of the modern reading, which adds the `;&` and `;;&` ends of a `case` branch. */
const MODERN_CONTROL = ['&&', '||', ';;&', ';;', ';&', '|&', '&', '|', ';', '(', ')']
/** The text of a word that starts an array assignment when a `(` follows it. */
const ARRAY_NAME = /^[A-Za-z_][A-Za-z0-9_]*\+?=$/
/** The start of a `${…}` form of an array: an optional `#` or `!`, a name, and `[`. */
const ARRAY_FORM = /([#!]?)([A-Za-z_][A-Za-z0-9_]*)\[/y
/** The words after which a new command starts, so a `case` or an `esac` there is a keyword. */
const COMMAND_STARTS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '{', '!'])
const REDIRECTS = ['&>>', '<<<', '<<-', '&>', '>>', '>|', '>&', '<&', '<>', '<<', '>', '<']
const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>'])
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/
/** A parameter name inside `${…}`, read at a position: a name, digits, or one special character. */
const BRACED_NAME = /[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-]/y
/** The operators of a `${…}` that the analysis resolves, longest first. */
const OPERATORS = [':-', ':=', ':+', '##', '%%', '-', '=', '+', '#', '%']
const FD = /^[0-9]+(?=[<>])/
const SPECIAL = new Set(['@', '*', '#', '?', '$', '!', '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', '\\': '\\', "'": "'", '"': '"' }
const IN_DOUBLE_QUOTES = '"\\$`\n'
const IN_HEREDOC = '\\$`\n'

/** Thrown inside the lexer when the command does not parse; `lex` turns it into an error. */
class Unparsed extends Error {}

/** Lexes one command line, as Arrester 1.1.3 did, or with `modern` also with arrays, the `;&` and `;;&` ends of a `case` branch, and a `case` inside a substitution. */
export function lex(command: string, modern = false): Lexed {
  if (command.length > MAX_COMMAND) return { error: TOO_LONG }
  const lexer = new Lexer(command, 0, 0, modern)
  return lexer.run() ? { tokens: lexer.tokens, ...(lexer.legacy ? { legacy: true as const } : {}), ...(lexer.quoting ? { quoting: true as const } : {}) } : { error: UNPARSED }
}

/** The parts of a heredoc body whose delimiter is unquoted, which the shell expands like double-quoted text with `"` plain, and whether the reading is `legacy`, as `lex` says; undefined when an expansion in it does not parse. `modern` reads it as `lex` says. */
export function heredocWord(text: string, modern = false): { word: Word; legacy?: true } | undefined {
  const lexer = new Lexer(text, 0, 0, modern)
  const word = lexer.expandable()
  return word === undefined ? undefined : { word, ...(lexer.legacy ? { legacy: true as const } : {}) }
}

/** The source text of each `unknown` part that an arithmetic expansion or an unread `${…}` form gave, which the scan for assignments reads. */
const SOURCES = new WeakMap<Part, string>()

/** The source text of an `unknown` part, or an empty text when the lexer gave none. */
export function unknownSource(part: Part): string {
  return SOURCES.get(part) ?? ''
}

/** The source spelling of each expansion part, such as `$name`, `${name}`, `$(…)`, or a backtick substitution. */
const SPELLINGS = new WeakMap<Part, string>()

/** The source spelling of an expansion part, or an empty text when the lexer gave none. */
export function spellingOf(part: Part): string {
  return SPELLINGS.get(part) ?? ''
}

/** The text of a part: literal text as it is, expansions written as typed. */
function partText(part: Part): string {
  if (part.kind === 'text') return part.text
  if (part.kind === 'var') return `$${part.name}`
  if (part.kind === 'param') return part.op === 'length' ? `\${#${part.name}}` : `\${${part.name}${part.op}${wordText(part.word)}}`
  if (part.kind === 'sub') return `$(${part.command})`
  if (part.kind === 'array') return `(${part.elements.map(wordText).join(' ')})`
  if (part.kind === 'elements') return `\${${part.name}[${part.joined ? '*' : '@'}]}`
  return part.kind === 'process' ? `${part.isOutput ? '>' : '<'}(${part.command})` : '$(( ))'
}

/** The text of a word with its quotes removed; what a skeleton's unresolved operand uses. */
export function wordText(word: Word): string {
  return word.map(partText).join('')
}

/** Adds text to the word, joined to the last part when that part is text with the same quoting. */
function pushText(parts: Word, text: string, quoted: boolean): void {
  const last = parts[parts.length - 1]
  if (last !== undefined && last.kind === 'text' && last.quoted === quoted) last.text += text
  else parts.push({ kind: 'text', text, quoted })
}

/** Where a `case` inside a substitution stands: before its word, before `in`, at a pattern, or in a branch body. */
type CaseState = 'word' | 'in' | 'pattern' | 'body'

/** The text of a word that is unquoted literal text, else undefined. */
function plainText(word: Word): string | undefined {
  return word.every(part => part.kind === 'text' && !part.quoted) ? wordText(word) : undefined
}

/** Moves the `case` states of a substitution past the token just read, so the scan knows when a `)` ends a pattern and not the substitution: `case` at the start of a command opens one, `in` starts its patterns, `)` its branch body, `;;`, `;&`, or `;;&` the next pattern, and `esac` closes it. */
function caseStep(cases: CaseState[], tokens: readonly Token[]): void {
  const token = tokens[tokens.length - 1]
  const previous = tokens[tokens.length - 2]
  const text = token?.type === 'op' ? token.op : token?.type === 'word' ? plainText(token.word) : undefined
  const isStart = previous === undefined || previous.type === 'op' || (previous.type === 'word' && COMMAND_STARTS.has(plainText(previous.word) ?? ''))
  const last = cases.length - 1
  const state = cases[last]
  if (state === 'word') cases[last] = 'in'
  else if (state === 'in') {
    if (text === 'in') cases[last] = 'pattern'
  } else if (state === 'pattern') {
    if (text === 'esac') cases.pop()
    else if (text === ')') cases[last] = 'body'
  } else if (text === 'case' && isStart) cases.push('word')
  else if (state === 'body' && (text === ';;' || text === ';&' || text === ';;&')) cases[last] = 'pattern'
  else if (state === 'body' && text === 'esac' && isStart) cases.pop()
}

/** Whether the parts of a word so far are an unquoted `NAME=` or `NAME+=`, which a `(` turns into an array assignment. */
function isArrayName(parts: Word): boolean {
  const [only] = parts
  return parts.length === 1 && only?.kind === 'text' && !only.quoted && ARRAY_NAME.test(only.text)
}

/** One scan of one command line, or of the command inside a substitution that starts at `start`. With `modern`, it also reads arrays, the `;&` and `;;&` operators, and a `case` inside a substitution; without it, it reads as Arrester 1.1.3 did. */
class Lexer {
  readonly tokens: Token[] = []
  private readonly pending: { redirect: Redirect; raw: string }[] = []
  /** The source spelling of each expansion part, which a heredoc delimiter keeps as written. */
  private readonly spellings = new Map<Part, string>()
  private readonly src: string
  private readonly nesting: number
  private readonly modern: boolean
  private i: number
  /** How deep the `${…}` being read nests in other ones. */
  private braces = 0
  /** Set when, without `modern`, a substitution here ended at the `)` of a `case` pattern, as Arrester 1.1.3 ended it, where the shell and the modern reading go on to the `esac`. */
  legacy = false
  /** Set when the text holds `$'…'` or `$"…"`, also in a substitution; the reading does not change. */
  quoting = false

  constructor(src: string, start: number, nesting: number, modern: boolean) {
    this.src = src
    this.i = start
    this.nesting = nesting
    this.modern = modern
  }

  /** Scans the command; false when it does not parse or a heredoc has no end. */
  run(): boolean {
    try {
      this.scan(false)
    } catch (error) {
      if (error instanceof Unparsed) return false
      throw error
    }
    return this.pending.length === 0
  }

  /** The whole source read as a heredoc body that the shell expands; undefined when it does not parse. */
  expandable(): Word | undefined {
    const parts: Word = []
    try {
      this.quoted(parts, undefined, IN_HEREDOC)
    } catch (error) {
      if (error instanceof Unparsed) return undefined
      throw error
    }
    return parts
  }

  /** The main loop: blanks, newlines, comments, redirections, operators, and words. Inside a substitution it stops at the `)` that closes it and returns that index; in the modern reading, the `)` of a `case` pattern does not close it, and without it, such a close marks the reading `legacy`. */
  private scan(isInner: boolean): number {
    let depth = 0
    const cases: CaseState[] = []
    const tracks = isInner
    while (this.i < this.src.length) {
      const ch = this.src.charAt(this.i)
      if (ch === ' ' || ch === '\t') {
        this.i += 1
        continue
      }
      if (ch === '\\' && this.src.charAt(this.i + 1) === '\n') {
        this.i += 2
        continue
      }
      if (ch === '\n') {
        this.i += 1
        this.tokens.push({ type: 'op', op: '\n' })
        if (tracks) caseStep(cases, this.tokens)
        this.heredocs()
        continue
      }
      if (ch === '#') {
        const end = this.src.indexOf('\n', this.i)
        this.i = end < 0 ? this.src.length : end
        continue
      }
      if ((ch === '<' || ch === '>') && this.src.charAt(this.i + 1) === '(') {
        this.tokens.push({ type: 'word', word: this.word() })
        continue
      }
      const fd = FD.exec(this.src.slice(this.i, this.i + 10))?.[0]
      const at = this.i + (fd?.length ?? 0)
      const redirect = REDIRECTS.find(op => this.src.startsWith(op, at))
      if (redirect !== undefined) {
        this.i = at
        this.redirect(redirect, fd === undefined ? undefined : Number(fd))
        continue
      }
      const control = (this.modern ? MODERN_CONTROL : CONTROL).find(op => this.src.startsWith(op, this.i))
      if (control !== undefined) {
        const isPattern = cases.at(-1) === 'pattern'
        const inPattern = isPattern && this.modern
        if (isInner && control === ')' && depth === 0 && !inPattern) {
          if (this.pending.length > 0) throw new Unparsed()
          if (isPattern) this.legacy = true
          return this.i
        }
        if (control === '(' && !inPattern) depth += 1
        else if (control === ')' && !inPattern) depth -= 1
        this.i += control.length
        this.tokens.push({ type: 'op', op: control, ...(control === '(' && this.src.charAt(this.afterContinuations(this.i)) === '(' ? { joined: true as const } : {}) })
        if (tracks) caseStep(cases, this.tokens)
        continue
      }
      this.tokens.push({ type: 'word', word: this.word() })
      if (tracks) caseStep(cases, this.tokens)
    }
    if (isInner) throw new Unparsed()
    return this.i
  }

  /** A redirection and its target word; `<<` and `<<-` wait for their body after the next newline. Without a number, `<` forms read descriptor 0 and the others write descriptor 1. */
  private redirect(op: string, fd: number | undefined): void {
    this.i += op.length
    while (this.src.charAt(this.i) === ' ' || this.src.charAt(this.i) === '\t') this.i += 1
    const ch = this.src.charAt(this.i)
    const isProcess = (ch === '<' || ch === '>') && this.src.charAt(this.i + 1) === '('
    if (this.i >= this.src.length || (WORD_END.has(ch) && !isProcess)) throw new Unparsed()
    const start = this.i
    const redirect: Redirect = { op, fd: fd ?? (op.startsWith('<') ? 0 : 1), target: this.word() }
    if (op === '<<' || op === '<<-') this.pending.push({ redirect, raw: this.src.slice(start, this.i) })
    this.tokens.push({ type: 'redirect', redirect })
  }

  /** One word, up to an unquoted blank or operator. In the modern reading, a `(` right after an unquoted `NAME=` or `NAME+=` opens an array assignment, which must end the word; in an element of an array (`inArray`), such a nested array does not parse, before the lexer reads into it. */
  private word(inArray = false): Word {
    const parts: Word = []
    while (this.i < this.src.length) {
      const ch = this.src.charAt(this.i)
      const isProcess = (ch === '<' || ch === '>') && this.src.charAt(this.i + 1) === '('
      if (this.modern && ch === '(' && isArrayName(parts)) {
        if (inArray) throw new Unparsed()
        parts.push({ kind: 'array', elements: this.array() })
        if (this.i < this.src.length && !WORD_END.has(this.src.charAt(this.i))) throw new Unparsed()
        break
      }
      if (WORD_END.has(ch) && !isProcess) break
      const at = this.i
      if (isProcess) parts.push({ kind: 'process', command: this.inner(this.i + 1), isOutput: ch === '>' })
      else if (ch === "'") pushText(parts, this.single(), true)
      else if (ch === '"') this.double(parts)
      else if (ch === '\\') {
        if (this.src.charAt(this.i + 1) !== '\n') pushText(parts, this.src.charAt(this.i + 1), true)
        this.i += 2
      } else if (ch === '$') this.dollar(parts, false)
      else if (ch === '`') parts.push({ kind: 'sub', command: this.backtick(), quoted: false })
      else {
        pushText(parts, ch, false)
        this.i += 1
      }
      this.spell(parts, at)
    }
    return parts
  }

  /** The elements of an array assignment, from the `(` at the cursor to the `)` that closes it: words with blanks, newlines, and comments between them. Another operator, a nested array, and a newline before a pending heredoc body do not parse. */
  private array(): Word[] {
    const elements: Word[] = []
    this.i += 1
    for (;;) {
      if (this.i >= this.src.length) throw new Unparsed()
      const ch = this.src.charAt(this.i)
      if (ch === ')') {
        this.i += 1
        return elements
      }
      if (ch === '\n' && this.pending.length > 0) throw new Unparsed()
      if (ch === ' ' || ch === '\t' || ch === '\n') this.i += 1
      else if (ch === '\\' && this.src.charAt(this.i + 1) === '\n') this.i += 2
      else if (ch === '#') {
        const end = this.src.indexOf('\n', this.i)
        this.i = end < 0 ? this.src.length : end
      } else if (WORD_END.has(ch) && !((ch === '<' || ch === '>') && this.src.charAt(this.i + 1) === '(')) throw new Unparsed()
      else elements.push(this.word(true))
    }
  }

  /** Keeps the source spelling, from `at`, of an expansion part that the last step added, also for `spellingOf`. */
  private spell(parts: Word, at: number): void {
    const part = parts[parts.length - 1]
    if (part === undefined || part.kind === 'text' || this.spellings.has(part)) return
    this.spellings.set(part, this.src.slice(at, this.i))
    SPELLINGS.set(part, this.src.slice(at, this.i))
  }

  /** The text of a single-quoted string. */
  private single(): string {
    const end = this.src.indexOf("'", this.i + 1)
    if (end < 0) throw new Unparsed()
    const text = this.src.slice(this.i + 1, end)
    this.i = end + 1
    return text
  }

  /** A double-quoted string, from its opening quote to its closing one. */
  private double(parts: Word): void {
    this.i += 1
    this.quoted(parts, '"', IN_DOUBLE_QUOTES)
    this.i += 1
  }

  /** Quoted text and expansions up to `end`, or to the end of the source when `end` is undefined; a backslash escapes only the characters in `escapable`. */
  private quoted(parts: Word, end: string | undefined, escapable: string): void {
    const start = parts.length
    for (;;) {
      if (this.i >= this.src.length) {
        if (end === undefined) {
          if (parts.length === start) pushText(parts, '', true)
          return
        }
        throw new Unparsed()
      }
      const ch = this.src.charAt(this.i)
      if (ch === end) {
        if (parts.length === start) pushText(parts, '', true)
        return
      }
      const next = this.src.charAt(this.i + 1)
      const at = this.i
      if (ch === '\\' && next !== '' && escapable.includes(next)) {
        if (next !== '\n') pushText(parts, next, true)
        this.i += 2
      } else if (ch === '$') this.dollar(parts, true)
      else if (ch === '`') parts.push({ kind: 'sub', command: this.backtick(), quoted: true })
      else {
        pushText(parts, ch, true)
        this.i += 1
      }
      this.spell(parts, at)
    }
  }

  /** The index at or after `at` past each backslash-newline, which the shell removes before it reads `((`; only in the modern reading, so the reading of 1.1.3 stays as it was. */
  private afterContinuations(at: number): number {
    let index = at
    while (this.modern && this.src.startsWith('\\\n', index)) index += 2
    return index
  }

  /** A `$` expansion: arithmetic, a command substitution, a braced or plain variable, ANSI-C text, or a translated string; in the modern reading, `$(` and `(` with only backslash-newlines between them start arithmetic too. */
  private dollar(parts: Word, quoted: boolean): void {
    const next = this.src.charAt(this.i + 1)
    if (next === '(' && this.src.charAt(this.afterContinuations(this.i + 2)) === '(') {
      const start = this.i
      this.arithmetic(this.i + 1)
      const part: Part = { kind: 'unknown' }
      SOURCES.set(part, this.src.slice(start, this.i))
      parts.push(part)
    } else if (next === '(') parts.push({ kind: 'sub', command: this.inner(this.i + 1), quoted })
    else if (next === '{') parts.push(this.braced(quoted))
    else if (next === "'" && !quoted) {
      this.quoting = true
      pushText(parts, this.ansiC(), true)
    } else if (next === '"' && !quoted) {
      this.quoting = true
      this.i += 1
      this.double(parts)
    } else if (SPECIAL.has(next)) {
      this.i += 2
      parts.push({ kind: 'var', name: next, quoted })
    } else {
      const name = NAME.exec(this.src.slice(this.i + 1, this.i + 257))?.[0]
      if (name === undefined) {
        pushText(parts, '$', quoted)
        this.i += 1
      } else {
        this.i += 1 + name.length
        parts.push({ kind: 'var', name, quoted })
      }
    }
  }

  /** `${…}`, read to the `}` that closes it: the parameter it names when the body is a name and nothing more, a parameter part for `${#name}` and for an operator in OPERATORS with its word, else an unknown part, which keeps its source text. In the modern reading, `${name[@]}` and `${name[*]}` are an `elements` part, and every other form with `[` after a name, also after `#` or `!`, is an unknown part that names the array. */
  private braced(quoted: boolean): Part {
    if (this.braces >= MAX_NESTING) throw new Unparsed()
    this.braces += 1
    const start = this.i
    this.i += 2
    ARRAY_FORM.lastIndex = this.i
    const form = this.modern ? ARRAY_FORM.exec(this.src) : null
    const bracket = ARRAY_FORM.lastIndex
    const subscript = form === null ? '' : this.src.slice(bracket, bracket + 3)
    const counted = this.src.charAt(this.i) === '#' ? this.parameterName(this.i + 1) : undefined
    let part: Part
    if (form !== null && form[1] === '' && (subscript === '@]}' || subscript === '*]}')) {
      this.i = bracket + 3
      part = { kind: 'elements', name: form[2]!, joined: subscript === '*]}', quoted }
    } else if (form !== null) {
      this.operand(quoted)
      part = { kind: 'unknown', name: form[2]! }
    } else if (counted !== undefined && this.src.charAt(this.i + 1 + counted.length) === '}') {
      this.i += counted.length + 2
      part = { kind: 'param', name: counted, op: 'length', word: [], quoted }
    } else {
      const name = this.parameterName(this.i)
      const op = name === undefined ? undefined : OPERATORS.find(operator => this.src.startsWith(operator, this.i + name.length))
      if (name !== undefined && this.src.charAt(this.i + name.length) === '}') {
        this.i += name.length + 1
        part = { kind: 'var', name, quoted }
      } else {
        this.i += (name?.length ?? 0) + (op?.length ?? 0)
        const word = this.operand(quoted)
        part = name === undefined || op === undefined ? { kind: 'unknown' } : { kind: 'param', name, op, word, quoted }
      }
    }
    if (part.kind === 'unknown') SOURCES.set(part, this.src.slice(start, this.i))
    this.braces -= 1
    return part
  }

  /** The parameter name that starts at `at`: a name, digits, or one special character; undefined when none does. */
  private parameterName(at: number): string | undefined {
    BRACED_NAME.lastIndex = at
    return BRACED_NAME.exec(this.src)?.[0]
  }

  /** The word of a parameter operator, up to the `}` that closes its `${`: quotes, escapes, and expansions as in a word, blanks and operators as text. In double quotes, a `'` is plain text and a `"` opens quoted text whose quotes are removed. */
  private operand(quoted: boolean): Word {
    const parts: Word = []
    for (;;) {
      if (this.i >= this.src.length) throw new Unparsed()
      const ch = this.src.charAt(this.i)
      if (ch === '}') {
        this.i += 1
        return parts
      }
      const at = this.i
      const next = this.src.charAt(this.i + 1)
      if (ch === "'" && !quoted) pushText(parts, this.single(), true)
      else if (ch === '"') this.double(parts)
      else if (ch === '\\' && next === '') throw new Unparsed()
      else if (ch === '\\' && (!quoted || `${IN_DOUBLE_QUOTES}}`.includes(next))) {
        if (next !== '\n') pushText(parts, next, true)
        this.i += 2
      } else if (ch === '$') this.dollar(parts, quoted)
      else if (ch === '`') parts.push({ kind: 'sub', command: this.backtick(), quoted })
      else {
        pushText(parts, ch, quoted)
        this.i += 1
      }
      this.spell(parts, at)
    }
  }

  /** `$'…'` decoded: `\n`, `\t`, `\\`, `\'`, `\"`, `\xHH`, and `\NNN` (octal). */
  private ansiC(): string {
    let text = ''
    let j = this.i + 2
    while (j < this.src.length && this.src.charAt(j) !== "'") {
      if (this.src.charAt(j) !== '\\') {
        text += this.src.charAt(j)
        j += 1
        continue
      }
      const escape = this.src.slice(j + 1, j + 4)
      const hex = /^x[0-9a-fA-F]{1,2}/.exec(escape)?.[0]
      const octal = /^[0-7]{1,3}/.exec(escape)?.[0]
      if (hex !== undefined) {
        text += String.fromCharCode(parseInt(hex.slice(1), 16))
        j += 1 + hex.length
      } else if (octal !== undefined) {
        text += String.fromCharCode(parseInt(octal, 8))
        j += 1 + octal.length
      } else {
        const ch = this.src.charAt(j + 1)
        text += ESCAPES[ch] ?? ch
        j += 2
      }
    }
    if (j >= this.src.length) throw new Unparsed()
    this.i = j + 1
    return text
  }

  /** Skips `$((…))`, nested parentheses and quotes respected. */
  private arithmetic(open: number): void {
    let depth = 0
    let j = open
    while (j < this.src.length) {
      const ch = this.src.charAt(j)
      if (ch === '\\') j += 2
      else if (ch === "'" || ch === '"') j = this.closeQuote(j) + 1
      else {
        if (ch === '(') depth += 1
        if (ch === ')') depth -= 1
        if (depth === 0) {
          this.i = j + 1
          return
        }
        j += 1
      }
    }
    throw new Unparsed()
  }

  /** The command inside `$(…)`, `<(…)`, or `>(…)` whose parenthesis opens at `open`, found with a lexer of its own, so quotes, comments, and heredocs inside it count. */
  private inner(open: number): string {
    if (this.nesting >= MAX_NESTING) throw new Unparsed()
    const lexer = new Lexer(this.src, open + 1, this.nesting + 1, this.modern)
    const close = lexer.scan(true)
    if (lexer.legacy) this.legacy = true
    if (lexer.quoting) this.quoting = true
    this.i = close + 1
    return this.src.slice(open + 1, close)
  }

  /** The index of the quote that closes the one at `at`. */
  private closeQuote(at: number): number {
    const quote = this.src.charAt(at)
    let j = at + 1
    while (j < this.src.length && this.src.charAt(j) !== quote) j += quote === '"' && this.src.charAt(j) === '\\' ? 2 : 1
    if (j >= this.src.length) throw new Unparsed()
    return j
  }

  /** The command inside backticks. */
  private backtick(): string {
    let text = ''
    let j = this.i + 1
    while (j < this.src.length && this.src.charAt(j) !== '`') {
      const next = this.src.charAt(j + 1)
      if (this.src.charAt(j) === '\\' && next !== '' && '`\\$'.includes(next)) {
        text += next
        j += 2
      } else {
        text += this.src.charAt(j)
        j += 1
      }
    }
    if (j >= this.src.length) throw new Unparsed()
    this.i = j + 1
    return text
  }

  /** Reads the bodies of the heredocs started on the line that just ended. The delimiter is the target word with its quotes removed and its expansions as written; quote removal that changes the word means some part of it is quoted. */
  private heredocs(): void {
    for (const { redirect, raw } of this.pending.splice(0)) {
      const delimiter = redirect.target.map(part => (part.kind === 'text' ? part.text : this.spellings.get(part) ?? partText(part))).join('')
      const lines: string[] = []
      for (;;) {
        if (this.i >= this.src.length) throw new Unparsed()
        const end = this.src.indexOf('\n', this.i)
        const raw = this.src.slice(this.i, end < 0 ? this.src.length : end)
        this.i = end < 0 ? this.src.length : end + 1
        const line = redirect.op === '<<-' ? raw.replace(/^\t+/, '') : raw
        if (line === delimiter) break
        lines.push(`${line}\n`)
      }
      redirect.heredoc = { text: lines.join(''), quoted: delimiter.replaceAll('\\\n', '') !== raw.replaceAll('\\\n', '') }
    }
  }
}
