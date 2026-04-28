/**
 * MilkdownEditor.tsx — Milkdown 7 WYSIWYG editor for JayNotes
 */
import React, { useEffect, useRef, useState, useCallback, Component } from 'react';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, remarkStringifyOptionsCtx } from '@milkdown/core';
import { isInTable } from '@milkdown/prose/tables';
import { TextSelection } from '@milkdown/prose/state';
import {
  commonmark,
  toggleStrongCommand, toggleEmphasisCommand, toggleInlineCodeCommand,
  wrapInBulletListCommand, wrapInOrderedListCommand,
  wrapInBlockquoteCommand, wrapInHeadingCommand,
  insertHrCommand, turnIntoTextCommand,
} from '@milkdown/preset-commonmark';
import {
  gfm,
  toggleStrikethroughCommand,
  insertTableCommand,
  addColAfterCommand, addColBeforeCommand,
  addRowAfterCommand, addRowBeforeCommand,
  deleteSelectedCellsCommand,
  columnResizingPlugin,
} from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import { upload, uploadConfig } from '@milkdown/plugin-upload';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { trailing } from '@milkdown/plugin-trailing';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { callCommand, insert } from '@milkdown/utils';
import {
  Bookmark, FileText, ClipboardList,
  Bold, Italic, Strikethrough, List, ListOrdered,
  CheckSquare, Code, Quote, Minus, Table, AlertTriangle, RefreshCw,
  Palette, Highlighter,
  Underline,
  AlignLeft, AlignCenter, AlignRight,
  Indent, Outdent, ChevronDown,
  Scissors, Copy, Clipboard,
  Search, Trash2, X, Replace, ChevronUp,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import {
  tagDecoratorPlugin, wikilinkPlugin, hashtagPlugin, checkboxClickPlugin, listTabPlugin,
  setWikilinkFileList, setOpenFileCallback,
  setHashtagList,
  subscribeToWikilinkSuggestions, unsubscribeWikilinkSuggestions,
  subscribeToHashtagSuggestions, unsubscribeHashtagSuggestions,
  execWrapInList, execLiftBlockquote, execInsertChecklist,
  execIndent, execOutdent,
  fontColorMark, highlightMark, applyFontColor, applyHighlight,
  tableThemePlugin, setTableThemeForCurrent, getCurrentTableTheme,
  serializeTableThemes, restoreTableThemes,
  underlineMark, toggleUnderline,
  alignPlugin, applyAlign, getCurrentAlign,
  serializeAlignments, restoreAlignments,
  jnHtmlMarksRemarkPlugin,
  findPlugin,
  WikilinkSuggestion,
  HashtagSuggestion,
} from '../lib/milkdown-plugins';
import type { AlignValue } from '../lib/milkdown-plugins';
import {
  spellcheckPlugin,
  spellSuggest,
  spellAddWord,
  spellIgnoreOnce,
} from '../lib/spellcheck-plugin';

// ─── Error boundary ───────────────────────────────────────────────────────────

interface EBState { hasError: boolean; error: string }
class EditorErrorBoundary extends Component<{ children: React.ReactNode; onReset: () => void }, EBState> {
  constructor(props: any) { super(props); this.state = { hasError: false, error: '' }; }
  static getDerivedStateFromError(e: Error) { return { hasError: true, error: e?.message || String(e) }; }
  componentDidCatch(e: Error, info: any) { console.error('[MilkdownEditor] crash:', e, info); }
  render() {
    if (this.state.hasError) return (
      <div className="h-full flex flex-col items-center justify-center gap-4 text-text-muted p-8">
        <AlertTriangle size={32} className="text-error opacity-60" />
        <div className="text-center">
          <p className="font-medium text-text-normal mb-1">Editor failed to load</p>
          <p className="text-xs opacity-60 font-mono max-w-md break-all">{this.state.error}</p>
        </div>
        <button onClick={() => { this.setState({ hasError: false, error: '' }); this.props.onReset(); }}
          className="flex items-center gap-2 px-3 py-1.5 text-sm rounded border border-border-color hover:border-interactive-accent hover:text-interactive-accent transition-colors">
          <RefreshCw size={13} /> Reload editor
        </button>
      </div>
    );
    return this.props.children;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface MilkdownEditorProps {
  filePath: string | null;
  isBookmarked?: boolean;
  onToggleBookmark?: () => void;
  onSplitRight?: () => void;
  onOpenFile?: (path: string) => void;
  templates?: { name: string; path: string; type: string }[];
}

// ─── Image upload ─────────────────────────────────────────────────────────────

async function uploadImageToServer(file: File): Promise<string> {
  const safeName = file.name === 'image.png' ? `pasted-image-${Date.now()}.png` : file.name;
  const formData = new FormData();
  formData.append('file', new File([file], safeName, { type: file.type }));
  const token = localStorage.getItem('jays_notes_token');
  const res = await fetch('/api/upload', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const data = await res.json();
  if (!data.path) throw new Error('No path returned');
  return `/api/${data.path}?token=${encodeURIComponent(token ?? '')}`;
}

// ─── Resizable image NodeView ─────────────────────────────────────────────────
// Wraps every image node in a container with a drag handle so users can resize.
// Width is stored in the `title` attribute as a pixel value (e.g. "480").

import { $view } from '@milkdown/utils';
import { imageSchema } from '@milkdown/preset-commonmark';

const resizableImageView = $view(imageSchema.node, () => (node: any, view: any, getPos: any) => {
  // Container
  const container = document.createElement('span');
  container.style.cssText = 'display:inline-block;position:relative;max-width:100%;vertical-align:bottom;line-height:0;';
  container.contentEditable = 'false';

  // Image element
  const img = document.createElement('img');
  img.src = node.attrs.src || '';
  img.alt = node.attrs.alt || '';
  img.style.cssText = 'display:block;max-width:100%;height:auto;border-radius:4px;cursor:default;';

  // Restore saved width
  const savedWidth = node.attrs.title ? parseInt(node.attrs.title, 10) : null;
  if (savedWidth && savedWidth > 0) {
    img.style.width = `${savedWidth}px`;
  }

  // Resize handle (bottom-right corner)
  const handle = document.createElement('span');
  handle.style.cssText = [
    'position:absolute;bottom:4px;right:4px;width:14px;height:14px;',
    'background:var(--interactive-accent,#00c882);border-radius:3px;',
    'cursor:nwse-resize;opacity:0;transition:opacity 0.15s;z-index:10;',
    'display:flex;align-items:center;justify-content:center;',
  ].join('');
  handle.innerHTML = '<svg width="8" height="8" viewBox="0 0 8 8" fill="white"><path d="M1 7L7 1M4 7L7 4M7 7V7"/><path d="M2 7h5V2" stroke="white" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>';

  container.addEventListener('mouseenter', () => { handle.style.opacity = '1'; });
  container.addEventListener('mouseleave', () => { handle.style.opacity = '0'; });

  // Drag-to-resize
  handle.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = img.offsetWidth;

    const onMove = (ev: MouseEvent) => {
      const newWidth = Math.max(80, startWidth + (ev.clientX - startX));
      img.style.width = `${newWidth}px`;
    };

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const finalWidth = Math.round(Math.max(80, startWidth + (ev.clientX - startX)));
      img.style.width = `${finalWidth}px`;
      // Persist width in the `title` attr via a ProseMirror transaction
      if (typeof getPos === 'function') {
        const pos = getPos();
        if (pos !== undefined) {
          const tr = view.state.tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            title: String(finalWidth),
          });
          view.dispatch(tr);
        }
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  container.appendChild(img);
  container.appendChild(handle);

  return {
    dom: container,
    update(updatedNode: any) {
      if (updatedNode.type.name !== 'image') return false;
      img.src = updatedNode.attrs.src || '';
      img.alt = updatedNode.attrs.alt || '';
      const w = updatedNode.attrs.title ? parseInt(updatedNode.attrs.title, 10) : null;
      if (w && w > 0) img.style.width = `${w}px`;
      else img.style.width = '';
      return true;
    },
    ignoreMutation: () => true,
    stopEvent: (e: Event) => e.type === 'mousedown' && (e.target as HTMLElement) === handle,
  };
});


const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28, 32];
const DEFAULT_FONT_SIZE = 15;

const FONT_COLORS = [
  { label: 'Default',        color: null },
  // Vivid — readable on dark bg
  { label: 'Red',            color: '#e53e3e' },
  { label: 'Orange',         color: '#dd6b20' },
  { label: 'Yellow',         color: '#d69e2e' },
  { label: 'Green',          color: '#38a169' },
  { label: 'Teal',           color: '#00c882' },
  { label: 'Blue',           color: '#3182ce' },
  { label: 'Purple',         color: '#805ad5' },
  { label: 'Pink',           color: '#d53f8c' },
  { label: 'Gray',           color: '#718096' },
  { label: 'White',          color: '#f7fafc' },
  // Soft pastels — great on dark backgrounds
  { label: 'Soft Red',       color: '#fc8181' },
  { label: 'Soft Orange',    color: '#f6ad55' },
  { label: 'Soft Yellow',    color: '#f6e05e' },
  { label: 'Soft Green',     color: '#68d391' },
  { label: 'Soft Blue',      color: '#63b3ed' },
  { label: 'Soft Purple',    color: '#b794f4' },
  { label: 'Soft Pink',      color: '#f687b3' },
  { label: 'Slate',          color: '#a0aec0' },
  // Professional / editorial
  { label: 'Brown',          color: '#975a16' },
  { label: 'Crimson',        color: '#c53030' },
  { label: 'Navy',           color: '#2b6cb0' },
  // New dark-mode professional additions
  { label: 'Cyan',           color: '#00bcd4' },
  { label: 'Lime',           color: '#84cc16' },
  { label: 'Amber',          color: '#f59e0b' },
  { label: 'Indigo',         color: '#6366f1' },
  { label: 'Coral',          color: '#f87171' },
  { label: 'Mint',           color: '#34d399' },
  { label: 'Sky',            color: '#38bdf8' },
  { label: 'Violet',         color: '#a78bfa' },
  { label: 'Rose',           color: '#fb7185' },
  { label: 'Gold',           color: '#fbbf24' },
];

const HIGHLIGHT_COLORS = [
  { label: 'None',           color: null },
  // Existing
  { label: 'Yellow',         color: 'rgba(253,230,138,0.85)' },
  { label: 'Green',          color: 'rgba(187,247,208,0.85)' },
  { label: 'Blue',           color: 'rgba(191,219,254,0.85)' },
  { label: 'Pink',           color: 'rgba(251,207,232,0.85)' },
  { label: 'Purple',         color: 'rgba(221,214,254,0.85)' },
  { label: 'Orange',         color: 'rgba(254,215,170,0.85)' },
  { label: 'Red',            color: 'rgba(254,202,202,0.85)' },
  { label: 'Teal',           color: 'rgba(167,243,208,0.85)' },
  { label: 'Lemon',          color: 'rgba(254,249,195,0.85)' },
  { label: 'Lilac',          color: 'rgba(233,213,255,0.85)' },
  { label: 'Blush',          color: 'rgba(255,228,230,0.85)' },
  { label: 'Sky',            color: 'rgba(224,242,254,0.85)' },
  { label: 'Mint',           color: 'rgba(209,250,229,0.85)' },
  { label: 'Peach',          color: 'rgba(255,237,213,0.85)' },
  { label: 'Lavender',       color: 'rgba(237,233,254,0.85)' },
  { label: 'Cream',          color: 'rgba(254,252,191,0.85)' },
  { label: 'Powder',         color: 'rgba(190,227,248,0.85)' },
  // New dark-mode-friendly semi-opaque highlights
  { label: 'Dark Teal',      color: 'rgba(0,200,130,0.25)' },
  { label: 'Dark Blue',      color: 'rgba(59,130,246,0.30)' },
  { label: 'Dark Purple',    color: 'rgba(139,92,246,0.30)' },
  { label: 'Dark Red',       color: 'rgba(239,68,68,0.28)' },
  { label: 'Dark Orange',    color: 'rgba(249,115,22,0.28)' },
  { label: 'Dark Yellow',    color: 'rgba(234,179,8,0.30)' },
  { label: 'Dark Green',     color: 'rgba(34,197,94,0.25)' },
  { label: 'Dark Pink',      color: 'rgba(236,72,153,0.25)' },
];

const TABLE_THEMES = [
  { id: '',           label: 'Default',     preview: ['#363636', '#1e1e1e'] },
  // ── Dark-native themes (look great on dark backgrounds) ──
  { id: 'carbon',     label: 'Carbon',      preview: ['#374151', '#1f2937'] },
  { id: 'ocean',      label: 'Ocean',       preview: ['#1e3a5f', '#162032'] },
  { id: 'forest',     label: 'Forest',      preview: ['#1a3a2a', '#122518'] },
  { id: 'midnight',   label: 'Midnight',    preview: ['#2d2058', '#1a1035'] },
  { id: 'ember',      label: 'Ember',       preview: ['#7c2d12', '#3b0d06'] },
  { id: 'steel',      label: 'Steel',       preview: ['#1e3a4c', '#0f2030'] },
  // ── Light themes (work on light backgrounds) ──
  { id: 'sky',        label: 'Sky',         preview: ['#bfdbfe', '#eff6ff'] },
  { id: 'mint',       label: 'Mint',        preview: ['#bbf7d0', '#f0fdf4'] },
  { id: 'peach',      label: 'Peach',       preview: ['#fed7aa', '#fff7ed'] },
  { id: 'lavender',   label: 'Lavender',    preview: ['#ddd6fe', '#f5f3ff'] },
  { id: 'rose',       label: 'Rose',        preview: ['#fecdd3', '#fff1f2'] },
  { id: 'lemon',      label: 'Lemon',       preview: ['#fef08a', '#fefce8'] },
  { id: 'slate',      label: 'Slate',       preview: ['#cbd5e1', '#f8fafc'] },
  { id: 'lilac',      label: 'Lilac',       preview: ['#e9d8fd', '#faf5ff'] },
  { id: 'blush',      label: 'Blush',       preview: ['#fde8e8', '#fff5f5'] },
  { id: 'sage',       label: 'Sage',        preview: ['#c6f6d5', '#f0fff4'] },
  { id: 'cream',      label: 'Cream',       preview: ['#fefcbf', '#fffff0'] },
  { id: 'powder',     label: 'Powder',      preview: ['#bee3f8', '#ebf8ff'] },
  { id: 'sand',       label: 'Sand',        preview: ['#fde8c8', '#fffaf0'] },
  { id: 'mist',       label: 'Mist',        preview: ['#e2e8f0', '#f7fafc'] },
  { id: 'coral',      label: 'Coral',       preview: ['#feb2b2', '#fff5f5'] },
];

// ─── Inner editor ─────────────────────────────────────────────────────────────

interface InnerProps {
  initialContent: string;
  editorRef: React.MutableRefObject<Editor | null>;
  onMarkdownChange: (md: string) => void;
  onReady: () => void;
}

const InnerMilkdown: React.FC<InnerProps> = ({ initialContent, editorRef, onMarkdownChange, onReady }) => {
  const onChangeRef = useRef(onMarkdownChange);
  onChangeRef.current = onMarkdownChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const { loading, get } = useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialContent || '');

        // Prevent remark-stringify from escaping [ and ] so that [[wikilinks]]
        // are saved to disk as-is rather than as \[\[...\]\].
        // We patch the text node handler to temporarily remove [ ] from the
        // mdast-util-to-markdown unsafe list during serialization.
        ctx.update(remarkStringifyOptionsCtx, () => ({
          handlers: {
            text(node: any, _: any, state: any, info: any) {
              const orig = state.unsafe;
              state.unsafe = orig.filter((u: any) => u.character !== '[' && u.character !== ']');
              const result = state.safe(node.value, info);
              state.unsafe = orig;
              return result;
            },
          },
        }));

        ctx.get(listenerCtx).markdownUpdated((_ctx, md) => onChangeRef.current(md));
        // Fire a custom event on every selection change so the React UI can
        // reliably detect cursor placement (native 'selectionchange' doesn't
        // fire on single-click cursor placement inside ProseMirror).
        ctx.get(listenerCtx).selectionUpdated(() => {
          window.dispatchEvent(new CustomEvent('jn-selection-updated'));
        });
        ctx.update(uploadConfig.key, (prev) => ({
          ...prev,
          enableHtmlFileUploader: true,
          uploader: async (files: FileList, schema: any) => {
            const nodes: any[] = [];
            for (const file of Array.from(files)) {
              if (!file.type.startsWith('image/')) continue;
              try {
                const url = await uploadImageToServer(file);
                const node = schema.nodes.image?.createAndFill({ src: url, alt: file.name, title: '' });
                if (node) nodes.push(node);
              } catch (err) { console.error('[upload]', err); }
            }
            return nodes;
          },
        }));
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .use(upload)
      .use(trailing)
      .use(columnResizingPlugin)
      .use(jnHtmlMarksRemarkPlugin)
      .use(fontColorMark)
      .use(highlightMark)
      .use(underlineMark)
      .use(alignPlugin)
      .use(tableThemePlugin)
      .use(resizableImageView)
      .use(listTabPlugin)
      .use(tagDecoratorPlugin)
      .use(wikilinkPlugin)
      .use(hashtagPlugin)
      .use(checkboxClickPlugin)
      .use(spellcheckPlugin)
      .use(findPlugin),
    []
  );

  useEffect(() => {
    if (!loading) {
      const inst = get();
      if (inst) { editorRef.current = inst; onReadyRef.current(); }
    }
  }, [loading, get, editorRef]);

  return <Milkdown />;
};

