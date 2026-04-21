/**
 * MilkdownEditor.tsx — WYSIWYG markdown editor built on Milkdown 7
 *
 * Features:
 *  - Full WYSIWYG editing (bold, italic, strike, headings, lists, code, tables)
 *  - GFM: strikethrough, task lists, tables (via @milkdown/preset-gfm)
 *  - Paste/drop image upload → /api/upload → real server URL in document
 *  - Proper onChange via @milkdown/plugin-listener (no MutationObserver)
 *  - Auto-save with 600ms debounce
 *  - Functional toolbar: bold, italic, strike, H1/H2/H3, bullet, ordered,
 *    task list, blockquote, inline code, horizontal rule
 *  - Font scaling via Ctrl +/- /0 and toolbar
 *  - Template insertion, bookmark toggle
 *  - Trailing newline plugin so cursor never gets stuck at end
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/core';
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
} from '@milkdown/preset-commonmark';
import {
  gfm,
  toggleStrikethroughCommand,
  insertTableCommand,
} from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import { upload, uploadConfig } from '@milkdown/plugin-upload';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { trailing } from '@milkdown/plugin-trailing';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { callCommand } from '@milkdown/utils';
import {
  Bookmark, FileText, ClipboardList,
  Bold, Italic, Strikethrough, List, ListOrdered,
  CheckSquare, Heading1, Heading2, Heading3,
  Code, Quote, Minus, Table,
} from 'lucide-react';
import { apiFetch } from '../lib/api';

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
  if (!data.path) throw new Error('Server returned no path');
  return `/api/${data.path}?token=${encodeURIComponent(token ?? '')}`;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28, 32];
const DEFAULT_FONT_SIZE = 15;

// ─── Inner editor (must live inside MilkdownProvider) ────────────────────────

interface InnerProps {
  initialContent: string;
  editorRef: React.MutableRefObject<Editor | null>;
  onMarkdownChange: (md: string) => void;
  onReady: () => void;
}

const InnerMilkdown: React.FC<InnerProps> = ({
  initialContent,
  editorRef,
  onMarkdownChange,
  onReady,
}) => {
  // Stable callback refs so useEditor deps don't change on every render
  const onChangeRef = useRef(onMarkdownChange);
  onChangeRef.current = onMarkdownChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const { loading, get } = useEditor(
    (root) =>
      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, initialContent);

          // Listener: fires on every markdown change
          ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
            onChangeRef.current(markdown);
          });

          // Image upload config
          ctx.update(uploadConfig.key, (prev) => ({
            ...prev,
            enableHtmlFileUploader: true,
            uploader: async (files: FileList, schema: any) => {
              const nodes: any[] = [];
              for (const file of Array.from(files)) {
                if (!file.type.startsWith('image/')) continue;
                try {
                  const url = await uploadImageToServer(file);
                  const node = schema.nodes.image?.createAndFill({
                    src: url,
                    alt: file.name,
                    title: '',
                  });
                  if (node) nodes.push(node);
                } catch (err) {
                  console.error('[MilkdownEditor] upload error:', err);
                }
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
        .use(trailing),
    [] // empty deps — initialContent is set via defaultValueCtx once
  );

  useEffect(() => {
    if (!loading) {
      const inst = get();
      if (inst) {
        editorRef.current = inst;
        onReadyRef.current();
      }
    }
  }, [loading, get, editorRef]);

  return <Milkdown />;
};

// ─── Toolbar button helper ────────────────────────────────────────────────────

const ToolBtn: React.FC<{
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ title, onClick, children, style }) => (
  <button className="format-toolbar-btn" title={title} onClick={onClick} style={style}>
    {children}
  </button>
);

// ─── Main exported component ──────────────────────────────────────────────────

export const MilkdownEditor: React.FC<MilkdownEditorProps> = ({
  filePath,
  isBookmarked,
  onToggleBookmark,
  templates = [],
}) => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [editorReady, setEditorReady] = useState(false);
  const [isTemplateMenuOpen, setIsTemplateMenuOpen] = useState(false);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);

  const editorRef = useRef<Editor | null>(null);
  const saveTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const currentFileRef = useRef(filePath);
  currentFileRef.current = filePath;
  // Track latest markdown so template append works
  const latestMdRef = useRef('');

  // ── Font size CSS var ──────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.style.setProperty('--editor-font-size', `${fontSize}px`);
  }, [fontSize]);

  // ── Ctrl +/- /0 ───────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); setFontSize(p => Math.min(p + 1, 40)); }
      else if (e.key === '-') { e.preventDefault(); setFontSize(p => Math.max(p - 1, 8)); }
      else if (e.key === '0') { e.preventDefault(); setFontSize(DEFAULT_FONT_SIZE); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Load file ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!filePath) { setContent(''); return; }
    setEditorReady(false);
    editorRef.current = null;
    latestMdRef.current = '';
    setLoading(true);
    apiFetch(`/api/file?path=${encodeURIComponent(filePath)}`)
      .then(r => (r.ok ? r.text() : Promise.reject('load-error')))
      .then(text => {
        setContent(text);
        latestMdRef.current = text;
        setEditorKey(k => k + 1);
      })
      .catch(() => {
        const err = '# Error loading file';
        setContent(err);
        latestMdRef.current = err;
        setEditorKey(k => k + 1);
      })
      .finally(() => setLoading(false));
  }, [filePath]);

  // ── Save handler (called by listener plugin) ───────────────────────────────
  const handleMarkdownChange = useCallback((md: string) => {
    latestMdRef.current = md;
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
        .catch(err => console.error('[MilkdownEditor] save error:', err));
    }, 600);
  }, []);

  // ── Toolbar command helper ─────────────────────────────────────────────────
  const cmd = useCallback((command: any, payload?: any) => {
    const inst = editorRef.current;
    if (!inst) return;
    inst.action(callCommand(command, payload));
  }, []);

  // ── Template insertion ─────────────────────────────────────────────────────
  const handleApplyTemplate = async (t: { name: string; path: string; type: string }) => {
    try {
      const res = await apiFetch(`/api/file?path=${encodeURIComponent(t.path)}`);
      if (!res.ok) return;
      let tmpl = await res.text();
      tmpl = tmpl.replace(/{{date}}/g, new Date().toISOString().split('T')[0]);
      const inst = editorRef.current;
      if (inst) {
        // Use insert utility to append at end
        const { insert } = await import('@milkdown/utils');
        inst.action(insert('\n\n' + tmpl));
      }
      setIsTemplateMenuOpen(false);
    } catch (err) {
      console.error('[MilkdownEditor] template error:', err);
    }
  };

  const handleReady = useCallback(() => setEditorReady(true), []);

  // ── Empty / loading states ─────────────────────────────────────────────────
  if (!filePath) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted bg-bg-primary">
        <div className="text-center flex flex-col items-center">
          <div className="w-24 h-24 mb-6 opacity-10">
            <svg viewBox="0 0 100 100" fill="currentColor">
              <path d="M50 0 L93.3 25 L93.3 75 L50 100 L6.7 75 L6.7 25 Z" />
            </svg>
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

  if (loading) {
    return <div className="h-full flex items-center justify-center text-text-muted">Loading…</div>;
  }

  return (
    <div className="h-full w-full flex flex-col min-w-0 overflow-hidden bg-bg-primary">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="px-4 py-2 text-sm text-text-muted border-b border-border-color flex-shrink-0 flex items-center justify-between bg-bg-secondary/50 backdrop-blur-sm z-20">
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
          <span className="text-xs text-text-muted px-1 select-none tabular-nums"
            title="Ctrl+= / Ctrl+- to scale | Ctrl+0 to reset">{fontSize}px</span>
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

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
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
        <ToolBtn title="Bullet list" onClick={() => cmd(wrapInBulletListCommand.key)}><List size={13} /></ToolBtn>
        <ToolBtn title="Ordered list" onClick={() => cmd(wrapInOrderedListCommand.key)}><ListOrdered size={13} /></ToolBtn>
        <ToolBtn title="Task list (type [ ] in a bullet)" onClick={() => {
          // Insert a task list item via markdown input rule
          cmd(wrapInBulletListCommand.key);
        }}><CheckSquare size={13} /></ToolBtn>

        <div className="format-toolbar-separator" />

        {/* Block elements */}
        <ToolBtn title="Blockquote" onClick={() => cmd(wrapInBlockquoteCommand.key)}><Quote size={13} /></ToolBtn>
        <ToolBtn title="Horizontal rule" onClick={() => cmd(insertHrCommand.key)}><Minus size={13} /></ToolBtn>
        <ToolBtn title="Insert table" onClick={() => cmd(insertTableCommand.key)}><Table size={13} /></ToolBtn>

        <div className="format-toolbar-separator" />

        {/* Font size */}
        <select title="Font size"
          value={FONT_SIZES.includes(fontSize) ? fontSize : ''}
          onChange={e => setFontSize(Number(e.target.value))}>
          {FONT_SIZES.map(s => <option key={s} value={s}>{s}px</option>)}
          {!FONT_SIZES.includes(fontSize) && <option value={fontSize}>{fontSize}px</option>}
        </select>
        <ToolBtn title="Increase font (Ctrl++)" onClick={() => setFontSize(p => Math.min(p + 1, 40))} style={{ fontWeight: 700, fontSize: 13 }}>A⁺</ToolBtn>
        <ToolBtn title="Decrease font (Ctrl+-)" onClick={() => setFontSize(p => Math.max(p - 1, 8))} style={{ fontWeight: 500, fontSize: 11 }}>A⁻</ToolBtn>
        <ToolBtn title="Reset font (Ctrl+0)" onClick={() => setFontSize(DEFAULT_FONT_SIZE)} style={{ fontSize: 10 }}>↺</ToolBtn>
      </div>

      {/* ── Milkdown WYSIWYG editor ──────────────────────────────────────── */}
      <div className="milkdown-wrapper flex-grow min-w-0 overflow-auto custom-scrollbar">
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
  );
};
