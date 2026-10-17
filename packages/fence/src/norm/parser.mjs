// Recursive-descent parser for the supported bash subset, over the tokenizer
// in tokenize.mjs. One pass, no backtracking, linear in the input.
//
// The parser's nesting is an explicit, bounded stack: every construct that
// nests (subshell, group, if/for/while/case, command substitution, `${…}`
// argument) enters a shared depth counter before it descends, and nesting past
// MAX_DEPTH is opaque `depth`. The JavaScript call stack therefore never holds
// more than a fixed number of frames per level, whatever the input.
//
// parseShell never throws and never returns a partly parsed program: any
// construct outside the subset, any cap exceeded and any internal error comes
// back as {opaque:{reason, construct, offset}}.

import { Lexer, Opaque, MAX_DEPTH, MAX_BYTES, isName } from './tokenize.mjs';

/**
 * @typedef {import('./tokenize.mjs').Word} Word
 * @typedef {import('./tokenize.mjs').Lit} Lit
 * @typedef {import('./tokenize.mjs').Var} Var
 * @typedef {import('./tokenize.mjs').CmdSub} CmdSub
 * @typedef {import('./tokenize.mjs').Arith} Arith
 * @typedef {import('./tokenize.mjs').Glob} Glob
 * @typedef {import('./tokenize.mjs').HeredocRedir} HeredocRedir
 * @typedef {{op:string, fd?:number, target:Word}|HeredocRedir} Redir
 *   op is one of `>` `>>` `>|` `&>` `&>>` `<` `<>` `>&` `<&` `<<<` (herestring,
 *   the target is the word), or `<<` `<<-` for a heredoc (HeredocRedir, no
 *   target).
 * @typedef {{type:'simple', assigns:{name:string, value:Word}[], words:Word[], redirs:Redir[], off:number}} SimpleNode
 *   `off` is the offset of the command's first token in the original command.
 * @typedef {{type:'list', items:{node:Node, async:boolean}[]}} ListNode
 *   `async` is true for a command ended by `&`.
 * @typedef {{type:'and'|'or', left:Node, right:Node}} AndOrNode
 * @typedef {{type:'pipeline', commands:Node[], ops:string[], negated:boolean}} PipelineNode
 *   ops[i] (`|` or `|&`) joins commands[i] and commands[i+1].
 * @typedef {{type:'subshell'|'group', body:ListNode, redirs:Redir[]}} BlockNode
 * @typedef {{type:'if', clauses:{cond:ListNode, body:ListNode}[], else:ListNode|null, redirs:Redir[]}} IfNode
 * @typedef {{type:'for', var:string, items:Word[]|null, body:ListNode, redirs:Redir[]}} ForNode
 *   items is null for `for x; do` (the positional parameters).
 * @typedef {{type:'while', until:boolean, cond:ListNode, body:ListNode, redirs:Redir[]}} WhileNode
 * @typedef {{type:'case', word:Word, arms:{patterns:Word[], body:ListNode|null, term:string|null}[], redirs:Redir[]}} CaseNode
 * @typedef {ListNode|AndOrNode|PipelineNode|BlockNode|IfNode|ForNode|WhileNode|CaseNode|SimpleNode} Node
 * @typedef {{opaque:{reason:string, construct:string, offset:number}}} OpaqueResult
 */

export { MAX_DEPTH, MAX_BYTES };

// Words that end a list when they appear in command position.
const LIST_END_WORDS = new Set(['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}']);
const CASE_TERMS = new Set([';;', ';&', ';;&']);
const UNSUPPORTED_WORDS = new Set(['function', 'select', '[[', ']]']);
// zsh-only reserved words and precommand modifiers in command position.
const ZSH_COMMAND_WORDS = new Set(['repeat', 'coproc', 'foreach', '-']);

const ASSIGN_LIKE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The literal value of a word when it has no expansion and no glob: `r''m`,
 * `"r"m` and `\rm` all give `rm`. Returns null otherwise, including for a word
 * that undergoes tilde expansion: a leading unquoted `~`, and in an
 * assignment value or an assignment-like word (bash expands those too) an
 * unquoted `~` after `=` or `:`.
 * @param {Word} word
 * @returns {string|null}
 */
