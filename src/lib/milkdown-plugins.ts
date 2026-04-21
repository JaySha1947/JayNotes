/**
 * milkdown-plugins.ts — Custom Milkdown plugins for JayNotes
 */

import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';
import { wrapInList, liftListItem } from 'prosemirror-schema-list';

// ─── Callback for opening a file (set by the React component) ────────────────
let _onOpenFile: ((path: string) => void) | null = null;
export function setOpenFileCallback(cb: (path: string) => void) { _onOpenFile = cb; }

// ─── #tag decorator ───────────────────────────────────────────────────────────

export const tagDecoratorPlugin = $prose(() => {
  const key = new PluginKey('jn-tags');
  return new Plugin({
    key,
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        // Match tags after start-of-string, whitespace, or any non-word/non-# punctuation
        const TAG_RE = /(^|[^\w#])(#[a-zA-Z][a-zA-Z0-9_-]*)/g;
        state.doc.descendants((node, pos) => {
          if (!node.isText) return;
          const text = node.text ?? '';
          let m;
          TAG_RE.lastIndex = 0;
          while ((m = TAG_RE.exec(text)) !== null) {
            const start = pos + m.index + m[1].length;
            decos.push(Decoration.inline(start, start + m[2].length, { class: 'jn-tag' }));
          }
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
});

// ─── [[wikilink]] decorator + autocomplete + double-click nav ─────────────────

let _fileList: string[] = [];
export function setWikilinkFileList(files: string[]) { _fileList = files; }

export interface WikilinkSuggestion {
  active: boolean;
  query: string;
  from: number;
  to: number;
  suggestions: string[];
  selectedIndex: number;
  coords: { left: number; bottom: number; top: number } | null;
}
const EMPTY_SUG: WikilinkSuggestion = {
  active: false, query: '', from: 0, to: 0, suggestions: [], selectedIndex: 0, coords: null,
};
let _sug: WikilinkSuggestion = { ...EMPTY_SUG };
let _cb: ((s: WikilinkSuggestion) => void) | null = null;

export function subscribeToWikilinkSuggestions(cb: (s: WikilinkSuggestion) => void) { _cb = cb; }
export function unsubscribeWikilinkSuggestions() { _cb = null; }
function notifySug(s: WikilinkSuggestion) { _sug = s; _cb?.(s); }

// Minimum characters typed after `[[` before the dropdown appears
const MIN_AUTOCOMPLETE_CHARS = 2;

export const wikilinkPlugin = $prose(() => {
  const key = new PluginKey('jn-wikilinks');

  const LINK_RE = /\[\[([^\]\n]*)\]\]/g;

  function getWikilinkAtPos(state: any, pos: number): string | null {
    const $pos = state.doc.resolve(pos);
    const node = $pos.parent;
    const offset = $pos.parentOffset;
    const text = node.textContent;
    let match;
    LINK_RE.lastIndex = 0;
    while ((match = LINK_RE.exec(text)) !== null) {
      if (match.index <= offset && offset <= match.index + match[0].length) {
        return match[1].split('|')[0].split('#')[0].trim();
      }
    }
    return null;
  }

  function isCursorInsideCompletedLink(state: any, pos: number): boolean {
    const $pos = state.doc.resolve(pos);
    const text = $pos.parent.textContent;
    const offset = $pos.parentOffset;
    let match;
    LINK_RE.lastIndex = 0;
    while ((match = LINK_RE.exec(text)) !== null) {
      if (match.index <= offset && offset <= match.index + match[0].length) {
        return true;
      }
    }
    return false;
  }

  return new Plugin({
    key,
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (!node.isText) return;
          const text = node.text ?? '';
          let m;
          LINK_RE.lastIndex = 0;
          while ((m = LINK_RE.exec(text)) !== null) {
            decos.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, {
              class: 'jn-wikilink',
              'data-target': m[1].split('|')[0].split('#')[0].trim(),
            }));
          }
        });
        return DecorationSet.create(state.doc, decos);
      },

      // Double-click opens the file; single click is untouched (just moves cursor).
      handleDOMEvents: {
        dblclick(view, event) {
          const coords = { left: (event as MouseEvent).clientX, top: (event as MouseEvent).clientY };
          const pos = view.posAtCoords(coords);
          if (!pos) return false;
          const target = getWikilinkAtPos(view.state, pos.pos);
          if (target && _onOpenFile) {
            event.preventDefault();
            _onOpenFile(target.endsWith('.md') ? target : `${target}.md`);
            return true;
          }
          return false;
        },
      },
    },

    view() {
      return {
        update(view) {
          const { from, to } = view.state.selection;

          if (from !== to) {
            if (_sug.active) notifySug({ ...EMPTY_SUG });
            return;
          }

          // Suppress autocomplete when cursor is inside a completed [[...]] link
          if (isCursorInsideCompletedLink(view.state, from)) {
            if (_sug.active) notifySug({ ...EMPTY_SUG });
            return;
          }

          const $pos = view.state.doc.resolve(from);
          const textBefore = $pos.parent.textContent.slice(0, $pos.parentOffset);
          const idx = textBefore.lastIndexOf('[[');

          if (idx === -1) {
            if (_sug.active) notifySug({ ...EMPTY_SUG });
            return;
          }

          const partial = textBefore.slice(idx + 2);

          if (partial.includes(']]') || partial.includes('\n')) {
            if (_sug.active) notifySug({ ...EMPTY_SUG });
            return;
          }

          // Require at least MIN_AUTOCOMPLETE_CHARS typed after `[[`
          if (partial.length < MIN_AUTOCOMPLETE_CHARS) {
            if (_sug.active) notifySug({ ...EMPTY_SUG });
            return;
          }

          const docFrom = from - partial.length - 2;
          const q = partial.toLowerCase();
          const suggestions = _fileList
            .filter(f => f.toLowerCase().includes(q))
            .slice(0, 10);

          if (suggestions.length === 0) {
            if (_sug.active) notifySug({ ...EMPTY_SUG });
            return;
          }

          let coords: { left: number; bottom: number; top: number } | null = null;
          try {
            const c = view.coordsAtPos(from);
            coords = { left: c.left, bottom: c.bottom, top: c.top };
          } catch (_) {
            coords = null;
          }

          const selectedIndex = Math.min(
            _sug.selectedIndex,
            Math.max(0, suggestions.length - 1),
          );

          notifySug({
            active: true,
            query: partial,
            from: docFrom,
            to: from,
            suggestions,
            selectedIndex,
            coords,
          });
        },
        destroy() { notifySug({ ...EMPTY_SUG }); },
      };
    },
  });
});