// ─── Table-theme markdown helpers ────────────────────────────────────────────
//
// Themes are stored as HTML comments immediately before their table in the
// markdown file:  <!-- jn-theme:ocean -->
// This way the theme travels with the file and works cross-browser / cross-device.

/**
 * Extract <!-- jn-theme:X --> comments from raw markdown.
 * Returns the cleaned markdown (comments removed) and the extracted theme
 * entries ready for restoreTableThemes().
 *
 * Algorithm: scan lines top-to-bottom. When we hit a jn-theme comment,
 * remember its theme. When we hit the start of a GFM table (line starting
 * with `|`), assign the remembered theme to that table's index (0-based count
 * of tables seen so far) and clear the pending theme.
 */
function extractTableThemeComments(
  md: string,
): { clean: string; themes: Array<{ index: number; theme: string }> } {
  const themes: Array<{ index: number; theme: string }> = [];
  let tableIndex = 0;
  let pendingTheme: string | null = null;

  const lines = md.split('\n');
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const themeMatch = line.match(/^<!--\s*jn-theme:([a-z0-9_-]*)\s*-->$/);
    if (themeMatch) {
      pendingTheme = themeMatch[1] || null;
      // Drop this line (don't push to kept)
      continue;
    }
    // Detect start of a GFM table: a line that starts with |
    if (line.trimStart().startsWith('|')) {
      if (pendingTheme) {
        themes.push({ index: tableIndex, theme: pendingTheme });
        pendingTheme = null;
      }
      // Count each table only once: skip until we leave the table block
      kept.push(line);
      i++;
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        kept.push(lines[i]);
        i++;
      }
      tableIndex++;
      // Re-process the line that ended the table block
      i--;
      continue;
    }
    // Non-table, non-comment line: clear pending theme if it wasn't consumed
    if (pendingTheme && line.trim() !== '') pendingTheme = null;
    kept.push(line);
  }

  return { clean: kept.join('\n'), themes };
}

/**
 * Inject <!-- jn-theme:X --> comments before each table in the serialized
 * markdown, based on the current ProseMirror plugin state.
 * Existing jn-theme comments are first stripped, then fresh ones injected.
 */
function injectTableThemeComments(
  md: string,
  pmState: any,
): string {
  // Build theme map: tableIndex → themeId using the imported serializeTableThemes
  const themeMap = new Map<number, string>();
  const entries: Array<{ index: number; theme: string }> = serializeTableThemes(pmState);
  for (const { index, theme } of entries) {
    if (theme) themeMap.set(index, theme);
  }

  // Strip any existing jn-theme comments first
  const stripped = md.replace(/^<!--\s*jn-theme:[a-z0-9_-]*\s*-->\n/gm, '');

  if (themeMap.size === 0) return stripped;

  // Re-inject fresh comments before each themed table
  let tableIndex = 0;
  const resultLines: string[] = [];
  const lines = stripped.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('|')) {
      // Start of a GFM table — inject comment if this table has a theme
      const theme = themeMap.get(tableIndex);
      if (theme) resultLines.push(`<!-- jn-theme:${theme} -->`);
      // Consume all table rows
      resultLines.push(line);
      i++;
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        resultLines.push(lines[i]);
        i++;
      }
      tableIndex++;
      i--;
      continue;
    }
    resultLines.push(line);
  }

  return resultLines.join('\n');
}

// ─── Toolbar button ───────────────────────────────────────────────────────────

const ToolBtn: React.FC<{
  title: string; onClick: () => void; children: React.ReactNode;
  style?: React.CSSProperties; danger?: boolean;
}> = ({ title, onClick, children, style, danger }) => (
  <button
    className={`format-toolbar-btn${danger ? ' danger' : ''}`}
    title={title} onClick={onClick} style={style}
  >
    {children}
  </button>
);

// ─── EditorInner ─────────────────────────────────────────────────────────────