export function literalValue(word) {
  const text = literalText(word);
  if (text === null) return null;
  const ps = word.parts;
  if (ps.length === 0) return text;
  if (!ps[0].quoted && ps[0].text.startsWith('~')) return null;
  const assignLike = word.assign === true || (!ps[0].quoted && ASSIGN_LIKE.test(ps[0].text));
  if (!assignLike) return text;
  let prev = '';
  for (const p of ps) {
    for (let i = 0; i < p.text.length; i++) {
      const c = p.text[i];
      if (!p.quoted && c === '~' && (prev === ':' || prev === '=')) return null;
      prev = c;
    }
  }
  return text;
}

/**
 * The literal text of a word, ignoring quoting, when it has no expansion and
 * no glob. Unlike literalValue it does not refuse tilde words, so it is for
 * display and reserved-word checks only: never use it to resolve a path or a
 * command name (use literalValue, which is null for words the shell expands).
 * @param {Word} word
 * @returns {string|null}
 */
export function literalText(word) {
  let out = '';
  for (const p of word.parts) {
    if (p.type !== 'lit') return null;
    out += p.text;
  }
  return out;
}

// The text of a token that is a single unquoted literal (a reserved word
// candidate), else null.
function plainWord(t) {
  if (t.t !== 'word') return null;
  const ps = t.word.parts;
  if (ps.length !== 1 || ps[0].type !== 'lit' || ps[0].quoted) return null;
  return ps[0].text;
}

// `{NAME}` as a single unquoted literal.
function isNamedFd(t) {
  const w = plainWord(t);
  return w !== null && w.length > 2 && w[0] === '{' && w[w.length - 1] === '}' && isName(w.slice(1, -1));
}

function endsWithUnquotedEquals(word) {
  const last = word.parts[word.parts.length - 1];
  return last !== undefined && last.type === 'lit' && !last.quoted && last.text.endsWith('=');
}

function isOp(t, v) {
  return t.t === 'op' && t.v === v;
}

function describe(t) {
  if (t.t === 'op') return t.v === '\n' ? 'newline' : t.v;
  if (t.t === 'redir') return 'redirection';
  if (t.t === 'eof') return 'end';
  return plainWord(t) ?? 'word';
}

class Parser {
  constructor(text, base, shared, map = null) {
    this.shared = shared;
    this.lex = new Lexer(text, base, this, map);
  }

  enter(construct, off) {
    if (++this.shared.depth > MAX_DEPTH) throw new Opaque('depth', construct, off);
  }

  leave() {
    this.shared.depth--;
  }

  syntax(t) {
    return new Opaque('syntax', describe(t), t.off);
  }

  // A missing closer: unterminated at end of input, a syntax error otherwise.
  missing(t, construct, openOff) {
    if (t.t === 'eof') return new Opaque('unterminated', construct, openOff);
    return this.syntax(t);
  }

  parseProgram() {
    const list = this.parseList();
    const t = this.lex.peek();
    if (t.t !== 'eof') throw this.syntax(t);
    return list;
  }

  // Called by the lexer after `$(`: the inner program and its closing `)`.
  parseCmdSubBody(off) {
    const list = this.parseList();
    const t = this.lex.next();
    if (!isOp(t, ')')) throw this.missing(t, 'command-substitution', off);
    return list;
  }

  // Called by the lexer for backtick text; map[i] is the original offset of text[i].
  parseNested(text, map) {
    return new Parser(text, 0, this.shared, map).parseProgram();
  }

  // Called by the lexer for an unquoted heredoc body; map[i] is the original
  // offset of text[i]. A `$( … )` in the body parses from the body's lexer.
  parseHeredocBody(text, map) {
    return new Parser(text, 0, this.shared, map).lex.readHeredocParts();
  }

  skipNewlines() {
    while (isOp(this.lex.peek(), '\n')) this.lex.next();
  }

  isListEnd(t) {
    if (t.t === 'eof') return true;
    if (t.t === 'op') return t.v === ')' || CASE_TERMS.has(t.v);
    const w = plainWord(t);
    return w !== null && LIST_END_WORDS.has(w);
  }

