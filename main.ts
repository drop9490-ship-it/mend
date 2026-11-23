// main.ts is mend, the CLI SPEC.md specifies. Starter did sections 1 to 4, 9 and 10
// (command line, output and exit codes, safe paths, format detection, JSON edits,
// atomicity); this file adds sections 5 to 8: three-tier line matching, unified
// diffs, SEARCH/REPLACE blocks and V4A patches. Node 22, standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

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
  recordMove(oldPath: string, newPath: string): void {
    this.moves.push([oldPath, newPath]);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Section 3: file line model
// ---------------------------------------------------------------------------

interface FileModel {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let finalBreak = false;
  if (text.endsWith(br)) {
    lines.pop();
    finalBreak = true;
  }
  return { br, lines, finalBreak };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

// ---------------------------------------------------------------------------
// Section 5: matching lines
// ---------------------------------------------------------------------------

/** One line of an old/new pair: context lines live in both O and N. */
interface LItem {
  text: string;
  ctx: boolean;
  oIdx: number; // index in O when ctx, else -1
  noNL: boolean; // a `\` line follows this body line
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function findOccurrences(O: string[], fileLines: string[], tier: number): number[] {
  const oN = O.map((l) => normLine(l, tier));
  const fN = fileLines.map((l) => normLine(l, tier));
  const res: number[] = [];
  for (let i = 0; i + O.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (fN[i + j] !== oN[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** First tier (0, 1, 2; only 0 when strict) with an occurrence at or after `from`. */
function tierFind(
  O: string[],
  fileLines: string[],
  strict: boolean,
  from: number,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = findOccurrences(O, fileLines, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/**
 * Replace O by N at position pos. Context lines are written as the file's own
 * matched lines; at tier 2 every other N line is re-indented from O's first
 * line's leading whitespace to the file's first matched line's.
 */
function applyReplace(fileLines: string[], O: LItem[], N: LItem[], pos: number, tier: number): string[] {
  const out = fileLines.slice(0, pos);
  const P = O.length > 0 ? leadingWs(O[0]!.text) : '';
  const F = fileLines.length > pos ? leadingWs(fileLines[pos]!) : '';
  for (const item of N) {
    if (item.ctx) {
      out.push(fileLines[pos + item.oIdx]!);
    } else if (tier === 2) {
      const t = item.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(P)) out.push(F + t.slice(P.length));
      else out.push(t);
    } else {
      out.push(item.text);
    }
  }
  out.push(...fileLines.slice(pos + O.length));
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

// ---------------------------------------------------------------------------
// Section 9: JSON edits (starter, unchanged)
// ---------------------------------------------------------------------------

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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNL: boolean;
}

interface Hunk {
  A: number;
  O: LItem[];
  N: LItem[];
  items: BodyItem[];
  lastCtxPlusNoNL: boolean;
  hasCtxPlus: boolean;
}

function parsePathField(s: string): string {
  let t = s.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function unifiedPath(p: string): string | null {
  if (p === '/dev/null') return null;
  return stripAB(p);
}

/** Parse one hunk starting at lines[i] (an @@ line). Returns the hunk and the next index. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const A = Number(m[1]);
  // Collect raw body lines, then drop empty lines at the end of the body.
  const raw: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push(l);
      j++;
    } else break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const items: BodyItem[] = [];
  for (const l of raw) {
    if (l === '') items.push({ kind: 'ctx', text: '', noNL: false });
    else if (l[0] === ' ') items.push({ kind: 'ctx', text: l.slice(1), noNL: false });
    else if (l[0] === '-') items.push({ kind: 'old', text: l.slice(1), noNL: false });
    else if (l[0] === '+') items.push({ kind: 'new', text: l.slice(1), noNL: false });
    else if (l[0] === '\\') {
      if (items.length > 0) items[items.length - 1]!.noNL = true;
    }
  }
  const O: LItem[] = [];
  const N: LItem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      const oIdx = O.length;
      O.push({ text: it.text, ctx: true, oIdx, noNL: it.noNL });
      N.push({ text: it.text, ctx: true, oIdx, noNL: it.noNL });
    } else if (it.kind === 'old') {
      O.push({ text: it.text, ctx: false, oIdx: -1, noNL: it.noNL });
    } else {
      N.push({ text: it.text, ctx: false, oIdx: -1, noNL: it.noNL });
    }
  }
  let lastCtxPlusNoNL = false;
  let hasCtxPlus = false;
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it.kind === 'ctx' || it.kind === 'new') {
      lastCtxPlusNoNL = it.noNL;
      hasCtxPlus = true;
      break;
    }
  }
  return { hunk: { A, O, N, items, lastCtxPlusNoNL, hasCtxPlus }, next: j };
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

/**
 * Parse one section. startIdx is the index of the first line after the
 * `diff --git` line, or the index of the `--- ` line that starts the section.
 * diffOld/diffNew are the paths from the `diff --git` line (null when the
 * section starts at a `--- ` line).
 */
function parseSection(lines: string[], startIdx: number, diffOld: string | null, diffNew: string | null): { section: Section; next: number } {
  let headerOld: string | null | undefined;
  let headerNew: string | null | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let newFileMode = false;
  let deletedFileMode = false;
  const hunks: Hunk[] = [];
  let j = startIdx;
  let seenHunk = false;
  let headerPairSeen = false;
  // A section starting at a ---/+++ pair: consume the pair first.
  if (diffOld === null && j < lines.length && lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) {
    headerOld = unifiedPath(parsePathField(lines[j]!));
    headerNew = unifiedPath(parsePathField(lines[j + 1]!));
    j += 2;
    headerPairSeen = true;
  }
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('@@')) {
      const { hunk, next } = parseHunk(lines, j);
      hunks.push(hunk);
      seenHunk = true;
      j = next;
      continue;
    }
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) {
      // The section's own header pair (once, before any hunk) is consumed;
      // any later pair starts a new section.
      if (!seenHunk && !headerPairSeen) {
        headerOld = unifiedPath(parsePathField(l));
        headerNew = unifiedPath(parsePathField(lines[j + 1]!));
        headerPairSeen = true;
        j += 2;
        continue;
      }
      break;
    }
    if (!seenHunk) {
      if (l.startsWith('--- ')) {
        // A --- line not followed by a +++ line inside the header.
        throw new Exit2(`error: parse ${j + 2}`);
      }
      if (l.startsWith('rename from ')) {
        renameFrom = stripAB(l.slice('rename from '.length).trim());
      } else if (l.startsWith('rename to ')) {
        renameTo = stripAB(l.slice('rename to '.length).trim());
      } else if (l === 'new file mode' || l.startsWith('new file mode ')) {
        newFileMode = true;
      } else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        deletedFileMode = true;
      }
      // Any other header line (index, old/new mode, similarity, prose) is ignored.
    }
    // After the first hunk, lines that are not hunks or new sections are ignored.
    j++;
  }
  const oldPath = headerOld !== undefined ? headerOld : renameFrom !== undefined ? renameFrom : diffOld;
  const newPath = headerNew !== undefined ? headerNew : renameTo !== undefined ? renameTo : diffNew;
  return { section: { oldPath, newPath, newFileMode, deletedFileMode, hunks }, next: j };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const { section, next } = parseSection(lines, i + 1, m[1]!, m[2]!);
      edits.push(unifiedSectionEdit(section, strict));
      i = next;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const { section, next } = parseSection(lines, i, null, null);
      edits.push(unifiedSectionEdit(section, strict));
      i = next;
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return edits;
}

/** Apply one hunk to the file's lines; returns the new lines and final-break flag. */
function applyOneHunk(
  fileLines: string[],
  finalBreak: boolean,
  hunk: Hunk,
  strict: boolean,
  path: string,
  d: number,
): { lines: string[]; finalBreak: boolean } {
  if (hunk.O.length > 0) {
    const found = tierFind(
      hunk.O.map((o) => o.text),
      fileLines,
      strict,
      0,
    );
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.A - 1 + d;
    let pos = found.positions[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const newLines = applyReplace(fileLines, hunk.O, hunk.N, pos, found.tier);
    const touchesEnd = pos + hunk.O.length === fileLines.length;
    const newFinal = touchesEnd ? (hunk.hasCtxPlus ? !hunk.lastCtxPlusNoNL : newLines.length > 0) : finalBreak;
    return { lines: newLines, finalBreak: newFinal };
  }
  // Empty O: insert N after the first A + d lines (all of them when fewer).
  const at = Math.max(0, Math.min(hunk.A + d, fileLines.length));
  const newLines = [...fileLines.slice(0, at), ...hunk.N.map((n) => n.text), ...fileLines.slice(at)];
  const touchesEnd = at === fileLines.length;
  const newFinal = touchesEnd ? (hunk.hasCtxPlus ? !hunk.lastCtxPlusNoNL : newLines.length > 0) : finalBreak;
  return { lines: newLines, finalBreak: newFinal };
}

function applyUnifiedHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let model = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const r = applyOneHunk(model.lines, model.finalBreak, h, strict, path, d);
    model = { br: model.br, lines: r.lines, finalBreak: r.finalBreak };
    d += h.N.length - h.O.length;
  }
  return renderFile(model);
}

function unifiedSectionEdit(section: Section, strict: boolean): Edit {
  const isCreation = section.oldPath === null || section.newFileMode;
  const isDeletion = section.newPath === null || section.deletedFileMode;
  if (isDeletion && !isCreation) {
    const p = section.oldPath ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (isCreation) {
    const p = section.newPath ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlusNoNL = false;
      let hasPlus = false;
      for (const h of section.hunks) {
        for (const it of h.items) {
          if (it.kind === 'new') {
            plus.push(it.text);
            hasPlus = true;
            lastPlusNoNL = it.noNL;
          }
        }
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (hasPlus && lastPlusNoNL ? '' : '\n');
      tree.now.set(p, text);
    };
  }
  const oldP = section.oldPath ?? '';
  const newP = section.newPath ?? '';
  if (oldP !== newP) {
    // Move.
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyUnifiedHunks(text, section.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.recordMove(oldP, newP);
    };
  }
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const text = tree.get(oldP);
    if (text === null) throw new Fail('missing', oldP);
    const out = applyUnifiedHunks(text, section.hunks, strict, oldP);
    tree.now.set(oldP, out);
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const model = parseFile(text);
    const found = tierFind(oldLines, model.lines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const O = oldLines.map((t) => ({ text: t, ctx: false, oIdx: -1, noNL: false }) as LItem);
    const N = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1, noNL: false }) as LItem);
    const out = applyReplace(model.lines, O, N, pos, found.tier);
    tree.now.set(path, renderFile({ br: model.br, lines: out, finalBreak: model.finalBreak }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplace; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srBlockEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  O: LItem[];
  N: LItem[];
}

const V4A_ADD = '*** Add File:';
const V4A_DEL = '*** Delete File:';
const V4A_UPD = '*** Update File:';
const V4A_MOVE = '*** Move to:';

function isV4ASectionStart(l: string): boolean {
  return l.startsWith(V4A_ADD) || l.startsWith(V4A_DEL) || l.startsWith(V4A_UPD);
}

/** Collect a section's raw body lines (with their indexes) until the next section or End Patch; trailing blank lines are dropped. */
function collectV4ABody(lines: string[], start: number, end: number): { body: Array<[number, string]>; next: number } {
  const body: Array<[number, string]> = [];
  let i = start;
  while (i < end) {
    const l = lines[i]!;
    if (isV4ASectionStart(l)) break;
    body.push([i, l]);
    i++;
  }
  while (body.length > 0 && body[body.length - 1]![1].trim() === '') body.pop();
  return { body, next: i };
}

function parseUpdateBody(body: Array<[number, string]>, updateLine: number): { moveTo: string | null; chunks: V4AChunk[] } {
  let moveTo: string | null = null;
  const chunks: V4AChunk[] = [];
  let current: { anchor: string | null; eof: boolean; items: BodyItem[] } | null = null;
  const flush = (): void => {
    if (current === null) return;
    const O: LItem[] = [];
    const N: LItem[] = [];
    for (const it of current.items) {
      if (it.kind === 'ctx') {
        const oIdx = O.length;
        O.push({ text: it.text, ctx: true, oIdx, noNL: it.noNL });
        N.push({ text: it.text, ctx: true, oIdx, noNL: it.noNL });
      } else if (it.kind === 'old') {
        O.push({ text: it.text, ctx: false, oIdx: -1, noNL: it.noNL });
      } else {
        N.push({ text: it.text, ctx: false, oIdx: -1, noNL: it.noNL });
      }
    }
    chunks.push({ anchor: current.anchor, eof: current.eof, O, N });
    current = null;
  };
  for (let k = 0; k < body.length; k++) {
    const [idx, line] = body[k]!;
    if (line.startsWith(V4A_MOVE)) {
      if (k !== 0 || moveTo !== null || chunks.length > 0 || current !== null) throw new Exit2(`error: parse ${idx + 1}`);
      moveTo = line.slice(V4A_MOVE.length).trim();
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (current === null) {
        chunks.push({ anchor: null, eof: true, O: [], N: [] });
      } else {
        current.eof = true;
        flush();
      }
      continue;
    }
    if (line.startsWith('@@')) {
      flush();
      const anchor = line.slice(2).trim();
      current = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (current === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${idx + 1}`);
        current = { anchor: null, eof: false, items: [] };
      }
      if (line === '') current.items.push({ kind: 'ctx', text: '', noNL: false });
      else if (line[0] === ' ') current.items.push({ kind: 'ctx', text: line.slice(1), noNL: false });
      else if (line[0] === '-') current.items.push({ kind: 'old', text: line.slice(1), noNL: false });
      else current.items.push({ kind: 'new', text: line.slice(1), noNL: false });
      continue;
    }
    throw new Exit2(`error: parse ${idx + 1}`);
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
  return { moveTo, chunks };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(text);
    let lines = model.lines.slice();
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = tierFind([ch.anchor], lines, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.positions[0]! + 1;
      }
      if (ch.O.length > 0) {
        const oTexts = ch.O.map((o) => o.text);
        if (ch.eof) {
          let found: { tier: number; positions: number[] } | null = null;
          for (const t of strict ? [0] : [0, 1, 2]) {
            const pos = findOccurrences(oTexts, lines, t).filter((p) => p >= cursor && p + oTexts.length === lines.length);
            if (pos.length > 0) {
              found = { tier: t, positions: pos };
              break;
            }
          }
          if (found === null) throw new Fail('no-match', path);
          const pos = found.positions[0]!;
          lines = applyReplace(lines, ch.O, ch.N, pos, found.tier);
          cursor = pos + ch.N.length;
        } else {
          const found = tierFind(oTexts, lines, strict, cursor);
          if (found === null) throw new Fail('no-match', path);
          const pos = found.positions[0]!;
          lines = applyReplace(lines, ch.O, ch.N, pos, found.tier);
          cursor = pos + ch.N.length;
        }
      } else {
        const at = ch.eof ? lines.length : cursor;
        const mapped = ch.N.map((n) => n.text);
        lines = [...lines.slice(0, at), ...mapped, ...lines.slice(at)];
        cursor = at + mapped.length;
      }
    }
    const out = renderFile({ br: model.br, lines, finalBreak: model.finalBreak });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith(V4A_ADD)) {
      const path = l.slice(V4A_ADD.length).trim();
      const { body, next } = collectV4ABody(lines, i + 1, last);
      const fileLines: string[] = [];
      for (const [idx, bl] of body) {
        if (bl === '') fileLines.push('');
        else if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = next;
    } else if (l.startsWith(V4A_DEL)) {
      const path = l.slice(V4A_DEL.length).trim();
      const { body, next } = collectV4ABody(lines, i + 1, last);
      for (const [idx, bl] of body) {
        if (!blank(bl)) throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      i = next;
    } else if (l.startsWith(V4A_UPD)) {
      const path = l.slice(V4A_UPD.length).trim();
      const { body, next } = collectV4ABody(lines, i + 1, last);
      const upd = parseUpdateBody(body, i);
      edits.push(v4aUpdateEdit(path, upd.moveTo, upd.chunks, strict));
      i = next;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 1-2, 10: command line, output, exit codes, order and atomicity
// ---------------------------------------------------------------------------

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
  // Exit 0: one line per changed path, in byte order of the paths (UTF-8);
  // a successful move prints `R <old> -> <new>` (sorted by <new>) instead of
  // the pair's D and A lines.
  const rows: Array<{ key: string; line: string }> = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  const toWrite: Array<{ p: string; was: string | null; now: string | null }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    toWrite.push({ p, was, now });
    if (!suppressed.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const c of toWrite) {
      if (c.now === null) rmSync(c.p, { force: true });
      else {
        mkdirSync(dirname(c.p), { recursive: true });
        writeFileSync(c.p, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
