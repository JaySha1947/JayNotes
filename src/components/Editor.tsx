import React, { useEffect, useState, useCallback, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { autocompletion, CompletionContext } from '@codemirror/autocomplete';
import {
  Bookmark, FileText, ClipboardList,
  Bold, Italic, Strikethrough, List, ListOrdered, CheckSquare, Palette
} from 'lucide-react';

import { tagPlugin, linkPlugin, calloutPlugin, imagePlugin } from '../lib/editor-extensions';
import { apiFetch } from '../lib/api';

interface EditorProps {
  filePath: string | null;
  onOpenFile?: (path: string) => void;
  isBookmarked?: boolean;
  onToggleBookmark?: () => void;
  onSplitRight?: () => void; // retained for interface compat, not rendered
  templates?: { name: string, path: string, type: string }[];
}

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28, 32];
const DEFAULT_FONT_SIZE = 15;

function getAlphaPrefix(n: number): string {
  let result = '';
  while (n > 0) {
    result = String.fromCharCode(((n - 1) % 26) + 97) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result + '.';
}

function getRomanPrefix(n: number): string {
  const vals = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const syms = ['m','cm','d','cd','c','xc','l','xl','x','ix','v','iv','i'];
  let result = '';
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { result += syms[i]; n -= vals[i]; }
  }
  return result + '.';
}

