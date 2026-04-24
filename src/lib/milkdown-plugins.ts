/**
 * milkdown-plugins.ts — Custom Milkdown plugins for JayNotes
 */

import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $mark, $markSchema, $prose } from '@milkdown/utils';
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
 * Toggle GFM task-list formatting on the selected line(s).
 *
 * Logic:
 *  - ALL blocks are already task items → REMOVE: strip checked attr, revert to plain bullets
 *  - SOME blocks are task items        → ADD: convert only non-task blocks to tasks
 *  - NO blocks are task items          → ADD: convert all blocks to tasks
 *
 * ADD path:
 *  - Block inside list_item (plain bullet) → setNodeMarkup to add checked:false (no re-wrap)
 *  - Plain paragraph                       → wrap in bullet_list > list_item{checked:false}
 *
 * REMOVE path:
 *  - task list_item → setNodeMarkup to set checked:null (reverts to plain bullet)
 */
export function execInsertChecklist(view: any): boolean {
  const { state, dispatch } = view;
  const { from, to } = state.selection;
  const schema = state.schema;

  const bulletListType = schema.nodes.bullet_list;
  const listItemType   = schema.nodes.list_item;
  const paragraphType  = schema.nodes.paragraph;
  if (!bulletListType || !listItemType || !paragraphType) return false;

  type BlockKind = 'task' | 'list-item' | 'plain';
  interface BlockInfo {
    paraFrom: number;
    paraTo: number;
    content: any;
    kind: BlockKind;
    listItemPos: number;
  }

  const classifyPos = (pos: number): { kind: BlockKind; listItemPos: number } => {
    const $p = state.doc.resolve(pos);
    for (let d = $p.depth; d > 0; d--) {
      const n = $p.node(d);
      if (n.type === listItemType) {
        return {
          kind: n.attrs.checked != null ? 'task' : 'list-item',
          listItemPos: $p.before(d),
        };
      }
    }
    return { kind: 'plain', listItemPos: -1 };
  };

  const blocks: BlockInfo[] = [];

  state.doc.nodesBetween(from, to, (node: any, pos: number) => {
    if (node.isTextblock) {
      const { kind, listItemPos } = classifyPos(pos + 1);
      blocks.push({ paraFrom: pos, paraTo: pos + node.nodeSize, content: node.content, kind, listItemPos });
      return false;
    }
    return true;
  });

  // Collapsed cursor fallback
  if (blocks.length === 0) {
    const $from = state.doc.resolve(from);
    if ($from.parent.isTextblock) {
      const { kind, listItemPos } = classifyPos(from);
      blocks.push({
        paraFrom: $from.start($from.depth) - 1,
        paraTo:   $from.end($from.depth) + 1,
        content:  $from.parent.content,
        kind, listItemPos,
      });
    }
  }

  if (blocks.length === 0) return false;

  const allTask = blocks.every(b => b.kind === 'task');
  let tr = state.tr;

  if (allTask) {
    // REMOVE: lift each task item out of the list entirely → plain paragraph.
    // We call liftTopLevelListItem for each item (top-down so positions stay valid).
    // Process top-down (ascending pos) when lifting.
    const sortedAsc = [...blocks].filter(b => b.kind === 'task' && b.listItemPos >= 0)
      .sort((a, b) => a.listItemPos - b.listItemPos);
    for (const b of sortedAsc) {
      const tempState = state.apply(tr);
      const mappedPos = tr.mapping.map(b.listItemPos);
      // Set selection inside this list_item so liftTopLevelListItem can find it
      let resolvedPos: any;
      try { resolvedPos = tempState.doc.resolve(mappedPos + 1); }
      catch (_) { continue; }
      const sel = tempState.selection.constructor.near(resolvedPos);
      const itemState = tempState.apply(tempState.tr.setSelection(sel));
      let itemTr: any = null;
      liftTopLevelListItem(itemState, (t: any) => { itemTr = t; }, listItemType);
      if (itemTr && itemTr.steps.length > 0) {
        for (const step of itemTr.steps) {
          try { tr = tr.step(step); } catch (_) {}
        }
      }
    }
  } else {
    // ADD: convert non-task blocks only
    for (const b of [...blocks].reverse()) {
      if (b.kind === 'task') continue;

      if (b.kind === 'list-item' && b.listItemPos >= 0) {
        const mappedPos = tr.mapping.map(b.listItemPos);
        const liNode = tr.doc.nodeAt(mappedPos);
        if (liNode && liNode.type === listItemType) {
          tr = tr.setNodeMarkup(mappedPos, undefined, { ...liNode.attrs, checked: false });
        }
        continue;
      }

      // Plain paragraph — wrap in bullet_list > list_item{checked:false}
      const $para = state.doc.resolve(b.paraFrom + 1);
      const blockStart = $para.start($para.depth);
      const blockEnd   = $para.end($para.depth);
      const para = paragraphType.create(null, b.content);
      const item = listItemType.create({ checked: false }, para);
      const list = bulletListType.create(null, item);
      tr = tr.replaceWith(blockStart - 1, blockEnd + 1, list);
    }
  }

  if (tr.steps.length === 0) return false;
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
        if (event.key !== 'Tab') return false;

        const { state, dispatch } = view;
        const { $from, $to } = state.selection;
        const schema = state.schema;
        const listItemType = schema.nodes.list_item;
        const paragraphType = schema.nodes.paragraph;

        // ── Case 1: plain text (not in any list) ─────────────────────────────
        // Tab inserts two spaces. Shift+Tab does nothing in plain text.
        if (listItemType) {
          let inList = false;
          state.doc.nodesBetween($from.pos, $to.pos, (node) => {
            if (node.type === listItemType) { inList = true; return false; }
            return true;
          });
          // Also check $from.parent ancestry (collapsed cursor)
          if (!inList) {
            for (let d = $from.depth; d > 0; d--) {
              if ($from.node(d).type === listItemType) { inList = true; break; }
            }
          }

          if (!inList) {
            if (event.shiftKey) return false; // let browser handle
            // Insert 2-space indent at cursor position
            event.preventDefault();
            if (paragraphType && $from.parent.isTextblock) {
              const tr = state.tr.insertText('  ', $from.pos, $to.pos);
              dispatch(tr);
              return true;
            }
            return false;
          }
        } else {
          return false;
        }

        event.preventDefault();

        // ── Case 2: Shift+Tab — outdent only the CURRENT item ────────────────
        // Explicitly narrow selection to just the item containing $from so
        // liftListItem doesn't lift the whole parent chain.
        if (event.shiftKey) {
          return liftCurrentItemOnly(state, dispatch, listItemType);
        }

        // ── Case 3: Tab — sink current item ──────────────────────────────────
        return sinkMultipleListItems(state, dispatch, listItemType);
      },
    },
  });
});

