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
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import {
  tagDecoratorPlugin, wikilinkPlugin, checkboxClickPlugin, listTabPlugin,
  setWikilinkFileList, setOpenFileCallback,
  subscribeToWikilinkSuggestions, unsubscribeWikilinkSuggestions,
  execWrapInList, execLiftBlockquote, execInsertChecklist,
  execIndent, execOutdent,
  fontColorMark, highlightMark, applyFontColor, applyHighlight,
  tableThemePlugin, setTableThemeForCurrent, getCurrentTableTheme,
  serializeTableThemes, restoreTableThemes,
  underlineMark, toggleUnderline,
  alignPlugin, applyAlign, getCurrentAlign,
  serializeAlignments, restoreAlignments,
  jnHtmlMarksRemarkPlugin,
  WikilinkSuggestion,
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
  { label: 'Default',   color: null },
  { label: 'Red',       color: '#e53e3e' },
  { label: 'Orange',    color: '#dd6b20' },
  { label: 'Yellow',    color: '#d69e2e' },
  { label: 'Green',     color: '#38a169' },
  { label: 'Teal',      color: '#00c882' },
  { label: 'Blue',      color: '#3182ce' },
  { label: 'Purple',    color: '#805ad5' },
  { label: 'Pink',      color: '#d53f8c' },
  { label: 'Gray',      color: '#718096' },
  { label: 'White',     color: '#f7fafc' },
];

const HIGHLIGHT_COLORS = [
  { label: 'None',      color: null },
  { label: 'Yellow',    color: 'rgba(253,230,138,0.85)' },
  { label: 'Green',     color: 'rgba(187,247,208,0.85)' },
  { label: 'Blue',      color: 'rgba(191,219,254,0.85)' },
  { label: 'Pink',      color: 'rgba(251,207,232,0.85)' },
  { label: 'Purple',    color: 'rgba(221,214,254,0.85)' },
  { label: 'Orange',    color: 'rgba(254,215,170,0.85)' },
  { label: 'Red',       color: 'rgba(254,202,202,0.85)' },
  { label: 'Teal',      color: 'rgba(167,243,208,0.85)' },
];