  /** @returns {ListNode} */
  parseList() {
    const items = [];
    for (;;) {
      this.skipNewlines();
      if (this.isListEnd(this.lex.peek())) break;
      const node = this.parseAndOr();
      const t = this.lex.peek();
      if (isOp(t, ';') || isOp(t, '\n') || isOp(t, '&')) {
        this.lex.next();
        items.push({ node, async: t.v === '&' });
      } else {
        items.push({ node, async: false });
        break;
      }
    }
    return { type: 'list', items };
  }

  parseAndOr() {
    let left = this.parsePipeline();
    for (;;) {
      const t = this.lex.peek();
      if (!isOp(t, '&&') && !isOp(t, '||')) return left;
      this.lex.next();
      this.skipNewlines();
      const right = this.parsePipeline();
      left = { type: t.v === '&&' ? 'and' : 'or', left, right };
    }
  }

  parsePipeline() {
    let negated = false;
    if (plainWord(this.lex.peek()) === '!') {
      this.lex.next();
      negated = true;
    }
    const commands = [this.parseCommand()];
    const ops = [];
    for (;;) {
      const t = this.lex.peek();
      if (!isOp(t, '|') && !isOp(t, '|&')) break;
      this.lex.next();
      this.skipNewlines();
      ops.push(t.v);
      commands.push(this.parseCommand());
    }
    if (commands.length === 1 && !negated) return commands[0];
    return { type: 'pipeline', commands, ops, negated };
  }

  parseCommand() {
    const t = this.lex.peek();
    if (isOp(t, '(')) return this.withRedirs(this.parseSubshell());
    if (t.t === 'redir') return this.parseSimple();
    if (t.t !== 'word') throw this.syntax(t);
    const w = plainWord(t);
    switch (w) {
      case 'if':
        return this.withRedirs(this.parseIf());
      case 'for':
        return this.withRedirs(this.parseFor());
      case 'while':
      case 'until':
        return this.withRedirs(this.parseWhile(w === 'until'));
      case 'case':
        return this.withRedirs(this.parseCase());
      case '{':
        return this.withRedirs(this.parseGroup());
      default:
        break;
    }
    if (w !== null && UNSUPPORTED_WORDS.has(w)) throw new Opaque('unsupported', w, t.off);
    if (w !== null && (LIST_END_WORDS.has(w) || w === '!' || w === 'in')) throw this.syntax(t);
    return this.parseSimple();
  }

  // Redirections after a compound command.
  withRedirs(node) {
    node.redirs = [];
    while (this.lex.peek().t === 'redir') node.redirs.push(this.parseRedir());
    return node;
  }

  parseRedir() {
    const r = this.lex.next();
    const target = this.lex.next();
    if (target.t !== 'word') throw this.syntax(target);
    if (r.op === '<<' || r.op === '<<-') return this.lex.heredoc(r, target);
    const redir = { op: r.op, target: target.word };
    if (r.fd !== undefined) redir.fd = r.fd;
    return redir;
  }

  expectWord(word, construct, openOff) {
    const t = this.lex.next();
    if (plainWord(t) !== word) throw this.missing(t, construct, openOff);
  }

  nonEmpty(list, t) {
    if (list.items.length === 0) throw this.syntax(t);
    return list;
  }

  parseSubshell() {
    const open = this.lex.next();
    if (isOp(this.lex.peek(), '(') && this.lex.peek().adj) {
      // `((` is an arithmetic command; count the run so a long run of
      // parentheses reports depth instead of recursing.
      let n = 1;
      while (isOp(this.lex.peek(), '(') && this.lex.peek().adj && n <= MAX_DEPTH) {
        this.lex.next();
        n++;
      }
      if (this.shared.depth + n > MAX_DEPTH) throw new Opaque('depth', 'subshell', open.off);
      throw new Opaque('unsupported', 'arithmetic-command', open.off);
    }
    this.enter('subshell', open.off);
    const body = this.parseList();
    const close = this.lex.next();
    if (!isOp(close, ')')) throw this.missing(close, 'subshell', open.off);
    this.nonEmpty(body, close);
    this.leave();
    return { type: 'subshell', body };
  }