/**
 * Lift ONLY the list_item that contains the cursor, one level up.
 * If already at top level, convert to a plain paragraph.
 * Does NOT lift sibling items or parent items.
 */
function liftCurrentItemOnly(state: any, dispatch: any, listItemType: any): boolean {
  const { $from } = state.selection;

  // Find the innermost list_item containing the cursor
  let itemDepth = -1;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === listItemType) { itemDepth = d; break; }
  }
  if (itemDepth < 0) return false;

  // Build a selection that starts and ends inside ONLY this list_item
  const itemStart = $from.before(itemDepth) + 1; // just inside the list_item
  const $sel = state.doc.resolve(itemStart);
  const isolatedSel = state.selection.constructor.near($sel);
  const isolatedState = state.apply(state.tr.setSelection(isolatedSel));

  // Try native liftListItem on the isolated state
  let itemTr: any = null;
  const lifted = liftListItem(listItemType)(isolatedState, (t: any) => { itemTr = t; });

  if (lifted && itemTr) {
    dispatch(itemTr.scrollIntoView());
    return true;
  }

  // Already at top level — convert to plain paragraph
  return liftTopLevelListItem(isolatedState, dispatch, listItemType);
}

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

/**
 * Indent the selected list item(s) by one level.
 *
 * The correct behaviour — matching Word, VS Code, etc. — is:
 *   "Move ALL selected top-level items one level deeper, as a group."
 *
 * ProseMirror's sinkListItem only nests the cursor item under its previous
 * sibling, one at a time.  Calling it once per item in a loop creates a
 * cascade tree instead of a parallel indent.
 *
 * Our approach:
 *   1. Collect only the top-level list_item nodes that overlap the selection.
 *   2. The FIRST item in the group becomes the last child of its previous
 *      sibling's nested list (or a new nested list inside that sibling).
 *   3. The remaining items are inserted right after the first item inside
 *      the same nested list — all at the same depth.
 *
 * If there is no previous sibling (item is the first in the list), we cannot
 * sink — no-op and return false for that case.
 */
