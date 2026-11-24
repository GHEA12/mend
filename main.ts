// main.ts is mend, the CLI SPEC.md specifies: it applies AI-written edits in four formats
// (unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a tree of text
// files, changing every file or none. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. Sections 1 to 4, 9 and 10 follow the kit starter's
// shape; sections 5 to 8 (line matching at three tiers, unified diffs, SEARCH/REPLACE
// blocks and V4A patches) are implemented here.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Spaces and tabs only: the whitespace SPEC.md's matching tiers strip. */
const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** One file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One line of N: `ctx` is its index in O when it is a context line, -1 when it is added. */
interface NLine {
  text: string;
  ctx: number;
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

/** Positions where O occurs in `lines` at `tier`, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eof: boolean): number[] {
  const out: number[] = [];
  const last = lines.length - o.length;
  for (let p = Math.max(from, 0); p <= last; p += 1) {
    if (eof && p + o.length !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineEq(lines[p + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(p);
  }
  return out;
}

/** The first tier at which O occurs (at or after `from`), with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number, eof: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos = occurrences(lines, o, tier, from, eof);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** N with context lines taken from the file and other lines re-indented at tier 2 (section 5). */
function buildNew(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  let p = '';
  let f = '';
  if (tier === 2 && o.length > 0) {
    p = leadST(o[0]!);
    f = leadST(fileLines[pos]!);
  }
  for (const nl of n) {
    if (nl.ctx >= 0) {
      out.push(fileLines[pos + nl.ctx]!);
      continue;
    }
    const t = nl.text;
    if (tier === 2 && t !== '' && trimST(t) !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC.md section 6) ----

type HunkOp = { t: 'ctx' | 'del' | 'add' | 'bs'; text: string };
interface Hunk {
  a: number;
  ops: HunkOp[];
}
interface Section {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `--- ` or `+++ ` line names, or null for /dev/null. */
function diffPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** A hunk's body, from the line after its header; empty lines at its end are not part of it. */
function parseHunk(lines: string[], i: number, a: number): { hunk: Hunk; next: number } {
  const ops: HunkOp[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      ops.push({ t: 'ctx', text: '' });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      ops.push({ t: 'ctx', text: l.slice(1) });
      j += 1;
      continue;
    }
    if (c === '-') {
      ops.push({ t: 'del', text: l.slice(1) });
      j += 1;
      continue;
    }
    if (c === '+') {
      ops.push({ t: 'add', text: l.slice(1) });
      j += 1;
      continue;
    }
    if (c === '\\') {
      ops.push({ t: 'bs', text: l.slice(1) });
      j += 1;
      continue;
    }
    break;
  }
  while (ops.length > 0 && ops[ops.length - 1]!.t === 'ctx' && ops[ops.length - 1]!.text === '') ops.pop();
  return { hunk: { a, ops }, next: j };
}

/** Whether a `\` line follows the hunk's last line of one of the given kinds. */
function noEolAfter(hunk: Hunk, kinds: Array<'ctx' | 'add'>): boolean {
  let last = -1;
  for (let k = 0; k < hunk.ops.length; k += 1) {
    if (kinds.includes(hunk.ops[k]!.t as 'ctx' | 'add')) last = k;
  }
  if (last < 0) return false;
  return hunk.ops[last + 1] !== undefined && hunk.ops[last + 1]!.t === 'bs';
}

/** A hunk's old lines O and new lines N (with context mapping). */
function hunkParts(hunk: Hunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  let oi = 0;
  for (const op of hunk.ops) {
    if (op.t === 'ctx') {
      o.push(op.text);
      n.push({ text: op.text, ctx: oi });
      oi += 1;
    } else if (op.t === 'del') {
      o.push(op.text);
      oi += 1;
    } else if (op.t === 'add') {
      n.push({ text: op.text, ctx: -1 });
    }
  }
  return { o, n };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const fresh = (diffOld: string | undefined, diffNew: string | undefined): Section => ({
    oldPath: undefined,
    newPath: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld,
    diffNew,
    create: false,
    del: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh(m[1], m[2]);
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i, parseInt(m[1]!, 10));
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = diffPath(l);
        i += 1;
        continue;
      }
      if (l.startsWith('+++ ')) {
        cur.newPath = diffPath(l);
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = fresh(undefined, undefined);
      sections.push(cur);
      inHeader = true;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** One unified section as an edit. */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.oldPath !== undefined ? sec.oldPath : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newP = sec.newPath !== undefined ? sec.newPath : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  const oldPath = oldP === undefined ? newP ?? null : oldP;
  const newPath = newP === undefined ? oldP ?? null : newP;
  const isCreate = sec.create || oldPath === null;
  const isDelete = !isCreate && (sec.del || newPath === null);
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      const target = newPath ?? oldPath;
      if (target === null) throw new Fail('unsafe', '');
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const out: string[] = [];
      let noEol = false;
      let seenPlus = false;
      for (const hunk of sec.hunks) {
        for (const op of hunk.ops) if (op.t === 'add') out.push(op.text);
        if (hunk.ops.some((op) => op.t === 'add')) {
          seenPlus = true;
          noEol = noEolAfter(hunk, ['add']);
        }
      }
      tree.now.set(target, out.length === 0 ? '' : out.join('\n') + (seenPlus && noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = oldPath ?? newPath;
      if (target === null) throw new Fail('unsafe', '');
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const from = oldPath ?? newPath;
    const to = newPath ?? oldPath;
    if (from === null || to === null) throw new Fail('unsafe', '');
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (from !== to && tree.get(to) !== null) throw new Fail('exists', to);
    const f = splitFile(before);
    let d = 0;
    for (const hunk of sec.hunks) {
      const { o, n } = hunkParts(hunk);
      const noEol = noEolAfter(hunk, ['ctx', 'add']);
      if (o.length === 0) {
        const at = Math.min(Math.max(hunk.a + d, 0), f.lines.length);
        const touchesEnd = at === f.lines.length;
        f.lines.splice(at, 0, ...n.map((x) => x.text));
        if (touchesEnd) f.final = !noEol;
        d += n.length;
        continue;
      }
      const found = findTier(f.lines, o, strict, 0, false);
      if (found === null) throw new Fail('no-match', from);
      const want = hunk.a - 1 + d;
      let pos = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - want) < Math.abs(pos - want)) pos = p;
      }
      const touchesEnd = pos + o.length === f.lines.length;
      const made = buildNew(f.lines, pos, o, n, found.tier);
      f.lines.splice(pos, o.length, ...made);
      if (touchesEnd) f.final = !noEol;
      d += n.length - o.length;
    }
    const out = joinFile(f);
    tree.now.set(to, out);
    if (from !== to) {
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => unifiedEdit(sec, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const made = buildNew(f.lines, found.pos[0]!, oldLines, newLines.map((t) => ({ text: t, ctx: -1 })), found.tier);
    f.lines.splice(found.pos[0]!, oldLines.length, ...made);
    tree.now.set(path, joinFile(f));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (;;) {
    let s = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  ops: HunkOp[];
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  moveTo: string | undefined;
  addLines: string[];
  chunks: VChunk[];
}

const ADD_PREFIX = '*** Add File: ';
const DEL_PREFIX = '*** Delete File: ';
const UPD_PREFIX = '*** Update File: ';
const MOVE_PREFIX = '*** Move to: ';

function sectionStart(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith(ADD_PREFIX)) return 'add';
  if (line.startsWith(DEL_PREFIX)) return 'delete';
  if (line.startsWith(UPD_PREFIX)) return 'update';
  return null;
}

/** One V4A section's raw lines (between its start line and the next section or End Patch). */
function v4aSections(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const kind = sectionStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? ADD_PREFIX : kind === 'delete' ? DEL_PREFIX : UPD_PREFIX;
    const sec: VSection = { kind, path: l.slice(prefix.length).trim(), line: i + 1, moveTo: undefined, addLines: [], chunks: [] };
    sections.push(sec);
    const raw: string[] = [];
    let j = i + 1;
    while (j < last) {
      const x = lines[j]!;
      if (!blank(x) && sectionStart(x) !== null) break;
      raw.push(x);
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      for (let k = 0; k < raw.length; k += 1) {
        const x = raw[k]!;
        if (x.startsWith('+')) sec.addLines.push(x.slice(1));
        else if (x === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k += 1) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
    } else {
      let k = 0;
      if (k < raw.length && raw[k]!.startsWith(MOVE_PREFIX)) {
        sec.moveTo = raw[k]!.slice(MOVE_PREFIX.length).trim();
        k += 1;
      }
      let cur: VChunk | null = null;
      let closedByEof = false;
      for (; k < raw.length; k += 1) {
        const x = raw[k]!;
        if (x.startsWith('@@')) {
          cur = { anchor: x.slice(2).trim() === '' ? null : x.slice(2).trim(), eof: false, ops: [] };
          sec.chunks.push(cur);
          closedByEof = false;
          continue;
        }
        if (x === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 2 + k}`);
          cur.eof = true;
          cur = null;
          closedByEof = true;
          continue;
        }
        const c = x === '' ? ' ' : x[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          if (cur === null) {
            if (closedByEof || sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 2 + k}`);
            cur = { anchor: null, eof: false, ops: [] };
            sec.chunks.push(cur);
          }
          if (c === ' ') cur.ops.push({ t: 'ctx', text: x.slice(1) });
          else if (c === '-') cur.ops.push({ t: 'del', text: x.slice(1) });
          else cur.ops.push({ t: 'add', text: x.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === undefined) throw new Exit2(`error: parse ${sec.line}`);
    }
    i = j;
  }
  return sections;
}

/** One V4A section as an edit. */
function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let foundAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let p = cursor; p < f.lines.length; p += 1) {
            if (lineEq(f.lines[p]!, chunk.anchor, tier)) {
              foundAt = p;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', sec.path);
        cursor = foundAt + 1;
      }
      const { o, n } = hunkParts({ a: 0, ops: chunk.ops });
      if (o.length === 0) {
        const at = chunk.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...n.map((x) => x.text));
        cursor = at + n.length;
        continue;
      }
      const found = findTier(f.lines, o, strict, cursor, chunk.eof);
      if (found === null) throw new Fail('no-match', sec.path);
      const pos = found.pos[0]!;
      const made = buildNew(f.lines, pos, o, n, found.tier);
      f.lines.splice(pos, o.length, ...made);
      cursor = pos + made.length;
    }
    const out = joinFile(f);
    if (sec.moveTo !== undefined) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return v4aSections(lines).map((sec) => v4aEdit(sec, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      rOld.add(o);
      rNew.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p) || rNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
