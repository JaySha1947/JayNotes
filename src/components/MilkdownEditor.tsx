/**
 * MilkdownEditor.tsx — WYSIWYG markdown editor built on Milkdown 7
 *
 * Features:
 *  - Full WYSIWYG editing (bold, italic, lists, headings, code, etc.)
 *  - Paste-to-upload images → /api/upload → inserts real URL into document
 *  - Auto-save with 600ms debounce
 *  - Font scaling via Ctrl +/- /0 and toolbar controls
 *  - Template insertion
 *  - Bookmark toggle
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { history } from '@milkdown/plugin-history';
import { upload, uploadConfig } from '@milkdown/plugin-upload';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { getMarkdown, replaceAll } from '@milkdown/utils';
import { Bookmark, FileText, ClipboardList } from 'lucide-react';
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

// ─── Image upload helper ──────────────────────────────────────────────────────

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
  // append token so image loads correctly via authenticated endpoint
  return `/api/${data.path}?token=${encodeURIComponent(token ?? '')}`;
}

// ─── Font size constants ──────────────────────────────────────────────────────

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28, 32];
const DEFAULT_FONT_SIZE = 15;

// ─── Inner editor component (must live inside MilkdownProvider) ───────────────

interface InnerProps {
  initialContent: string;
  editorRef: React.MutableRefObject<Editor | null>;
  onReady: () => void;
}

const InnerMilkdown: React.FC<InnerProps> = ({ initialContent, editorRef, onReady }) => {
  const { loading, get } = useEditor(
    (root) =>
      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, initialContent);

          // Configure the upload plugin with our server uploader
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
                  console.error('[MilkdownEditor] image upload failed:', err);
                }
              }
              return nodes;
            },
          }));
        })
        .use(commonmark)
        .use(history)
        .use(upload),
    [initialContent]
  );

  // Once editor is ready, expose the instance via ref
  useEffect(() => {
    if (!loading) {
      const instance = get();
      if (instance) {
        editorRef.current = instance;
        onReady();
      }
    }
  }, [loading, get, editorRef, onReady]);

  return <Milkdown />;
};

// ─── Main exported component ──────────────────────────────────────────────────

export const MilkdownEditor: React.FC<MilkdownEditorProps> = ({
  filePath,
  isBookmarked,
  onToggleBookmark,
  templates = [],
}) => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [editorKey, setEditorKey] = useState(0);   // remount on file change
  const [editorReady, setEditorReady] = useState(false);
  const [isTemplateMenuOpen, setIsTemplateMenuOpen] = useState(false);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);

  const editorInstanceRef = useRef<Editor | null>(null);
  const saveTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const currentFileRef = useRef(filePath);
  currentFileRef.current = filePath;

  // ── Font size CSS variable ─────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.style.setProperty('--editor-font-size', `${fontSize}px`);
  }, [fontSize]);

  // ── Ctrl +/- /0 keyboard scaling ──────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); setFontSize(p => Math.min(p + 1, 40)); }
      else if (e.key === '-') { e.preventDefault(); setFontSize(p => Math.max(p - 1, 8)); }
      else if (e.key === '0') { e.preventDefault(); setFontSize(DEFAULT_FONT_SIZE); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Load file ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!filePath) { setContent(''); return; }
    setEditorReady(false);
    editorInstanceRef.current = null;
    setLoading(true);
    apiFetch(`/api/file?path=${encodeURIComponent(filePath)}`)
      .then(r => (r.ok ? r.text() : Promise.reject('load-error')))
      .then(text => {
        setContent(text);
        setEditorKey(k => k + 1);
      })
      .catch(() => {
        setContent('# Error loading file');
        setEditorKey(k => k + 1);
      })
      .finally(() => setLoading(false));
  }, [filePath]);

  // ── Auto-save via MutationObserver on editor DOM changes ──────────────────
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editorReady) return;
    const container = wrapperRef.current;
    if (!container) return;
    let lastMd = '';

    const save = () => {
      const inst = editorInstanceRef.current;
      if (!inst) return;
      const md = inst.action(getMarkdown());
      if (!md || md === lastMd) return;
      lastMd = md;
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
    };

    const obs = new MutationObserver(save);
    obs.observe(container, { subtree: true, childList: true, characterData: true });
    return () => obs.disconnect();
  }, [editorReady]);

  // ── Template insertion ─────────────────────────────────────────────────────
  const handleApplyTemplate = async (t: { name: string; path: string; type: string }) => {
    try {
      const res = await apiFetch(`/api/file?path=${encodeURIComponent(t.path)}`);
      if (!res.ok) return;
      let tmpl = await res.text();
      tmpl = tmpl.replace(/{{date}}/g, new Date().toISOString().split('T')[0]);
      const inst = editorInstanceRef.current;
      if (inst) {
        const current = inst.action(getMarkdown()) ?? '';
        inst.action(replaceAll(current + '\n\n' + tmpl));
      }
      setIsTemplateMenuOpen(false);
    } catch (err) {
      console.error('[MilkdownEditor] template error:', err);
    }
  };

  const handleEditorReady = useCallback(() => setEditorReady(true), []);

  // ── Empty state ────────────────────────────────────────────────────────────
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
    return (
      <div className="h-full flex items-center justify-center text-text-muted">
        Loading…
      </div>
    );
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
            <button
              onClick={onToggleBookmark}
              className={`p-1.5 rounded transition-colors ${isBookmarked ? 'text-interactive-accent bg-interactive-accent/10' : 'text-text-muted hover:text-text-normal hover:bg-bg-secondary'}`}
              title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
            >
              <Bookmark size={14} fill={isBookmarked ? 'currentColor' : 'none'} />
            </button>
          )}

          <span
            className="text-xs text-text-muted px-1 select-none tabular-nums"
            title="Ctrl+= / Ctrl+- to scale | Ctrl+0 to reset"
          >
            {fontSize}px
          </span>

          {/* Template menu */}
          <div className="relative">
            <button
              onClick={() => setIsTemplateMenuOpen(o => !o)}
              className={`p-1.5 rounded transition-colors ${isTemplateMenuOpen ? 'text-interactive-accent bg-interactive-accent/10' : 'text-text-muted hover:text-text-normal hover:bg-bg-secondary'}`}
              title="Insert Template"
            >
              <ClipboardList size={14} />
            </button>
            {isTemplateMenuOpen && (
              <div className="absolute right-0 mt-2 w-48 bg-bg-secondary border border-border-color rounded-md shadow-xl z-50 py-1 overflow-hidden">
                <div className="px-3 py-1.5 text-[10px] font-bold text-text-muted uppercase tracking-wider border-b border-border-color">
                  Insert Template
                </div>
                <div className="max-h-60 overflow-y-auto custom-scrollbar">
                  {templates.filter(t => t.type === 'file').length === 0 ? (
                    <div className="px-3 py-2 text-xs text-text-muted italic">No templates found</div>
                  ) : (
                    templates.filter(t => t.type === 'file').map(t => (
                      <button
                        key={t.path}
                        onClick={() => handleApplyTemplate(t)}
                        className="w-full text-left px-3 py-2 text-xs text-text-normal hover:bg-bg-primary hover:text-interactive-accent transition-colors truncate"
                      >
                        {t.name}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="format-toolbar">
        <select
          title="Font size"
          value={FONT_SIZES.includes(fontSize) ? fontSize : ''}
          onChange={e => setFontSize(Number(e.target.value))}
        >
          {FONT_SIZES.map(s => <option key={s} value={s}>{s}px</option>)}
          {!FONT_SIZES.includes(fontSize) && <option value={fontSize}>{fontSize}px</option>}
        </select>
        <button className="format-toolbar-btn" title="Increase font (Ctrl++)"
          onClick={() => setFontSize(p => Math.min(p + 1, 40))} style={{ fontWeight: 700, fontSize: 13 }}>A⁺</button>
        <button className="format-toolbar-btn" title="Decrease font (Ctrl+-)"
          onClick={() => setFontSize(p => Math.max(p - 1, 8))} style={{ fontWeight: 500, fontSize: 11 }}>A⁻</button>
        <button className="format-toolbar-btn" title="Reset font (Ctrl+0)"
          onClick={() => setFontSize(DEFAULT_FONT_SIZE)} style={{ fontSize: 10 }}>↺</button>

        <div className="format-toolbar-separator" />

        <span className="text-xs text-text-muted px-1 select-none hidden sm:inline">
          Use keyboard shortcuts: <strong>Ctrl+B</strong> bold · <strong>Ctrl+I</strong> italic · <strong>Ctrl+Z</strong> undo
        </span>
      </div>

      {/* ── Milkdown editor ─────────────────────────────────────────────── */}
      <div ref={wrapperRef} className="milkdown-wrapper flex-grow min-w-0 overflow-auto custom-scrollbar">
        <MilkdownProvider>
          <InnerMilkdown
            key={editorKey}
            initialContent={content}
            editorRef={editorInstanceRef}
            onReady={handleEditorReady}
          />
        </MilkdownProvider>
      </div>
    </div>
  );
};