export function execIndent(view: any): boolean {
  if (!view) return false;
  const { state, dispatch } = view;
  const schema = state.schema;
  const listItemType = schema.nodes.list_item;
  const bulletListType = schema.nodes.bullet_list;
  const orderedListType = schema.nodes.ordered_list;
  if (!listItemType) return false;

  const { from, to } = state.selection;

  // Collect the top-level list_item positions overlapping the selection.
  // "Top-level" means we stop descending once we find a list_item — we do
  // not collect items nested inside selected items.
  const positions: number[] = [];
  state.doc.nodesBetween(from, to, (node: any, pos: number) => {
    if (node.type === listItemType) {
      positions.push(pos);
      return false; // don't descend into children
    }
    return true;
  });

  if (positions.length === 0) return false;

  // Single item — delegate to the native sinkListItem which handles all
  // edge cases correctly (first-child guard, nested list type, etc.)
  if (positions.length === 1) {
    const worked = sinkListItem(listItemType)(state, dispatch);
    if (worked) { view.focus(); return true; }
    return false;
  }

  // Multi-item indent.
  // Strategy: run sinkListItem on the FIRST item to create/find the nested
  // list, then for every subsequent item splice it into that nested list.
  //
  // Implementation: process in reverse (bottom-up) position order so that
  // position offsets from earlier steps don't invalidate later ones.
  // But we must first handle the first item to create the anchor, then
  // move the rest into that anchor — all in one transaction.

  // --- Build the whole thing in a single tr ---
  // Step 1: figure out the parent list node and index of the first selected item.
  const firstPos = positions[0];
  const $first = state.doc.resolve(firstPos + 1);
  // Depth of the list_item
  let itemDepth = -1;
  for (let d = $first.depth; d > 0; d--) {
    if ($first.node(d).type === listItemType) { itemDepth = d; break; }
  }
  if (itemDepth < 0) return false;

  const listDepth = itemDepth - 1;
  const listNode = $first.node(listDepth);
  const listStart = $first.before(listDepth);

  // Find the index of the first selected item within its parent list
  let firstIndex = -1;
  listNode.forEach((_: any, offset: number, i: number) => {
    if (listStart + 1 + offset === firstPos) firstIndex = i;
  });
  if (firstIndex < 0) return false;
  // Cannot indent if there's no previous sibling to nest under
  if (firstIndex === 0) return false;

  // Collect the actual node objects for all selected items (they all share the
  // same parent list at this depth — that's what "top-level selected" means)
  const selectedItems: any[] = positions.map(pos => state.doc.nodeAt(pos)).filter(Boolean);

  // Compute spans: start of first selected item → end of last selected item
  const firstItemStart = positions[0];
  const lastPos = positions[positions.length - 1];
  const lastNode = state.doc.nodeAt(lastPos)!;
  const lastItemEnd = lastPos + lastNode.nodeSize;

  // Previous sibling of the first selected item
  const prevSiblingIndex = firstIndex - 1;
  let prevSiblingOffset = 0;
  listNode.forEach((_: any, offset: number, i: number) => {
    if (i === prevSiblingIndex) prevSiblingOffset = offset;
  });
  const prevSiblingPos = listStart + 1 + prevSiblingOffset;
  const prevSiblingNode = listNode.child(prevSiblingIndex);

  // Determine the nested list type (prefer the existing nested list in prev
  // sibling if one exists; otherwise use the same list type as the parent)
  const parentListType = listNode.type;
  let existingNestedList: any = null;
  let nestedListInsertPos: number | null = null; // absolute position to insert into

  // The prev sibling's content: look for a child list at the end
  const prevSibContent = prevSiblingNode.content;
  const lastChildOfPrev = prevSibContent.lastChild;
  if (lastChildOfPrev &&
      (lastChildOfPrev.type === bulletListType || lastChildOfPrev.type === orderedListType)) {
    existingNestedList = lastChildOfPrev;
    // Insert position = end of existing nested list, before its closing token
    nestedListInsertPos = prevSiblingPos + prevSiblingNode.nodeSize - 1 - 1; // before </li>
  }

  let tr = state.tr;

  // Build the fragment of items to insert (all selected items)
  const itemsFragment = schema.nodes.fragment
    ? null // not a real API; we'll build manually
    : null;

  if (existingNestedList) {
    // Append all selected items into the existing nested list, then delete
    // them from their original positions.
    // Insert at end of existing nested list (before its closing tag)
    const insertAt = prevSiblingPos + prevSiblingNode.nodeSize - 1 - 1;
    // We need to insert BEFORE the </list> of the nested list.
    // existingNestedList ends at prevSiblingPos + prevSiblingNode.nodeSize - 1 (excl </li>)
    // nestedList starts at prevSiblingPos + prevSiblingNode.nodeSize - 1 - existingNestedList.nodeSize
    const nestedListStart = prevSiblingPos + prevSiblingNode.nodeSize - 1 - existingNestedList.nodeSize;
    const insertIntoNestedListAt = nestedListStart + existingNestedList.nodeSize - 1;
    tr = tr.insert(insertIntoNestedListAt, selectedItems as any);
    // Now delete the originals. Because we inserted *before* them, positions shifted.
    const insertedSize = selectedItems.reduce((s: number, n: any) => s + n.nodeSize, 0);
    tr = tr.delete(firstItemStart + insertedSize, lastItemEnd + insertedSize);
  } else {
    // Create a new nested list wrapping all selected items, replace them all
    const newNestedList = parentListType.create(null, selectedItems);
    // Insert the new nested list at the end of the previous sibling (before its closing </li>)
    const insertAt = prevSiblingPos + prevSiblingNode.nodeSize - 1;
    tr = tr.insert(insertAt, newNestedList);
    // Delete original items (positions shifted by inserted nested list)
    const insertedSize = newNestedList.nodeSize;
    tr = tr.delete(firstItemStart + insertedSize, lastItemEnd + insertedSize);
  }

  dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/**
 * Outdent the selected list item(s) by one level.
 *
 * Applies liftListItem independently to each selected top-level item,
 * processing top-down so earlier lifted positions don't shift later ones
 * in the wrong direction. Falls back to converting top-level items to
 * plain paragraphs if they're already at root depth.
 */
export function execOutdent(view: any): boolean {
  if (!view) return false;
  const { state, dispatch } = view;
  const listItemType = state.schema.nodes.list_item;
  if (!listItemType) return false;

  const { from, to } = state.selection;

  // Collect top-level list_item positions overlapping the selection
  const positions: number[] = [];
  state.doc.nodesBetween(from, to, (node: any, pos: number) => {
    if (node.type === listItemType) {
      positions.push(pos);
      return false;
    }
    return true;
  });

  if (positions.length === 0) return false;

  // Single item — use liftCurrentItemOnly (handles top-level → paragraph too)
  if (positions.length === 1) {
    const worked = liftCurrentItemOnly(state, dispatch, listItemType);
    if (worked) { view.focus(); return true; }
    return false;
  }

  // Multi-item: lift each item independently, accumulating steps top-down
  // so position offsets from earlier lifts shift later items correctly.
  let currentState = state;
  let finalTr = state.tr;
  let anyWorked = false;

  // Sort ascending (top-down)
  const ordered = [...positions].sort((a, b) => a - b);

  for (const origPos of ordered) {
    const mappedPos = finalTr.mapping.map(origPos);

    // Resolve the item in the current doc
    let resolvedPos: any = null;
    try {
      const $p = currentState.doc.resolve(mappedPos + 1);
      resolvedPos = $p;
    } catch (_) { continue; }
    if (!resolvedPos) continue;

    // Set selection inside this item
    const sel = currentState.selection.constructor.near(resolvedPos);
    const itemState = currentState.apply(currentState.tr.setSelection(sel));

    let itemTr: any = null;
    const itemDispatch = (t: any) => { itemTr = t; };

    // Try liftListItem first; fall back to liftTopLevelListItem
    let worked = liftListItem(listItemType)(itemState, itemDispatch) ?? false;
    if (!worked) {
      worked = liftTopLevelListItem(itemState, itemDispatch, listItemType);
    }

    if (worked && itemTr && itemTr.steps.length > 0) {
      anyWorked = true;
      for (const step of itemTr.steps) {
        try { finalTr = finalTr.step(step); } catch (_) { /* skip */ }
      }
      currentState = itemState.apply(itemTr);
    }
  }

  if (anyWorked) {
    dispatch(finalTr.scrollIntoView());
    view.focus();
    return true;
  }
  return false;
}

/** Is the cursor inside a list? */
export function isInList(state: any): boolean {
  const listItemType = state.schema.nodes.list_item;
  if (!listItemType) return false;
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === listItemType) return true;
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

/**
 * Lift a single top-level list item into a plain paragraph.
 * Called when liftListItem returns false (item is already at root level).
 * Replaces the entire list_item (and its parent list if it becomes empty)
 * with just the paragraph content.
 */
function liftTopLevelListItem(state: any, dispatch: any, listItemType: any): boolean {
  const { $from } = state.selection;

  // Walk up to find the list_item and its parent list
  let listItemDepth = -1;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === listItemType) { listItemDepth = d; break; }
  }
  if (listItemDepth < 0) return false;

  const listDepth = listItemDepth - 1;
  const listNode = $from.node(listDepth);
  const listItemNode = $from.node(listItemDepth);
  const paragraphType = state.schema.nodes.paragraph;
  if (!paragraphType) return false;

  // Position of the list_item node
  const listItemStart = $from.before(listItemDepth);
  const listItemEnd = listItemStart + listItemNode.nodeSize;

  // Collect the text content of the list_item (first paragraph's content)
  let textContent: any = null;
  listItemNode.forEach((child: any) => {
    if (!textContent && child.isTextblock) textContent = child.content;
  });

  const para = paragraphType.create(null, textContent ?? undefined);

  let tr = state.tr;

  if (listNode.childCount === 1) {
    // This is the only item in the list — replace the entire list with the paragraph
    const listStart = $from.before(listDepth);
    const listEnd = listStart + listNode.nodeSize;
    tr = tr.replaceWith(listStart, listEnd, para);
  } else {
    // Replace just the list_item with the paragraph
    tr = tr.replaceWith(listItemStart, listItemEnd, para);
  }

  dispatch(tr.scrollIntoView());
  return true;
}

