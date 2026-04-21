/**
 * list-extension.ts
 *
 * CodeMirror 6 extension that adds proper Enter / Tab / Shift+Tab behaviour
 * for ALL list types: bullets (- / * / +), numbered (1.), alphabetic (a.),
 * Roman numeral (i.), and checklists (- [ ] / - [x] ).
 *
 * Also exports a syntax-highlighting decorator so alpha/roman markers are
 * coloured the same way as bullet and numbered list markers.
 */

import { keymap } from '@codemirror/view';
import { EditorState, Transaction } from '@codemirror/state';
import { indentMore, indentLess } from '@codemirror/commands';
import {
  Decoration,
  DecorationSet,
  MatchDecorator,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Parse a list line, returning the indent, marker, and trailing text. */
interface ListLine {
  indent: string;
  marker: string;   // e.g. "-", "1.", "a.", "iv.", "- [ ]", "- [x]"
  space: string;    // the space after the marker
  text: string;     // rest of the content
  type: 'bullet' | 'numbered' | 'alpha' | 'roman' | 'checklist' | null;
}

// Patterns – order matters (checklist before bullet)
const LIST_RE =
  /^(\s*)(- \[[ x]\]|[-*+]|\d+\.|[a-z]{1,3}\.|[ivxlcdm]{1,6}\.)( )(.*)/i;

function parseLine(text: string): ListLine | null {
  const m = text.match(LIST_RE);
  if (!m) return null;
  const marker = m[2];
  let type: ListLine['type'] = null;
  if (/^- \[[ x]\]$/.test(marker))          type = 'checklist';
  else if (/^[-*+]$/.test(marker))            type = 'bullet';
  else if (/^\d+\.$/.test(marker))            type = 'numbered';
  else if (/^[a-z]{1,3}\.$/i.test(marker) && !isRoman(marker.slice(0,-1))) type = 'alpha';
  else if (isRoman(marker.slice(0,-1)))        type = 'roman';
  else return null;
  return { indent: m[1], marker, space: m[3], text: m[4], type };
}

const ROMAN_DIGITS = new Set(['i','v','x','l','c','d','m']);
function isRoman(s: string): boolean {
  if (!s) return false;
  const lower = s.toLowerCase();
  return lower.split('').every(c => ROMAN_DIGITS.has(c));
}

function nextAlpha(marker: string): string {
  // marker = "a." → "b.", "z." → "aa."
  const letters = marker.slice(0, -1);
  let carry = true;
  let result = '';
  for (let i = letters.length - 1; i >= 0; i--) {
    if (carry) {
      const code = letters.charCodeAt(i) - 97; // 0-25
      if (code === 25) { result = 'a' + result; }
      else { result = String.fromCharCode(code + 1 + 97) + result; carry = false; }
    } else {
      result = letters[i] + result;
    }
  }
  if (carry) result = 'a' + result;
  return result + '.';
}

function romanToInt(s: string): number {
  const map: Record<string,number> = {i:1,v:5,x:10,l:50,c:100,d:500,m:1000};
  let n = 0, prev = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const val = map[s[i]] ?? 0;
    n += val < prev ? -val : val;
    prev = val;
  }
  return n;
}

function intToRoman(n: number): string {
  const vals = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const syms = ['m','cm','d','cd','c','xc','l','xl','x','ix','v','iv','i'];
  let result = '';
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { result += syms[i]; n -= vals[i]; }
  }
  return result;
}

function nextRoman(marker: string): string {
  const letters = marker.slice(0, -1).toLowerCase();
  return intToRoman(romanToInt(letters) + 1) + '.';
}

function nextMarker(parsed: ListLine): string {
  switch (parsed.type) {
    case 'numbered': {
      const n = parseInt(parsed.marker, 10);
      return `${n + 1}.`;
    }
    case 'alpha':    return nextAlpha(parsed.marker);
    case 'roman':    return nextRoman(parsed.marker);
    case 'checklist': return '- [ ]';
    default:         return parsed.marker; // bullet stays the same
  }
}

// ─── Enter handler ─────────────────────────────────────────────────────────────

function handleEnter(state: EditorState): Transaction | null {
  const range = state.selection.main;
  if (range.from !== range.to) return null; // has selection – don't intercept

  const line = state.doc.lineAt(range.from);
  const parsed = parseLine(line.text);
  if (!parsed) return null;

  // Cursor must be after the marker+space
  const markerEnd = line.from + parsed.indent.length + parsed.marker.length + 1;
  if (range.from < markerEnd) return null;

  // Empty list item (only marker, no text) → exit list
  if (parsed.text.trim() === '') {
    return state.update({
      changes: { from: line.from, to: line.to, insert: '' },
      selection: { anchor: line.from },
    });
  }

  // Continue list with next marker
  const next = nextMarker(parsed);
  const insert = '\n' + parsed.indent + next + ' ';
  return state.update({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length },
  });
}

// ─── Tab / Shift+Tab handlers ──────────────────────────────────────────────────

function handleTab(state: EditorState): Transaction | null {
  const line = state.doc.lineAt(state.selection.main.from);
  if (!parseLine(line.text)) return null; // not a list line
  return indentMore({ state, dispatch: () => {} }) as any ?? null;
}

function handleShiftTab(state: EditorState): Transaction | null {
  const line = state.doc.lineAt(state.selection.main.from);
  if (!parseLine(line.text)) return null;
  return indentLess({ state, dispatch: () => {} }) as any ?? null;
}

// ─── Export: keymap extension ──────────────────────────────────────────────────

export const listKeymap = keymap.of([
  {
    key: 'Enter',
    run(view) {
      const tr = handleEnter(view.state);
      if (!tr) return false;
      view.dispatch(tr);
      return true;
    },
  },
  {
    key: 'Tab',
    run(view) {
      const line = view.state.doc.lineAt(view.state.selection.main.from);
      if (!parseLine(line.text)) return false;
      // Indent by 2 spaces
      const { from } = view.state.selection.main;
      const lineStart = view.state.doc.lineAt(from).from;
      view.dispatch(view.state.update({
        changes: { from: lineStart, insert: '  ' },
        selection: { anchor: from + 2 },
      }));
      return true;
    },
  },
  {
    key: 'Shift-Tab',
    run(view) {
      const line = view.state.doc.lineAt(view.state.selection.main.from);
      const parsed = parseLine(line.text);
      if (!parsed) return false;
      if (parsed.indent.length === 0) return false;
      // Remove up to 2 spaces of indent
      const remove = Math.min(2, parsed.indent.length);
      view.dispatch(view.state.update({
        changes: { from: line.from, to: line.from + remove, insert: '' },
        selection: { anchor: Math.max(line.from, view.state.selection.main.from - remove) },
      }));
      return true;
    },
  },
]);

// ─── Export: marker syntax highlighter ────────────────────────────────────────

// Matches alpha/roman list markers at line start so they get the same colour
// treatment as bullet/numbered markers (which CodeMirror's markdown extension
// already handles). We only match markers that are NOT already markdown tokens.
const alphaRomanDecorator = new MatchDecorator({
  // matches lines starting with optional indent then alpha or roman marker
  regexp: /^(?:[ \t]*)([a-z]{1,3}\.|[ivxlcdm]{1,6}\.) /gim,
  decoration: () => Decoration.mark({ class: 'cm-list-marker-custom' }),
});

export const alphaRomanMarkerPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: any) {
      this.decorations = alphaRomanDecorator.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = alphaRomanDecorator.updateDeco(update, this.decorations);
    }
  },
  { decorations: v => v.decorations }
);