const EditorInner: React.FC<MilkdownEditorProps> = ({
  filePath, isBookmarked, onToggleBookmark, onOpenFile, templates = [],
}) => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [isTemplateMenuOpen, setIsTemplateMenuOpen] = useState(false);
  const [showTableTools, setShowTableTools] = useState(false);
  const [tableTheme, setTableTheme] = useState<string>('');
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number } | null>(null);
  // Color picker dropdowns use position:fixed with coords to escape the
  // overflow-x-auto toolbar scroll container.
  const [colorPickerPos, setColorPickerPos] = useState<{ top: number; left: number } | null>(null);
  const [highlightPickerPos, setHighlightPickerPos] = useState<{ top: number; left: number } | null>(null);
  const [suggestions, setSuggestions] = useState<WikilinkSuggestion>({
    active: false, query: '', from: 0, to: 0, suggestions: [], selectedIndex: 0, coords: null,
  });
  const [hashtagSuggestions, setHashtagSuggestions] = useState<HashtagSuggestion>({
    active: false, query: '', from: 0, to: 0, suggestions: [], selectedIndex: 0, coords: null,
  });

  // ── Spell / grammar suggestion popup ─────────────────────────────────────
  interface SpellPopupState {
    x: number;
    y: number;
    word: string;
    type: 'spell' | 'grammar';
    message?: string;      // grammar rule description
    suggestions: string[];
    // The ProseMirror position range of the decorated word, so we can replace it
    from: number;
    to: number;
  }
  const [spellPopup, setSpellPopup] = useState<SpellPopupState | null>(null);
  const spellPopupRef = useRef<HTMLDivElement | null>(null);

  // ── Find & Replace ────────────────────────────────────────────────────────
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [findMatchCase, setFindMatchCase] = useState(false);
  const [findCurrentIdx, setFindCurrentIdx] = useState(0);
  const [findMatches, setFindMatches] = useState<Array<{ from: number; to: number }>>([]);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const findPanelRef = useRef<HTMLDivElement | null>(null);
  // Decoration plugin key for find highlights (managed separately from spellcheck)
  const findDecoStateRef = useRef<{ query: string; matchCase: boolean; matches: Array<{from:number;to:number}>; currentIdx: number }>({ query: '', matchCase: false, matches: [], currentIdx: 0 });

  const editorRef = useRef<Editor | null>(null);
  const templateMenuRef = useRef<HTMLDivElement | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const colorPickerRef = useRef<HTMLDivElement | null>(null);
  const highlightPickerRef = useRef<HTMLDivElement | null>(null);
  const colorBtnRef = useRef<HTMLButtonElement | null>(null);
  const highlightBtnRef = useRef<HTMLButtonElement | null>(null);
  const themePickerRef = useRef<HTMLDivElement | null>(null);
  const themeBtnRef = useRef<HTMLButtonElement | null>(null);
  // Cache the last selection range so color/highlight can be applied even after
  // the picker opens (which may move focus away from the editor).
  // We store the full Selection object so CellSelection (multi-cell table) is preserved.
  const savedSelectionRef = useRef<any | null>(null);
  const saveTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const currentFileRef = useRef(filePath);
  currentFileRef.current = filePath;
  const sugRef = useRef(suggestions);
  sugRef.current = suggestions;
  const hashtagSugRef = useRef(hashtagSuggestions);
  hashtagSugRef.current = hashtagSuggestions;
  // ── Contextual formatting menu + F4 repeat-last-action state ────────────
  // Hoisted up here so the close-ctx-menu useEffect (declared later near the
  // other outside-click effects) can depend on `ctxMenu` without a
  // "used-before-declaration" error.
  //
  // Last-used font color and highlight color are remembered so the main
  // split-button can apply them in one click; the chevron beside each split
  // opens the palette for picking a different color.
  //
  // F4 repeats the most recent formatting action on the current selection.
  // Only formatting-type actions are recorded.

  type RepeatableAction =
    | { type: 'bold' | 'italic' | 'underline' | 'strike' | 'inlineCode' }
    | { type: 'align'; align: AlignValue }
    | { type: 'indent' | 'outdent' }
    | { type: 'fontColor'; color: string | null }
    | { type: 'highlight'; color: string | null };

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [ctxColorPos, setCtxColorPos] = useState<{ top: number; left: number } | null>(null);
  const [ctxHighlightPos, setCtxHighlightPos] = useState<{ top: number; left: number } | null>(null);

  // Last-used colors — default to the first actual color in each palette
  const firstFontColor = FONT_COLORS.find(c => c.color)?.color ?? '#e53e3e';
  const firstHighlight = HIGHLIGHT_COLORS.find(c => c.color)?.color ?? 'rgba(253,230,138,0.85)';
  const lastFontColorRef = useRef<string>(
    (typeof localStorage !== 'undefined' && localStorage.getItem('jn-last-font-color')) || firstFontColor
  );
  const lastHighlightRef = useRef<string>(
    (typeof localStorage !== 'undefined' && localStorage.getItem('jn-last-highlight')) || firstHighlight
  );
  // Tiny state bump so the color-bar under the split buttons re-renders
  // when the last-used color changes.
  const [, bumpColorBars] = useState(0);
  const rememberFontColor = (c: string | null) => {
    if (c) {
      lastFontColorRef.current = c;
      try { localStorage.setItem('jn-last-font-color', c); } catch (_) { /* quota */ }
      bumpColorBars(n => n + 1);
    }
  };
  const rememberHighlight = (c: string | null) => {
    if (c) {
      lastHighlightRef.current = c;
      try { localStorage.setItem('jn-last-highlight', c); } catch (_) { /* quota */ }
      bumpColorBars(n => n + 1);
    }
  };

  const lastActionRef = useRef<RepeatableAction | null>(null);
  const recordAction = useCallback((action: RepeatableAction) => {
    lastActionRef.current = action;
  }, []);

  // Persist table themes to localStorage keyed by filePath. Populated by the
  // editor-ready effect; called by cmdTableTheme after every theme change.
  const persistThemesRef = useRef<(() => void) | null>(null);
  // Same pattern for per-block alignment.
  const persistAlignRef = useRef<(() => void) | null>(null);
  // Column-width persistence (MutationObserver + localStorage sidecar).
  const colWidthObserverRef = useRef<MutationObserver | null>(null);

  // Invoked once per editor mount (per file load). Restores persisted table
  // themes and alignments from localStorage and installs persistence functions.
  const handleEditorReady = useCallback(() => {
    const inst = editorRef.current;
    const path = currentFileRef.current;
    if (!inst || !path) return;

    let view: any;
    try { view = inst.action((ctx: any) => ctx.get(editorViewCtx)); }
    catch { return; }
    if (!view) return;

    // Restore themes from markdown comments (extracted at load time)
    // Fall back to localStorage for files saved before this change.
    try {
      let entries = pendingThemesRef.current;
      if (entries.length === 0) {
        // Legacy fallback: check localStorage
        const raw = localStorage.getItem(`jn-themes:${path}`);
        if (raw) entries = JSON.parse(raw) as Array<{ index: number; theme: string }>;
      }
      if (Array.isArray(entries) && entries.length > 0) {
        restoreTableThemes(view, entries);
      }
      pendingThemesRef.current = [];
    } catch (_) { /* ignore corrupt entries */ }

    // Restore alignments
    try {
      const raw = localStorage.getItem(`jn-align:${path}`);
      if (raw) {
        const entries = JSON.parse(raw) as Array<{ index: number; align: AlignValue }>;
        if (Array.isArray(entries) && entries.length > 0) {
          restoreAlignments(view, entries);
        }
      }
    } catch (_) { /* ignore corrupt entries */ }

    // Theme persistence is now handled by embedding <!-- jn-theme:X --> comments
    // in the markdown file (see handleMarkdownChange / injectTableThemeComments).
    // Keep a no-op ref so cmdTableTheme callers don't crash.
    persistThemesRef.current = () => { /* themes saved via markdown comments */ };
    persistAlignRef.current = () => {
      const currentPath = currentFileRef.current;
      if (!currentPath) return;
      try {
        const entries = serializeAlignments(view.state);
        if (entries.length === 0) {
          localStorage.removeItem(`jn-align:${currentPath}`);
        } else {
          localStorage.setItem(`jn-align:${currentPath}`, JSON.stringify(entries));
        }
      } catch (_) { /* non-fatal */ }
    };

    // ── Column-width restore ─────────────────────────────────────────────
    // Milkdown's columnResizingPlugin stores widths in <col style="width:Xpx">
    // elements. We save them as a sidecar in localStorage and restore via DOM
    // after the editor mounts, since GFM markdown has no column-width syntax.
    try {
      const savedWidths = localStorage.getItem(`jn-colwidths:${path}`);
      if (savedWidths) {
        const tableWidths = JSON.parse(savedWidths) as Array<Array<number | null>>;
        const applyWidths = () => {
          try {
            const editorDom = inst.action((ctx: any) => ctx.get(editorViewCtx))?.dom as HTMLElement | undefined;
            if (!editorDom) return;
            const tables = editorDom.querySelectorAll('table');
            tableWidths.forEach((widths, tIdx) => {
              const table = tables[tIdx];
              if (!table) return;
              const cols = table.querySelectorAll('colgroup col');
              widths.forEach((w, cIdx) => {
                const col = cols[cIdx] as HTMLElement | undefined;
                if (col && w != null) col.style.width = `${w}px`;
              });
            });
          } catch (_) { /* ignore */ }
        };
        // Double-rAF: first rAF waits for ProseMirror to finish its initial
        // render; second rAF waits for columnResizingPlugin to also finish.
        // Multiple timeouts ensure widths survive the plugin's own initialization.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          applyWidths();
          setTimeout(applyWidths, 100);
          setTimeout(applyWidths, 300);
          setTimeout(applyWidths, 600);
        }));
      }
    } catch (_) { /* ignore corrupt data */ }

    // ── Column-width observer ────────────────────────────────────────────
    // Save column widths after the user finishes dragging a resize handle.
    // We use mouseup on the document (the resize handle is inside the editor
    // but the drag ends on document) rather than a MutationObserver, because
    // a subtree style-observer fires on every spell-check decoration and
    // causes excessive calls / potential crashes.
    if (colWidthObserverRef.current) {
      // Reuse the ref to store a cleanup fn via a small wrapper object trick —
      // store the removeEventListener as a no-op observer disconnect substitute.
      (colWidthObserverRef.current as any).disconnect?.();
    }
    let colWidthTimer: ReturnType<typeof setTimeout> | null = null;
    const saveColWidths = () => {
      const currentPath = currentFileRef.current;
      if (!currentPath) return;
      try {
        const editorDom = inst.action((ctx: any) => ctx.get(editorViewCtx))?.dom as HTMLElement | undefined;
        if (!editorDom) return;
        const tables = editorDom.querySelectorAll('table');
        if (tables.length === 0) return;
        const tableWidths: Array<Array<number | null>> = [];
        tables.forEach(table => {
          const cols = table.querySelectorAll('colgroup col');
          const widths: Array<number | null> = [];
          cols.forEach((col: Element) => {
            const w = (col as HTMLElement).style.width;
            widths.push(w ? parseFloat(w) : null);
          });
          tableWidths.push(widths);
        });
        const allNull = tableWidths.every(t => t.every(w => w == null));
        if (allNull) {
          localStorage.removeItem(`jn-colwidths:${currentPath}`);
        } else {
          localStorage.setItem(`jn-colwidths:${currentPath}`, JSON.stringify(tableWidths));
        }
      } catch (_) { /* quota — non-fatal */ }
    };
    const onMouseUp = () => {
      if (colWidthTimer) clearTimeout(colWidthTimer);
      colWidthTimer = setTimeout(saveColWidths, 300);
    };
    document.addEventListener('mouseup', onMouseUp);
    // Store cleanup in the ref using a fake observer shape
    colWidthObserverRef.current = { disconnect: () => document.removeEventListener('mouseup', onMouseUp) } as any;
  }, []);

  // Register onOpenFile callback in the ProseMirror plugin so dblclick works
  useEffect(() => {
    if (onOpenFile) setOpenFileCallback(onOpenFile);
    return () => setOpenFileCallback(() => {});
  }, [onOpenFile]);

  // Disconnect column-width MutationObserver on unmount
  useEffect(() => {
    return () => { colWidthObserverRef.current?.disconnect(); };
  }, []);

  // Font size
  useEffect(() => {
    document.documentElement.style.setProperty('--editor-font-size', `${fontSize}px`);
  }, [fontSize]);

  // Ctrl +/- /0
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); setFontSize(p => Math.min(p + 1, 40)); }
      else if (e.key === '-') { e.preventDefault(); setFontSize(p => Math.max(p - 1, 8)); }
      else if (e.key === '0') { e.preventDefault(); setFontSize(DEFAULT_FONT_SIZE); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // File list for wikilink autocomplete — refreshed on mount and whenever files change
  const refreshFileList = useCallback(() => {
    apiFetch('/api/files').then(r => r.json()).then(data => {
      const flat: string[] = [];
      const walk = (nodes: any[]) => {
        for (const n of nodes) {
          if (n.type === 'file') flat.push(n.name.replace(/\.md$/, ''));
          if (n.children) walk(n.children);
        }
      };
      walk(data);
      setWikilinkFileList(flat);
    }).catch(() => {});
  }, []);

  // Hashtag list for hashtag autocomplete — refreshed on mount and whenever files change
  const refreshHashtagList = useCallback(() => {
    apiFetch('/api/tags').then(r => r.json()).then((data: { tag: string }[]) => {
      setHashtagList(data.map((t: { tag: string }) => t.tag.replace(/^#/, '')));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    refreshFileList();
    window.addEventListener('file-saved', refreshFileList);
    return () => window.removeEventListener('file-saved', refreshFileList);
  }, [refreshFileList]);

  useEffect(() => {
    refreshHashtagList();
    window.addEventListener('file-saved', refreshHashtagList);
    return () => window.removeEventListener('file-saved', refreshHashtagList);
  }, [refreshHashtagList]);

  // Wikilink suggestions
  useEffect(() => {
    subscribeToWikilinkSuggestions(s => setSuggestions({ ...s }));
    return () => unsubscribeWikilinkSuggestions();
  }, []);

  // Hashtag suggestions
  useEffect(() => {
    subscribeToHashtagSuggestions(s => setHashtagSuggestions({ ...s }));
    return () => unsubscribeHashtagSuggestions();
  }, []);

  // Keyboard nav for wikilink dropdown
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const s = sugRef.current;
      if (!s.active) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestions(p => ({ ...p, selectedIndex: Math.min(p.selectedIndex + 1, p.suggestions.length - 1) })); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestions(p => ({ ...p, selectedIndex: Math.max(p.selectedIndex - 1, 0) })); }
      else if ((e.key === 'Enter' || e.key === 'Tab') && s.suggestions[s.selectedIndex]) { e.preventDefault(); insertWikilink(s.suggestions[s.selectedIndex]); }
      else if (e.key === 'Escape') setSuggestions(p => ({ ...p, active: false }));
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  // Keyboard nav for hashtag dropdown
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const s = hashtagSugRef.current;
      if (!s.active) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setHashtagSuggestions(p => ({ ...p, selectedIndex: Math.min(p.selectedIndex + 1, p.suggestions.length - 1) })); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHashtagSuggestions(p => ({ ...p, selectedIndex: Math.max(p.selectedIndex - 1, 0) })); }
      else if ((e.key === 'Enter' || e.key === 'Tab') && s.suggestions[s.selectedIndex]) { e.preventDefault(); insertHashtag(s.suggestions[s.selectedIndex]); }
      else if (e.key === 'Escape') setHashtagSuggestions(p => ({ ...p, active: false }));
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  const insertWikilink = useCallback((filename: string) => {
    const inst = editorRef.current;
    if (!inst) return;
    const s = sugRef.current;
    try {
      const view = inst.action((ctx: any) => ctx.get(editorViewCtx));
      if (!view) return;
      view.dispatch(view.state.tr.replaceWith(s.from, s.to, view.state.schema.text(`[[${filename}]]`)));
      setSuggestions({ active: false, query: '', from: 0, to: 0, suggestions: [], selectedIndex: 0, coords: null });
      view.focus();
    } catch (err) { console.error('[insertWikilink]', err); }
  }, []);

  const insertHashtag = useCallback((tag: string) => {
    const inst = editorRef.current;
    if (!inst) return;
    const s = hashtagSugRef.current;
    try {
      const view = inst.action((ctx: any) => ctx.get(editorViewCtx));
      if (!view) return;
      // Replace from the `#` position up to current cursor with `#tag `
      view.dispatch(view.state.tr.replaceWith(s.from, s.to, view.state.schema.text(`#${tag} `)));
      setHashtagSuggestions({ active: false, query: '', from: 0, to: 0, suggestions: [], selectedIndex: 0, coords: null });
      view.focus();
    } catch (err) { console.error('[insertHashtag]', err); }
  }, []);

  // Themes extracted from markdown comments during load — restored after editor mounts
  const pendingThemesRef = useRef<Array<{ index: number; theme: string }>>([]);

  // Load file — strips <!-- jn-theme:X --> comments from content (editor never
  // sees them) and stores the extracted themes to restore after mount.
  useEffect(() => {
    if (!filePath) { setContent(''); return; }
    editorRef.current = null;
    setLoading(true);
    apiFetch(`/api/file?path=${encodeURIComponent(filePath)}`)
      .then(r => r.ok ? r.text() : Promise.reject(new Error('Load failed')))
      .then(text => {
        const { clean, themes } = extractTableThemeComments(text);
        pendingThemesRef.current = themes;
        setContent(clean);
        setEditorKey(k => k + 1);
      })
      .catch(() => { setContent('# Error loading file'); setEditorKey(k => k + 1); })
      .finally(() => setLoading(false));
  }, [filePath]);

  // Save — injects <!-- jn-theme:X --> comments into the markdown before each
  // themed table so the theme travels with the file and works cross-browser.
  const handleMarkdownChange = useCallback((md: string) => {
    const path = currentFileRef.current;
    if (!path) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      // Embed table themes as HTML comments in the markdown
      const view = editorRef.current
        ? (() => { try { return editorRef.current!.action((ctx: any) => ctx.get(editorViewCtx)); } catch { return null; } })()
        : null;
      const mdWithThemes = view ? injectTableThemeComments(md, view.state) : md;

      apiFetch('/api/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: mdWithThemes }),
      }).then(() => window.dispatchEvent(new CustomEvent('file-saved')))
        .catch(err => console.error('[save]', err));
    }, 600);
  }, []);

  // Get ProseMirror view
  const getView = useCallback(() => {
    const inst = editorRef.current;
    if (!inst) return null;
    try { return inst.action((ctx: any) => ctx.get(editorViewCtx)); } catch { return null; }
  }, []);

  // ── Delete the entire table containing the cursor ─────────────────────────
  const cmdDeleteTable = useCallback(() => {
    const view = getView();
    if (!view) return;
    const { state, dispatch } = view;
    const { $from } = state.selection;
    for (let d = $from.depth; d >= 0; d--) {
      if ($from.node(d).type.name === 'table') {
        const tableStart = $from.before(d);
        const tableEnd = tableStart + $from.node(d).nodeSize;
        dispatch(state.tr.delete(tableStart, tableEnd).scrollIntoView());
        return;
      }
    }
  }, [getView]);

  // ── Find & Replace engine ─────────────────────────────────────────────────
  // Finds matches in visible text only (doc.textBetween with block separator)
  // so markdown syntax tokens are never matched or replaced.
  const runFind = useCallback((query: string, matchCase: boolean, doc?: any): Array<{ from: number; to: number }> => {
    const view = getView();
    if (!view && !doc) return [];
    const pmDoc = doc ?? view!.state.doc;
    if (!query) return [];
    const matches: Array<{ from: number; to: number }> = [];
    const flags = matchCase ? 'g' : 'gi';
    let re: RegExp;
    try { re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); }
    catch { return []; }

    pmDoc.descendants((node: any, pos: number, parent: any) => {
      // Skip code blocks and HTML nodes — only search visible prose text
      const typeName = node.type?.name ?? '';
      const parentType = parent?.type?.name ?? '';
      if (['code_block','fence','html_block','html_inline'].includes(typeName)) return false;
      if (['code_block','fence','html_block','html_inline'].includes(parentType)) return false;
      if (!node.isText) return true;
      const text = node.text ?? '';
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        matches.push({ from: pos + m.index, to: pos + m.index + m[0].length });
      }
      return false;
    });
    return matches;
  }, [getView]);

  // Apply find highlight decorations via a DOM overlay approach
  // (We track matches in state and render highlighted spans in the ProseMirror
  //  view using the existing decoration infrastructure)
  const applyFindDecorations = useCallback((query: string, matchCase: boolean, idx: number) => {
    const view = getView();
    if (!view) return;
    const matches = runFind(query, matchCase, view.state.doc);
    setFindMatches(matches);
    setFindCurrentIdx(Math.min(idx, Math.max(0, matches.length - 1)));
    findDecoStateRef.current = { query, matchCase, matches, currentIdx: Math.min(idx, Math.max(0, matches.length - 1)) };
    // Scroll current match into view
    if (matches.length > 0) {
      const cur = matches[Math.min(idx, matches.length - 1)];
      try {
        const coords = view.coordsAtPos(cur.from);
        const container = editorContainerRef.current;
        if (container && coords) {
          const rect = container.getBoundingClientRect();
          const relTop = coords.top - rect.top + container.scrollTop - 100;
          container.scrollTo({ top: Math.max(0, relTop), behavior: 'smooth' });
        }
      } catch { /* ignore */ }
    }
    // Dispatch a no-op transaction to trigger re-render with new decorations
    view.dispatch(view.state.tr.setMeta('jn-find-update', { query, matchCase, matches, currentIdx: Math.min(idx, Math.max(0, matches.length - 1)) }));
  }, [getView, runFind]);

  const findNext = useCallback(() => {
    const { query, matchCase, matches } = findDecoStateRef.current;
    if (!matches.length) return;
    const next = (findDecoStateRef.current.currentIdx + 1) % matches.length;
    applyFindDecorations(query, matchCase, next);
  }, [applyFindDecorations]);

  const findPrev = useCallback(() => {
    const { query, matchCase, matches } = findDecoStateRef.current;
    if (!matches.length) return;
    const prev = (findDecoStateRef.current.currentIdx - 1 + matches.length) % matches.length;
    applyFindDecorations(query, matchCase, prev);
  }, [applyFindDecorations]);

  const doReplace = useCallback((replaceWith: string) => {
    const view = getView();
    if (!view) return;
    const { matches, currentIdx } = findDecoStateRef.current;
    if (!matches.length) return;
    const m = matches[currentIdx];
    const tr = view.state.tr.replaceWith(m.from, m.to, view.state.schema.text(replaceWith));
    view.dispatch(tr);
    // Re-run find after replacement
    const { query, matchCase } = findDecoStateRef.current;
    setTimeout(() => applyFindDecorations(query, matchCase, Math.min(currentIdx, matches.length - 2)), 50);
  }, [getView, applyFindDecorations]);

  const doReplaceAll = useCallback((replaceWith: string) => {
    const view = getView();
    if (!view) return;
    const { query, matchCase } = findDecoStateRef.current;
    const matches = runFind(query, matchCase, view.state.doc);
    if (!matches.length) return;
    // Apply replacements back-to-front so positions stay valid
    let tr = view.state.tr;
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      if (replaceWith) {
        tr = tr.replaceWith(m.from, m.to, view.state.schema.text(replaceWith));
      } else {
        tr = tr.delete(m.from, m.to);
      }
    }
    view.dispatch(tr);
    setFindMatches([]);
    setFindCurrentIdx(0);
    findDecoStateRef.current = { ...findDecoStateRef.current, matches: [], currentIdx: 0 };
  }, [getView, runFind]);

  // Close find panel and clear decorations
  const closeFindReplace = useCallback(() => {
    setShowFindReplace(false);
    setFindQuery('');
    setReplaceQuery('');
    setFindMatches([]);
    setFindCurrentIdx(0);
    findDecoStateRef.current = { query: '', matchCase: false, matches: [], currentIdx: 0 };
    const view = getView();
    if (view) view.dispatch(view.state.tr.setMeta('jn-find-update', { query: '', matchCase: false, matches: [], currentIdx: 0 }));
    view?.focus();
  }, [getView]);

  // Ctrl+F / Ctrl+H keyboard shortcut
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setShowFindReplace(true);
        setReplaceQuery('');
        setTimeout(() => findInputRef.current?.focus(), 50);
      }
      if (e.ctrlKey && (e.key === 'h' || e.key === 'H')) {
        e.preventDefault();
        setShowFindReplace(true);
        setTimeout(() => findInputRef.current?.focus(), 50);
      }
      if (e.key === 'Escape' && showFindReplace) {
        closeFindReplace();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [showFindReplace, closeFindReplace]);

  // Track cursor line/col — must be after getView is defined
  useEffect(() => {
    const updateCursor = () => {
      try {
        const view = getView();
        if (!view) { setCursorPos(null); return; }
        const { from } = view.state.selection;
        const textBefore = view.state.doc.textBetween(0, from, '\n', '\0');
        const lines = textBefore.split('\n');
        const line = lines.length;
        const col = (lines[lines.length - 1]?.length ?? 0) + 1;
        setCursorPos({ line, col });
      } catch { setCursorPos(null); }
    };
    window.addEventListener('jn-selection-updated', updateCursor);
    return () => window.removeEventListener('jn-selection-updated', updateCursor);
  }, [getView]);

  // Auto-show/hide table toolbar when cursor moves into/out of a table.
  // Also sync the active theme indicator when moving between tables.
  //
  // Triggers the check on:
  //   - jn-selection-updated  (every ProseMirror transaction, including keyboard nav)
  //   - selectionchange       (DOM-level changes)
  //   - mouseup on the editor (catches single click cursor placement immediately)
  //
  // Reading theme from plugin state (not the DOM) means we always get the
  // source of truth — DOM attrs can be stripped/re-rendered by ProseMirror.
  useEffect(() => {
    const check = () => {
      const view = getView();
      if (!view) return;
      const inTable = isInTable(view.state);
      setShowTableTools(prev => prev !== inTable ? inTable : prev);

      if (inTable) {
        // Theme lives in plugin state (authoritative)
        const theme = getCurrentTableTheme(view.state);
        setTableTheme(prev => (prev !== theme ? theme : prev));

        // Also cache the DOM wrapper for any features that still need it
        const { $from } = view.state.selection;
        try {
          const domInfo = view.domAtPos($from.pos);
          const cursorNode = domInfo.node instanceof Element
            ? domInfo.node
            : domInfo.node.parentElement;
          activeTableWrapperRef.current =
            (cursorNode?.closest?.('.tableWrapper') as HTMLElement | null) ?? null;
        } catch (_) {
          activeTableWrapperRef.current = null;
        }
      } else {
        activeTableWrapperRef.current = null;
      }
    };

    // Listen to three complementary events so the table toolbar appears
    // instantly on any kind of cursor placement into a table cell.
    const onMouseUp = () => requestAnimationFrame(check);
    window.addEventListener('jn-selection-updated', check);
    document.addEventListener('selectionchange', check);
    // mouseup on the editor container catches the exact moment a single click
    // places the cursor inside a table cell (before blur/focus side-effects).
    const container = editorContainerRef.current;
    container?.addEventListener('mouseup', onMouseUp);

    return () => {
      window.removeEventListener('jn-selection-updated', check);
      document.removeEventListener('selectionchange', check);
      container?.removeEventListener('mouseup', onMouseUp);
    };
  }, [getView]);

  // Close template menu when clicking outside it
  useEffect(() => {
    if (!isTemplateMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (templateMenuRef.current && !templateMenuRef.current.contains(e.target as Node)) {
        setIsTemplateMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isTemplateMenuOpen]);

  // Close color pickers when clicking outside
  useEffect(() => {
    if (!colorPickerPos && !highlightPickerPos) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (colorPickerPos) {
        const inBtn = colorBtnRef.current?.contains(target);
        const inPicker = colorPickerRef.current?.contains(target);
        if (!inBtn && !inPicker) setColorPickerPos(null);
      }
      if (highlightPickerPos) {
        const inBtn = highlightBtnRef.current?.contains(target);
        const inPicker = highlightPickerRef.current?.contains(target);
        if (!inBtn && !inPicker) setHighlightPickerPos(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [colorPickerPos, highlightPickerPos]);

  // Close theme picker when clicking outside
  useEffect(() => {
    if (!showThemePicker) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (themePickerRef.current?.contains(t)) return;
      if (themeBtnRef.current?.contains(t)) return;
      setShowThemePicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showThemePicker]);

  // Close the right-click ctx menu on: outside click, scroll, Escape, resize.
  // The ctx menu's own button mousedowns call e.preventDefault() + stopPropagation
  // so they don't dismiss the menu before the action runs.
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  const ctxColorPaletteRef = useRef<HTMLDivElement | null>(null);
  const ctxHighlightPaletteRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => { setCtxMenu(null); setCtxColorPos(null); setCtxHighlightPos(null); };
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ctxMenuRef.current?.contains(t)) return;
      if (ctxColorPaletteRef.current?.contains(t)) return;
      if (ctxHighlightPaletteRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const container = editorContainerRef.current;
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    container?.addEventListener('scroll', close);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
      container?.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
    };
  }, [ctxMenu]);

  // Close spell popup on outside click / Escape / scroll
  useEffect(() => {
    if (!spellPopup) return;
    const close = () => setSpellPopup(null);
    const onMouseDown = (e: MouseEvent) => {
      if (spellPopupRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const container = editorContainerRef.current;
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    container?.addEventListener('scroll', close);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
      container?.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
    };
  }, [spellPopup]);

  // Toolbar command (focus then rAF)
  const cmd = useCallback((command: any, payload?: any) => {
    const view = getView();
    if (view && !view.hasFocus()) view.focus();
    requestAnimationFrame(() => {
      try { editorRef.current?.action(callCommand(command, payload)); } catch (err) { console.warn('[cmd]', err); }
    });
  }, [getView]);

  // Synchronous table command — rAF causes setCellAttr to lose the selection
  // because selectionchange fires between focus() and the rAF callback.
  const cmdTable = useCallback((command: any, payload?: any) => {
    try { editorRef.current?.action(callCommand(command, payload)); } catch (err) { console.warn('[cmdTable]', err); }
  }, []);

  // List with multi-line support
  const cmdList = useCallback((listType: 'bullet_list' | 'ordered_list') => {
    const view = getView();
    if (!view) return;
    if (!view.hasFocus()) view.focus();
    requestAnimationFrame(() => { try { execWrapInList(view, listType); } catch (err) { console.warn('[list]', err); } });
  }, [getView]);

  // Checklist — creates real GFM task list nodes
  const cmdChecklist = useCallback(() => {
    const view = getView();
    if (!view) return;
    if (!view.hasFocus()) view.focus();
    // Run synchronously (no rAF) so the view state reflects exactly where the
    // cursor was when the button was clicked, before any focus-shift side-effects.
    try { execInsertChecklist(view); } catch (err) { console.warn('[checklist]', err); }
  }, [getView]);

  // Blockquote toggle
  const cmdBlockquote = useCallback(() => {
    const view = getView();
    if (!view) return;
    if (!view.hasFocus()) view.focus();
    requestAnimationFrame(() => {
      try {
        if (!execLiftBlockquote(view)) editorRef.current?.action(callCommand(wrapInBlockquoteCommand.key));
      } catch (err) { console.warn('[blockquote]', err); }
    });
  }, [getView]);

  // Font color — restore saved selection (opening the picker can move focus)
  // before applying the mark. Also remembers last-used color and records the
  // action for F4 repeat. Restores the full ProseMirror Selection object so
  // CellSelection (multi-cell table) is preserved.
  const cmdColor = useCallback((color: string | null) => {
    const view = getView();
    if (!view) return;
    const saved = savedSelectionRef.current;
    if (saved) {
      try {
        // If saved is a full Selection object (has .map), restore it directly
        if (typeof saved.map === 'function') {
          const tr = view.state.tr.setSelection(saved);
          view.dispatch(tr);
        } else {
          // Fallback: it's a plain {from, to}
          const tr = view.state.tr.setSelection(
            TextSelection.create(view.state.doc, saved.from, saved.to)
          );
          view.dispatch(tr);
        }
      } catch (_) { /* ignore if selection is stale */ }
      view.focus();
    }
    applyFontColor(view, color);
    rememberFontColor(color);
    recordAction({ type: 'fontColor', color });
    setColorPickerPos(null);
    setCtxColorPos(null);
  }, [getView, recordAction]);

  // Highlight — same selection restoration as font color.
  const cmdHighlight = useCallback((color: string | null) => {
    const view = getView();
    if (!view) return;
    const saved = savedSelectionRef.current;
    if (saved) {
      try {
        if (typeof saved.map === 'function') {
          const tr = view.state.tr.setSelection(saved);
          view.dispatch(tr);
        } else {
          const tr = view.state.tr.setSelection(
            TextSelection.create(view.state.doc, saved.from, saved.to)
          );
          view.dispatch(tr);
        }
      } catch (_) { /* ignore if selection is stale */ }
      view.focus();
    }
    applyHighlight(view, color);
    rememberHighlight(color);
    recordAction({ type: 'highlight', color });
    setHighlightPickerPos(null);
    setCtxHighlightPos(null);
  }, [getView, recordAction]);

  // ── Recording wrappers for F4-repeatable toolbar/ctx-menu actions ────────
  // These are thin wrappers that delegate to the existing `cmd` helper but
  // also call recordAction so F4 can replay them.
  const cmdBold        = useCallback(() => { cmd(toggleStrongCommand.key);       recordAction({ type: 'bold' }); },       [cmd, recordAction]);
  const cmdItalic      = useCallback(() => { cmd(toggleEmphasisCommand.key);     recordAction({ type: 'italic' }); },     [cmd, recordAction]);
  const cmdStrike      = useCallback(() => { cmd(toggleStrikethroughCommand.key); recordAction({ type: 'strike' }); },    [cmd, recordAction]);
  const cmdInlineCode  = useCallback(() => { cmd(toggleInlineCodeCommand.key);   recordAction({ type: 'inlineCode' }); }, [cmd, recordAction]);

  const cmdUnderline = useCallback(() => {
    const view = getView();
    if (!view) return;
    if (!view.hasFocus()) view.focus();
    toggleUnderline(view);
    recordAction({ type: 'underline' });
  }, [getView, recordAction]);

  const cmdAlign = useCallback((align: AlignValue) => {
    const view = getView();
    if (!view) return;
    if (!view.hasFocus()) view.focus();
    applyAlign(view, align);
    persistAlignRef.current?.();
    recordAction({ type: 'align', align });
  }, [getView, recordAction]);

  const cmdIndent = useCallback(() => {
    const view = getView();
    if (!view) return;
    // Restore selection saved at ctx-menu open time (right-click can collapse it)
    const saved = savedSelectionRef.current;
    if (saved && saved.from !== saved.to) {
      try {
        const tr = view.state.tr.setSelection(
          TextSelection.create(view.state.doc, saved.from, saved.to)
        );
        view.dispatch(tr);
      } catch (_) { /* ignore if positions became stale */ }
    }
    if (execIndent(view)) recordAction({ type: 'indent' });
  }, [getView, recordAction]);

  const cmdOutdent = useCallback(() => {
    const view = getView();
    if (!view) return;
    // Restore selection saved at ctx-menu open time (right-click can collapse it)
    const saved = savedSelectionRef.current;
    if (saved && saved.from !== saved.to) {
      try {
        const tr = view.state.tr.setSelection(
          TextSelection.create(view.state.doc, saved.from, saved.to)
        );
        view.dispatch(tr);
      } catch (_) { /* ignore if positions became stale */ }
    }
    if (execOutdent(view)) recordAction({ type: 'outdent' });
  }, [getView, recordAction]);

  // Replay the last recorded action on the current selection.
  // Intentionally does NOT re-record (would make F4 infinitely repeat itself).
  const repeatLastAction = useCallback(() => {
    const action = lastActionRef.current;
    if (!action) return;
    const view = getView();
    if (!view) return;
    if (!view.hasFocus()) view.focus();

    switch (action.type) {
      case 'bold':       cmd(toggleStrongCommand.key); break;
      case 'italic':     cmd(toggleEmphasisCommand.key); break;
      case 'strike':     cmd(toggleStrikethroughCommand.key); break;
      case 'inlineCode': cmd(toggleInlineCodeCommand.key); break;
      case 'underline':  toggleUnderline(view); break;
      case 'align':
        applyAlign(view, action.align);
        persistAlignRef.current?.();
        break;
      case 'indent':     execIndent(view); break;
      case 'outdent':    execOutdent(view); break;
      case 'fontColor':
        applyFontColor(view, action.color);
        rememberFontColor(action.color);
        break;
      case 'highlight':
        applyHighlight(view, action.color);
        rememberHighlight(action.color);
        break;
    }
  }, [cmd, getView]);

  // F4 keydown — listen on window with capture so it wins over inner handlers
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'F4') return;
      // Only trigger if the editor has focus (or the container has focus inside it)
      const active = document.activeElement as HTMLElement | null;
      const container = editorContainerRef.current;
      if (!container) return;
      if (!container.contains(active) && !container.contains(document.activeElement)) return;
      e.preventDefault();
      repeatLastAction();
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [repeatLastAction]);

  // Apply a theme to the table containing the cursor. Uses a ProseMirror
  // decoration plugin (tableThemePlugin) to persist the class across ProseMirror
  // re-renders — the previous direct DOM class mutation approach was wiped
  // by the TableView NodeView on every transaction.
  const activeTableWrapperRef = useRef<HTMLElement | null>(null);

  const cmdTableTheme = useCallback((theme: string) => {
    const view = getView();
    if (!view) return;
    if (!view.hasFocus()) view.focus();
    setTableThemeForCurrent(view, theme);
    setTableTheme(theme);
    // Persist the change
    persistThemesRef.current?.();
  }, [getView]);

  // Template
  const handleApplyTemplate = async (t: { name: string; path: string; type: string }) => {
    try {
      const res = await apiFetch(`/api/file?path=${encodeURIComponent(t.path)}`);
      if (!res.ok) return;
      let tmpl = await res.text();
      tmpl = tmpl.replace(/{{date}}/g, new Date().toISOString().split('T')[0]);
      editorRef.current?.action(insert('\n\n' + tmpl));
      setIsTemplateMenuOpen(false);
    } catch (err) { console.error('[template]', err); }
  };

  if (!filePath) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted bg-bg-primary">
        <div className="text-center flex flex-col items-center">
          <div className="w-24 h-24 mb-6 opacity-10">
            <svg viewBox="0 0 100 100" fill="currentColor"><path d="M50 0 L93.3 25 L93.3 75 L50 100 L6.7 75 L6.7 25 Z" /></svg>
          </div>
          <div className="space-y-3 text-sm">
            <p className="flex items-center justify-center gap-2">
              <kbd className="bg-bg-secondary px-2 py-1 rounded border border-border-color font-mono text-xs">Ctrl + P</kbd>
              <span>to open command palette</span>
            </p>
            <p className="flex items-center justify-center gap-2">
              <kbd className="bg-bg-secondary px-2 py-1 rounded border border-border-color font-mono text-xs">Ctrl + N</kbd>
              <span>to create new note</span>
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (loading) return <div className="h-full flex items-center justify-center text-text-muted">Loading…</div>;

  return (
    <div className="h-full w-full flex flex-col min-w-0 overflow-hidden bg-bg-primary">

      {/* Header + Toolbar combined */}
      <div className="flex-shrink-0 border-b border-border-color bg-bg-secondary/50 z-20">
        {/* File path row with inline toolbar */}
        <div className="flex items-center min-h-0 relative">
          {/* File path — compact left side */}
          <div className="flex items-center gap-2 px-3 py-1.5 text-sm text-text-muted flex-shrink-0 min-w-0 max-w-[200px]">
            <FileText size={13} className="text-interactive-accent flex-shrink-0" />
            <span className="truncate font-medium text-text-normal text-xs">{filePath?.split('/').pop()}</span>
          </div>
          {/* Toolbar — scrollable centre region */}
          <div className="flex-grow overflow-x-auto min-w-0">
            <div className="format-toolbar border-0 py-0.5 px-1 flex-nowrap" style={{ minWidth: 'max-content' }}>
              <ToolBtn title="Bold (Ctrl+B)" onClick={cmdBold}><Bold size={12} /></ToolBtn>
              <ToolBtn title="Italic (Ctrl+I)" onClick={cmdItalic}><Italic size={12} /></ToolBtn>
              <ToolBtn title="Underline" onClick={cmdUnderline}><Underline size={12} /></ToolBtn>
              <ToolBtn title="Strikethrough" onClick={cmdStrike}><Strikethrough size={12} /></ToolBtn>
              <ToolBtn title="Inline code" onClick={cmdInlineCode}><Code size={12} /></ToolBtn>
              {/* Font color picker */}
              <button
                ref={colorBtnRef}
                className="format-toolbar-btn"
                title="Font color (select text first)"
                onMouseDown={e => {
                  e.preventDefault(); // Don't blur the editor — preserves selection
                  const view = getView();
                  if (view) {
                    savedSelectionRef.current = view.state.selection;
                  }
                }}
                onClick={() => {
                  if (colorPickerPos) {
                    setColorPickerPos(null);
                    return;
                  }
                  const rect = colorBtnRef.current?.getBoundingClientRect();
                  if (rect) {
                    setColorPickerPos({ top: rect.bottom + 4, left: rect.left });
                    setHighlightPickerPos(null);
                  }
                }}
              >
                <Palette size={12} />
              </button>
              {/* Highlight picker */}
              <button
                ref={highlightBtnRef}
                className="format-toolbar-btn"
                title="Highlight (select text first)"
                onMouseDown={e => {
                  e.preventDefault();
                  const view = getView();
                  if (view) {
                    savedSelectionRef.current = view.state.selection;
                  }
                }}
                onClick={() => {
                  if (highlightPickerPos) {
                    setHighlightPickerPos(null);
                    return;
                  }
                  const rect = highlightBtnRef.current?.getBoundingClientRect();
                  if (rect) {
                    setHighlightPickerPos({ top: rect.bottom + 4, left: rect.left });
                    setColorPickerPos(null);
                  }
                }}
              >
                <Highlighter size={12} />
              </button>
              <div className="format-toolbar-separator" />
              <ToolBtn title="Heading 1" onClick={() => cmd(wrapInHeadingCommand.key, 1)} style={{ fontWeight: 700, fontSize: 11 }}>H1</ToolBtn>
              <ToolBtn title="Heading 2" onClick={() => cmd(wrapInHeadingCommand.key, 2)} style={{ fontWeight: 700, fontSize: 10 }}>H2</ToolBtn>
              <ToolBtn title="Heading 3" onClick={() => cmd(wrapInHeadingCommand.key, 3)} style={{ fontWeight: 700, fontSize: 9 }}>H3</ToolBtn>
              <ToolBtn title="Plain paragraph" onClick={() => cmd(turnIntoTextCommand.key)} style={{ fontSize: 9 }}>¶</ToolBtn>
              <div className="format-toolbar-separator" />
              <ToolBtn title="Bullet list" onClick={() => cmdList('bullet_list')}><List size={12} /></ToolBtn>
              <ToolBtn title="Ordered list" onClick={() => cmdList('ordered_list')}><ListOrdered size={12} /></ToolBtn>
              <ToolBtn title="Task / checklist" onClick={cmdChecklist}><CheckSquare size={12} /></ToolBtn>
              <div className="format-toolbar-separator" />
              <ToolBtn title="Blockquote" onClick={cmdBlockquote}><Quote size={12} /></ToolBtn>
              <ToolBtn title="Horizontal rule" onClick={() => cmd(insertHrCommand.key)}><Minus size={12} /></ToolBtn>
              <div className="format-toolbar-separator" />
              <ToolBtn title="Insert table" onClick={() => cmd(insertTableCommand.key)}><Table size={12} /></ToolBtn>
              <div className="format-toolbar-separator" />
              <select title="Font size" value={FONT_SIZES.includes(fontSize) ? fontSize : ''}
                onChange={e => setFontSize(Number(e.target.value))}
                style={{ fontSize: 10, padding: '1px 2px', height: 22 }}>
                {FONT_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                {!FONT_SIZES.includes(fontSize) && <option value={fontSize}>{fontSize}</option>}
              </select>
            </div>
          </div>
          {/* Right actions — font size + find + template + bookmark */}
          <div className="flex items-center gap-0.5 px-2 flex-shrink-0">
            <ToolBtn title="Larger (Ctrl++)" onClick={() => setFontSize(p => Math.min(p + 1, 40))} style={{ fontWeight: 700, fontSize: 11 }}>A⁺</ToolBtn>
            <ToolBtn title="Smaller (Ctrl+-)" onClick={() => setFontSize(p => Math.max(p - 1, 8))} style={{ fontWeight: 500, fontSize: 10 }}>A⁻</ToolBtn>
            <div className="format-toolbar-separator" />
            {/* Find & Replace toggle */}
            <button
              onClick={() => {
                setShowFindReplace(v => {
                  if (v) { closeFindReplace(); return false; }
                  setTimeout(() => findInputRef.current?.focus(), 50);
                  return true;
                });
              }}
              className={`p-1.5 rounded transition-colors ${showFindReplace ? 'text-interactive-accent bg-interactive-accent/10' : 'text-text-muted hover:text-text-normal hover:bg-bg-secondary'}`}
              title="Find &amp; Replace (Ctrl+F)"
            >
              <Search size={13} />
            </button>
            <div className="format-toolbar-separator" />
            <div className="relative" ref={templateMenuRef}>
              <button onClick={() => setIsTemplateMenuOpen(o => !o)}
                className={`p-1.5 rounded transition-colors ${isTemplateMenuOpen ? 'text-interactive-accent bg-interactive-accent/10' : 'text-text-muted hover:text-text-normal hover:bg-bg-secondary'}`}
                title="Insert Template">
                <ClipboardList size={13} />
              </button>
              {isTemplateMenuOpen && (
                <div className="absolute right-0 mt-2 w-48 bg-bg-secondary border border-border-color rounded-md shadow-xl z-50 py-1 overflow-hidden">
                  <div className="px-3 py-1.5 text-[10px] font-bold text-text-muted uppercase tracking-wider border-b border-border-color">Insert Template</div>
                  <div className="max-h-60 overflow-y-auto custom-scrollbar">
                    {templates.filter(t => t.type === 'file').length === 0
                      ? <div className="px-3 py-2 text-xs text-text-muted italic">No templates found</div>
                      : templates.filter(t => t.type === 'file').map(t => (
                        <button key={t.path} onClick={() => handleApplyTemplate(t)}
                          className="w-full text-left px-3 py-2 text-xs text-text-normal hover:bg-bg-primary hover:text-interactive-accent transition-colors truncate">
                          {t.name}
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>
            {onToggleBookmark && (
              <button onClick={onToggleBookmark}
                className={`p-1.5 rounded transition-colors ${isBookmarked ? 'text-interactive-accent bg-interactive-accent/10' : 'text-text-muted hover:text-text-normal hover:bg-bg-secondary'}`}
                title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}>
                <Bookmark size={13} fill={isBookmarked ? 'currentColor' : 'none'} />
              </button>
            )}
            {/* Cursor position indicator */}
            {cursorPos && (
              <span
                title="Cursor position (Line : Column)"
                style={{
                  fontSize: 10,
                  color: 'var(--text-muted)',
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 4,
                  padding: '1px 6px',
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: '0.02em',
                  whiteSpace: 'nowrap',
                  userSelect: 'none',
                  minWidth: 60,
                  textAlign: 'center',
                }}
              >
                Ln {cursorPos.line} · Col {cursorPos.col}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Table toolbar — auto-shows when cursor is inside a table */}
      {showTableTools && (
        <div className="format-toolbar" style={{ borderTop: '1px solid var(--border-color)', background: 'rgba(0,200,130,0.04)', flexWrap: 'wrap', gap: 2 }}>
          {/* Label */}
          <span className="text-xs font-semibold text-text-muted px-1 select-none" style={{ opacity: 0.7, letterSpacing: '0.04em' }}>TABLE</span>
          <div className="format-toolbar-separator" />

          {/* Row controls */}
          <span className="text-xs text-text-muted px-1 select-none" style={{ opacity: 0.5 }}>Row:</span>
          <ToolBtn title="Add row above" onClick={() => cmdTable(addRowBeforeCommand.key)}>
            <span style={{ fontSize: 10, fontWeight: 700 }}>↑ Add</span>
          </ToolBtn>
          <ToolBtn title="Add row below" onClick={() => cmdTable(addRowAfterCommand.key)}>
            <span style={{ fontSize: 10, fontWeight: 700 }}>↓ Add</span>
          </ToolBtn>
          <ToolBtn title="Delete row" danger onClick={() => cmdTable(deleteSelectedCellsCommand.key)}>
            <span style={{ fontSize: 10, fontWeight: 700 }}>✕ Row</span>
          </ToolBtn>

          <div className="format-toolbar-separator" />

          {/* Column controls */}
          <span className="text-xs text-text-muted px-1 select-none" style={{ opacity: 0.5 }}>Col:</span>
          <ToolBtn title="Add column left" onClick={() => cmdTable(addColBeforeCommand.key)}>
            <span style={{ fontSize: 10, fontWeight: 700 }}>← Add</span>
          </ToolBtn>
          <ToolBtn title="Add column right" onClick={() => cmdTable(addColAfterCommand.key)}>
            <span style={{ fontSize: 10, fontWeight: 700 }}>→ Add</span>
          </ToolBtn>
          <ToolBtn title="Delete column" danger onClick={() => cmdTable(deleteSelectedCellsCommand.key)}>
            <span style={{ fontSize: 10, fontWeight: 700 }}>✕ Col</span>
          </ToolBtn>

          <div className="format-toolbar-separator" />
          <span className="text-xs text-text-muted px-1 select-none" style={{ opacity: 0.4 }}>Tab / Shift+Tab to navigate cells</span>

          <div className="format-toolbar-separator" />
          {/* Delete entire table */}
          <ToolBtn title="Delete entire table" danger onClick={cmdDeleteTable}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 10, fontWeight: 700 }}>
              <Trash2 size={11} />
              <span>Table</span>
            </span>
          </ToolBtn>
          <div className="format-toolbar-separator" />
          {/* Table design themes — compact dropdown button */}
          <div className="relative" style={{ display: 'inline-flex', alignItems: 'center' }}>
            <button
              ref={themeBtnRef}
              className="format-toolbar-btn"
              title="Table theme"
              style={{ display: 'flex', alignItems: 'center', gap: 3, paddingRight: 4 }}
              onClick={() => setShowThemePicker(p => !p)}
            >
              {/* Show current theme's preview swatches, or "default" swatches */}
              {(() => {
                const cur = TABLE_THEMES.find(t => t.id === tableTheme) ?? TABLE_THEMES[0];
                return (<>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: cur.preview[0], display: 'inline-block' }} />
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: cur.preview[1], display: 'inline-block' }} />
                  <span style={{ fontSize: 9 }}>▾</span>
                </>);
              })()}
            </button>
            {showThemePicker && (
              <div
                ref={themePickerRef}
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  left: 0,
                  zIndex: 200,
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 7,
                  padding: 6,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  minWidth: 110,
                }}
              >
                {TABLE_THEMES.map(t => (
                  <button
                    key={t.id}
                    title={t.label}
                    onMouseDown={e => {
                      e.preventDefault();
                      cmdTableTheme(t.id);
                      setShowThemePicker(false);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '3px 6px',
                      borderRadius: 4,
                      border: 'none',
                      background: tableTheme === t.id ? 'rgba(0,200,130,0.12)' : 'transparent',
                      color: 'var(--text-normal)',
                      cursor: 'pointer',
                      outline: tableTheme === t.id ? '1px solid var(--interactive-accent)' : 'none',
                    }}
                  >
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: t.preview[0], flexShrink: 0 }} />
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: t.preview[1], flexShrink: 0 }} />
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Find & Replace panel */}
      {showFindReplace && (
        <div
          ref={findPanelRef}
          className="jn-find-panel"
        >
          {/* Find row */}
          <div className="jn-find-row">
            <Search size={12} className="jn-find-icon" />
            <input
              ref={findInputRef}
              className="jn-find-input"
              placeholder="Find…"
              value={findQuery}
              onChange={e => {
                const q = e.target.value;
                setFindQuery(q);
                setFindCurrentIdx(0);
                applyFindDecorations(q, findMatchCase, 0);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.shiftKey ? findPrev() : findNext(); }
                if (e.key === 'Escape') closeFindReplace();
              }}
              spellCheck={false}
            />
            {/* Match count */}
            <span className="jn-find-count">
              {findQuery
                ? findMatches.length > 0
                  ? `${findCurrentIdx + 1}/${findMatches.length}`
                  : 'No results'
                : ''}
            </span>
            {/* Case-sensitive toggle */}
            <button
              className={`jn-find-btn${findMatchCase ? ' active' : ''}`}
              title="Match case"
              onClick={() => {
                const mc = !findMatchCase;
                setFindMatchCase(mc);
                applyFindDecorations(findQuery, mc, 0);
              }}
            >
              Aa
            </button>
            <button className="jn-find-btn" title="Previous match (Shift+Enter)" onClick={findPrev} disabled={!findMatches.length}>
              <ChevronUp size={12} />
            </button>
            <button className="jn-find-btn" title="Next match (Enter)" onClick={findNext} disabled={!findMatches.length}>
              <ChevronDown size={12} />
            </button>
            <button className="jn-find-btn" title="Close (Esc)" onClick={closeFindReplace}>
              <X size={12} />
            </button>
          </div>
          {/* Replace row */}
          <div className="jn-find-row">
            <Replace size={12} className="jn-find-icon" />
            <input
              className="jn-find-input"
              placeholder="Replace with…"
              value={replaceQuery}
              onChange={e => setReplaceQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') doReplace(replaceQuery);
                if (e.key === 'Escape') closeFindReplace();
              }}
              spellCheck={false}
            />
            <button
              className="jn-find-action-btn"
              title="Replace current match"
              onClick={() => doReplace(replaceQuery)}
              disabled={!findMatches.length}
            >
              Replace
            </button>
            <button
              className="jn-find-action-btn"
              title="Replace all matches"
              onClick={() => doReplaceAll(replaceQuery)}
              disabled={!findMatches.length}
            >
              All
            </button>
          </div>
        </div>
      )}

      {/* Editor + wikilink dropdown */}
      <div
        ref={editorContainerRef}
        className="flex-grow min-w-0 overflow-auto custom-scrollbar relative"
        onClick={(e) => {
          // Detect clicks on spell/grammar decorated spans and show the popup.
          // We walk up from the click target to find the decorated element.
          const target = e.target as HTMLElement;
          const decorated = target.closest('.jn-spell-error, .jn-grammar-error') as HTMLElement | null;
          if (!decorated) return;

          const word = decorated.getAttribute('data-jn-word') ?? '';
          const type = (decorated.getAttribute('data-jn-type') ?? 'spell') as 'spell' | 'grammar';
          const msg  = decorated.getAttribute('data-jn-msg') ?? undefined;

          // Find the ProseMirror position range for this decoration so we can
          // replace the word when the user picks a suggestion.
          const view = getView();
          let pmFrom = -1, pmTo = -1;
          if (view) {
            try {
              // domAtPos in reverse: find pos from the DOM node
              const domPos = view.posAtDOM(decorated, 0);
              pmFrom = domPos;
              pmTo = domPos + (decorated.textContent?.length ?? word.length);
            } catch { /* pos lookup failed — suggestions will still work via search */ }
          }

          const suggs = type === 'spell' ? spellSuggest(word) : [];

          // Position popup just below the clicked element
          const rect = decorated.getBoundingClientRect();
          const POPUP_W = 220;
          const x = Math.min(rect.left, window.innerWidth - POPUP_W - 8);
          const y = rect.bottom + 4;

          setSpellPopup({ x, y, word, type, message: msg, suggestions: suggs, from: pmFrom, to: pmTo });
        }}
        onContextMenu={(e) => {
          // Right-click opens the formatting ctx menu at cursor.
          // We don't open on right-click of images, links, or the wikilink
          // dropdown so the native browser menu still works there when useful.
          // Right-clicking a spell/grammar decoration opens the spell popup instead.
          const target = e.target as HTMLElement;
          if (target.closest('img, a, .jn-wikilink-dropdown')) return;

          // Check for spell/grammar decoration
          const decorated = target.closest('.jn-spell-error, .jn-grammar-error') as HTMLElement | null;
          if (decorated) {
            e.preventDefault();
            const word = decorated.getAttribute('data-jn-word') ?? '';
            const type = (decorated.getAttribute('data-jn-type') ?? 'spell') as 'spell' | 'grammar';
            const msg  = decorated.getAttribute('data-jn-msg') ?? undefined;
            const view = getView();
            let pmFrom = -1, pmTo = -1;
            if (view) {
              try {
                const domPos = view.posAtDOM(decorated, 0);
                pmFrom = domPos;
                pmTo = domPos + (decorated.textContent?.length ?? word.length);
              } catch { /* ignore */ }
            }
            const suggs = type === 'spell' ? spellSuggest(word) : [];
            const POPUP_W = 220;
            const x = Math.min(e.clientX, window.innerWidth - POPUP_W - 8);
            const y = Math.min(e.clientY + 6, window.innerHeight - 200);
            setSpellPopup({ x, y, word, type, message: msg, suggestions: suggs, from: pmFrom, to: pmTo });
            setCtxMenu(null);
            return;
          }

          e.preventDefault();
          // Capture the current ProseMirror selection BEFORE the contextmenu
          // event can cause the browser to collapse it. All ctx menu actions
          // (including indent/outdent) restore this saved range first.
          const view = getView();
          if (view) {
            savedSelectionRef.current = view.state.selection;
          }
          // Clamp to viewport so the menu doesn't render off-screen
          const MENU_APPROX_W = 380;
          const MENU_APPROX_H = 40;
          const x = Math.min(e.clientX, window.innerWidth - MENU_APPROX_W - 8);
          const y = Math.min(e.clientY, window.innerHeight - MENU_APPROX_H - 8);
          setCtxMenu({ x: Math.max(8, x), y: Math.max(8, y) });
          setCtxColorPos(null);
          setCtxHighlightPos(null);
        }}
      >
        {suggestions.active && suggestions.suggestions.length > 0 && (() => {
          // Position the dropdown just below the current cursor.
          // suggestions.coords is in viewport coords; subtract the container's
          // top-left (plus its scroll offset) to get coords inside the scroll container.
          const container = editorContainerRef.current;
          let style: React.CSSProperties = { top: 8, left: 20 };
          if (container && suggestions.coords) {
            const rect = container.getBoundingClientRect();
            const left = Math.max(8, suggestions.coords.left - rect.left + container.scrollLeft);
            const top = suggestions.coords.bottom - rect.top + container.scrollTop + 4;
            const maxLeft = Math.max(8, container.clientWidth - 260);
            style = { top, left: Math.min(left, maxLeft) };
          }
          return (
            <div className="jn-wikilink-dropdown" style={style} role="listbox">
              {suggestions.suggestions.map((s, i) => (
                <div key={s}
                  role="option"
                  aria-selected={i === suggestions.selectedIndex}
                  className={`jn-wikilink-option${i === suggestions.selectedIndex ? ' selected' : ''}`}
                  onMouseDown={e => { e.preventDefault(); insertWikilink(s); }}>
                  <span className="jn-wikilink-option-icon">📄</span>
                  <span className="jn-wikilink-option-label">{s}</span>
                </div>
              ))}
            </div>
          );
        })()}
        {hashtagSuggestions.active && hashtagSuggestions.suggestions.length > 0 && (() => {
          const container = editorContainerRef.current;
          let style: React.CSSProperties = { top: 8, left: 20 };
          if (container && hashtagSuggestions.coords) {
            const rect = container.getBoundingClientRect();
            const left = Math.max(8, hashtagSuggestions.coords.left - rect.left + container.scrollLeft);
            const top = hashtagSuggestions.coords.bottom - rect.top + container.scrollTop + 4;
            const maxLeft = Math.max(8, container.clientWidth - 240);
            style = { top, left: Math.min(left, maxLeft) };
          }
          return (
            <div className="jn-hashtag-dropdown" style={style} role="listbox" aria-label="Hashtag suggestions">
              <div className="jn-hashtag-dropdown-header">Existing tags</div>
              {hashtagSuggestions.suggestions.map((tag, i) => (
                <div key={tag}
                  role="option"
                  aria-selected={i === hashtagSuggestions.selectedIndex}
                  className={`jn-hashtag-option${i === hashtagSuggestions.selectedIndex ? ' selected' : ''}`}
                  onMouseDown={e => { e.preventDefault(); insertHashtag(tag); }}>
                  <span className="jn-hashtag-option-hash">#</span>
                  <span className="jn-hashtag-option-label">{tag}</span>
                </div>
              ))}
            </div>
          );
        })()}
        <div className="milkdown-wrapper h-full">
          <MilkdownProvider>
            <InnerMilkdown
              key={editorKey}
              initialContent={content}
              editorRef={editorRef}
              onMarkdownChange={handleMarkdownChange}
              onReady={handleEditorReady}
            />
          </MilkdownProvider>
        </div>
      </div>

      {/* Floating color pickers rendered at root level with position:fixed
          to escape the overflow-x-auto toolbar scroll container. */}
      {colorPickerPos && (
        <div
          ref={colorPickerRef}
          className="jn-color-picker-dropdown"
          style={{ position: 'fixed', top: colorPickerPos.top, left: colorPickerPos.left, zIndex: 1000 }}
        >
          <div className="jn-color-picker-label">Font Color</div>
          <div className="jn-color-picker-grid">
            {FONT_COLORS.map(({ label, color }) => (
              <button
                key={label}
                title={label}
                className="jn-color-swatch"
                style={{ background: color ?? 'transparent', border: color ? 'none' : '1px dashed var(--border-color)' }}
                onMouseDown={e => { e.preventDefault(); cmdColor(color); }}
              >
                {!color && <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>✕</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {highlightPickerPos && (
        <div
          ref={highlightPickerRef}
          className="jn-color-picker-dropdown"
          style={{ position: 'fixed', top: highlightPickerPos.top, left: highlightPickerPos.left, zIndex: 1000 }}
        >
          <div className="jn-color-picker-label">Highlight</div>
          <div className="jn-color-picker-grid">
            {HIGHLIGHT_COLORS.map(({ label, color }) => (
              <button
                key={label}
                title={label}
                className="jn-color-swatch"
                style={{ background: color ?? 'transparent', border: color ? 'none' : '1px dashed var(--border-color)' }}
                onMouseDown={e => { e.preventDefault(); cmdHighlight(color); }}
              >
                {!color && <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>✕</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Right-click contextual formatting menu.
          Buttons use onMouseDown with preventDefault+stopPropagation so:
            (1) the editor's selection isn't lost to focus changes
            (2) the menu's own outside-click handler doesn't dismiss it
                before the action runs. */}
      {ctxMenu && (() => {
        const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
        const runAndClose = (fn: () => void) => (e: React.MouseEvent) => {
          stop(e);
          fn();
          setCtxMenu(null);
        };
        return (
          <div
            ref={ctxMenuRef}
            className="jn-ctx-menu"
            style={{ top: ctxMenu.y, left: ctxMenu.x }}
            onMouseDown={stop}
          >
            {/* Cut / Copy / Paste */}
            <button
              className="jn-ctx-btn"
              title="Cut (Ctrl+X)"
              onMouseDown={e => {
                stop(e);
                document.execCommand('cut');
                setCtxMenu(null);
              }}
            >
              <Scissors size={13} />
            </button>
            <button
              className="jn-ctx-btn"
              title="Copy (Ctrl+C)"
              onMouseDown={e => {
                stop(e);
                document.execCommand('copy');
                setCtxMenu(null);
              }}
            >
              <Copy size={13} />
            </button>
            <button
              className="jn-ctx-btn"
              title="Paste (Ctrl+V)"
              onMouseDown={async e => {
                stop(e);
                setCtxMenu(null);
                try {
                  const view = getView();
                  if (view) { view.focus(); }
                  // Use execCommand for synchronous paste (clipboard API requires
                  // user-gesture context which we've already consumed in onMouseDown)
                  document.execCommand('paste');
                } catch { /* paste may be blocked by browser policy */ }
              }}
            >
              <Clipboard size={13} />
            </button>

            <span className="jn-ctx-divider" />

            <button className="jn-ctx-btn" title="Bold (Ctrl+B)" onMouseDown={runAndClose(cmdBold)}>
              <Bold size={13} />
            </button>
            <button className="jn-ctx-btn" title="Italic (Ctrl+I)" onMouseDown={runAndClose(cmdItalic)}>
              <Italic size={13} />
            </button>
            <button className="jn-ctx-btn" title="Underline" onMouseDown={runAndClose(cmdUnderline)}>
              <Underline size={13} />
            </button>

            <span className="jn-ctx-divider" />

            <button className="jn-ctx-btn" title="Align left" onMouseDown={runAndClose(() => cmdAlign('left'))}>
              <AlignLeft size={13} />
            </button>
            <button className="jn-ctx-btn" title="Align center" onMouseDown={runAndClose(() => cmdAlign('center'))}>
              <AlignCenter size={13} />
            </button>
            <button className="jn-ctx-btn" title="Align right" onMouseDown={runAndClose(() => cmdAlign('right'))}>
              <AlignRight size={13} />
            </button>

            <span className="jn-ctx-divider" />

            <button className="jn-ctx-btn" title="Decrease indent" onMouseDown={runAndClose(cmdOutdent)}>
              <Outdent size={13} />
            </button>
            <button className="jn-ctx-btn" title="Increase indent" onMouseDown={runAndClose(cmdIndent)}>
              <Indent size={13} />
            </button>

            {/* Font color split-button — main applies last-used, chevron opens palette */}
            <span className="jn-ctx-split">
              <button
                className="jn-ctx-btn"
                title="Apply last font color"
                onMouseDown={e => {
                  stop(e);
                  // Save selection for cmdColor to restore
                  const view = getView();
                  if (view) {
                    savedSelectionRef.current = view.state.selection;
                  }
                  cmdColor(lastFontColorRef.current);
                  setCtxMenu(null);
                }}
              >
                <Palette size={13} />
                <span className="jn-ctx-color-bar" style={{ background: lastFontColorRef.current }} />
              </button>
              <button
                className="jn-ctx-split-arrow"
                title="Choose font color"
                onMouseDown={e => {
                  stop(e);
                  // Save selection before opening palette
                  const view = getView();
                  if (view) {
                    savedSelectionRef.current = view.state.selection;
                  }
                  const btn = e.currentTarget as HTMLElement;
                  const rect = btn.getBoundingClientRect();
                  setCtxColorPos({ top: rect.bottom + 4, left: rect.left });
                  setCtxHighlightPos(null);
                }}
              >
                <ChevronDown size={10} />
              </button>
            </span>

            <span className="jn-ctx-divider" />

            {/* Highlight split-button */}
            <span className="jn-ctx-split">
              <button
                className="jn-ctx-btn"
                title="Apply last highlight"
                onMouseDown={e => {
                  stop(e);
                  const view = getView();
                  if (view) {
                    savedSelectionRef.current = view.state.selection;
                  }
                  cmdHighlight(lastHighlightRef.current);
                  setCtxMenu(null);
                }}
              >
                <Highlighter size={13} />
                <span className="jn-ctx-color-bar" style={{ background: lastHighlightRef.current }} />
              </button>
              <button
                className="jn-ctx-split-arrow"
                title="Choose highlight"
                onMouseDown={e => {
                  stop(e);
                  const view = getView();
                  if (view) {
                    savedSelectionRef.current = view.state.selection;
                  }
                  const btn = e.currentTarget as HTMLElement;
                  const rect = btn.getBoundingClientRect();
                  setCtxHighlightPos({ top: rect.bottom + 4, left: rect.left });
                  setCtxColorPos(null);
                }}
              >
                <ChevronDown size={10} />
              </button>
            </span>
          </div>
        );
      })()}

      {/* Ctx menu font-color palette */}
      {ctxColorPos && (
        <div
          ref={ctxColorPaletteRef}
          className="jn-ctx-palette"
          style={{ top: ctxColorPos.top, left: ctxColorPos.left }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="jn-color-picker-label">Font Color</div>
          <div className="jn-color-picker-grid">
            {FONT_COLORS.map(({ label, color }) => (
              <button
                key={label}
                title={label}
                className="jn-color-swatch"
                style={{ background: color ?? 'transparent', border: color ? 'none' : '1px dashed var(--border-color)' }}
                onMouseDown={e => {
                  e.preventDefault();
                  e.stopPropagation();
                  cmdColor(color);
                  setCtxMenu(null);
                }}
              >
                {!color && <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>✕</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Ctx menu highlight palette */}
      {ctxHighlightPos && (
        <div
          ref={ctxHighlightPaletteRef}
          className="jn-ctx-palette"
          style={{ top: ctxHighlightPos.top, left: ctxHighlightPos.left }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="jn-color-picker-label">Highlight</div>
          <div className="jn-color-picker-grid">
            {HIGHLIGHT_COLORS.map(({ label, color }) => (
              <button
                key={label}
                title={label}
                className="jn-color-swatch"
                style={{ background: color ?? 'transparent', border: color ? 'none' : '1px dashed var(--border-color)' }}
                onMouseDown={e => {
                  e.preventDefault();
                  e.stopPropagation();
                  cmdHighlight(color);
                  setCtxMenu(null);
                }}
              >
                {!color && <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>✕</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Spell / grammar suggestion popup ─────────────────────────────── */}
      {spellPopup && (() => {
        const { x, y, word, type, message, suggestions: suggs, from: pmFrom, to: pmTo } = spellPopup;

        /** Replace the decorated word in the editor with `replacement`. */
        const applyReplacement = (replacement: string) => {
          const view = getView();
          if (view && pmFrom >= 0 && pmTo > pmFrom) {
            try {
              const tr = view.state.tr.replaceWith(
                pmFrom, pmTo,
                view.state.schema.text(replacement)
              );
              view.dispatch(tr);
              view.focus();
            } catch { /* position stale — ignore */ }
          }
          setSpellPopup(null);
        };

        return (
          <div
            ref={spellPopupRef}
            className="jn-spell-popup"
            style={{ top: y, left: x }}
            onMouseDown={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="jn-spell-popup-header">
              <span className={`jn-spell-badge ${type}`}>
                {type === 'spell' ? 'Spelling' : 'Grammar'}
              </span>
            </div>

            {/* The word/phrase */}
            <div className="jn-spell-popup-word">"{word}"</div>

            {/* Grammar rule message */}
            {type === 'grammar' && message && (
              <div className="jn-spell-grammar-msg">{message}</div>
            )}

            {/* Suggestions list (spell only) */}
            {type === 'spell' && (
              <div className="jn-spell-suggestions">
                {suggs.length > 0
                  ? suggs.map(s => (
                    <button
                      key={s}
                      className="jn-spell-suggestion"
                      onMouseDown={e => { e.preventDefault(); applyReplacement(s); }}
                    >
                      {s}
                    </button>
                  ))
                  : <div className="jn-spell-suggestion-none">No suggestions</div>
                }
              </div>
            )}

            {/* Action row */}
            <div className="jn-spell-popup-actions">
              <button
                className="jn-spell-action"
                onMouseDown={e => {
                  e.preventDefault();
                  spellIgnoreOnce(word);
                  setSpellPopup(null);
                }}
              >
                Ignore
              </button>
              {type === 'spell' && (
                <button
                  className="jn-spell-action"
                  onMouseDown={e => {
                    e.preventDefault();
                    spellAddWord(word);
                    setSpellPopup(null);
                  }}
                >
                  Add to dictionary
                </button>
              )}
              <button
                className="jn-spell-action danger"
                onMouseDown={e => { e.preventDefault(); setSpellPopup(null); }}
              >
                Dismiss
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

// ─── Public export — wrapped in error boundary ────────────────────────────────

export const MilkdownEditor: React.FC<MilkdownEditorProps> = (props) => {
  const [resetKey, setResetKey] = useState(0);
  return (
    <EditorErrorBoundary onReset={() => setResetKey(k => k + 1)}>
      <EditorInner key={resetKey} {...props} />
    </EditorErrorBoundary>
  );
};