const TABLE_THEMES = [
  { id: '',          label: 'Default',    preview: ['#363636', '#1e1e1e'] },
  { id: 'sky',       label: 'Sky',        preview: ['#bfdbfe', '#eff6ff'] },
  { id: 'mint',      label: 'Mint',       preview: ['#bbf7d0', '#f0fdf4'] },
  { id: 'peach',     label: 'Peach',      preview: ['#fed7aa', '#fff7ed'] },
  { id: 'lavender',  label: 'Lavender',   preview: ['#ddd6fe', '#f5f3ff'] },
  { id: 'rose',      label: 'Rose',       preview: ['#fecdd3', '#fff1f2'] },
  { id: 'lemon',     label: 'Lemon',      preview: ['#fef08a', '#fefce8'] },
  { id: 'slate',     label: 'Slate',      preview: ['#cbd5e1', '#f8fafc'] },
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
      .use(checkboxClickPlugin)
      .use(spellcheckPlugin),
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
  // Color picker dropdowns use position:fixed with coords to escape the
  // overflow-x-auto toolbar scroll container.
  const [colorPickerPos, setColorPickerPos] = useState<{ top: number; left: number } | null>(null);
  const [highlightPickerPos, setHighlightPickerPos] = useState<{ top: number; left: number } | null>(null);
  const [suggestions, setSuggestions] = useState<WikilinkSuggestion>({
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
  const savedSelectionRef = useRef<{ from: number; to: number } | null>(null);
  const saveTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const currentFileRef = useRef(filePath);
  currentFileRef.current = filePath;
  const sugRef = useRef(suggestions);
  sugRef.current = suggestions;
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

    // Restore themes from localStorage
    try {
      const raw = localStorage.getItem(`jn-themes:${path}`);
      if (raw) {
        const entries = JSON.parse(raw) as Array<{ index: number; theme: string }>;
        if (Array.isArray(entries) && entries.length > 0) {
          restoreTableThemes(view, entries);
        }
      }
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

    // Install persistence functions — closed over this view+path
    persistThemesRef.current = () => {
      const currentPath = currentFileRef.current;
      if (!currentPath) return;
      try {
        const entries = serializeTableThemes(view.state);
        if (entries.length === 0) {
          localStorage.removeItem(`jn-themes:${currentPath}`);
        } else {
          localStorage.setItem(`jn-themes:${currentPath}`, JSON.stringify(entries));
        }
      } catch (_) { /* quota / parse errors are non-fatal */ }
    };
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
  }, []);

  // Register onOpenFile callback in the ProseMirror plugin so dblclick works
  useEffect(() => {
    if (onOpenFile) setOpenFileCallback(onOpenFile);
    return () => setOpenFileCallback(() => {});
  }, [onOpenFile]);

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

  useEffect(() => {
    refreshFileList();
    window.addEventListener('file-saved', refreshFileList);
    return () => window.removeEventListener('file-saved', refreshFileList);
  }, [refreshFileList]);

  // Wikilink suggestions
  useEffect(() => {
    subscribeToWikilinkSuggestions(s => setSuggestions({ ...s }));
    return () => unsubscribeWikilinkSuggestions();
  }, []);

  // Keyboard nav for dropdown
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

  // Load file
  useEffect(() => {
    if (!filePath) { setContent(''); return; }
    editorRef.current = null;
    setLoading(true);
    apiFetch(`/api/file?path=${encodeURIComponent(filePath)}`)
      .then(r => r.ok ? r.text() : Promise.reject(new Error('Load failed')))
      .then(text => { setContent(text); setEditorKey(k => k + 1); })
      .catch(() => { setContent('# Error loading file'); setEditorKey(k => k + 1); })
      .finally(() => setLoading(false));
  }, [filePath]);

  // Save
  const handleMarkdownChange = useCallback((md: string) => {
    const path = currentFileRef.current;
    if (!path) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      apiFetch('/api/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: md }),
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
  // action for F4 repeat.
  const cmdColor = useCallback((color: string | null) => {
    const view = getView();
    if (!view) return;
    const saved = savedSelectionRef.current;
    if (saved) {
      const tr = view.state.tr.setSelection(
        TextSelection.create(view.state.doc, saved.from, saved.to)
      );
      view.dispatch(tr);
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
      const tr = view.state.tr.setSelection(
        TextSelection.create(view.state.doc, saved.from, saved.to)
      );
      view.dispatch(tr);
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
                    const { from, to } = view.state.selection;
                    savedSelectionRef.current = { from, to };
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
                    const { from, to } = view.state.selection;
                    savedSelectionRef.current = { from, to };
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
          {/* Right actions — font size + template + bookmark */}
          <div className="flex items-center gap-0.5 px-2 flex-shrink-0">
            <ToolBtn title="Larger (Ctrl++)" onClick={() => setFontSize(p => Math.min(p + 1, 40))} style={{ fontWeight: 700, fontSize: 11 }}>A⁺</ToolBtn>
            <ToolBtn title="Smaller (Ctrl+-)" onClick={() => setFontSize(p => Math.max(p - 1, 8))} style={{ fontWeight: 500, fontSize: 10 }}>A⁻</ToolBtn>
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
            const { from, to } = view.state.selection;
            savedSelectionRef.current = { from, to };
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
                    const { from, to } = view.state.selection;
                    savedSelectionRef.current = { from, to };
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
                    const { from, to } = view.state.selection;
                    savedSelectionRef.current = { from, to };
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
                    const { from, to } = view.state.selection;
                    savedSelectionRef.current = { from, to };
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
                    const { from, to } = view.state.selection;
                    savedSelectionRef.current = { from, to };
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
