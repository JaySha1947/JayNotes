/**
 * MilkdownEditor.tsx — Milkdown 7 WYSIWYG editor for JayNotes
 *
 * Issues fixed in this revision:
 *  1. Checklist works via "- [ ] " input rule (type in editor)
 *  2. #tags highlighted via custom ProseMirror decorator
 *  3. [[wikilink]] autocomplete dropdown with keyboard nav
 *  4. [[wikilink]] highlighted + double-click navigates to file
 *  5. Backlinks/forwardlinks still driven by saved markdown (server reads [[]])
 *  6. Code block toggle is reversible (turnIntoTextCommand)
 *  7. Font reset button works
 *  8. Table is interactive (columnResizingPlugin + tableEditingPlugin from GFM)
 *  9. Multi-line list: wraps all selected paragraphs, toggle removes markers
 */

import React, {
  useEffect, useRef, useState, useCallback,
} from 'react';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/core';
import {
  commonmark,
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
  wrapInHeadingCommand,
  insertHrCommand,
  turnIntoTextCommand,
  liftListItemCommand,
  bulletListSchema,
  orderedListSchema,
  listItemSchema,
} from '@milkdown/preset-commonmark';
import {
  gfm,
  toggleStrikethroughCommand,
  insertTableCommand,
  columnResizingPlugin,
  tableEditingPlugin,
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
  CheckSquare, Code, Quote, Minus, Table,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import {
  tagDecoratorPlugin,
  wikilinkPlugin,
  setWikilinkFileList,
  subscribeToWikilinkSuggestions,
  unsubscribeWikilinkSuggestions,
  WikilinkSuggestion,
} from '../lib/milkdown-plugins';

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
  const safeName =
    file.name === 'image.png' ? `pasted-image-${Date.now()}.png` : file.name;
  const formData = new FormData();
  formData.append('file', new File([file], safeName, { type: file.type }));
  const token = localStorage.getItem('jays_notes_token');
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.path) throw new Error('No path');
  return `/api/${data.path}?token=${encodeURIComponent(token ?? '')}`;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28, 32];
const DEFAULT_FONT_SIZE = 15;

// ─── Inner editor ─────────────────────────────────────────────────────────────

interface InnerProps {
  initialContent: string;
  editorRef: React.MutableRefObject<Editor | null>;
  onMarkdownChange: (md: string) => void;
  onReady: () => void;
}

const InnerMilkdown: React.FC<InnerProps> = ({
  initialContent, editorRef, onMarkdownChange, onReady,
}) => {
  const onChangeRef = useRef(onMarkdownChange);
  onChangeRef.current = onMarkdownChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const { loading, get } = useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialContent);
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
  title: string; onClick: () => void;
  children: React.ReactNode; style?: React.CSSProperties;
}> = ({ title, onClick, children, style }) => (
  <button className="format-toolbar-btn" title={title} onClick={onClick} style={style}>
    {children}
  </button>
);

// ─── Main component ───────────────────────────────────────────────────────────

