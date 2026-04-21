/**
 * milkdown-plugins.ts — Custom Milkdown plugins for JayNotes
 *
 * IMPORTANT: PluginKey instances must NOT be created at module scope —
 * they must be created lazily inside the plugin factory functions to avoid
 * crashing during module initialization before ProseMirror is ready.
 */

import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';
import { wrapInList, liftListItem } from 'prosemirror-schema-list';

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

// ─── [[wikilink]] decorator + autocomplete ────────────────────────────────────

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
  return new Plugin({
    key,
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        const LINK_RE = /\[\[([^\]]*)\]\]/g;
        state.doc.descendants((node, pos) => {
          if (!node.isText) return;
          const text = node.text ?? '';
          let m;
          LINK_RE.lastIndex = 0;
          while ((m = LINK_RE.exec(text)) !== null) {
            decos.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, {
              class: 'jn-wikilink',
              'data-target': m[1].split('|')[0],
            }));
          }
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
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