function liftMultipleListItems(state: any, dispatch: any, listItemType: any): boolean {
  // Try native lift first (handles nested items correctly)
  const worked = applyToEachItem(state, dispatch, listItemType, true, // top-down
    (s: any, d: any) => liftListItem(listItemType)(s, d) ?? false
  );
  if (worked) return true;

  // Native lift failed → item is at top level. Convert to plain paragraph.
  return liftTopLevelListItem(state, dispatch, listItemType);
}

// ─── Font color & highlight marks ────────────────────────────────────────────
//
// These are Milkdown `$markSchema` plugins that inject two new marks:
//   jn_color     — renders as <span style="color: ...">
//   jn_highlight — renders as <span style="background-color: ...">
//
// Uses $markSchema (not bare $mark) for proper context integration and
// includes parseMarkdown / toMarkdown stubs so marks survive round-trips
// (serialized as HTML spans in the markdown).
//
// `applyFontColor` and `applyHighlight` are called from the toolbar and use
// ProseMirror transactions to add/remove these marks on the current selection.

export const fontColorMark = $markSchema('jn_color', () => ({
  attrs: { color: { default: '#000000' } },
  inclusive: false,
  parseDOM: [
    {
      tag: 'span[data-jn-color]',
      getAttrs: (dom: any) => ({ color: dom.getAttribute('data-jn-color') || '#000000' }),
    },
  ],
  toDOM: (mark: any) => [
    'span',
    {
      'data-jn-color': mark.attrs.color,
      style: `color:${mark.attrs.color}`,
    },
    0,
  ],
  parseMarkdown: {
    // Match inline HTML nodes that carry our data attribute
    match: (node: any) =>
      node.type === 'html' && /data-jn-color/.test(node.value ?? ''),
    runner: (state: any, node: any, markType: any) => {
      // Extract the color from the raw HTML value
      const colorMatch = (node.value ?? '').match(/data-jn-color="([^"]+)"/);
      const color = colorMatch ? colorMatch[1] : '#000000';
      // Extract inner text content
      const textMatch = (node.value ?? '').match(/>([^<]*)<\/span>/);
      const text = textMatch ? textMatch[1] : '';
      if (text) {
        state.openMark(markType, { color });
        state.addNode('text', undefined, text);
        state.closeMark(markType);
      }
    },
  },
  toMarkdown: {
    match: (mark: any) => mark.type.name === 'jn_color',
    // Called by the serializer once per mark — just open the mark context.
    // The serializer walks the node's text children and calls closeMark after.
    runner: (state: any, mark: any) => {
      state.withMark(mark, 'html', undefined, {
        value: `<span data-jn-color="${mark.attrs.color}" style="color:${mark.attrs.color}">`,
      });
    },
  },
}));