  parseGroup() {
    const open = this.lex.next();
    this.enter('group', open.off);
    const body = this.parseList();
    const close = this.lex.peek();
    this.expectWord('}', 'group', open.off);
    this.nonEmpty(body, close);
    this.leave();
    return { type: 'group', body };
  }

  // cond list, `then`, body list (both non-empty)
  parseClause(open) {
    const cond = this.nonEmpty(this.parseList(), this.lex.peek());
    this.expectWord('then', 'if', open.off);
    const body = this.nonEmpty(this.parseList(), this.lex.peek());
    return { cond, body };
  }

  parseIf() {
    const open = this.lex.next();
    this.enter('if', open.off);
    const clauses = [this.parseClause(open)];
    let elseList = null;
    for (;;) {
      const w = plainWord(this.lex.peek());
      if (w === 'elif') {
        this.lex.next();
        clauses.push(this.parseClause(open));
      } else if (w === 'else') {
        this.lex.next();
        elseList = this.nonEmpty(this.parseList(), this.lex.peek());
        break;
      } else break;
    }
    this.expectWord('fi', 'if', open.off);
    this.leave();
    return { type: 'if', clauses, else: elseList };
  }

  parseDoBody(open, construct) {
    this.expectWord('do', construct, open.off);
    const body = this.nonEmpty(this.parseList(), this.lex.peek());
    this.expectWord('done', construct, open.off);
    return body;
  }

  parseFor() {
    const open = this.lex.next();
    this.enter('for', open.off);
    const v = this.lex.next();
    if (isOp(v, '(')) throw new Opaque('unsupported', 'arithmetic-for', v.off);
    const name = plainWord(v);
    if (name === null || !isName(name)) throw this.missing(v, 'for', open.off);
    this.skipNewlines();
    let items = null;
    if (plainWord(this.lex.peek()) === 'in') {
      this.lex.next();
      items = [];
      while (this.lex.peek().t === 'word') items.push(this.lex.next().word);
      const sep = this.lex.next();
      if (!isOp(sep, ';') && !isOp(sep, '\n')) throw this.missing(sep, 'for', open.off);
    } else if (isOp(this.lex.peek(), ';')) {
      this.lex.next();
    }
    this.skipNewlines();
    const body = this.parseDoBody(open, 'for');
    this.leave();
    return { type: 'for', var: name, items, body };
  }

  parseWhile(until) {
    const open = this.lex.next();
    const construct = until ? 'until' : 'while';
    this.enter(construct, open.off);
    const cond = this.nonEmpty(this.parseList(), this.lex.peek());
    const body = this.parseDoBody(open, construct);
    this.leave();
    return { type: 'while', until, cond, body };
  }

  parseCase() {
    const open = this.lex.next();
    this.enter('case', open.off);
    const subject = this.lex.next();
    if (subject.t !== 'word') throw this.missing(subject, 'case', open.off);
    this.skipNewlines();
    this.expectWord('in', 'case', open.off);
    const arms = [];
    for (;;) {
      this.skipNewlines();
      let t = this.lex.peek();
      if (plainWord(t) === 'esac') {
        this.lex.next();
        break;
      }
      if (isOp(t, '(')) this.lex.next();
      const patterns = [];
      for (;;) {
        t = this.lex.next();
        if (t.t !== 'word') throw this.missing(t, 'case', open.off);
        patterns.push(t.word);
        if (!isOp(this.lex.peek(), '|')) break;
        this.lex.next();
      }
      t = this.lex.next();
      if (!isOp(t, ')')) throw this.missing(t, 'case', open.off);
      const list = this.parseList();
      const body = list.items.length ? list : null;
      t = this.lex.peek();
      if (t.t === 'op' && CASE_TERMS.has(t.v)) {
        this.lex.next();
        arms.push({ patterns, body, term: t.v });
        continue;
      }
      arms.push({ patterns, body, term: null });
      this.skipNewlines();
      this.expectWord('esac', 'case', open.off);
      break;
    }
    this.leave();
    return { type: 'case', word: subject.word, arms };
  }

