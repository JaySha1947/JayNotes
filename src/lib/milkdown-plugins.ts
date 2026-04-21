/**
 * milkdown-plugins.ts
 *
 * Custom ProseMirror plugins that add Obsidian-style features to Milkdown:
 *  1. [[wikilink]] rendering + autocomplete dropdown
 *  2. #tag highlighting
 *  3. Double-click on [[wikilink]] to navigate
 */

import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

// ─── Shared file list (updated externally) ────────────────────────────────────

let _fileList: string[] = [];
export function setWikilinkFileList(files: string[]) {
  _fileList = files;
}

// ─── #tag decorator ───────────────────────────────────────────────────────────

const tagKey = new PluginKey('jaynotes-tags');

export const tagDecoratorPlugin = $prose(() => {
  return new Plugin({
    key: tagKey,
    props: {
      decorations(state) {
        const decorations: Decoration[] = [];
        const doc = state.doc;
        // Only match #word where # is preceded by space/start-of-text, not # headings
        const TAG_RE = /(?:^|(?<=\s))#([a-zA-Z][a-zA-Z0-9_-]*)/g;
        doc.descendants((node, pos) => {
          if (!node.isText) return;
          const text = node.text ?? '';
          let match;
          TAG_RE.lastIndex = 0;
          while ((match = TAG_RE.exec(text)) !== null) {
            const start = pos + match.index;
            const end = start + match[0].length;
            decorations.push(
              Decoration.inline(start, end, { class: 'jn-tag' })
            );
          }
        });
        return DecorationSet.create(doc, decorations);
      },
    },
  });
});

// ─── [[wikilink]] decorator + autocomplete ────────────────────────────────────

const wikilinkKey = new PluginKey('jaynotes-wikilinks');

// We keep the autocomplete state outside the plugin so we can read it in React
export interface WikilinkSuggestion {
  active: boolean;
  query: string;
  from: number;   // start of [[ in doc
  to: number;     // current cursor position
  suggestions: string[];
  selectedIndex: number;
}

let _suggestionState: WikilinkSuggestion = {
  active: false, query: '', from: 0, to: 0, suggestions: [], selectedIndex: 0,
};
let _onSuggestionChange: ((s: WikilinkSuggestion) => void) | null = null;

export function subscribeToWikilinkSuggestions(cb: (s: WikilinkSuggestion) => void) {
  _onSuggestionChange = cb;
}
export function unsubscribeWikilinkSuggestions() {
  _onSuggestionChange = null;
}
export function getCurrentSuggestions() { return _suggestionState; }

function notifySuggestions(s: WikilinkSuggestion) {
  _suggestionState = s;
  _onSuggestionChange?.(s);
}

export const wikilinkPlugin = $prose(() => {
  return new Plugin({
    key: wikilinkKey,

    // Decorate [[wikilinks]] in the doc
    props: {
      decorations(state) {
        const decorations: Decoration[] = [];
        const LINK_RE = /\[\[([^\]]*)\]\]/g;
        state.doc.descendants((node, pos) => {
          if (!node.isText) return;
          const text = node.text ?? '';
          let match;
          LINK_RE.lastIndex = 0;
          while ((match = LINK_RE.exec(text)) !== null) {
            const start = pos + match.index;
            const end = start + match[0].length;
            const target = match[1].split('|')[0];
            decorations.push(
              Decoration.inline(start, end, {
                class: 'jn-wikilink',
                'data-target': target,
              })
            );
          }
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },

    // Track cursor to show/hide autocomplete
    view() {
      return {
        update(view) {
          const { state } = view;
          const { from } = state.selection;
          const $pos = state.doc.resolve(from);
          const textBefore = $pos.parent.textContent.slice(0, $pos.parentOffset);

          // Find the last [[ in the text before cursor
          const idx = textBefore.lastIndexOf('[[');
          if (idx !== -1) {
            const partial = textBefore.slice(idx + 2);
            // Only active if no ]] after [[
            if (!partial.includes(']]') && !partial.includes('\n')) {
              const docFrom = from - partial.length - 2; // position of [[
              const query = partial.toLowerCase();
              const suggestions = _fileList
                .filter(f => f.toLowerCase().includes(query))
                .slice(0, 8);
              notifySuggestions({
                active: suggestions.length > 0,
                query: partial,
                from: docFrom,
                to: from,
                suggestions,
                selectedIndex: 0,
              });
              return;
            }
          }
          if (_suggestionState.active) {
            notifySuggestions({ ..._suggestionState, active: false });
          }
        },
        destroy() {
          notifySuggestions({ active: false, query: '', from: 0, to: 0, suggestions: [], selectedIndex: 0 });
        },
      };
    },
  });
});