export const highlightMark = $markSchema('jn_highlight', () => ({
  attrs: { color: { default: '#ffeb3b' } },
  inclusive: false,
  parseDOM: [
    {
      tag: 'span[data-jn-highlight]',
      getAttrs: (dom: any) => ({ color: dom.getAttribute('data-jn-highlight') || '#ffeb3b' }),
    },
  ],
  toDOM: (mark: any) => [
    'span',
    {
      'data-jn-highlight': mark.attrs.color,
      style: `background-color:${mark.attrs.color};border-radius:2px;padding:0 1px`,
    },
    0,
  ],
  parseMarkdown: {
    match: (node: any) =>
      node.type === 'html' && /data-jn-highlight/.test(node.value ?? ''),
    runner: (state: any, node: any, markType: any) => {
      const colorMatch = (node.value ?? '').match(/data-jn-highlight="([^"]+)"/);
      const color = colorMatch ? colorMatch[1] : '#ffeb3b';
      const textMatch = (node.value ?? '').match(/>([^<]*)<\/span>/);
      const text = textMatch ? textMatch[1] : '';
      if (text) {
        state.openMark(markType, { color });
        state.addNode('text', undefined, text);
        state.closeMark(markType);
      }
    },
  },
  toMarkdown: {
    match: (mark: any) => mark.type.name === 'jn_highlight',
    runner: (state: any, mark: any) => {
      state.withMark(mark, 'html', undefined, {
        value: `<span data-jn-highlight="${mark.attrs.color}" style="background-color:${mark.attrs.color};border-radius:2px;padding:0 1px">`,
      });
    },
  },
}));