export const Editor: React.FC<EditorProps> = ({
  filePath, onOpenFile, isBookmarked, onToggleBookmark, templates = []
}) => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [isTemplateMenuOpen, setIsTemplateMenuOpen] = useState(false);
  const [fontSize, setFontSize] = useState<number>(DEFAULT_FONT_SIZE);
  const editorRef = useRef<any>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);

  // Apply font size to editor via CSS variable on the editor wrapper
  useEffect(() => {
    document.documentElement.style.setProperty('--editor-font-size', `${fontSize}px`);
  }, [fontSize]);

  // Ctrl +/- font scaling keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        setFontSize(prev => Math.min(prev + 1, 40));
      } else if (e.key === '-') {
        e.preventDefault();
        setFontSize(prev => Math.max(prev - 1, 8));
      } else if (e.key === '0') {
        e.preventDefault();
        setFontSize(DEFAULT_FONT_SIZE);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    const fetchFiles = async () => {
      try {
        const res = await apiFetch('/api/files');
        const data = await res.json();
        const flatFiles: string[] = [];
        const flatten = (nodes: any[]) => {
          for (const node of nodes) {
            if (node.type === 'file') flatFiles.push(node.name.replace('.md', ''));
            if (node.children) flatten(node.children);
          }
        };
        flatten(data);
        setFiles(flatFiles);
      } catch (error) {
        console.error(error);
      }
    };
    fetchFiles();
  }, []);

  useEffect(() => {
    if (!filePath) { setContent(''); return; }
    const loadFile = async () => {
      setLoading(true);
      try {
        const res = await apiFetch(`/api/file?path=${encodeURIComponent(filePath)}`);
        if (res.ok) {
          setContent(await res.text());
        } else {
          setContent('# Error loading file');
        }
      } catch {
        setContent('# Error loading file');
      } finally {
        setLoading(false);
      }
    };
    loadFile();
  }, [filePath]);

  const handleApplyTemplate = async (template: { name: string, path: string, type: string }) => {
    try {
      const res = await apiFetch(`/api/file?path=${encodeURIComponent(template.path)}`);
      if (res.ok) {
        let templateContent = await res.text();
        const today = new Date().toISOString().split('T')[0];
        templateContent = templateContent.replace(/{{date}}/g, today);
        if (editorRef.current?.view) {
          const view = editorRef.current.view;
          const lastLine = view.state.doc.length;
          view.dispatch({
            changes: { from: lastLine, insert: `\n\n${templateContent}` },
            selection: { anchor: lastLine + 2 + templateContent.length }
          });
        } else {
          setContent(prev => prev + `\n\n${templateContent}`);
        }
        setIsTemplateMenuOpen(false);
      }
    } catch (error) {
      console.error('Failed to apply template', error);
    }
  };

  const saveTimeoutRef = useRef<NodeJS.Timeout>(undefined);

  const onChange = useCallback((val: string) => {
    setContent(val);
    if (!filePath) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await apiFetch('/api/file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, content: val }),
        });
        window.dispatchEvent(new CustomEvent('file-saved'));
      } catch (error) {
        console.error('Failed to save file', error);
      }
    }, 500);
  }, [filePath]);

  const pasteHandler = EditorView.domEventHandlers({
    paste(event, view) {
      const items = event.clipboardData?.items;
      if (!items) return false;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          if (!file) continue;
          event.preventDefault();
          const formData = new FormData();
          const ext = file.name && file.name !== 'image.png' ? file.name.split('.').pop() : 'png';
          const newFileName = file.name === 'image.png' ? `pasted-image-${Date.now()}.${ext}` : file.name;
          const uploadFile = new File([file], newFileName, { type: file.type });
          formData.append('file', uploadFile);
          const placeholder = `![Uploading ${newFileName}...]()`;
          const insertPos = view.state.selection.main.head;
          view.dispatch({ changes: { from: insertPos, insert: placeholder } });
          const token = localStorage.getItem('jays_notes_token');
          fetch('/api/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
          }).then(async res => {
            if (!res.ok) {
              const text = await res.text();
              throw new Error(text || `HTTP ${res.status}`);
            }
            return res.json();
          }).then(data => {
            const text = data.path ? `![image](/api/${data.path})` : `Failed to upload: ${newFileName}`;
            const docText = view.state.doc.toString();
            const index = docText.indexOf(placeholder);
            if (index !== -1) view.dispatch({ changes: { from: index, to: index + placeholder.length, insert: text } });
          }).catch(err => {
            let errMsg = err.message;
            if (errMsg.includes('<!DOCTYPE') || errMsg.includes('<!doctype')) {
              errMsg = 'Server returned an HTML error (possibly file size too large or proxy issue).';
            }
            const docText = view.state.doc.toString();
            const index = docText.indexOf(placeholder);
            if (index !== -1) view.dispatch({ changes: { from: index, to: index + placeholder.length, insert: `> ❌ Upload failed: ${errMsg}` } });
          });
          return true;
        }
      }
      return false;
    }
  });

  const linkCompletion = useCallback((context: CompletionContext) => {
    const word = context.matchBefore(/\[\[[^\]]*/);
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;
    return {
      from: word.from + 2,
      options: files.map(f => ({ label: f, type: 'text' })),
      validFor: /^[\w\s]*$/
    };
  }, [files]);

  // ── Formatting helpers ──────────────────────────────────────────────────────

  const getView = () => editorRef.current?.view;

  const toggleInline = (marker: string) => {
    const view = getView();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    const ml = marker.length;
    const before = view.state.sliceDoc(Math.max(0, from - ml), from);
    const after = view.state.sliceDoc(to, Math.min(view.state.doc.length, to + ml));
    if (before === marker && after === marker) {
      view.dispatch({
        changes: [{ from: from - ml, to: from, insert: '' }, { from: to, to: to + ml, insert: '' }],
        selection: { anchor: from - ml, head: to - ml }
      });
    } else {
      view.dispatch({
        changes: { from, to, insert: marker + selected + marker },
        selection: { anchor: from + ml, head: to + ml }
      });
    }
    view.focus();
  };

  const toggleLinePrefix = (prefix: string) => {
    const view = getView();
    if (!view) return;
    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    if (line.text.startsWith(prefix)) {
      view.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert: '' } });
    } else {
      const stripped = line.text.replace(/^(\s*)([-*+]\s|\d+\.\s|[a-z]+\.\s|[ivxlcdm]+\.\s|\- \[[ x]\] )/i, '$1');
      view.dispatch({ changes: { from: line.from, to: line.to, insert: prefix + stripped } });
    }
    view.focus();
  };

  const insertChecklist = () => {
    const view = getView();
    if (!view) return;
    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    if (line.text.startsWith('- [ ] ') || line.text.startsWith('- [x] ')) {
      view.dispatch({ changes: { from: line.from, to: line.from + 6, insert: '' } });
    } else {
      const stripped = line.text.replace(/^(\s*)([-*+]\s|\d+\.\s)/i, '$1');
      view.dispatch({ changes: { from: line.from, to: line.to, insert: '- [ ] ' + stripped } });
    }
    view.focus();
  };

  const toggleAlphaList = () => {
    const view = getView();
    if (!view) return;
    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    let lineNum = line.number;
    let count = 1;
    while (lineNum > 1) {
      const prev = view.state.doc.line(lineNum - 1);
      if (/^[a-z]+\.\s/.test(prev.text)) { count++; lineNum--; } else break;
    }
    toggleLinePrefix(getAlphaPrefix(count) + ' ');
  };

  const toggleRomanList = () => {
    const view = getView();
    if (!view) return;
    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    let lineNum = line.number;
    let count = 1;
    while (lineNum > 1) {
      const prev = view.state.doc.line(lineNum - 1);
      if (/^[ivxlcdm]+\.\s/i.test(prev.text)) { count++; lineNum--; } else break;
    }
    toggleLinePrefix(getRomanPrefix(count) + ' ');
  };

  const insertColor = (color: string) => {
    const view = getView();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to) || 'colored text';
    const insert = `<span style="color:${color}">${selected}</span>`;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
    view.focus();
  };

  if (!filePath) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted bg-bg-primary">
        <div className="text-center flex flex-col items-center">
          <div className="w-24 h-24 mb-6 opacity-10 text-text-muted">
            <svg viewBox="0 0 100 100" fill="currentColor">
              <path d="M50 0 L93.3 25 L93.3 75 L50 100 L6.7 75 L6.7 25 Z" />
            </svg>
          </div>
          <div className="space-y-3 text-sm">
            <p className="flex items-center justify-center gap-2">
              <kbd className="bg-bg-secondary px-2 py-1 rounded border border-border-color font-mono text-xs text-text-normal">Ctrl + P</kbd>
              <span>to open command palette</span>
            </p>
            <p className="flex items-center justify-center gap-2">
              <kbd className="bg-bg-secondary px-2 py-1 rounded border border-border-color font-mono text-xs text-text-normal">Ctrl + N</kbd>
              <span>to create new note</span>
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="h-full flex items-center justify-center text-text-muted">Loading...</div>;
  }

  return (
    <div className="h-full w-full flex flex-col min-w-0 overflow-hidden bg-bg-primary">

      {/* Header bar */}
      <div className="px-4 py-2 text-sm text-text-muted border-b border-border-color flex-shrink-0 flex items-center justify-between bg-bg-secondary/50 backdrop-blur-sm sticky top-0 z-20">
        <div className="flex items-center gap-3 truncate">
          <FileText size={14} className="text-interactive-accent flex-shrink-0" />
          <span className="truncate font-medium">{filePath}</span>
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

          <span className="text-xs text-text-muted px-1 select-none tabular-nums" title="Ctrl+= / Ctrl+- to scale  |  Ctrl+0 to reset">
            {fontSize}px
          </span>

          {/* Template menu */}
          <div className="relative">
            <button
              onClick={() => setIsTemplateMenuOpen(!isTemplateMenuOpen)}
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
                    <div className="px-3 py-2 text-xs text-text-muted italic">No text templates found</div>
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

      {/* Formatting toolbar */}
      <div className="format-toolbar">
        <button className="format-toolbar-btn" title="Bold" onClick={() => toggleInline('**')}>
          <Bold size={13} />
        </button>
        <button className="format-toolbar-btn" title="Italic" onClick={() => toggleInline('*')}>
          <Italic size={13} />
        </button>
        <button className="format-toolbar-btn" title="Strikethrough" onClick={() => toggleInline('~~')}>
          <Strikethrough size={13} />
        </button>

        <div className="format-toolbar-separator" />

        <select
          title="Font size"
          value={FONT_SIZES.includes(fontSize) ? fontSize : ''}
          onChange={e => setFontSize(Number(e.target.value))}
        >
          {FONT_SIZES.map(s => (
            <option key={s} value={s}>{s}px</option>
          ))}
          {!FONT_SIZES.includes(fontSize) && (
            <option value={fontSize}>{fontSize}px</option>
          )}
        </select>

        <button
          className="format-toolbar-btn"
          title="Increase font size (Ctrl + +)"
          onClick={() => setFontSize(prev => Math.min(prev + 1, 40))}
          style={{ fontWeight: 700, fontSize: 13 }}
        >
          A⁺
        </button>
        <button
          className="format-toolbar-btn"
          title="Decrease font size (Ctrl + -)"
          onClick={() => setFontSize(prev => Math.max(prev - 1, 8))}
          style={{ fontWeight: 500, fontSize: 11 }}
        >
          A⁻
        </button>
        <button
          className="format-toolbar-btn"
          title="Reset font size (Ctrl + 0)"
          onClick={() => setFontSize(DEFAULT_FONT_SIZE)}
          style={{ fontSize: 10 }}
        >
          ↺
        </button>

        <div className="format-toolbar-separator" />

        <button
          className="format-toolbar-btn"
          title="Font color"
          onClick={() => colorInputRef.current?.click()}
          style={{ position: 'relative' }}
        >
          <Palette size={13} />
          <input
            ref={colorInputRef}
            type="color"
            defaultValue="#00c882"
            style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
            onChange={e => insertColor(e.target.value)}
          />
        </button>

        <div className="format-toolbar-separator" />

        <button className="format-toolbar-btn" title="Bullet list" onClick={() => toggleLinePrefix('- ')}>
          <List size={13} />
        </button>
        <button className="format-toolbar-btn" title="Numbered list" onClick={() => toggleLinePrefix('1. ')}>
          <ListOrdered size={13} />
        </button>
        <button
          className="format-toolbar-btn"
          title="Alphabetic list"
          onClick={toggleAlphaList}
          style={{ fontWeight: 600, fontSize: 11, letterSpacing: '-0.5px' }}
        >
          a.
        </button>
        <button
          className="format-toolbar-btn"
          title="Roman numeral list"
          onClick={toggleRomanList}
          style={{ fontWeight: 600, fontSize: 11, letterSpacing: '-0.5px' }}
        >
          i.
        </button>

        <div className="format-toolbar-separator" />

        <button className="format-toolbar-btn" title="Checklist / task item" onClick={insertChecklist}>
          <CheckSquare size={13} />
        </button>
      </div>

      {/* Editor content */}
      <div className="flex-grow min-w-0 overflow-auto custom-scrollbar">
        <CodeMirror
          ref={editorRef}
          value={content}
          height="100%"
          theme={oneDark}
          extensions={[
            markdown({ base: markdownLanguage, codeLanguages: languages }),
            tagPlugin,
            linkPlugin,
            calloutPlugin,
            imagePlugin,
            autocompletion({ override: [linkCompletion] }),
            EditorView.lineWrapping,
            pasteHandler,
            EditorView.domEventHandlers({
              dblclick(event, view) {
                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                if (pos !== null) {
                  const line = view.state.doc.lineAt(pos);
                  const text = line.text;
                  let start = pos - line.from;
                  let end = pos - line.from;
                  while (start > 0 && text.slice(start - 2, start) !== '[[') start--;
                  while (end < text.length && text.slice(end, end + 2) !== ']]') end++;
                  if (
                    start > 0 && end < text.length &&
                    text.slice(start - 2, start) === '[[' &&
                    text.slice(end, end + 2) === ']]'
                  ) {
                    const linkTarget = text.slice(start, end).split('|')[0];
                    if (onOpenFile) { onOpenFile(`${linkTarget}.md`); return true; }
                  }
                }
                return false;
              }
            })
          ]}
          onChange={onChange}
          className="text-lg h-full cm-editor-obsidian"
        />
      </div>
    </div>
  );
};
