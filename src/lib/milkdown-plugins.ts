/**
 * milkdown-plugins.ts — Custom Milkdown plugins for JayNotes
 */

import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';
import { wrapInList, liftListItem, sinkListItem } from 'prosemirror-schema-list';

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
        // Match tags after start-of-string, whitespace, or any non-word/non-# punctuation.
        // Exclude HTML/XML hex entity suffixes like #x20, #x72 (from &#x20; &#x72;).
        const TAG_RE = /(^|[^\w&#])(#[a-zA-Z][a-zA-Z0-9_-]*)/g;
        const isEntitySuffix = (tag: string) => /^#x[0-9a-fA-F]+$/i.test(tag);
        state.doc.descendants((node, pos) => {
          if (!node.isText) return;
          const text = node.text ?? '';
          let m;
          TAG_RE.lastIndex = 0;
          while ((m = TAG_RE.exec(text)) !== null) {
            if (isEntitySuffix(m[2])) continue;
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
const MIN_AUTOCOMPLETE_CHARS = 0;

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

// ─── Task-list helpers ────────────────────────────────────────────────────────

/** Return the list_item ancestor of `pos` if it is a GFM task item (checked != null). */
function getTaskItemAt(state: any, pos: number): { node: any; nodePos: number } | null {
  const $pos = state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === 'list_item' && node.attrs.checked != null) {
      return { node, nodePos: $pos.before(d) };
    }
  }
  return null;
}

/** Toggle a task-item's checked attribute via a ProseMirror transaction. */
export function toggleTaskItemChecked(view: any, itemPos: number): boolean {
  const { state, dispatch } = view;
  const node = state.doc.nodeAt(itemPos);
  if (!node || node.type.name !== 'list_item' || node.attrs.checked == null) return false;
  const tr = state.tr.setNodeMarkup(itemPos, undefined, {
    ...node.attrs,
    checked: !node.attrs.checked,
  });
  dispatch(tr);
  return true;
}

/**
 * Insert GFM task-list items for the current selection.
 * If the cursor is already inside a task-list item, convert it back to a
 * plain paragraph inside a regular bullet list (toggle-off behaviour).
 */
export function execInsertChecklist(view: any): boolean {
  const { state, dispatch } = view;
  const { from, to } = state.selection;
  const schema = state.schema;

  const bulletListType = schema.nodes.bullet_list;
  const listItemType   = schema.nodes.list_item;
  const paragraphType  = schema.nodes.paragraph;
  if (!bulletListType || !listItemType || !paragraphType) return false;

  // ── Toggle-off: if cursor is already in a task item, un-task it ──────────
  const taskItem = getTaskItemAt(state, from);
  if (taskItem) {
    let tr = state.tr;
    let changed = false;
    state.doc.nodesBetween(from, to, (node: any, pos: number) => {
      if (node.type === listItemType && node.attrs.checked != null) {
        tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: null });
        changed = true;
      }
    });
    if (changed) { dispatch(tr.scrollIntoView()); return true; }
  }

  // ── Insert: collect text blocks in the selection ─────────────────────────
  const blocks: { from: number; to: number; content: any }[] = [];
  state.doc.nodesBetween(from, to, (node: any, pos: number) => {
    if (node.isTextblock) {
      blocks.push({ from: pos, to: pos + node.nodeSize, content: node.content });
      return false;
    }
    return true;
  });

  // Single-block / no-selection fallback
  if (blocks.length === 0) {
    const $from = state.doc.resolve(from);
    const blockNode = $from.parent;
    const blockStart = $from.start($from.depth);
    const blockEnd   = $from.end($from.depth);
    const para = paragraphType.create(null, blockNode.content);
    const item = listItemType.create({ checked: false }, para);
    const list = bulletListType.create(null, item);
    const tr = state.tr.replaceWith(blockStart - 1, blockEnd + 1, list);
    dispatch(tr.scrollIntoView());
    return true;
  }

  // Multi-block: replace each block in reverse so positions stay valid
  let tr = state.tr;
  for (const block of [...blocks].reverse()) {
    const para = paragraphType.create(null, block.content);
    const item = listItemType.create({ checked: false }, para);
    const list = bulletListType.create(null, item);
    tr = tr.replaceWith(block.from, block.to, list);
  }
  dispatch(tr.scrollIntoView());
  return true;
}

// ─── Checkbox click plugin ────────────────────────────────────────────────────
// Intercepts mousedown on task-list <li> elements and toggles the checked attr.
// We use mousedown (not click) so we can preventDefault before ProseMirror
// moves the cursor, keeping the current cursor position intact.

export const checkboxClickPlugin = $prose(() => {
  const key = new PluginKey('jn-checkbox-click');
  return new Plugin({
    key,
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          const target = event.target as HTMLElement;
          // Only act when the user clicks directly on the <li> or its ::before
          // pseudo-element (which occupies the left ~20px of the item).
          const li = target.closest('li[data-item-type="task"]') as HTMLElement | null;
          if (!li) return false;

          // The ::before pseudo-element is the visual checkbox. It occupies
          // roughly the first 22px from the left edge of the <li>.
          const liRect = li.getBoundingClientRect();
          const clickX = (event as MouseEvent).clientX - liRect.left;
          if (clickX > 28) return false; // click was in the text area — don't intercept

          event.preventDefault();

          // Find the ProseMirror position of this <li> node
          const posData = view.posAtDOM(li, 0);
          const $pos = view.state.doc.resolve(posData);
          // Walk up to find the list_item node
          for (let d = $pos.depth; d >= 0; d--) {
            const node = $pos.node(d);
            if (node.type.name === 'list_item' && node.attrs.checked != null) {
              const nodePos = $pos.before(d);
              const tr = view.state.tr.setNodeMarkup(nodePos, undefined, {
                ...node.attrs,
                checked: !node.attrs.checked,
              });
              view.dispatch(tr);
              return true;
            }
          }
          return false;
        },
      },
    },
  });
});

