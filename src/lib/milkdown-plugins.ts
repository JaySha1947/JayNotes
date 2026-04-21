/**
 * milkdown-plugins.ts — Custom ProseMirror/Milkdown plugins for JayNotes
 */

import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';
import { wrapInList, liftListItem } from 'prosemirror-schema-list';

// ─── #tag decorator ───────────────────────────────────────────────────────────

const tagKey = new PluginKey('jn-tags');

export const tagDecoratorPlugin = $prose(() => new Plugin({
  key: tagKey,
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
}));

// ─── [[wikilink]] decorator + autocomplete ────────────────────────────────────

let _fileList: string[] = [];
export function setWikilinkFileList(files: string[]) { _fileList = files; }

export interface WikilinkSuggestion {
  active: boolean; query: string; from: number; to: number;
  suggestions: string[]; selectedIndex: number;
}
const EMPTY: WikilinkSuggestion = { active: false, query: '', from: 0, to: 0, suggestions: [], selectedIndex: 0 };
let _sug: WikilinkSuggestion = { ...EMPTY };
let _cb: ((s: WikilinkSuggestion) => void) | null = null;

export function subscribeToWikilinkSuggestions(cb: (s: WikilinkSuggestion) => void) { _cb = cb; }
export function unsubscribeWikilinkSuggestions() { _cb = null; }
function notifySug(s: WikilinkSuggestion) { _sug = s; _cb?.(s); }

const wikilinkKey = new PluginKey('jn-wikilinks');

export const wikilinkPlugin = $prose(() => new Plugin({
  key: wikilinkKey,
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
            notifySug({ active: suggestions.length > 0, query: partial, from: docFrom, to: from, suggestions, selectedIndex: Math.min(_sug.selectedIndex, Math.max(0, suggestions.length - 1)) });
            return;
          }
        }
        if (_sug.active) notifySug({ ..._sug, active: false });
      },
      destroy() { notifySug({ ...EMPTY }); },
    };
  },
}));

// ─── Task list NodeView — adds interactive checkboxes ─────────────────────────
// Renders li[data-item-type="task"] with a real <input type="checkbox">

const taskKey = new PluginKey('jn-task-nodeview');

export const taskListNodeViewPlugin = $prose(() => new Plugin({
  key: taskKey,
  props: {
    nodeViews: {
      list_item(node, view, getPos) {
        // Only intercept task items (checked !== null)
        if (node.attrs.checked === null || node.attrs.checked === undefined) {
          return false as any;  // fall through to default rendering
        }

        const li = document.createElement('li');
        li.setAttribute('data-item-type', 'task');
        li.style.cssText = 'list-style:none;display:flex;align-items:flex-start;gap:6px;margin:1px 0;padding:0';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = node.attrs.checked === true;
        cb.style.cssText = 'margin-top:3px;flex-shrink:0;cursor:pointer;accent-color:var(--interactive-accent)';
        cb.contentEditable = 'false';
        cb.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const pos = typeof getPos === 'function' ? getPos() : undefined;
          if (typeof pos !== 'number') return;
          view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
        });

        const span = document.createElement('span');
        span.style.cssText = 'flex:1;min-width:0';
        if (node.attrs.checked) {
          span.style.textDecoration = 'line-through';
          span.style.opacity = '0.55';
        }

        li.appendChild(cb);
        li.appendChild(span);

        return {
          dom: li,
          contentDOM: span,
          update(updated) {
            if (updated.type !== node.type) return false;
            if (updated.attrs.checked === null || updated.attrs.checked === undefined) return false;
            cb.checked = updated.attrs.checked === true;
            span.style.textDecoration = updated.attrs.checked ? 'line-through' : '';
            span.style.opacity = updated.attrs.checked ? '0.55' : '';
            return true;
          },
        };
      },
    },
  },
}));

// ─── Multi-line list wrapping ─────────────────────────────────────────────────

export function execWrapInList(view: any, listTypeName: 'bullet_list' | 'ordered_list'): boolean {
  const { state, dispatch } = view;
  const listType = state.schema.nodes[listTypeName];
  if (!listType) return false;
  // If already in this list type, lift out (toggle)
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