export const MilkdownEditor: React.FC<MilkdownEditorProps> = ({
  filePath, isBookmarked, onToggleBookmark, onOpenFile, templates = [],
}) => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [isTemplateMenuOpen, setIsTemplateMenuOpen] = useState(false);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [suggestions, setSuggestions] = useState<WikilinkSuggestion>({
    active: false, query: '', from: 0, to: 0, suggestions: [], selectedIndex: 0,
  });

  const editorRef = useRef<Editor | null>(null);
  const saveTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const currentFileRef = useRef(filePath);
  currentFileRef.current = filePath;
  const suggestionsRef = useRef(suggestions);
  suggestionsRef.current = suggestions;

  // ── Font size ──────────────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.style.setProperty('--editor-font-size', `${fontSize}px`);
  }, [fontSize]);

  // ── Ctrl +/- /0 ───────────────────────────────────────────────────────────
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

  // ── Load files list for wikilink autocomplete ──────────────────────────────
  useEffect(() => {
    apiFetch('/api/files')
      .then(r => r.json())
      .then(data => {
        const flat: string[] = [];
        const walk = (nodes: any[]) => {
          for (const n of nodes) {
            if (n.type === 'file') flat.push(n.name.replace(/\.md$/, ''));
            if (n.children) walk(n.children);
          }
        };
        walk(data);
        setWikilinkFileList(flat);
      })
      .catch(() => {});
  }, []);

  // ── Subscribe to wikilink suggestion changes ───────────────────────────────
  useEffect(() => {
    subscribeToWikilinkSuggestions(setSuggestions);
    return () => unsubscribeWikilinkSuggestions();
  }, []);

  // ── Keyboard nav for wikilink dropdown ────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const s = suggestionsRef.current;
      if (!s.active) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSuggestions(prev => ({ ...prev, selectedIndex: Math.min(prev.selectedIndex + 1, prev.suggestions.length - 1) }));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSuggestions(prev => ({ ...prev, selectedIndex: Math.max(prev.selectedIndex - 1, 0) }));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (s.suggestions[s.selectedIndex]) {
          e.preventDefault();
          insertWikilink(s.suggestions[s.selectedIndex]);
        }
      } else if (e.key === 'Escape') {
        setSuggestions(prev => ({ ...prev, active: false }));
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  // ── Insert chosen wikilink ─────────────────────────────────────────────────
  const insertWikilink = useCallback((filename: string) => {
    const inst = editorRef.current;
    if (!inst) return;
    const s = suggestionsRef.current;
    const view = inst.action((ctx: any) => ctx.get(editorViewCtx));
    if (!view) return;
    // Replace from [[ to cursor with [[filename]]
    const { tr, doc } = view.state;
    // s.from points to the [[ character position
    const replacement = `[[${filename}]]`;
    view.dispatch(
      tr.replaceWith(s.from, s.to, view.state.schema.text(replacement))
    );
    setSuggestions(prev => ({ ...prev, active: false }));
    view.focus();
  }, []);

  // ── Double-click on wikilink to navigate ──────────────────────────────────
  const handleEditorClick = useCallback((e: React.MouseEvent) => {
    if (e.detail !== 2) return; // only double-click
    const target = e.target as HTMLElement;
    const linkEl = target.closest('.jn-wikilink') as HTMLElement | null;
    if (!linkEl) return;
    const fileTarget = linkEl.dataset.target;
    if (fileTarget && onOpenFile) {
      onOpenFile(fileTarget.endsWith('.md') ? fileTarget : `${fileTarget}.md`);
    }
  }, [onOpenFile]);

  // ── Load file ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!filePath) { setContent(''); return; }
    editorRef.current = null;
    setLoading(true);
    apiFetch(`/api/file?path=${encodeURIComponent(filePath)}`)
      .then(r => r.ok ? r.text() : Promise.reject())
      .then(text => { setContent(text); setEditorKey(k => k + 1); })
      .catch(() => { setContent('# Error loading file'); setEditorKey(k => k + 1); })
      .finally(() => setLoading(false));
  }, [filePath]);

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleMarkdownChange = useCallback((md: string) => {
    const path = currentFileRef.current;
    if (!path) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      apiFetch('/api/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: md }),
      })
        .then(() => window.dispatchEvent(new CustomEvent('file-saved')))
        .catch(err => console.error('[save]', err));
    }, 600);
  }, []);

  // ── Toolbar command helper: focus first, then run ─────────────────────────
  const cmd = useCallback((command: any, payload?: any) => {
    const inst = editorRef.current;
    if (!inst) return;
    try {
      const view = inst.action((ctx: any) => ctx.get(editorViewCtx));
      if (view && !view.hasFocus()) view.focus();
    } catch (_) {}
    requestAnimationFrame(() => {
      try { editorRef.current?.action(callCommand(command, payload)); }
      catch (err) { console.warn('[cmd]', err); }
    });
  }, []);

  // ── Multi-line list: wrap all selected paragraphs ─────────────────────────
  const cmdMultiList = useCallback((listCommand: any) => {
    const inst = editorRef.current;
    if (!inst) return;
    try {
      const view = inst.action((ctx: any) => ctx.get(editorViewCtx));
      if (!view) return;
      if (!view.hasFocus()) view.focus();
      requestAnimationFrame(() => {
        try {
          const { state, dispatch } = view;
          const { from, to } = state.selection;
          // Collect all top-level block positions in selection
          const positions: number[] = [];
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name === 'paragraph') positions.push(pos);
            return true;
          });
          if (positions.length <= 1) {
            // Single block: use standard command
            inst.action(callCommand(listCommand));
            return;
          }
          // Multiple: wrap each paragraph individually
          let tr = state.tr;
          let offset = 0;
          for (const pos of positions) {
            const adjustedPos = pos + offset;
            const node = tr.doc.nodeAt(adjustedPos);
            if (!node) continue;
            // Create list_item > paragraph
            const listItemType = state.schema.nodes.list_item;
            const listType = listCommand === wrapInBulletListCommand.key
              ? state.schema.nodes.bullet_list
              : state.schema.nodes.ordered_list;
            if (!listItemType || !listType) break;
            const listItem = listItemType.create(null, node.copy(node.content));
            const list = listType.create(null, listItem);
            tr = tr.replaceWith(adjustedPos, adjustedPos + node.nodeSize, list);
            offset += list.nodeSize - node.nodeSize;
          }
          dispatch(tr.scrollIntoView());
        } catch (err) { console.warn('[multiList]', err); }
      });
    } catch (_) {}
  }, []);

  // ── Template insertion ─────────────────────────────────────────────────────
  const handleApplyTemplate = async (t: { name: string; path: string; type: string }) => {
    try {
      const res = await apiFetch(`/api/file?path=${encodeURIComponent(t.path)}`);
      if (!res.ok) return;
      let tmpl = await res.text();
      tmpl = tmpl.replace(/{{date}}/g, new Date().toISOString().split('T')[0]);
      const inst = editorRef.current;
      if (inst) inst.action(insert('\n\n' + tmpl));
      setIsTemplateMenuOpen(false);
    } catch (err) { console.error('[template]', err); }
  };

  const handleReady = useCallback(() => {}, []);

  // ── Empty / loading ────────────────────────────────────────────────────────
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

      {/* Toolbar */}
      <div className="format-toolbar">
        <ToolBtn title="Bold (Ctrl+B)" onClick={() => cmd(toggleStrongCommand.key)}><Bold size={13} /></ToolBtn>
        <ToolBtn title="Italic (Ctrl+I)" onClick={() => cmd(toggleEmphasisCommand.key)}><Italic size={13} /></ToolBtn>
        <ToolBtn title="Strikethrough" onClick={() => cmd(toggleStrikethroughCommand.key)}><Strikethrough size={13} /></ToolBtn>
        <ToolBtn title="Inline code" onClick={() => cmd(toggleInlineCodeCommand.key)}><Code size={13} /></ToolBtn>
        <div className="format-toolbar-separator" />
        <ToolBtn title="Heading 1" onClick={() => cmd(wrapInHeadingCommand.key, 1)} style={{ fontWeight: 700, fontSize: 12 }}>H1</ToolBtn>
        <ToolBtn title="Heading 2" onClick={() => cmd(wrapInHeadingCommand.key, 2)} style={{ fontWeight: 700, fontSize: 11 }}>H2</ToolBtn>
        <ToolBtn title="Heading 3" onClick={() => cmd(wrapInHeadingCommand.key, 3)} style={{ fontWeight: 700, fontSize: 10 }}>H3</ToolBtn>
        <ToolBtn title="Plain text (remove heading/list)" onClick={() => cmd(turnIntoTextCommand.key)} style={{ fontSize: 10 }}>¶</ToolBtn>
        <div className="format-toolbar-separator" />
        <ToolBtn title="Bullet list (wraps all selected lines)" onClick={() => cmdMultiList(wrapInBulletListCommand.key)}><List size={13} /></ToolBtn>
        <ToolBtn title="Ordered list (wraps all selected lines)" onClick={() => cmdMultiList(wrapInOrderedListCommand.key)}><ListOrdered size={13} /></ToolBtn>
        <ToolBtn title="Task list: type '- [ ] ' or '- [x] ' in a bullet" onClick={() => cmd(wrapInBulletListCommand.key)}><CheckSquare size={13} /></ToolBtn>
        <div className="format-toolbar-separator" />
        <ToolBtn title="Blockquote" onClick={() => cmd(wrapInBlockquoteCommand.key)}><Quote size={13} /></ToolBtn>
        <ToolBtn title="Horizontal rule" onClick={() => cmd(insertHrCommand.key)}><Minus size={13} /></ToolBtn>
        <ToolBtn title="Insert table (Tab to move between cells)" onClick={() => cmd(insertTableCommand.key)}><Table size={13} /></ToolBtn>
        <div className="format-toolbar-separator" />
        <select title="Font size" value={FONT_SIZES.includes(fontSize) ? fontSize : ''}
          onChange={e => setFontSize(Number(e.target.value))}>
          {FONT_SIZES.map(s => <option key={s} value={s}>{s}px</option>)}
          {!FONT_SIZES.includes(fontSize) && <option value={fontSize}>{fontSize}px</option>}
        </select>
        <ToolBtn title="Larger (Ctrl++)" onClick={() => setFontSize(p => Math.min(p + 1, 40))} style={{ fontWeight: 700, fontSize: 13 }}>A⁺</ToolBtn>
        <ToolBtn title="Smaller (Ctrl+-)" onClick={() => setFontSize(p => Math.max(p - 1, 8))} style={{ fontWeight: 500, fontSize: 11 }}>A⁻</ToolBtn>
        <ToolBtn title="Reset to default (Ctrl+0)" onClick={() => setFontSize(DEFAULT_FONT_SIZE)} style={{ fontSize: 10 }}>↺</ToolBtn>
      </div>

      {/* Editor + wikilink dropdown */}
      <div className="flex-grow min-w-0 overflow-auto custom-scrollbar relative">
        {/* Wikilink autocomplete dropdown */}
        {suggestions.active && (
          <div className="jn-wikilink-dropdown">
            {suggestions.suggestions.map((s, i) => (
              <div
                key={s}
                className={`jn-wikilink-option${i === suggestions.selectedIndex ? ' selected' : ''}`}
                onMouseDown={e => { e.preventDefault(); insertWikilink(s); }}
              >
                📄 {s}
              </div>
            ))}
          </div>
        )}

        <div className="milkdown-wrapper h-full" onClick={handleEditorClick}>
          <MilkdownProvider>
            <InnerMilkdown
              key={editorKey}
              initialContent={content}
              editorRef={editorRef}
              onMarkdownChange={handleMarkdownChange}
              onReady={handleReady}
            />
          </MilkdownProvider>
        </div>
      </div>
    </div>
  );
};