// ─── Multi-item list indentation (Tab / Shift+Tab) ───────────────────────────
//
// Milkdown's built-in listItemKeymap binds Tab→sinkListItemCommand and
// Shift-Tab→liftListItemCommand, but prosemirror-schema-list's sinkListItem /
// liftListItem only operate on the single item containing $from. This plugin
// intercepts Tab/Shift+Tab BEFORE the built-in handler and processes every
// list_item node that overlaps the selection, enabling true multi-item indent.
//
// It runs as a ProseMirror plugin with a key handler that returns `true`
// (consumed) when it acts, so the default handler never fires.

export const listTabPlugin = $prose(() => {
  const key = new PluginKey('jn-list-tab');

  return new Plugin({
    key,
    props: {
      handleKeyDown(view, event) {
        // Only intercept Tab and Shift+Tab
        if (event.key !== 'Tab') return false;
        // Don't steal Tab from the wikilink autocomplete dropdown
        // (that handler is registered with `capture:true` and runs first —
        // if it consumed the event it wouldn't reach here, but guard anyway)

        const { state, dispatch } = view;
        const { $from, $to } = state.selection;
        const listItemType = state.schema.nodes.list_item;
        if (!listItemType) return false;

        // Check whether selection touches any list item
        let inList = false;
        state.doc.nodesBetween($from.pos, $to.pos, (node) => {
          if (node.type === listItemType) { inList = true; return false; }
          return true;
        });
        if (!inList) return false;

        event.preventDefault();

        if (event.shiftKey) {
          return liftMultipleListItems(state, dispatch, listItemType);
        } else {
          return sinkMultipleListItems(state, dispatch, listItemType);
        }
      },
    },
  });
});

