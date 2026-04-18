import React, { useEffect, useState, useRef } from 'react';
import { Folder, File, ChevronRight, ChevronDown, FolderPlus, ArrowUpDown, LayoutGrid, FilePlus2, SquarePlus, Copy, Trash2 } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { PromptModal } from './PromptModal';

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'folder' | 'canvas';
  children?: FileNode[];
}

interface FileExplorerProps {
  onSelectFile: (path: string) => void;
  onCreateFile: (folderPath?: string, type?: 'file' | 'canvas') => void;
  activeFile: string | null;
  refreshTrigger?: number;
  bookmarks?: string[];
}

const FileTreeItem: React.FC<{
  node: FileNode;
  onSelectFile: (path: string) => void;
  activeFile: string | null;
  level: number;
  onContextMenu: (e: React.MouseEvent, path: string, isFolder: boolean) => void;
  onMoveFile: (source: string, destination: string) => void;
  bookmarks?: string[];
  inlineCreate?: string | null;
  onInlineCreateSubmit?: (name: string) => void;
  onInlineCreateCancel?: () => void;
  onDuplicateFile?: (path: string) => void;
  onDeleteFile?: (path: string) => void;
}> = ({ node, onSelectFile, activeFile, level, onContextMenu, onMoveFile, bookmarks, inlineCreate, onInlineCreateSubmit, onInlineCreateCancel, onDuplicateFile, onDeleteFile }) => {
  const [isOpen, setIsOpen] = useState(true);
  const [isDragOver, setIsDragOver] = useState(false);
  const isFolder = node.type === 'folder';
  const isActive = activeFile === node.path;

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', node.path);
    e.stopPropagation();
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (isFolder) {
      e.preventDefault();
      setIsDragOver(true);
      e.stopPropagation();
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (isFolder) {
      setIsDragOver(false);
      e.stopPropagation();
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    if (isFolder) {
      e.preventDefault();
      setIsDragOver(false);
      e.stopPropagation();
      const sourcePath = e.dataTransfer.getData('text/plain');
      if (sourcePath && sourcePath !== node.path) {
        const fileName = sourcePath.split('/').pop();
        const destPath = node.path ? `${node.path}/${fileName}` : fileName;
        if (destPath) {
          onMoveFile(sourcePath, destPath);
        }
      }
    }
  };

  return (
    <div>
      <div
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`group flex items-center py-1 px-2 cursor-pointer select-none text-sm hover:bg-interactive-hover min-w-0 ${
          isActive ? 'bg-interactive-hover text-interactive-accent' : 'text-text-normal'
        } ${isDragOver ? 'bg-interactive-hover ring-1 ring-interactive-accent' : ''}`}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
        onClick={() => {
          if (isFolder) {
            setIsOpen(!isOpen);
          } else {
            onSelectFile(node.path);
          }
        }}
        onContextMenu={(e) => onContextMenu(e, node.path, isFolder)}
      >
        {isFolder ? (
          isOpen ? <ChevronDown size={14} className="mr-1 text-text-muted flex-shrink-0" /> : <ChevronRight size={14} className="mr-1 text-text-muted flex-shrink-0" />
        ) : node.type === 'canvas' ? (
          <LayoutGrid size={14} className="mr-1 text-text-muted flex-shrink-0" />
        ) : (
          <File size={14} className="mr-1 text-text-muted flex-shrink-0" />
        )}
        <span className="truncate min-w-0 flex-grow">{node.name}</span>
        {node.type === 'canvas' && (
          <span className="ml-2 px-1 py-0.5 text-[10px] font-bold bg-interactive-accent/20 text-interactive-accent rounded leading-none mr-2">CANVAS</span>
        )}
        {!isFolder && bookmarks?.includes(node.path) && (
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-interactive-accent flex-shrink-0 mr-2"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
        )}
        
        {!isFolder && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDuplicateFile?.(node.path);
              }}
              className="p-1 hover:bg-bg-secondary hover:text-text-normal text-text-muted rounded"
              title="Duplicate File"
            >
              <Copy size={12} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteFile?.(node.path);
              }}
              className="p-1 hover:bg-error/10 hover:text-error text-text-muted rounded"
              title="Delete File"
            >
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>
      {isFolder && isOpen && (
        <div>
          {inlineCreate === node.path && (
            <div className="flex items-center py-1 px-2 text-sm" style={{ paddingLeft: `${(level + 1) * 12 + 8}px` }}>
              <Folder size={14} className="mr-1 text-text-muted flex-shrink-0" />
              <input 
                autoFocus
                type="text"
                className="bg-bg-secondary border border-interactive-accent outline-none text-text-normal px-1 py-0.5 rounded w-full"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onInlineCreateSubmit?.(e.currentTarget.value);
                  } else if (e.key === 'Escape') {
                    onInlineCreateCancel?.();
                  }
                }}
                onBlur={(e) => {
                  if (e.currentTarget.value) {
                    onInlineCreateSubmit?.(e.currentTarget.value);
                  } else {
                    onInlineCreateCancel?.();
                  }
                }}
              />
            </div>
          )}
          {node.children && node.children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              onSelectFile={onSelectFile}
              activeFile={activeFile}
              level={level + 1}
              onContextMenu={onContextMenu}
              onMoveFile={onMoveFile}
              bookmarks={bookmarks}
              inlineCreate={inlineCreate}
              onInlineCreateSubmit={onInlineCreateSubmit}
              onInlineCreateCancel={onInlineCreateCancel}
              onDuplicateFile={onDuplicateFile}
              onDeleteFile={onDeleteFile}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const FileExplorer: React.FC<FileExplorerProps> = ({ onSelectFile, onCreateFile, activeFile, refreshTrigger = 0, bookmarks }) => {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; isFolder: boolean } | null>(null);
  const [promptConfig, setPromptConfig] = useState<{ isOpen: boolean; title: string; defaultValue: string; mode?: 'prompt' | 'confirm'; onConfirm: (val: string) => void } | null>(null);
  const [inlineCreate, setInlineCreate] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<'name-asc' | 'name-desc' | 'created-desc' | 'created-asc' | 'modified-desc' | 'modified-asc'>('name-asc');
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);

  const fetchFiles = async () => {
    try {
      const res = await apiFetch('/api/files');
      if (!res.ok) {
        console.error('Failed to fetch files:', res.statusText);
        setFiles([]);
        return;
      }
      const data = await res.json();
      
      if (!Array.isArray(data)) {
        setFiles([]);
        return;
      }

      const sortNodes = (nodes: any[]) => {
        if (!Array.isArray(nodes)) return;
        nodes.sort((a, b) => {
          if (a.type === 'folder' && b.type === 'file') return -1;
          if (a.type === 'file' && b.type === 'folder') return 1;
          
          switch (sortOrder) {
            case 'name-asc': return a.name.localeCompare(b.name);
            case 'name-desc': return b.name.localeCompare(a.name);
            case 'created-desc': return (b.createdAt || 0) - (a.createdAt || 0);
            case 'created-asc': return (a.createdAt || 0) - (b.createdAt || 0);
            case 'modified-desc': return (b.updatedAt || 0) - (a.updatedAt || 0);
            case 'modified-asc': return (a.updatedAt || 0) - (b.updatedAt || 0);
            default: return 0;
          }
        });
        nodes.forEach(node => {
          if (node.children) sortNodes(node.children);
        });
      };
      
      sortNodes(data);
      setFiles(data);
    } catch (error) {
      console.error('Failed to fetch files', error);
    }
  };

  useEffect(() => {
    fetchFiles();
  }, [refreshTrigger, sortOrder]);

  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, path: string, isFolder: boolean) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, path, isFolder });
  };

  const handleNewNoteInFolder = (folderPath: string) => {
    onCreateFile(folderPath, 'file');
    setContextMenu(null);
  };

  const handleDuplicateFile = async (filePath: string) => {
    try {
      const res = await apiFetch('/api/file/duplicate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      if (res.ok) {
        fetchFiles();
      } else {
        try {
          const data = await res.json();
          alert(data.error || 'Failed to duplicate file');
        } catch (e) {
          alert('Failed to duplicate file');
        }
      }
    } catch (error) {
      console.error(error);
    }
    setContextMenu(null);
  };

  const handleNewFolder = (parentPath: string = '') => {
    setInlineCreate(parentPath);
    setContextMenu(null);
  };

  const handleDelete = (filePath: string) => {
    setPromptConfig({
      isOpen: true,
      title: `Are you sure you want to delete ${filePath.split('/').pop()}?`,
      defaultValue: '',
      mode: 'confirm',
      onConfirm: async () => {
        setPromptConfig(null);
        try {
          const res = await apiFetch(`/api/file?path=${encodeURIComponent(filePath)}`, {
            method: 'DELETE',
          });
          if (res.ok) {
            fetchFiles();
          } else {
            try {
              const data = await res.json();
              alert(data.error || 'Failed to delete');
            } catch (e) {
              alert('Failed to delete file');
            }
          }
        } catch (error) {
          console.error(error);
        }
      }
    });
    setContextMenu(null);
  };

  const handleNewCanvas = async (parentPath: string = '') => {
    onCreateFile(parentPath, 'canvas');
    setContextMenu(null);
  };

  const handleInlineCreateSubmit = async (folderName: string) => {
    if (!folderName) {
      setInlineCreate(null);
      return;
    }
    try {
      const newPath = inlineCreate ? `${inlineCreate}/${folderName}` : folderName;
      const res = await apiFetch('/api/file/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath, type: 'folder' }),
      });
      if (res.ok) {
        fetchFiles();
      } else {
        try {
          const data = await res.json();
          console.error(data.error || 'Failed to create folder');
        } catch (e) {
          console.error('Failed to create folder and failed to parse error response.');
        }
      }
    } catch (error) {
      console.error(error);
    }
    setInlineCreate(null);
  };

  const handleRename = (path: string) => {
    const isCanvas = path.endsWith('.canvas');
    const isMd = path.endsWith('.md');
    const extension = isCanvas ? '.canvas' : (isMd ? '.md' : '');
    const currentName = path.split('/').pop() || '';
    const nameWithoutExt = extension ? currentName.slice(0, -extension.length) : currentName;

    setPromptConfig({
      isOpen: true,
      title: 'Enter new name:',
      defaultValue: nameWithoutExt,
      onConfirm: async (newName) => {
        setPromptConfig(null);
        const finalNewName = extension ? `${newName}${extension}` : newName;
        if (finalNewName === currentName) return;
        
        try {
          const dir = path.split('/').slice(0, -1).join('/');
          const destination = dir ? `${dir}/${finalNewName}` : finalNewName;
          const res = await apiFetch('/api/file/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: path, destination }),
          });
          if (res.ok) {
            fetchFiles();
          } else {
            try {
              const data = await res.json();
              console.error(data.error || 'Failed to rename');
            } catch (e) {
              console.error('Failed to rename file');
            }
          }
        } catch (error) {
          console.error(error);
        }
      }
    });
    setContextMenu(null);
  };

  const handleMoveFile = async (source: string, destination: string) => {
    try {
      const res = await apiFetch('/api/file/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, destination }),
      });
      if (res.ok) {
        fetchFiles();
      }
    } catch (error) {
      console.error(error);
    }
  };

  const handleRootDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const sourcePath = e.dataTransfer.getData('text/plain');
    if (sourcePath) {
      const fileName = sourcePath.split('/').pop();
      if (fileName && sourcePath !== fileName) {
        handleMoveFile(sourcePath, fileName);
      }
    }
  };

  const handleRootDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  return (
    <div 
      className="h-full overflow-y-auto overflow-x-hidden py-2 min-w-0 relative"
      onDrop={handleRootDrop}
      onDragOver={handleRootDragOver}
    >
      <div className="px-4 mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold text-text-muted uppercase tracking-wider truncate">
          Files
        </div>
        <div className="flex items-center gap-1 text-text-muted relative">
          <button className="p-1 hover:text-text-normal hover:bg-interactive-hover rounded" title="New note" onClick={() => onCreateFile('')}>
            <FilePlus2 size={14} />
          </button>
          <button className="p-1 hover:text-text-normal hover:bg-interactive-hover rounded" title="New canvas" onClick={() => handleNewCanvas('')}>
            <SquarePlus size={14} />
          </button>
          <button className="p-1 hover:text-text-normal hover:bg-interactive-hover rounded" title="New folder" onClick={() => handleNewFolder('')}>
            <FolderPlus size={14} />
          </button>
          <button 
            className="p-1 hover:text-text-normal hover:bg-interactive-hover rounded" 
            title="Change sort order"
            onClick={() => setIsSortMenuOpen(!isSortMenuOpen)}
          >
            <ArrowUpDown size={14} />
          </button>
          
          {isSortMenuOpen && (
            <div className="absolute top-full right-0 mt-1 w-48 bg-bg-secondary border border-border-color rounded shadow-lg z-50 py-1 text-sm">
              <button className={`w-full text-left px-3 py-1.5 hover:bg-interactive-hover ${sortOrder === 'name-asc' ? 'text-interactive-accent' : 'text-text-normal'}`} onClick={() => { setSortOrder('name-asc'); setIsSortMenuOpen(false); }}>Name (A to Z)</button>
              <button className={`w-full text-left px-3 py-1.5 hover:bg-interactive-hover ${sortOrder === 'name-desc' ? 'text-interactive-accent' : 'text-text-normal'}`} onClick={() => { setSortOrder('name-desc'); setIsSortMenuOpen(false); }}>Name (Z to A)</button>
              <button className={`w-full text-left px-3 py-1.5 hover:bg-interactive-hover ${sortOrder === 'created-desc' ? 'text-interactive-accent' : 'text-text-normal'}`} onClick={() => { setSortOrder('created-desc'); setIsSortMenuOpen(false); }}>Created (New to Old)</button>
              <button className={`w-full text-left px-3 py-1.5 hover:bg-interactive-hover ${sortOrder === 'created-asc' ? 'text-interactive-accent' : 'text-text-normal'}`} onClick={() => { setSortOrder('created-asc'); setIsSortMenuOpen(false); }}>Created (Old to New)</button>
              <button className={`w-full text-left px-3 py-1.5 hover:bg-interactive-hover ${sortOrder === 'modified-desc' ? 'text-interactive-accent' : 'text-text-normal'}`} onClick={() => { setSortOrder('modified-desc'); setIsSortMenuOpen(false); }}>Modified (New to Old)</button>
              <button className={`w-full text-left px-3 py-1.5 hover:bg-interactive-hover ${sortOrder === 'modified-asc' ? 'text-interactive-accent' : 'text-text-normal'}`} onClick={() => { setSortOrder('modified-asc'); setIsSortMenuOpen(false); }}>Modified (Old to New)</button>
            </div>
          )}
        </div>
      </div>
      {inlineCreate === '' && (
        <div className="flex items-center py-1 px-2 text-sm" style={{ paddingLeft: '8px' }}>
          <Folder size={14} className="mr-1 text-text-muted flex-shrink-0" />
          <input 
            autoFocus
            type="text"
            className="bg-bg-secondary border border-interactive-accent outline-none text-text-normal px-1 py-0.5 rounded w-full"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleInlineCreateSubmit(e.currentTarget.value);
              } else if (e.key === 'Escape') {
                setInlineCreate(null);
              }
            }}
            onBlur={(e) => {
              if (e.currentTarget.value) {
                handleInlineCreateSubmit(e.currentTarget.value);
              } else {
                setInlineCreate(null);
              }
            }}
          />
        </div>
      )}
      {files.map((node) => (
        <FileTreeItem
          key={node.path}
          node={node}
          onSelectFile={onSelectFile}
          activeFile={activeFile}
          level={0}
          onContextMenu={handleContextMenu}
          onMoveFile={handleMoveFile}
          bookmarks={bookmarks}
          inlineCreate={inlineCreate}
          onInlineCreateSubmit={handleInlineCreateSubmit}
          onInlineCreateCancel={() => setInlineCreate(null)}
          onDuplicateFile={handleDuplicateFile}
          onDeleteFile={handleDelete}
        />
      ))}

      {contextMenu && (
        <div 
          className="fixed bg-bg-secondary border border-border-color rounded shadow-xl py-1 z-50 min-w-[160px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          {contextMenu.isFolder && (
            <>
              <button 
                className="w-full text-left px-4 py-1.5 text-sm text-text-normal hover:bg-interactive-hover hover:text-interactive-accent"
                onClick={() => handleNewNoteInFolder(contextMenu.path)}
              >
                <div className="flex items-center gap-2">
                  <FilePlus2 size={14} />
                  <span>New note</span>
                </div>
              </button>
              <button 
                className="w-full text-left px-4 py-1.5 text-sm text-text-normal hover:bg-interactive-hover hover:text-interactive-accent"
                onClick={() => handleNewCanvas(contextMenu.path)}
              >
                <div className="flex items-center gap-2">
                  <SquarePlus size={14} />
                  <span>New canvas</span>
                </div>
              </button>
              <button 
                className="w-full text-left px-4 py-1.5 text-sm text-text-normal hover:bg-interactive-hover hover:text-interactive-accent"
                onClick={() => handleNewFolder(contextMenu.path)}
              >
                <div className="flex items-center gap-2">
                  <FolderPlus size={14} />
                  <span>New folder</span>
                </div>
              </button>
            </>
          )}
          {!contextMenu.isFolder && (
            <button 
              className="w-full text-left px-4 py-1.5 text-sm text-text-normal hover:bg-interactive-hover hover:text-interactive-accent"
              onClick={() => handleDuplicateFile(contextMenu.path)}
            >
              Duplicate
            </button>
          )}
          <button 
            className="w-full text-left px-4 py-1.5 text-sm text-text-normal hover:bg-interactive-hover hover:text-interactive-accent"
            onClick={() => handleRename(contextMenu.path)}
          >
            Rename
          </button>
          <button 
            className="w-full text-left px-4 py-1.5 text-sm text-error hover:bg-error/10"
            onClick={() => handleDelete(contextMenu.path)}
          >
            Delete
          </button>
        </div>
      )}

      {promptConfig && (
        <PromptModal
          isOpen={promptConfig.isOpen}
          title={promptConfig.title}
          defaultValue={promptConfig.defaultValue}
          mode={promptConfig.mode}
          onConfirm={promptConfig.onConfirm}
          onCancel={() => setPromptConfig(null)}
        />
      )}
    </div>
  );
};
