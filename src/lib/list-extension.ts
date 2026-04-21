/**
 * list-extension.ts — comprehensive list behaviour for CodeMirror 6
 *
 * Handles: bullet (- * +), numbered (1.), alphabetic (a.), roman (i.),
 * checklist (- [ ] / - [x])
 *
 * Behaviours implemented:
 *   Enter  → continue list / exit on empty item
 *   Tab    → indent list line by 2 spaces (cursor stays after marker)
 *   Shift-Tab → outdent by 2 spaces
 */

import { keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';

// ─── Roman numeral helpers ────────────────────────────────────────────────────

const ROMAN_SET = new Set(['i','v','x','l','c','d','m']);

function isRomanStr(s: string): boolean {
  if (!s) return false;
  return s.toLowerCase().split('').every(c => ROMAN_SET.has(c));
}

function romanToInt(s: string): number {
  const map: Record<string, number> = { i:1, v:5, x:10, l:50, c:100, d:500, m:1000 };
  let n = 0, prev = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const val = map[s[i].toLowerCase()] ?? 0;
    n += val < prev ? -val : val;
    prev = val;
  }
  return n;
}

function intToRoman(n: number): string {
  const vals = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const syms = ['m','cm','d','cd','c','xc','l','xl','x','ix','v','iv','i'];
  let r = '';
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { r += syms[i]; n -= vals[i]; }
  }
  return r;
}

// ─── Alpha helpers ────────────────────────────────────────────────────────────

function nextAlphaMarker(marker: string): string {
  // marker is like "a." or "z." or "az."
  const letters = marker.slice(0, -1).toLowerCase();
  let carry = true;
  let result = '';
  for (let i = letters.length - 1; i >= 0; i--) {
    if (!carry) { result = letters[i] + result; continue; }
    const code = letters.charCodeAt(i) - 97;
    if (code === 25) { result = 'a' + result; }
    else { result = String.fromCharCode(code + 1 + 97) + result; carry = false; }
  }
  if (carry) result = 'a' + result;
  return result + '.';
}

// ─── Line parser ──────────────────────────────────────────────────────────────

type ListType = 'bullet' | 'numbered' | 'alpha' | 'roman' | 'checklist';

interface ParsedList {
  indent: string;
  marker: string;   // the full marker token, e.g. "a.", "iv.", "- [ ]", "-"
  text: string;     // content after marker + space
  type: ListType;
  markerLen: number; // length of indent + marker + space
}

/**
 * Parse a line into list components. Returns null if the line is not a list.
 * Priority: checklist > bullet > numbered > roman > alpha
 * (roman before alpha so "iv." isn't mistaken for alpha "iv.")
 */
function parseLine(raw: string): ParsedList | null {
  // Checklist: "  - [ ] text" or "  - [x] text"
  let m = raw.match(/^(\s*)(- \[[ xX]\])( )(.*)$/);
  if (m) return { indent: m[1], marker: m[2], text: m[4], type: 'checklist', markerLen: m[1].length + m[2].length + 1 };

  // Bullet: "  - text" or "  * text" or "  + text"
  m = raw.match(/^(\s*)([-*+])( )(.*)$/);
  if (m) return { indent: m[1], marker: m[2], text: m[4], type: 'bullet', markerLen: m[1].length + m[2].length + 1 };

  // Numbered: "  1. text"
  m = raw.match(/^(\s*)(\d+\.)( )(.*)$/);
  if (m) return { indent: m[1], marker: m[2], text: m[4], type: 'numbered', markerLen: m[1].length + m[2].length + 1 };

  // Roman or Alpha — distinguish by checking if all letters are roman digits
  // Pattern: "  iv. text" or "  b. text"
  m = raw.match(/^(\s*)([a-z]{1,6}\.)( )(.*)$/i);
  if (m) {
    const letters = m[2].slice(0, -1);
    const type: ListType = isRomanStr(letters) ? 'roman' : 'alpha';
    return { indent: m[1], marker: m[2], text: m[4], type, markerLen: m[1].length + m[2].length + 1 };
  }

  return null;
}

/** Compute the next marker in sequence for a given parsed list line */
function nextMarker(p: ParsedList): string {
  switch (p.type) {
    case 'checklist': return '- [ ]';
    case 'bullet':    return p.marker;
    case 'numbered': {
      const n = parseInt(p.marker, 10);
      return `${n + 1}.`;
    }
    case 'alpha': return nextAlphaMarker(p.marker);
    case 'roman': {
      const n = romanToInt(p.marker.slice(0, -1));
      return intToRoman(n + 1) + '.';
    }
  }
}

// ─── Keymap ───────────────────────────────────────────────────────────────────

export const listKeymap = keymap.of([
  {
    key: 'Enter',
    run(view) {
      const state = view.state;
      const sel = state.selection.main;
      // Only handle cursor (no selection)
      if (sel.from !== sel.to) return false;

      const line = state.doc.lineAt(sel.from);
      const parsed = parseLine(line.text);
      if (!parsed) return false;

      // Cursor must be at or after the end of the marker
      const markerEnd = line.from + parsed.markerLen;
      if (sel.from < markerEnd) return false;

      // Empty item → exit list (replace line with blank line)
      if (parsed.text.trim() === '' && sel.from >= markerEnd) {
        view.dispatch(state.update({
          changes: { from: line.from, to: line.to, insert: '' },
          selection: { anchor: line.from },
        }));
        return true;
      }

      // Continue list: insert newline + indent + nextMarker + space
      const next = nextMarker(parsed);
      const insert = '\n' + parsed.indent + next + ' ';
      view.dispatch(state.update({
        changes: { from: sel.from, to: sel.to, insert },
        selection: { anchor: sel.from + insert.length },
      }));
      return true;
    },
  },

  {
    key: 'Tab',
    run(view) {
      const state = view.state;
      const line = state.doc.lineAt(state.selection.main.from);
      if (!parseLine(line.text)) return false;
      // Prepend 2 spaces to the line; keep cursor relative position
      const cur = state.selection.main.from;
      view.dispatch(state.update({
        changes: { from: line.from, to: line.from, insert: '  ' },
        selection: { anchor: cur + 2 },
      }));
      return true;
    },
  },

  {
    key: 'Shift-Tab',
    run(view) {
      const state = view.state;
      const line = state.doc.lineAt(state.selection.main.from);
      const parsed = parseLine(line.text);
      if (!parsed) return false;
      if (parsed.indent.length === 0) return false;
      const remove = Math.min(2, parsed.indent.length);
      const cur = state.selection.main.from;
      view.dispatch(state.update({
        changes: { from: line.from, to: line.from + remove, insert: '' },
        selection: { anchor: Math.max(line.from, cur - remove) },
      }));
      return true;
    },
  },
]);