// ─── Multi-line list wrapping via prosemirror-schema-list ─────────────────────

export function execWrapInList(view: any, listTypeName: 'bullet_list' | 'ordered_list'): boolean {
  const { state, dispatch } = view;
  const listType = state.schema.nodes[listTypeName];
  if (!listType) return false;
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === listType) {
      const listItemType = state.schema.nodes.list_item;
      if (listItemType) return liftListItem(listItemType)(state, dispatch) ?? false;
    }
  }
  return wrapInList(listType)(state, dispatch) ?? false;
}

// ─── Blockquote toggle ────────────────────────────────────────────────────────

export function execLiftBlockquote(view: any): boolean {
  const { state, dispatch } = view;
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'blockquote') {
      const start = $from.before(d);
      const end = $from.after(d);
      const node = $from.node(d);
      const tr = state.tr.replaceWith(start, end, node.content);
      if (dispatch) dispatch(tr.scrollIntoView());
      return true;
    }
  }
  return false;
}

// ─── Checklist: convert current/selected lines to GFM task list items ─────────

export function execInsertChecklist(view: any): boolean {
  const { state, dispatch } = view;
  const { from, to } = state.selection;
  const schema = state.schema;

  const bulletListType = schema.nodes.bullet_list;
  const listItemType = schema.nodes.list_item;
  const paragraphType = schema.nodes.paragraph;

  if (!bulletListType || !listItemType || !paragraphType) return false;

  const blocks: { from: number; to: number; text: string }[] = [];
  state.doc.nodesBetween(from, to, (node: any, pos: number) => {
    if (node.isTextblock) {
      blocks.push({ from: pos, to: pos + node.nodeSize, text: node.textContent });
      return false;
    }
    return true;
  });

  if (blocks.length === 0) {
    const $from = state.doc.resolve(from);
    const blockStart = $from.start($from.depth);
    const blockEnd = $from.end($from.depth);
    const blockNode = $from.parent;
    const para = paragraphType.create(null, blockNode.content);
    const item = listItemType.create({ checked: false }, para);
    const list = bulletListType.create(null, item);
    const tr = state.tr.replaceWith(blockStart - 1, blockEnd + 1, list);
    dispatch(tr.scrollIntoView());
    return true;
  }

  let tr = state.tr;
  const reversed = [...blocks].reverse();

  for (const block of reversed) {
    const para = paragraphType.createChecked(null, schema.text(block.text) as any);
    const item = listItemType.create({ checked: false }, para);
    const list = bulletListType.create(null, item);
    tr = tr.replaceWith(block.from, block.to, list);
  }

  dispatch(tr.scrollIntoView());

  requestAnimationFrame(() => {
    try {
      const { state: newState, dispatch: newDispatch } = view;
      let mergedTr = newState.tr;
      let changed = false;
      newState.doc.nodesBetween(from, Math.min(newState.doc.content.size, to + 100), (node: any, pos: number) => {
        if (node.type === bulletListType) {
          const $pos = newState.doc.resolve(pos + node.nodeSize);
          const nextNode = $pos.nodeAfter;
          if (nextNode && nextNode.type === bulletListType) {
            mergedTr = mergedTr.join(pos + node.nodeSize);
            changed = true;
          }
        }
        return true;
      });
      if (changed) newDispatch(mergedTr);
    } catch (_) {}
  });

  return true;
}