/**
 * Robust multi-item sink/lift.
 *
 * Strategy: rather than trying to map steps across accumulating transactions
 * (which breaks for ReplaceAroundStep whose mapped positions may become
 * invalid), we apply each individual sink/lift to a FRESH state derived from
 * the accumulated transaction, collect the steps it produced, append those
 * steps to our main tr, then derive the next state from that.
 *
 * Items are processed bottom-up for sink (so earlier positions stay valid
 * after the deeper items are wrapped) and top-down for lift.
 */

function applyToEachItem(
  state: any,
  dispatch: any,
  listItemType: any,
  ascending: boolean,
  operation: (itemState: any, itemDispatch: any) => boolean,
): boolean {
  const { $from, $to } = state.selection;

  // Collect positions of all list_item nodes overlapping the selection
  const positions: number[] = [];
  state.doc.nodesBetween($from.pos, $to.pos, (node: any, pos: number) => {
    if (node.type === listItemType) {
      positions.push(pos);
      return false; // don't descend further
    }
    return true;
  });

  if (positions.length === 0) return false;
  // Single item — use the operation directly so built-in edge-case handling works
  if (positions.length === 1) {
    const selNear = state.selection.constructor.near(state.doc.resolve(positions[0] + 1));
    const singleState = state.apply(state.tr.setSelection(selNear));
    return operation(singleState, dispatch);
  }

  const ordered = ascending ? [...positions].sort((a, b) => a - b) : [...positions].sort((a, b) => b - a);

  // We'll build a single transaction by applying state changes cumulatively
  // using state.apply(tr) after each item.
  let currentState = state;
  let finalTr = state.tr; // accumulates mapping only (we append real steps below)
  let anyWorked = false;

  // We need to track the *latest* applied transaction to pass to dispatch
  let latestAppliedState = state;

  for (const origPos of ordered) {
    // Map the original position through all changes so far
    const mappedPos = finalTr.mapping.map(origPos);

    // Find the list_item at mappedPos in currentState.doc
    let itemPos: number | null = null;
    currentState.doc.nodesBetween(mappedPos, mappedPos + 2, (node: any, pos: number) => {
      if (node.type === listItemType && itemPos === null) {
        itemPos = pos;
        return false;
      }
      return true;
    });
    if (itemPos === null) continue;

    // Set cursor inside this item and run the operation
    const $item = currentState.doc.resolve(itemPos + 1);
    const selInItem = currentState.selection.constructor.near($item);
    const itemState = currentState.apply(currentState.tr.setSelection(selInItem));

    let itemTr: any = null;
    const itemDispatch = (t: any) => { itemTr = t; };
    const worked = operation(itemState, itemDispatch);

    if (worked && itemTr && itemTr.steps.length > 0) {
      anyWorked = true;
      // Apply this transaction to advance currentState
      const nextState = itemState.apply(itemTr);
      // Update our mapping: compose finalTr.mapping with itemTr.mapping
      // We do this by appending the steps to our final transaction
      for (const step of itemTr.steps) {
        try {
          finalTr = finalTr.step(step);
        } catch (_) {
          // step couldn't apply — skip (position already shifted)
        }
      }
      currentState = nextState;
      latestAppliedState = nextState;
    }
  }

  if (anyWorked && dispatch) {
    dispatch(finalTr.scrollIntoView());
    return true;
  }

  return false;
}

function sinkMultipleListItems(state: any, dispatch: any, listItemType: any): boolean {
  const worked = applyToEachItem(state, dispatch, listItemType, false, // bottom-up
    (s: any, d: any) => sinkListItem(listItemType)(s, d) ?? false
  );
  if (!worked) {
    // Fallback to native single-item sink
    return sinkListItem(listItemType)(state, dispatch) ?? false;
  }
  return worked;
}

function liftMultipleListItems(state: any, dispatch: any, listItemType: any): boolean {
  const worked = applyToEachItem(state, dispatch, listItemType, true, // top-down
    (s: any, d: any) => liftListItem(listItemType)(s, d) ?? false
  );
  if (!worked) {
    return liftListItem(listItemType)(state, dispatch) ?? false;
  }
  return worked;
}