  // A leading NAME=value word as an assignment, or null.
  assignment(t) {
    const ps = t.word.parts;
    const first = ps[0];
    if (!first || first.type !== 'lit' || first.quoted) return null;
    const eq = first.text.indexOf('=');
    if (eq < 0) {
      // NAME[…]=… is an array element assignment
      if (isName(first.text) && ps[1] && ps[1].type === 'glob' && ps[1].text === '[') {
        for (let i = 2; i < ps.length; i++) {
          if (ps[i].type === 'lit' && !ps[i].quoted && ps[i].text.includes('=')) {
            throw new Opaque('unsupported', 'array-assign', t.off);
          }
        }
      }
      return null;
    }
    const name = first.text.slice(0, eq);
    if (!isName(name)) {
      if (name.endsWith('+') && isName(name.slice(0, -1))) throw new Opaque('unsupported', 'append-assign', t.off);
      return null;
    }
    const rest = first.text.slice(eq + 1);
    // zsh EQUALS expands a value starting with `=` (`X==ls`)
    if (rest.startsWith('=') && (rest.length > 1 || ps.length > 1)) throw new Opaque('unsupported', 'zsh-syntax', t.off);
    const parts = rest ? [{ type: 'lit', text: rest, quoted: false }, ...ps.slice(1)] : ps.slice(1);
    return { name, value: { parts, assign: true } };
  }

  /** @returns {SimpleNode} */
  parseSimple() {
    const off = this.lex.peek().off;
    const assigns = [];
    const words = [];
    const redirs = [];
    let lastAssign = false;
    let lastWord = null;
    for (;;) {
      const t = this.lex.peek();
      if (t.t === 'redir') {
        redirs.push(this.parseRedir());
        lastAssign = false;
      } else if (t.t === 'word') {
        this.lex.next();
        const after = this.lex.peek();
        // bash `{fd}>file` allocates a descriptor into a variable
        if (after.t === 'redir' && after.adj && isNamedFd(t)) throw new Opaque('unsupported', 'named-fd', t.off);
        const a = words.length === 0 ? this.assignment(t) : null;
        if (a) {
          assigns.push(a);
        } else {
          if (words.length === 0 && ZSH_COMMAND_WORDS.has(plainWord(t))) {
            throw new Opaque('unsupported', 'zsh-syntax', t.off);
          }
          words.push(t.word);
        }
        lastAssign = a !== null;
        lastWord = t;
      } else if (isOp(t, '(')) {
        if (lastAssign && t.adj) throw new Opaque('unsupported', 'array-assign', t.off);
        // zsh `=( … )` process substitution
        if (t.adj && lastWord && endsWithUnquotedEquals(lastWord.word)) {
          throw new Opaque('unsupported', 'zsh-syntax', t.off);
        }
        if (words.length === 1 && assigns.length === 0) {
          this.lex.next();
          // `name ( )` is a function definition; `time ( … )` is not
          if (isOp(this.lex.peek(), ')')) throw new Opaque('unsupported', 'function', t.off);
        }
        // `(` touching a word: a zsh glob qualifier `*(e:cmd:)` or grouping
        if (t.adj) throw new Opaque('unsupported', 'zsh-syntax', t.off);
        throw this.syntax(t);
      } else {
        break;
      }
    }
    return { type: 'simple', assigns, words, redirs, off };
  }
}

/**
 * Parse a shell command string.
 * @param {string} text
 * @returns {ListNode|OpaqueResult}
 */
export function parseShell(text) {
  try {
    if (typeof text !== 'string') return { opaque: { reason: 'internal', construct: 'input', offset: 0 } };
    if (text.length > MAX_BYTES || Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
      return { opaque: { reason: 'size', construct: 'command', offset: 0 } };
    }
    const nul = text.indexOf('\0');
    if (nul >= 0) return { opaque: { reason: 'unsupported', construct: 'nul', offset: nul } };
    return new Parser(text, 0, { depth: 0 }).parseProgram();
  } catch (e) {
    if (e instanceof Opaque) return { opaque: e.opaque };
    return { opaque: { reason: 'internal', construct: (e && e.name) || 'error', offset: 0 } };
  }
}
