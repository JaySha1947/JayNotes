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
        const TAG_RE = /(^|\s)(#[a-zA-Z][a-zA-Z0-9_-]*)/g;
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
  active: boolean; query: string; from: number; to: number;
  suggestions: string[]; selectedIndex: number;
}
const EMPTY_SUG: WikilinkSuggestion = {
  active: false, query: '', from: 0, to: 0, suggestions: [], selectedIndex: 0,
};
let _sug: WikilinkSuggestion = { ...EMPTY_SUG };
let _cb: ((s: WikilinkSuggestion) => void) | null = null;

export function subscribeToWikilinkSuggestions(cb: (s: WikilinkSuggestion) => void) { _cb = cb; }
export function unsubscribeWikilinkSuggestions() { _cb = null; }
function notifySug(s: WikilinkSuggestion) { _sug = s; _cb?.(s); }

export const wikilinkPlugin = $prose(() => {
  const key = new PluginKey('jn-wikilinks');

  // Regex to find [[target]] in a text node
  const LINK_RE = /\[\[([^\]]*)\]\]/g;

  // Given a ProseMirror position, find the wikilink target under the cursor
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

  return new Plugin({
    key,
    props: {
      // Decorate [[wikilinks]] inline
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

      // Intercept dblclick inside ProseMirror to navigate wikilinks
      handleDOMEvents: {
        dblclick(view, event) {
          const coords = { left: (event as MouseEvent).clientX, top: (event as MouseEvent).clientY };
          const pos = view.posAtCoords(coords);
          if (!pos) return false;
          const target = getWikilinkAtPos(view.state, pos.pos);
          if (target && _onOpenFile) {
            _onOpenFile(target.endsWith('.md') ? target : `${target}.md`);
            return true; // handled
          }
          return false;
        },
      },
    },

    // Track cursor position to show/hide autocomplete dropdown
    view() {
      return {
        update(view) {
          const { from } = view.state.selection;
          const $pos = view.state.doc.resolve(from);
          const textBefore = $pos.parent.textContent.slice(0, $pos.parentOffset);
          const idx = textBefore.lastIndexOf('[[');
          if (idx !== -1) {
            const partial = textBefore.slice(idx + 2);
            if (!partial.includes(']]') && !partial.includes('\n')) {
              const docFrom = from - partial.length - 2;
              const q = partial.toLowerCase();
              const suggestions = _fileList.filter(f => f.toLowerCase().includes(q)).slice(0, 10);
              const selectedIndex = Math.min(_sug.selectedIndex, Math.max(0, suggestions.length - 1));
              notifySug({ active: suggestions.length > 0, query: partial, from: docFrom, to: from, suggestions, selectedIndex });
              return;
            }
          }
          if (_sug.active) notifySug({ ..._sug, active: false });
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
// GFM task items are: bullet_list > list_item[checked=false/true] > paragraph
// We create the node structure directly instead of relying on text input rules.

export function execInsertChecklist(view: any): boolean {
  const { state, dispatch } = view;
  const { from, to } = state.selection;
  const schema = state.schema;

  const bulletListType = schema.nodes.bullet_list;
  const listItemType = schema.nodes.list_item;
  const paragraphType = schema.nodes.paragraph;

  if (!bulletListType || !listItemType || !paragraphType) return false;

  // Collect all top-level text blocks in the selection
  const blocks: { from: number; to: number; text: string }[] = [];
  state.doc.nodesBetween(from, to, (node: any, pos: number) => {
    if (node.isTextblock) {
      blocks.push({ from: pos, to: pos + node.nodeSize, text: node.textContent });
      return false;
    }
    return true;
  });

  if (blocks.length === 0) {
    // Nothing selected — insert a fresh task item at cursor
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

  // Multiple blocks: replace each with a task list item, combine into one list
  let tr = state.tr;
  // Work backwards so positions don't shift
  const reversed = [...blocks].reverse();
  let firstListStart = -1;
  let firstListEnd = -1;

  for (const block of reversed) {
    const para = paragraphType.createChecked(null, schema.text(block.text) as any);
    const item = listItemType.create({ checked: false }, para);
    const list = bulletListType.create(null, item);
    tr = tr.replaceWith(block.from, block.to, list);
  }

  // After insertion, try to join adjacent list nodes
  dispatch(tr.scrollIntoView());

  // Join adjacent bullet lists in a follow-up dispatch
  requestAnimationFrame(() => {
    try {
      const { state: newState, dispatch: newDispatch } = view;
      const { joinBackward } = require('prosemirror-commands');
      // Use transform to merge adjacent lists
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
