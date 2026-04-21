/**
 * MilkdownEditor.tsx — Milkdown 7 WYSIWYG editor for JayNotes
 */
import React, { useEffect, useRef, useState, useCallback, Component } from 'react';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/core';
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
  setAlignCommand,
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
  AlignLeft, AlignCenter, AlignRight,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import {
  tagDecoratorPlugin, wikilinkPlugin,
  setWikilinkFileList, setOpenFileCallback,
  subscribeToWikilinkSuggestions, unsubscribeWikilinkSuggestions,
  execWrapInList, execLiftBlockquote, execInsertChecklist,
  WikilinkSuggestion,
} from '../lib/milkdown-plugins';

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

// ─── Constants ────────────────────────────────────────────────────────────────

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28, 32];
const DEFAULT_FONT_SIZE = 15;

// ─── Inline Table Controls ────────────────────────────────────────────────────
// Renders contextual row/column controls directly adjacent to the active table,
// similar to Milkdown's own table UX. Positions itself over the editor container
// using getBoundingClientRect so it stays in sync with scroll.

interface TableControlsState {
  visible: boolean;
  tableRect: DOMRect | null;
  containerRect: DOMRect | null;
}

interface TableInlineControlsProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onCmd: (key: any, payload?: any) => void;
  addRowAfterKey: any;
  addRowBeforeKey: any;
  addColAfterKey: any;
  addColBeforeKey: any;
  deleteKey: any;
  alignKey: any;
}

