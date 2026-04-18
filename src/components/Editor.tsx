import React, { useEffect, useState, useCallback, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { autocompletion, CompletionContext } from '@codemirror/autocomplete';
import { Eye, Edit3, Split, Bookmark, MoreVertical, Trash2, FileText, Copy, Download, Share2, ClipboardList } from 'lucide-react';

import { tagPlugin, linkPlugin, calloutPlugin, imagePlugin } from '../lib/editor-extensions';
import { apiFetch } from '../lib/api';

interface EditorProps {
  filePath: string | null;
  onOpenFile?: (path: string) => void;
  isBookmarked?: boolean;
  onToggleBookmark?: () => void;
  onSplitRight?: () => void;
  templates?: { name: string, path: string, type: string }[];
}

import * as MarkdownModule from 'react-markdown';
const MarkdownComp = ((MarkdownModule as any).default || MarkdownModule) as any;

import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

export const Editor: React.FC<EditorProps> = ({ filePath, onOpenFile, isBookmarked, onToggleBookmark, onSplitRight, templates = [] }) => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<'editing' | 'reading'>('editing');
  const [isTemplateMenuOpen, setIsTemplateMenuOpen] = useState(false);
  const editorRef = useRef<any>(null);

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
    if (!filePath) {
      setContent('');
      return;
    }

    const loadFile = async () => {
      setLoading(true);
      try {
        const res = await apiFetch(`/api/file?path=${encodeURIComponent(filePath)}`);
        if (res.ok) {
          const text = await res.text();
          setContent(text);
        } else {
          setContent('# Error loading file');
        }
      } catch (error) {
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
        // Replace date
        const today = new Date().toISOString().split('T')[0];
        templateContent = templateContent.replace(/{{date}}/g, today);

        if (editorRef.current) {
          const view = editorRef.current.view;
          if (view) {
            // Insert at the bottom as requested
            const lastLine = view.state.doc.length;
            view.dispatch({
              changes: { from: lastLine, insert: `\n\n${templateContent}` },
              selection: { anchor: lastLine + 2 + templateContent.length }
            });
          }
        } else {
          // Fallback if editor not ready
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

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

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
          
          view.dispatch({
            changes: { from: insertPos, insert: placeholder }
          });
          
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
            if (data.path) {
              const text = `![image](/api/${data.path})`;
              const docText = view.state.doc.toString();
              const index = docText.indexOf(placeholder);
              if (index !== -1) {
                view.dispatch({
                  changes: { from: index, to: index + placeholder.length, insert: text }
                });
              }
            } else {
              // Revert placeholder if the server returned an error but 200 HTTP OK
              const docText = view.state.doc.toString();
              const index = docText.indexOf(placeholder);
              if (index !== -1) {
                view.dispatch({
                  changes: { from: index, to: index + placeholder.length, insert: `Failed to upload: ${newFileName}` }
                });
              }
            }
          }).catch(err => {
              console.error('Failed to upload image:', err);
              const docText = view.state.doc.toString();
              const index = docText.indexOf(placeholder);
              if (index !== -1) {
                let errMsg = err.message;
                if (errMsg.includes('<!DOCTYPE') || errMsg.includes('<!doctype')) {
                  errMsg = 'Server returned an HTML error (possibly file size too large or proxy issue).';
                }
                view.dispatch({
                  changes: { from: index, to: index + placeholder.length, insert: `> ❌ Upload failed: ${errMsg}` }
                });
              }
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

  const MarkdownRenderer = ({ content }: { content: string }) => {
    return (
      <div className="prose prose-lg dark:prose-invert max-w-none px-10 py-8 prose-slate prose-headings:font-bold prose-a:text-interactive-accent">
        <MarkdownComp
          remarkPlugins={[remarkBreaks, remarkGfm]}
          components={{
            img: ({ node, ...props }: any) => {
              const alt = props.alt || '';
              let width = undefined;
              if (alt.includes('|')) {
                width = alt.split('|')[1];
              }
              let src = props.src;
              if (src && src.startsWith('/api/')) {
                const token = localStorage.getItem('jays_notes_token');
                if (token) {
                  const separator = src.includes('?') ? '&' : '?';
                  src = `${src}${separator}token=${token}`;
                }
              }
              return (
                <img 
                  {...props} 
                  src={src}
                  style={{ width: width ? `${width}px` : 'auto' }} 
                  className="rounded-lg shadow-md border border-border-color mx-auto"
                  referrerPolicy="no-referrer"
                />
              );
            }
          }}
        >
          {content}
        </MarkdownComp>
      </div>
    );
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
      <div className="px-4 py-2 text-sm text-text-muted border-b border-border-color flex-shrink-0 flex items-center justify-between bg-bg-secondary/50 backdrop-blur-sm sticky top-0 z-20">
        <div className="flex items-center gap-3 truncate">
          <FileText size={14} className="text-interactive-accent flex-shrink-0" />
          <span className="truncate font-medium">{filePath}</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="flex bg-bg-primary rounded-md border border-border-color p-0.5 mr-2">
            <button
              onClick={() => setViewMode('editing')}
              className={`p-1.5 rounded transition-all ${viewMode === 'editing' ? 'bg-bg-secondary text-interactive-accent shadow-sm' : 'text-text-muted hover:text-text-normal'}`}
              title="Editing Mode"
            >
              <Edit3 size={14} />
            </button>
            <button
              onClick={() => setViewMode('reading')}
              className={`p-1.5 rounded transition-all ${viewMode === 'reading' ? 'bg-bg-secondary text-interactive-accent shadow-sm' : 'text-text-muted hover:text-text-normal'}`}
              title="Reading Mode"
            >
              <Eye size={14} />
            </button>
          </div>

          {onSplitRight && (
            <button 
              onClick={onSplitRight}
              className="p-1.5 rounded text-text-muted hover:text-text-normal hover:bg-bg-secondary transition-colors"
              title="Split Right"
            >
              <Split size={14} />
            </button>
          )}
          {onToggleBookmark && (
            <button 
              onClick={onToggleBookmark}
              className={`p-1.5 rounded transition-colors ${isBookmarked ? 'text-interactive-accent bg-interactive-accent/10' : 'text-text-muted hover:text-text-normal hover:bg-bg-secondary'}`}
              title={isBookmarked ? "Remove bookmark" : "Add bookmark"}
            >
              <Bookmark size={14} fill={isBookmarked ? "currentColor" : "none"} />
            </button>
          )}

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
      <div className="flex-grow min-w-0 overflow-auto custom-scrollbar">
        {viewMode === 'editing' ? (
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
                    if (start > 0 && end < text.length && text.slice(start - 2, start) === '[[' && text.slice(end, end + 2) === ']]') {
                      const linkContent = text.slice(start, end);
                      const linkTarget = linkContent.split('|')[0];
                      if (onOpenFile) {
                        onOpenFile(`${linkTarget}.md`);
                        return true;
                      }
                    }
                  }
                  return false;
                }
              })
            ]}
            onChange={onChange}
            className="text-lg h-full cm-editor-obsidian"
          />
        ) : (
          <MarkdownRenderer content={content} />
        )}
      </div>
    </div>
  );
};