// ─── Underline mark ──────────────────────────────────────────────────────────
// Underline is not part of CommonMark or GFM, so like jn_color/jn_highlight
// we serialize to an HTML <u> tag (round-trips cleanly through remark's html
// node passthrough).

export const underlineMark = $markSchema('jn_underline', () => ({
  inclusive: false,
  parseDOM: [{ tag: 'u' }, { tag: 'span[data-jn-underline]' }],
  toDOM: () => ['u', { 'data-jn-underline': '1' }, 0],
  parseMarkdown: {
    match: (node: any) =>
      node.type === 'html' &&
      (/^<u[\s>]/i.test(node.value ?? '') || /data-jn-underline/.test(node.value ?? '')),
    runner: (state: any, node: any, markType: any) => {
      const textMatch = (node.value ?? '').match(/>([^<]*)<\/(?:u|span)>/i);
      const text = textMatch ? textMatch[1] : '';
      if (text) {
        state.openMark(markType);
        state.addNode('text', undefined, text);
        state.closeMark(markType);
      }
    },
  },
  toMarkdown: {
    match: (mark: any) => mark.type.name === 'jn_underline',
    runner: (state: any, mark: any) => {
      state.withMark(mark, 'html', undefined, { value: '<u>' });
    },
  },
}));

/** Toggle underline on current selection. */
export function toggleUnderline(view: any): boolean {
  if (!view) return false;
  const { state, dispatch } = view;
  const markType = state.schema.marks['jn_underline'];
  if (!markType) return false;
  const { from, to, empty } = state.selection;
  if (empty) return false;
  // If any part of the selection already has the mark, remove it; else add it.
  const has = state.doc.rangeHasMark(from, to, markType);
  const tr = has
    ? state.tr.removeMark(from, to, markType)
    : state.tr.addMark(from, to, markType.create());
  dispatch(tr);
  view.focus();
  return true;
}

/**
 * Apply or remove a font color on the current selection.
 * If selection is empty (just cursor), no-op and returns false.
 * Passing `null` removes all jn_color marks from the selection.
 */
export function applyFontColor(view: any, color: string | null): boolean {
  if (!view) return false;
  const { state, dispatch } = view;
  const markType = state.schema.marks['jn_color'];
  if (!markType) {
    console.warn('[applyFontColor] jn_color mark not in schema');
    return false;
  }
  const { from, to, empty } = state.selection;
  if (empty) {
    console.warn('[applyFontColor] selection is empty — select text first');
    return false;
  }
  let tr = state.tr;
  tr = tr.removeMark(from, to, markType);
  if (color !== null) {
    tr = tr.addMark(from, to, markType.create({ color }));
  }
  dispatch(tr);
  view.focus();
  return true;
}

/**
 * Apply or remove a highlight (background color) on the current selection.
 * Passing `null` removes all jn_highlight marks from the selection.
 */
export function applyHighlight(view: any, color: string | null): boolean {
  if (!view) return false;
  const { state, dispatch } = view;
  const markType = state.schema.marks['jn_highlight'];
  if (!markType) {
    console.warn('[applyHighlight] jn_highlight mark not in schema');
    return false;
  }
  const { from, to, empty } = state.selection;
  if (empty) {
    console.warn('[applyHighlight] selection is empty — select text first');
    return false;
  }
  let tr = state.tr;
  tr = tr.removeMark(from, to, markType);
  if (color !== null) {
    tr = tr.addMark(from, to, markType.create({ color }));
  }
  dispatch(tr);
  view.focus();
  return true;
}

// ─── Table theme plugin ──────────────────────────────────────────────────────
//
// Applies theme classes to each table's `.tableWrapper` via ProseMirror
// decorations. Using decorations means the class survives every transaction —
// unlike the previous approach (direct classList manipulation) which was wiped
// by ProseMirror's NodeView re-render cycle.
//
// Plugin state is a Map<tablePos, themeId> keyed by the table node's start pos.
// Positions are auto-remapped through doc changes via tr.mapping.