const TableInlineControls: React.FC<TableInlineControlsProps> = ({
  containerRef, onCmd,
  addRowAfterKey, addRowBeforeKey, addColAfterKey, addColBeforeKey, deleteKey, alignKey,
}) => {
  const [state, setState] = useState<TableControlsState>({ visible: false, tableRect: null, containerRect: null });
  const rafRef = useRef<number>(0);

  const update = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    // Find the table that currently contains the cursor (ProseMirror sets .selectedCell or we find focused cell)
    const activeCell = container.querySelector('.ProseMirror td.selectedCell, .ProseMirror th.selectedCell') as HTMLElement | null;
    // Fallback: find table containing text cursor (selection inside td/th)
    const sel = window.getSelection();
    let tableEl: HTMLTableElement | null = null;
    if (activeCell) {
      tableEl = activeCell.closest('table') as HTMLTableElement | null;
    } else if (sel && sel.rangeCount > 0) {
      let node: Node | null = sel.getRangeAt(0).commonAncestorContainer;
      while (node && node !== container) {
        if ((node as HTMLElement).tagName === 'TABLE') { tableEl = node as HTMLTableElement; break; }
        node = node.parentNode;
      }
    }

    if (!tableEl) {
      setState(p => p.visible ? { visible: false, tableRect: null, containerRect: null } : p);
      return;
    }

    const tableRect = tableEl.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    setState({ visible: true, tableRect, containerRect });
  }, [containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const schedule = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(update);
    };

    // Listen on the container for mouse and selection events
    container.addEventListener('mouseup', schedule);
    container.addEventListener('keyup', schedule);
    container.addEventListener('click', schedule);
    document.addEventListener('selectionchange', schedule);

    return () => {
      container.removeEventListener('mouseup', schedule);
      container.removeEventListener('keyup', schedule);
      container.removeEventListener('click', schedule);
      document.removeEventListener('selectionchange', schedule);
      cancelAnimationFrame(rafRef.current);
    };
  }, [update, containerRef]);

  if (!state.visible || !state.tableRect || !state.containerRect) return null;

  const { tableRect, containerRect } = state;
  // Convert viewport coords → coords inside the scrollable container
  const container = containerRef.current!;
  const scrollLeft = container.scrollLeft;
  const scrollTop = container.scrollTop;
  const left = tableRect.left - containerRect.left + scrollLeft;
  const top = tableRect.top - containerRect.top + scrollTop;
  const width = tableRect.width;
  const height = tableRect.height;

  const btnBase: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', border: 'none', borderRadius: 4,
    background: 'var(--bg-secondary)', color: 'var(--text-muted)',
    fontSize: 11, fontWeight: 600, lineHeight: 1,
    transition: 'background 0.12s, color 0.12s',
  };

  const iconBtn = (title: string, label: string, onClick: () => void, danger = false): React.ReactNode => (
    <button
      key={title}
      title={title}
      onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      style={{
        ...btnBase,
        background: danger ? 'rgba(220,53,69,0.12)' : 'var(--bg-secondary)',
        color: danger ? '#e05a6a' : 'var(--text-muted)',
        width: 22, height: 22,
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.background = danger ? 'rgba(220,53,69,0.25)' : 'var(--interactive-hover)';
        (e.currentTarget as HTMLElement).style.color = danger ? '#ff6b7a' : 'var(--text-normal)';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.background = danger ? 'rgba(220,53,69,0.12)' : 'var(--bg-secondary)';
        (e.currentTarget as HTMLElement).style.color = danger ? '#e05a6a' : 'var(--text-muted)';
      }}
    >
      {label}
    </button>
  );

  const popupStyle: React.CSSProperties = {
    position: 'absolute', zIndex: 50,
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 6,
    boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
    padding: '3px 4px',
    display: 'flex', alignItems: 'center', gap: 2,
    pointerEvents: 'auto',
  };

  const divider = <div key="div" style={{ width: 1, height: 16, background: 'var(--border-color)', margin: '0 2px' }} />;

  return (
    <>
      {/* ── Column controls — centred above the table ── */}
      <div
        style={{
          ...popupStyle,
          top: top - 32,
          left: left + width / 2,
          transform: 'translateX(-50%)',
          flexDirection: 'row',
        }}
      >
        {iconBtn('Add column left', '←+', () => onCmd(addColBeforeKey))}
        {iconBtn('Add column right', '+→', () => onCmd(addColAfterKey))}
        {divider}
        {iconBtn('Align left', '⬤L', () => onCmd(alignKey, 'left'))}
        {iconBtn('Align center', '⬤C', () => onCmd(alignKey, 'center'))}
        {iconBtn('Align right', '⬤R', () => onCmd(alignKey, 'right'))}
        {divider}
        {iconBtn('Delete column', '✕Col', () => onCmd(deleteKey), true)}
      </div>

      {/* ── Row controls — centred to the left of the table ── */}
      <div
        style={{
          ...popupStyle,
          top: top + height / 2,
          left: left - 80,
          transform: 'translateY(-50%)',
          flexDirection: 'column',
          padding: '4px 3px',
        }}
      >
        {iconBtn('Add row above', '↑+', () => onCmd(addRowBeforeKey))}
        {iconBtn('Add row below', '+↓', () => onCmd(addRowAfterKey))}
        {divider}
        {iconBtn('Delete row', '✕Row', () => onCmd(deleteKey), true)}
      </div>
    </>
  );
};

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
        ctx.get(listenerCtx).markdownUpdated((_ctx, md) => onChangeRef.current(md));
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
      .use(tagDecoratorPlugin)
      .use(wikilinkPlugin),
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
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [suggestions, setSuggestions] = useState<WikilinkSuggestion>({
    active: false, query: '', from: 0, to: 0, suggestions: [], selectedIndex: 0, coords: null,
  });

  const editorRef = useRef<Editor | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const saveTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const currentFileRef = useRef(filePath);
  currentFileRef.current = filePath;
  const sugRef = useRef(suggestions);
  sugRef.current = suggestions;
  // Declared before early returns — fixes React error #300
  const noopReady = useCallback(() => {}, []);

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

  // Toolbar command (focus then rAF)
  const cmd = useCallback((command: any, payload?: any) => {
    const view = getView();
    if (view && !view.hasFocus()) view.focus();
    requestAnimationFrame(() => {
      try { editorRef.current?.action(callCommand(command, payload)); } catch (err) { console.warn('[cmd]', err); }
    });
  }, [getView]);

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
    requestAnimationFrame(() => { try { execInsertChecklist(view); } catch (err) { console.warn('[checklist]', err); } });
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

      {/* Header */}
      <div className="px-4 py-2 text-sm text-text-muted border-b border-border-color flex-shrink-0 flex items-center justify-between bg-bg-secondary/50 z-20">
        <div className="flex items-center gap-3 truncate">
          <FileText size={14} className="text-interactive-accent flex-shrink-0" />
          <span className="truncate font-medium text-text-normal">{filePath}</span>
        </div>
        <div className="flex items-center gap-1">
          {onToggleBookmark && (
            <button onClick={onToggleBookmark}
              className={`p-1.5 rounded transition-colors ${isBookmarked ? 'text-interactive-accent bg-interactive-accent/10' : 'text-text-muted hover:text-text-normal hover:bg-bg-secondary'}`}
              title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}>
              <Bookmark size={14} fill={isBookmarked ? 'currentColor' : 'none'} />
            </button>
          )}
          <span className="text-xs text-text-muted px-1 select-none tabular-nums" title="Ctrl+= / Ctrl+- / Ctrl+0">{fontSize}px</span>
          <div className="relative">
            <button onClick={() => setIsTemplateMenuOpen(o => !o)}
              className={`p-1.5 rounded transition-colors ${isTemplateMenuOpen ? 'text-interactive-accent bg-interactive-accent/10' : 'text-text-muted hover:text-text-normal hover:bg-bg-secondary'}`}
              title="Insert Template">
              <ClipboardList size={14} />
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
        </div>
      </div>

      {/* Main toolbar */}
      <div className="format-toolbar">
        {/* Inline formatting */}
        <ToolBtn title="Bold (Ctrl+B)" onClick={() => cmd(toggleStrongCommand.key)}><Bold size={13} /></ToolBtn>
        <ToolBtn title="Italic (Ctrl+I)" onClick={() => cmd(toggleEmphasisCommand.key)}><Italic size={13} /></ToolBtn>
        <ToolBtn title="Strikethrough" onClick={() => cmd(toggleStrikethroughCommand.key)}><Strikethrough size={13} /></ToolBtn>
        <ToolBtn title="Inline code" onClick={() => cmd(toggleInlineCodeCommand.key)}><Code size={13} /></ToolBtn>

        <div className="format-toolbar-separator" />

        {/* Headings */}
        <ToolBtn title="Heading 1" onClick={() => cmd(wrapInHeadingCommand.key, 1)} style={{ fontWeight: 700, fontSize: 12 }}>H1</ToolBtn>
        <ToolBtn title="Heading 2" onClick={() => cmd(wrapInHeadingCommand.key, 2)} style={{ fontWeight: 700, fontSize: 11 }}>H2</ToolBtn>
        <ToolBtn title="Heading 3" onClick={() => cmd(wrapInHeadingCommand.key, 3)} style={{ fontWeight: 700, fontSize: 10 }}>H3</ToolBtn>
        <ToolBtn title="Plain paragraph" onClick={() => cmd(turnIntoTextCommand.key)} style={{ fontSize: 10 }}>¶</ToolBtn>

        <div className="format-toolbar-separator" />

        {/* Lists */}
        <ToolBtn title="Bullet list (select multiple lines first)" onClick={() => cmdList('bullet_list')}><List size={13} /></ToolBtn>
        <ToolBtn title="Ordered list (select multiple lines first)" onClick={() => cmdList('ordered_list')}><ListOrdered size={13} /></ToolBtn>
        <ToolBtn title="Task / checklist item" onClick={cmdChecklist}><CheckSquare size={13} /></ToolBtn>

        <div className="format-toolbar-separator" />

        {/* Block */}
        <ToolBtn title="Blockquote (click again to remove)" onClick={cmdBlockquote}><Quote size={13} /></ToolBtn>
        <ToolBtn title="Horizontal rule" onClick={() => cmd(insertHrCommand.key)}><Minus size={13} /></ToolBtn>

        <div className="format-toolbar-separator" />

        {/* Table */}
        <ToolBtn title="Insert table" onClick={() => { cmd(insertTableCommand.key); setShowTableTools(true); }}>
          <Table size={13} />
        </ToolBtn>
        <button
          className={`format-toolbar-btn${showTableTools ? ' active' : ''}`}
          title="Toggle table toolbar"
          onClick={() => setShowTableTools(t => !t)}
          style={{ fontSize: 9, fontWeight: 600 }}
        >
          TBL▾
        </button>

        <div className="format-toolbar-separator" />

        {/* Font size */}
        <select title="Font size" value={FONT_SIZES.includes(fontSize) ? fontSize : ''}
          onChange={e => setFontSize(Number(e.target.value))}>
          {FONT_SIZES.map(s => <option key={s} value={s}>{s}px</option>)}
          {!FONT_SIZES.includes(fontSize) && <option value={fontSize}>{fontSize}px</option>}
        </select>
        <ToolBtn title="Larger (Ctrl++)" onClick={() => setFontSize(p => Math.min(p + 1, 40))} style={{ fontWeight: 700, fontSize: 13 }}>A⁺</ToolBtn>
        <ToolBtn title="Smaller (Ctrl+-)" onClick={() => setFontSize(p => Math.max(p - 1, 8))} style={{ fontWeight: 500, fontSize: 11 }}>A⁻</ToolBtn>
        <ToolBtn title="Reset font (Ctrl+0)" onClick={() => setFontSize(DEFAULT_FONT_SIZE)} style={{ fontSize: 10 }}>↺</ToolBtn>
      </div>

      {/* Table toolbar — shown when cursor is in a table or toggled on */}
      {showTableTools && (
        <div className="format-toolbar" style={{ borderTop: '1px solid var(--border-color)', background: 'rgba(0,200,130,0.04)' }}>
          <span className="text-xs text-text-muted px-1 select-none" style={{ opacity: 0.6 }}>Table:</span>
          <ToolBtn title="Add column after" onClick={() => cmd(addColAfterCommand.key)}>
            <span style={{ fontSize: 10, fontWeight: 600 }}>+Col→</span>
          </ToolBtn>
          <ToolBtn title="Add column before" onClick={() => cmd(addColBeforeCommand.key)}>
            <span style={{ fontSize: 10, fontWeight: 600 }}>←Col+</span>
          </ToolBtn>
          <ToolBtn title="Add row after" onClick={() => cmd(addRowAfterCommand.key)}>
            <span style={{ fontSize: 10, fontWeight: 600 }}>+Row↓</span>
          </ToolBtn>
          <ToolBtn title="Add row before" onClick={() => cmd(addRowBeforeCommand.key)}>
            <span style={{ fontSize: 10, fontWeight: 600 }}>↑Row+</span>
          </ToolBtn>
          <div className="format-toolbar-separator" />
          <ToolBtn title="Delete selected cell(s)" danger onClick={() => cmd(deleteSelectedCellsCommand.key)}>
            <span style={{ fontSize: 10, fontWeight: 600 }}>Del</span>
          </ToolBtn>
          <div className="format-toolbar-separator" />
          <ToolBtn title="Align left" onClick={() => cmd(setAlignCommand.key, 'left')}><AlignLeft size={12} /></ToolBtn>
          <ToolBtn title="Align center" onClick={() => cmd(setAlignCommand.key, 'center')}><AlignCenter size={12} /></ToolBtn>
          <ToolBtn title="Align right" onClick={() => cmd(setAlignCommand.key, 'right')}><AlignRight size={12} /></ToolBtn>
          <div className="format-toolbar-separator" />
          <span className="text-xs text-text-muted px-1 select-none" style={{ opacity: 0.5 }}>Tab=next cell · Shift+Tab=prev</span>
        </div>
      )}

      {/* Editor + wikilink dropdown */}
      <div ref={editorContainerRef} className="flex-grow min-w-0 overflow-auto custom-scrollbar relative">
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
        {/* Inline table controls — appear adjacent to the active table */}
        <TableInlineControls
          containerRef={editorContainerRef}
          onCmd={(key, payload) => cmd(key, payload)}
          addRowAfterKey={addRowAfterCommand.key}
          addRowBeforeKey={addRowBeforeCommand.key}
          addColAfterKey={addColAfterCommand.key}
          addColBeforeKey={addColBeforeCommand.key}
          deleteKey={deleteSelectedCellsCommand.key}
          alignKey={setAlignCommand.key}
        />
        <div className="milkdown-wrapper h-full">
          <MilkdownProvider>
            <InnerMilkdown
              key={editorKey}
              initialContent={content}
              editorRef={editorRef}
              onMarkdownChange={handleMarkdownChange}
              onReady={noopReady}
            />
          </MilkdownProvider>
        </div>
      </div>
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