export const TABLE_THEME_META = 'jn-set-table-theme';
export const tableThemePluginKey = new PluginKey('jn-table-theme');

interface TableThemeState {
  themes: Map<number, string>;
}

export const tableThemePlugin = $prose(() => {
  return new Plugin<TableThemeState>({
    key: tableThemePluginKey,
    state: {
      init: (): TableThemeState => ({ themes: new Map() }),
      apply(tr, prev): TableThemeState {
        let themes = prev.themes;

        const meta = tr.getMeta(TABLE_THEME_META);
        if (meta) {
          themes = new Map(prev.themes);
          if (meta.theme === '' || meta.theme == null) {
            themes.delete(meta.pos);
          } else {
            themes.set(meta.pos, meta.theme);
          }
        }

        if (tr.docChanged) {
          const remapped = new Map<number, string>();
          themes.forEach((theme, pos) => {
            const mapped = tr.mapping.mapResult(pos);
            if (!mapped.deleted) remapped.set(mapped.pos, theme);
          });
          themes = remapped;
        }

        return { themes };
      },
    },
    props: {
      decorations(state) {
        const pluginState = tableThemePluginKey.getState(state) as TableThemeState | undefined;
        if (!pluginState || pluginState.themes.size === 0) return DecorationSet.empty;

        const decos: Decoration[] = [];
        pluginState.themes.forEach((theme, pos) => {
          try {
            const node = state.doc.nodeAt(pos);
            if (node && node.type.name === 'table') {
              decos.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  class: `jn-table--${theme}`,
                  'data-jn-theme': theme,
                })
              );
            }
          } catch (_) { /* skip invalid positions */ }
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
});

/** Find the start position of the table containing the selection. Returns -1 if none. */
export function findTablePos(state: any): number {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === 'table') {
      return $from.before(d);
    }
  }
  return -1;
}

/** Get the current theme id ('' = default) for the table containing the selection. */
export function getCurrentTableTheme(state: any): string {
  const pos = findTablePos(state);
  if (pos < 0) return '';
  const pluginState = tableThemePluginKey.getState(state) as TableThemeState | undefined;
  return pluginState?.themes.get(pos) ?? '';
}

/** Apply a theme to the current table. theme='' removes any theme. */
export function setTableThemeForCurrent(view: any, theme: string): boolean {
  if (!view) return false;
  const pos = findTablePos(view.state);
  if (pos < 0) return false;
  view.dispatch(view.state.tr.setMeta(TABLE_THEME_META, { pos, theme }));
  return true;
}

/** Serialize theme state as [{tableIndex, theme}] pairs for persistence. */
export function serializeTableThemes(state: any): Array<{ index: number; theme: string }> {
  const pluginState = tableThemePluginKey.getState(state) as TableThemeState | undefined;
  if (!pluginState || pluginState.themes.size === 0) return [];

  const tables: number[] = [];
  state.doc.descendants((node: any, pos: number) => {
    if (node.type.name === 'table') {
      tables.push(pos);
      return false;
    }
    return true;
  });

  const result: Array<{ index: number; theme: string }> = [];
  pluginState.themes.forEach((theme, pos) => {
    const idx = tables.indexOf(pos);
    if (idx >= 0) result.push({ index: idx, theme });
  });
  return result;
}

/** Restore themes from persistence. Maps [tableIndex, theme] back to current table positions. */
export function restoreTableThemes(view: any, entries: Array<{ index: number; theme: string }>): void {
  if (!view || entries.length === 0) return;

  const tables: number[] = [];
  view.state.doc.descendants((node: any, pos: number) => {
    if (node.type.name === 'table') {
      tables.push(pos);
      return false;
    }
    return true;
  });

  let tr = view.state.tr;
  let any = false;
  for (const { index, theme } of entries) {
    const pos = tables[index];
    if (pos !== undefined && theme) {
      tr = tr.setMeta(TABLE_THEME_META, { pos, theme });
      any = true;
    }
  }
  if (any) view.dispatch(tr);
}

// ─── Block alignment plugin ──────────────────────────────────────────────────
//
// Text alignment (left/center/right) isn't part of CommonMark, so we avoid
// touching the markdown schema and instead track alignment in ProseMirror
// plugin state keyed by each textblock's position. Rendered via
// Decoration.node which applies `.jn-align-{left,center,right}` to the block.
// This mirrors the table-theme plugin approach — decorations survive every
// transaction cleanly and remap through doc changes.
//
// Persistence: a sidecar JSON blob in localStorage keyed by filePath. Not
// stored in the markdown itself (would pollute round-trips with HTML noise).

export const ALIGN_META = 'jn-set-align';
export const alignPluginKey = new PluginKey('jn-align');
export type AlignValue = 'left' | 'center' | 'right' | '';

interface AlignState {
  aligns: Map<number, AlignValue>;
}

export const alignPlugin = $prose(() => {
  return new Plugin<AlignState>({
    key: alignPluginKey,
    state: {
      init: (): AlignState => ({ aligns: new Map() }),
      apply(tr, prev): AlignState {
        let aligns = prev.aligns;

        const meta = tr.getMeta(ALIGN_META);
        if (meta) {
          aligns = new Map(prev.aligns);
          if (!meta.align || meta.align === 'left') {
            // 'left' is the default — no need to store it
            aligns.delete(meta.pos);
          } else {
            aligns.set(meta.pos, meta.align);
          }
        }

        if (tr.docChanged) {
          const remapped = new Map<number, AlignValue>();
          aligns.forEach((v, pos) => {
            const mapped = tr.mapping.mapResult(pos);
            if (!mapped.deleted) remapped.set(mapped.pos, v);
          });
          aligns = remapped;
        }

        return { aligns };
      },
    },
    props: {
      decorations(state) {
        const p = alignPluginKey.getState(state) as AlignState | undefined;
        if (!p || p.aligns.size === 0) return DecorationSet.empty;
        const decos: Decoration[] = [];
        p.aligns.forEach((v, pos) => {
          try {
            const node = state.doc.nodeAt(pos);
            if (node && node.isTextblock) {
              decos.push(
                Decoration.node(pos, pos + node.nodeSize, { class: `jn-align-${v}` })
              );
            }
          } catch (_) { /* invalid pos, skip */ }
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
});

/** Returns the start position of the innermost textblock containing the selection. */
function findBlockPos(state: any): number {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    const node = $from.node(d);
    if (node.isTextblock) return $from.before(d);
  }
  return -1;
}

/** Apply alignment to the block(s) overlapping the selection. Empty string = reset to left. */
export function applyAlign(view: any, align: AlignValue): boolean {
  if (!view) return false;
  const { state } = view;
  const { from, to } = state.selection;

  // Collect every textblock overlapping the selection
  const positions: number[] = [];
  state.doc.nodesBetween(from, to, (node: any, pos: number) => {
    if (node.isTextblock) positions.push(pos);
  });
  // Fallback for a collapsed cursor in the middle of a block
  if (positions.length === 0) {
    const pos = findBlockPos(state);
    if (pos >= 0) positions.push(pos);
  }
  if (positions.length === 0) return false;

  let tr = state.tr;
  for (const pos of positions) tr = tr.setMeta(ALIGN_META, { pos, align });
  view.dispatch(tr);
  view.focus();
  return true;
}

/** Get current alignment for the block containing the selection. */
export function getCurrentAlign(state: any): AlignValue {
  const pos = findBlockPos(state);
  if (pos < 0) return '';
  const p = alignPluginKey.getState(state) as AlignState | undefined;
  return p?.aligns.get(pos) ?? '';
}

/** Serialize alignment state for persistence as [{index, align}] (index = n-th textblock). */
export function serializeAlignments(state: any): Array<{ index: number; align: AlignValue }> {
  const p = alignPluginKey.getState(state) as AlignState | undefined;
  if (!p || p.aligns.size === 0) return [];
  const blocks: number[] = [];
  state.doc.descendants((node: any, pos: number) => {
    if (node.isTextblock) blocks.push(pos);
  });
  const result: Array<{ index: number; align: AlignValue }> = [];
  p.aligns.forEach((align, pos) => {
    const idx = blocks.indexOf(pos);
    if (idx >= 0) result.push({ index: idx, align });
  });
  return result;
}

/** Restore alignment from serialized form. */
export function restoreAlignments(view: any, entries: Array<{ index: number; align: AlignValue }>): void {
  if (!view || entries.length === 0) return;
  const blocks: number[] = [];
  view.state.doc.descendants((node: any, pos: number) => {
    if (node.isTextblock) blocks.push(pos);
  });
  let tr = view.state.tr;
  let any = false;
  for (const { index, align } of entries) {
    const pos = blocks[index];
    if (pos !== undefined && align) {
      tr = tr.setMeta(ALIGN_META, { pos, align });
      any = true;
    }
  }
  if (any) view.dispatch(tr);
}
