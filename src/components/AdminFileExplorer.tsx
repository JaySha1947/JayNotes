import React, { useEffect, useState, useRef, useMemo } from 'react';
import { 
  Folder, File, ChevronRight, ChevronDown, FolderPlus, 
  Trash2, Edit3, Download, Upload, Move, Info, X, 
  FilePlus2, RefreshCw, AlertTriangle, ArrowLeft, ArrowRight,
  LayoutGrid, List, Search, MoreVertical, Copy, ArrowUpLeft,
  User, Database, ShieldAlert, CheckCircle2, AlertCircle, Clock,
  FileArchive, FolderArchive
} from 'lucide-react';
import { Group, Panel as PanelOrig, Separator } from 'react-resizable-panels';
const PanelGroup = Group as any;
const Panel = PanelOrig as any;
const PanelResizeHandle = Separator as any;
import { apiFetch } from '../lib/api';
import { PromptModal } from './PromptModal';

interface StorageNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  size: number;
  createdAt: number;
  updatedAt: number;
  children?: StorageNode[];
}

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

export const AdminFileExplorer: React.FC = () => {
  const [nodes, setNodes] = useState<StorageNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['']));
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortConfig, setSortConfig] = useState<{ 
    key: keyof StorageNode; 
    direction: 'asc' | 'desc' 
  }>({ key: 'name', direction: 'asc' });
  
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [contextMenu, setContextMenu] = useState<{ 
    x: number; 
    y: number; 
    path: string;
    type: 'file' | 'folder';
  } | null>(null);
  
  const [promptConfig, setPromptConfig] = useState<{
    isOpen: boolean;
    title: string;
    defaultValue?: string;
    type: 'rename' | 'newFolder' | 'move' | 'copy' | 'zip' | 'unzip' | 'delete';
    targetPath?: string;
    mode?: 'prompt' | 'confirm';
    onConfirm: (val: string) => void;
  } | null>(null);

  const [metadata, setMetadata] = useState<StorageNode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  const fetchStorage = async (preserveSelection = false) => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/storage/list');
      if (res.ok) {
        setNodes(await res.json());
        if (!preserveSelection) {
          setSelectedPaths(new Set());
          setLastSelectedPath(null);
        }
      } else {
        addToast('Failed to load storage structure', 'error');
      }
    } catch (error) {
      console.error('Failed to fetch storage:', error);
      addToast('Network error while loading storage', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStorage();
  }, []);

  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, []);

  // Helper to find a folder node by path
  const findNodeByPath = (nodes: StorageNode[], path: string): StorageNode | null => {
    if (!path) return { name: 'Root', path: '', type: 'folder', children: nodes, size: 0, createdAt: 0, updatedAt: 0 };
    const parts = path.split('/');
    let current: StorageNode | undefined;
    let pool = nodes;

    for (const part of parts) {
      current = pool.find(n => n.name === part);
      if (!current || current.type !== 'folder') return null;
      pool = current.children || [];
    }
    return current || null;
  };

  const currentFolder = findNodeByPath(nodes, currentPath);
  const currentItems = useMemo(() => {
    let items = currentFolder?.children || [];
    
    // Filter
    if (searchQuery) {
      items = items.filter(n => n.name.toLowerCase().includes(searchQuery.toLowerCase()));
    }
    
    // Sort
    return [...items].sort((a, b) => {
      // Always folders first
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      
      const valA = a[sortConfig.key];
      const valB = b[sortConfig.key];
      
      if (typeof valA === 'string' && typeof valB === 'string') {
        const res = sortConfig.direction === 'asc' 
          ? valA.localeCompare(valB) 
          : valB.localeCompare(valA);
        return res;
      }
      return sortConfig.direction === 'asc' 
        ? (valA as number) - (valB as number) 
        : (valB as number) - (valA as number);
    });
  }, [currentFolder, searchQuery, sortConfig]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (promptConfig?.isOpen || metadata) return;
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = currentItems;
        if (items.length === 0) return;

        let currentIndex = lastSelectedPath ? items.findIndex(n => n.path === lastSelectedPath) : -1;
        
        if (e.key === 'ArrowDown') {
          currentIndex = Math.min(currentIndex + 1, items.length - 1);
        } else {
          currentIndex = currentIndex === -1 ? 0 : Math.max(currentIndex - 1, 0);
        }

        const nextItem = items[currentIndex];
        if (!nextItem) return;

        if (e.shiftKey) {
          // Range selection
          const startIndex = lastSelectedPath ? items.findIndex(n => n.path === Array.from(selectedPaths)[0]) : currentIndex;
          const start = Math.min(startIndex, currentIndex);
          const end = Math.max(startIndex, currentIndex);
          const range = items.slice(start, end + 1).map(n => n.path);
          setSelectedPaths(new Set(range));
        } else {
          setSelectedPaths(new Set([nextItem.path]));
        }
        setLastSelectedPath(nextItem.path);
      }

      if (e.key === 'Enter' && lastSelectedPath) {
        const item = currentItems.find(n => n.path === lastSelectedPath);
        if (item) handleOpen(item);
      }

      if (e.key === 'Delete' || (e.metaKey && e.key === 'Backspace')) {
        if (selectedPaths.size > 0) handleBulkDelete();
      }
      
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'a') {
          e.preventDefault();
          setSelectedPaths(new Set(currentItems.map(n => n.path)));
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentItems, lastSelectedPath, selectedPaths, promptConfig, metadata]);

  const toggleFolder = (path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleItemClick = (e: React.MouseEvent, item: StorageNode) => {
    e.stopPropagation();
    const { path } = item;
    
    if (e.ctrlKey || e.metaKey) {
      setSelectedPaths(prev => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      setLastSelectedPath(path);
    } else if (e.shiftKey && lastSelectedPath) {
      const currentIndex = currentItems.findIndex(n => n.path === path);
      const lastIndex = currentItems.findIndex(n => n.path === lastSelectedPath);
      if (currentIndex !== -1 && lastIndex !== -1) {
        const start = Math.min(currentIndex, lastIndex);
        const end = Math.max(currentIndex, lastIndex);
        const range = currentItems.slice(start, end + 1).map(n => n.path);
        setSelectedPaths(new Set(range));
      }
    } else {
      setSelectedPaths(new Set([path]));
      setLastSelectedPath(path);
    }
  };

  const handleOpen = (item: StorageNode) => {
    if (item.type === 'folder') {
      setCurrentPath(item.path);
      setExpandedFolders(prev => new Set(prev).add(item.path));
      setSelectedPaths(new Set());
      setLastSelectedPath(null);
    } else {
      setMetadata(item);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, item: StorageNode) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedPaths.has(item.path)) {
      setSelectedPaths(new Set([item.path]));
      setLastSelectedPath(item.path);
    }
    setContextMenu({ x: e.clientX, y: e.clientY, path: item.path, type: item.type });
  };

  const handleCreateFolder = () => {
    setPromptConfig({
      isOpen: true,
      title: 'New Folder Name',
      type: 'newFolder',
      onConfirm: async (name) => {
        if (!name) return;
        const fullPath = currentPath ? `${currentPath}/${name}` : name;
        const res = await apiFetch('/api/admin/storage/new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: fullPath, type: 'folder' })
        });
        if (res.ok) {
          addToast(`Folder "${name}" created`, 'success');
          fetchStorage(true);
        } else {
          addToast('Failed to create folder', 'error');
        }
        setPromptConfig(null);
      }
    });
  };

  const handleBulkDelete = () => {
    const count = selectedPaths.size;
    if (count === 0) return;
    
    const confirmMsg = count === 1 
      ? `Are you sure you want to delete "${Array.from(selectedPaths)[0].split('/').pop()}"?`
      : `Are you sure you want to delete ${count} items and all their contents?`;
      
    setPromptConfig({
      isOpen: true,
      title: confirmMsg,
      defaultValue: '',
      type: 'delete',
      mode: 'confirm',
      onConfirm: async () => {
        setPromptConfig(null);
        try {
          const res = await apiFetch('/api/admin/storage/bulk-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: Array.from(selectedPaths) })
          });
          
          const data = await res.json();
          if (res.ok || res.status === 207) {
            if (data.errors && data.errors.length > 0) {
              addToast(`Partial success. Failed to delete ${data.errors.length} items.`, 'error');
            } else {
              addToast(`Deleted ${count} item(s)`, 'success');
            }
            setSelectedPaths(new Set());
            setLastSelectedPath(null);
            fetchStorage();
          } else {
            addToast(data.error || 'Failed to delete items', 'error');
          }
        } catch (e) {
          addToast('Failed to execute bulk delete', 'error');
        }
      }
    });
  };

  const handleRename = (path: string) => {
    const isCanvas = path.endsWith('.canvas');
    const isMd = path.endsWith('.md');
    const extension = isCanvas ? '.canvas' : (isMd ? '.md' : '');
    const currentName = path.split('/').pop() || '';
    const nameWithoutExt = extension ? currentName.slice(0, -extension.length) : currentName;

    setPromptConfig({
      isOpen: true,
      title: 'Rename Item',
      defaultValue: nameWithoutExt,
      type: 'rename',
      targetPath: path,
      onConfirm: async (newName) => {
        if (!newName || newName === nameWithoutExt) {
          setPromptConfig(null);
          return;
        }
        const finalNewName = extension ? `${newName}${extension}` : newName;
        const dir = path.split('/').slice(0, -1).join('/');
        const destination = dir ? `${dir}/${finalNewName}` : finalNewName;
        
        const res = await apiFetch('/api/admin/storage/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: path, destination })
        });
        
        if (res.ok) {
          addToast('Renamed successfully', 'success');
          fetchStorage(true);
        } else {
          addToast('Rename failed', 'error');
        }
        setPromptConfig(null);
      }
    });
  };

  const handleCopy = (path: string) => {
    const name = path.split('/').pop() || '';
    const dir = path.split('/').slice(0, -1).join('/');
    const copyName = `${name} - copy`;
    const destination = dir ? `${dir}/${copyName}` : copyName;

    setPromptConfig({
      isOpen: true,
      title: 'Copy To',
      defaultValue: destination,
      type: 'copy',
      targetPath: path,
      onConfirm: async (dest) => {
        if (!dest) return;
        const res = await apiFetch('/api/admin/storage/copy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: path, destination: dest })
        });
        if (res.ok) {
          addToast('Copied successfully', 'success');
          fetchStorage(true);
        } else {
          addToast('Copy failed', 'error');
        }
        setPromptConfig(null);
      }
    });
  };

  const handleDownloadSelected = async () => {
    const paths = Array.from(selectedPaths);
    if (paths.length === 0) return;
    
    addToast('Preparing download...', 'info');

    try {
      let res;
      if (paths.length === 1) {
        // Single file or folder (endpoint handles folder zipping)
        const path = paths[0];
        res = await apiFetch(`/api/admin/storage/file?path=${encodeURIComponent(path)}`);
      } else {
        // Bulk download (ZIP)
        res = await apiFetch('/api/admin/storage/download-bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths })
        });
      }

      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const fileName = paths.length === 1 
          ? (paths[0].split('/').pop() || 'download') + (res.headers.get('Content-Type')?.includes('zip') ? '.zip' : '')
          : 'bulk-download.zip';
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        addToast('Download started', 'success');
      } else {
        addToast('Download failed', 'error');
      }
    } catch (e) {
      addToast('Download error', 'error');
    }
  };

  const handleZip = () => {
    if (selectedPaths.size === 0) return;
    const paths = Array.from(selectedPaths);
    const suggestedName = paths.length === 1 ? `${paths[0].split('/').pop()}.zip` : 'archive.zip';

    setPromptConfig({
      isOpen: true,
      title: 'Create ZIP Archive',
      defaultValue: suggestedName,
      type: 'zip',
      onConfirm: async (zipName) => {
        if (!zipName) return;
        const res = await apiFetch('/api/admin/storage/zip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths, targetName: zipName })
        });
        if (res.ok) {
          addToast('Archive created', 'success');
          fetchStorage(true);
        } else {
          addToast('Failed to create archive', 'error');
        }
        setPromptConfig(null);
      }
    });
  };

  const handleUnzip = (path: string) => {
    if (!path.toLowerCase().endsWith('.zip')) {
      addToast('Selected file is not a ZIP archive', 'error');
      return;
    }

    setPromptConfig({
      isOpen: true,
      title: 'Extract to folder (relative to root, blank for current)',
      defaultValue: currentPath,
      type: 'unzip',
      targetPath: path,
      onConfirm: async (dest) => {
        const res = await apiFetch('/api/admin/storage/unzip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, destination: dest || undefined })
        });
        if (res.ok) {
          addToast('Extraction complete', 'success');
          fetchStorage(true);
        } else {
          addToast('Extraction failed', 'error');
        }
        setPromptConfig(null);
      }
    });
  };

  const handleUpload = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    addToast(`Uploading ${file.name}...`, 'info');
    
    try {
      const res = await apiFetch(`/api/admin/storage/upload?path=${encodeURIComponent(currentPath)}`, {
        method: 'POST',
        body: formData
      });

      if (res.ok) {
        addToast('Upload successful', 'success');
        fetchStorage(true);
      } else {
        addToast('Upload failed', 'error');
      }
    } catch (e) {
      addToast('Network error during upload', 'error');
    }
    
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '-';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (ms: number) => {
    if (!ms) return '-';
    return new Date(ms).toLocaleDateString([], { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const renderTree = (node: StorageNode, level: number = 0) => {
    if (node.type !== 'folder') return null;
    const isExpanded = expandedFolders.has(node.path);
    const isCurrent = currentPath === node.path;
    const isUserRoot = level === 1;

    return (
      <div key={node.path}>
        <div 
          className={`flex items-center py-1 px-2 cursor-pointer rounded-md text-xs transition-colors mb-0.5 group ${
            isCurrent ? 'bg-interactive-accent/10 text-interactive-accent font-medium' : 'hover:bg-interactive-hover text-text-muted'
          }`}
          onClick={() => {
            setCurrentPath(node.path);
            if (!isExpanded) toggleFolder(node.path);
          }}
        >
          <div style={{ marginLeft: `${level * 12}px` }} className="flex items-center gap-1.5 flex-grow truncate">
            <button 
              onClick={(e) => { e.stopPropagation(); toggleFolder(node.path); }}
              className="p-0.5 rounded hover:bg-bg-primary/50"
            >
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {isUserRoot ? (
              <User size={14} className="text-interactive-accent opacity-80" />
            ) : (
              <Folder size={14} className={isCurrent ? "text-interactive-accent" : "text-text-muted opacity-60"} />
            )}
            <span className="truncate">{node.name || 'Master Storage'}</span>
          </div>
        </div>
        {isExpanded && node.children && node.children.some(c => c.type === 'folder') && (
          <div>
            {node.children
              .filter(c => c.type === 'folder')
              .map(child => renderTree(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  const breadcrumbs = useMemo(() => {
    const parts = currentPath ? currentPath.split('/') : [];
    const crumbs = [{ name: 'Root', path: '' }];
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      crumbs.push({ name: part, path: acc });
    }
    return crumbs;
  }, [currentPath]);

  return (
    <div className="flex flex-col h-full overflow-hidden rounded-xl bg-bg-primary border border-border-color shadow-xl" ref={containerRef}>
      {/* High Privilege Warning Banner */}
      <div className="bg-text-danger/10 border-b border-text-danger/20 px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-text-danger p-1 rounded">
            <ShieldAlert size={14} className="text-white" />
          </div>
          <span className="text-[11px] font-bold text-text-danger uppercase tracking-wider">
            Admin Mode: Master Storage Control
          </span>
          <span className="text-[11px] text-text-muted hidden lg:inline border-l border-text-danger/20 pl-3">
            Physical Vault Access. Changes here are permanent and global.
          </span>
        </div>
        <div className="flex items-center gap-3">
          {selectedPaths.size > 0 && (
            <div className="bg-text-danger text-white px-2 py-0.5 rounded text-[10px] font-black animate-pulse flex items-center gap-2">
              <CheckCircle2 size={10} />
              {selectedPaths.size} ITEMS SELECTED
            </div>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <div className="h-14 border-b border-border-color bg-bg-secondary/30 flex items-center px-4 gap-4 flex-shrink-0">
        <div className="flex items-center gap-1 flex-shrink-0">
          <button 
            disabled={!currentPath}
            onClick={() => {
              setCurrentPath(currentPath.split('/').slice(0, -1).join('/'));
              setSelectedPaths(new Set());
              setLastSelectedPath(null);
            }}
            className="p-2 rounded-lg hover:bg-interactive-hover disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            title="Up One Level"
          >
            <ArrowUpLeft size={18} />
          </button>
          <button 
            onClick={() => fetchStorage(true)}
            disabled={loading}
            className="p-2 rounded-lg hover:bg-interactive-hover transition-colors"
            title="Refresh"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin text-interactive-accent' : ''} />
          </button>
        </div>

        {/* Breadcrumbs */}
        <div className="flex-grow flex items-center gap-1 overflow-x-auto no-scrollbar scroll-smooth">
          {breadcrumbs.map((crumb, i) => (
            <React.Fragment key={crumb.path}>
              {i > 0 && <ChevronRight size={12} className="text-text-muted opacity-30 flex-shrink-0" />}
              <button
                onClick={() => {
                  setCurrentPath(crumb.path);
                  setSelectedPaths(new Set());
                  setLastSelectedPath(null);
                }}
                className={`flex-shrink-0 px-2.5 py-1.5 rounded-lg text-sm hover:bg-interactive-hover transition-colors ${
                  i === breadcrumbs.length - 1 ? 'text-text-normal font-bold' : 'text-text-muted'
                }`}
              >
                {crumb.name}
              </button>
            </React.Fragment>
          ))}
        </div>

        {/* Global Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="relative mr-2">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input 
              type="text" 
              placeholder="Search items..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-bg-primary border border-border-color rounded-xl pl-9 pr-4 py-2 text-xs outline-none focus:border-interactive-accent shadow-sm transition-all w-48 lg:w-64"
            />
          </div>
          
          <button 
            onClick={handleCreateFolder}
            className="p-2.5 rounded-xl hover:bg-interactive-hover text-text-muted hover:text-interactive-accent transition-all hover:shadow-sm"
            title="New Folder"
          >
            <FolderPlus size={18} />
          </button>
          
          <button 
            onClick={handleUpload}
            className="p-2.5 rounded-xl hover:bg-interactive-hover text-text-muted hover:text-interactive-accent transition-all hover:shadow-sm"
            title="Upload Files"
          >
            <Upload size={18} />
          </button>

          <div className="h-8 w-px bg-border-color mx-1" />

          <button 
            onClick={() => setViewMode('list')}
            className={`p-2.5 rounded-xl transition-all ${viewMode === 'list' ? 'bg-interactive-accent/10 text-interactive-accent shadow-inner' : 'text-text-muted hover:bg-interactive-hover'}`}
            title="List View"
          >
            <List size={18} />
          </button>
          <button 
            onClick={() => setViewMode('grid')}
            className={`p-2.5 rounded-xl transition-all ${viewMode === 'grid' ? 'bg-interactive-accent/10 text-interactive-accent shadow-inner' : 'text-text-muted hover:bg-interactive-hover'}`}
            title="Grid View"
          >
            <LayoutGrid size={18} />
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <PanelGroup direction="horizontal" className="flex-grow min-h-0 bg-bg-secondary/5">
        <Panel defaultSize={20} minSize={15} className="bg-bg-secondary/10 border-r border-border-color">
          <div className="h-full overflow-y-auto p-4 no-scrollbar scroll-smooth">
            <div className="flex items-center gap-2 mb-5 px-3 text-[10px] font-black text-text-muted uppercase tracking-[0.2em] opacity-40">
              <Database size={10} /> Hierarchy
            </div>
            <div className="space-y-1">
              {nodes
                .filter(n => n.type === 'folder')
                .map(node => renderTree(node))}
            </div>
          </div>
        </Panel>

        <PanelResizeHandle className="w-1.5 bg-transparent hover:bg-interactive-accent/20 transition-all cursor-col-resize active:bg-interactive-accent/50" />

        <Panel className="bg-bg-primary flex flex-col min-w-0 h-full overflow-hidden">
          {/* List Headers */}
          {viewMode === 'list' && currentItems.length > 0 && (
            <div className="grid grid-cols-12 gap-4 px-8 py-3 border-b border-border-color bg-bg-secondary/10 text-[10px] font-black text-text-muted uppercase tracking-widest select-none">
              <div 
                className="col-span-6 flex items-center gap-2 cursor-pointer hover:text-text-normal transition-colors" 
                onClick={() => setSortConfig({ key: 'name', direction: sortConfig.direction === 'asc' ? 'desc' : 'asc' })}
              >
                Name {sortConfig.key === 'name' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
              </div>
              <div 
                className="col-span-2 flex items-center gap-2 cursor-pointer hover:text-text-normal transition-colors" 
                onClick={() => setSortConfig({ key: 'size', direction: sortConfig.direction === 'asc' ? 'desc' : 'asc' })}
              >
                Size {sortConfig.key === 'size' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
              </div>
              <div 
                className="col-span-3 flex items-center gap-2 cursor-pointer hover:text-text-normal transition-colors" 
                onClick={() => setSortConfig({ key: 'updatedAt', direction: sortConfig.direction === 'asc' ? 'desc' : 'asc' })}
              >
                Modified {sortConfig.key === 'updatedAt' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
              </div>
              <div className="col-span-1" />
            </div>
          )}

          {/* Items Display */}
          <div className="flex-grow overflow-y-auto no-scrollbar scroll-smooth" onClick={() => {
            setSelectedPaths(new Set());
            setLastSelectedPath(null);
          }}>
            {loading ? (
              <div className="flex flex-col items-center justify-center h-full gap-5 text-text-muted">
                <div className="relative">
                  <RefreshCw size={48} className="animate-spin text-interactive-accent opacity-20" />
                  <Database size={24} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-interactive-accent" />
                </div>
                <p className="text-sm font-medium animate-pulse">Mapping physical vault...</p>
              </div>
            ) : currentItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-text-muted px-12 text-center">
                <div className="bg-bg-secondary/50 p-10 rounded-full mb-8 shadow-inner">
                  <Search size={64} className="opacity-10 translate-x-1" />
                </div>
                <h4 className="text-xl font-bold text-text-normal mb-3">No Items Found</h4>
                <p className="max-w-sm text-sm opacity-50 leading-relaxed font-medium">
                  This location appears to be empty or contains no items matching your current filters.
                </p>
                <div className="mt-8 flex gap-3">
                  <button onClick={handleCreateFolder} className="px-4 py-2 bg-interactive-accent text-white rounded-xl text-xs font-bold hover:opacity-90 transition-opacity">
                    New Folder
                  </button>
                  <button onClick={handleUpload} className="px-4 py-2 border border-border-color rounded-xl text-xs font-bold hover:bg-bg-secondary transition-colors">
                    Upload
                  </button>
                </div>
              </div>
            ) : viewMode === 'list' ? (
              <div className="p-3 space-y-1">
                {currentItems.map(item => {
                  const isSelected = selectedPaths.has(item.path);
                  const isZip = item.name.toLowerCase().endsWith('.zip');
                  return (
                    <div 
                      key={item.path}
                      onClick={(e) => handleItemClick(e, item)}
                      onDoubleClick={() => handleOpen(item)}
                      onContextMenu={(e) => handleContextMenu(e, item)}
                      className={`grid grid-cols-12 gap-4 px-5 py-2.5 text-sm rounded-xl cursor-pointer transition-all border group ${
                        isSelected 
                          ? 'bg-interactive-accent/10 border-interactive-accent/30 text-text-normal shadow-sm ring-1 ring-interactive-accent/10' 
                          : 'hover:bg-bg-secondary/80 text-text-muted hover:text-text-normal border-transparent'
                      }`}
                    >
                      <div className="col-span-6 flex items-center gap-4 truncate">
                        {item.type === 'folder' 
                          ? <Folder size={20} className="text-interactive-accent flex-shrink-0" />
                          : isZip 
                            ? <FileArchive size={20} className="text-orange-500 flex-shrink-0" />
                            : <File size={20} className="text-text-muted opacity-50 flex-shrink-0" />
                        }
                        <span className={`truncate font-medium ${isSelected ? 'font-bold' : ''}`}>{item.name}</span>
                      </div>
                      <div className="col-span-2 flex items-center text-[11px] opacity-50 font-mono tracking-tighter">
                        {formatSize(item.size)}
                      </div>
                      <div className="col-span-3 flex items-center text-[11px] opacity-50 font-medium">
                        {formatDate(item.updatedAt)}
                      </div>
                      <div className="col-span-1 flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                        <button 
                          onClick={(e) => { e.stopPropagation(); setMetadata(item); }}
                          className="p-1 px-2 hover:bg-interactive-accent/10 hover:text-interactive-accent rounded-lg transition-colors"
                        >
                          <MoreVertical size={16} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-6 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                {currentItems.map(item => {
                  const isSelected = selectedPaths.has(item.path);
                  const isZip = item.name.toLowerCase().endsWith('.zip');
                  return (
                    <div 
                      key={item.path}
                      onClick={(e) => handleItemClick(e, item)}
                      onDoubleClick={() => handleOpen(item)}
                      onContextMenu={(e) => handleContextMenu(e, item)}
                      className={`flex flex-col items-center p-5 rounded-2xl border transition-all group aspect-square justify-center relative shadow-sm ${
                        isSelected 
                          ? 'bg-interactive-accent/10 border-interactive-accent/40 scale-[0.98] ring-4 ring-interactive-accent/5' 
                          : 'hover:bg-bg-secondary hover:border-border-color border-transparent lg:hover:scale-[1.02]'
                      }`}
                    >
                      <div className="mb-4">
                        {item.type === 'folder' 
                          ? <Folder size={48} className="text-interactive-accent drop-shadow-md" />
                          : isZip 
                            ? <FileArchive size={48} className="text-orange-500 drop-shadow-md" />
                            : <File size={48} className="text-text-muted opacity-50 drop-shadow-sm" />
                        }
                      </div>
                      <span className={`text-xs text-center truncate w-full px-2 font-semibold ${isSelected ? 'text-text-normal' : 'text-text-muted'}`}>
                        {item.name}
                      </span>
                      {isSelected && (
                        <div className="absolute top-3 right-3 bg-interactive-accent text-white p-1 rounded-full shadow-lg scale-in-center">
                          <CheckCircle2 size={12} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Floating Actions Bar (Bulk Actions) */}
          {selectedPaths.size > 0 && (
            <div className="mx-6 mb-6 px-5 py-4 bg-bg-primary border border-border-color rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.3)] flex flex-wrap items-center justify-between gap-4 animate-in slide-in-from-bottom-8 duration-500">
              <div className="flex items-center gap-5 min-w-max">
                <div className="flex -space-x-3">
                  {Array.from(selectedPaths).slice(0, 3).map((p, i) => (
                    <div key={p} className="w-8 h-8 rounded-lg bg-interactive-accent flex items-center justify-center text-white border-2 border-bg-primary shadow-lg" style={{ zIndex: 10-i }}>
                      {currentItems.find(n => n.path === p)?.type === 'folder' ? <Folder size={14} /> : <File size={14} />}
                    </div>
                  ))}
                  {selectedPaths.size > 3 && (
                    <div className="w-8 h-8 rounded-lg bg-bg-secondary flex items-center justify-center text-text-muted border-2 border-bg-primary text-[10px] font-bold shadow-lg" style={{ zIndex: 0 }}>
                      +{selectedPaths.size - 3}
                    </div>
                  )}
                </div>
                <div className="flex flex-col">
                  <span className="text-sm font-black text-text-normal leading-none mb-1">
                    {selectedPaths.size} Item{selectedPaths.size > 1 ? 's' : ''} Selected
                  </span>
                  <button 
                    onClick={() => { setSelectedPaths(new Set()); setLastSelectedPath(null); }}
                    className="text-[10px] text-interactive-accent font-bold uppercase tracking-widest hover:underline text-left"
                  >
                    Discard Selection
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap justify-end">
                {selectedPaths.size === 1 && (
                  <>
                    <button 
                      onClick={() => handleRename(Array.from(selectedPaths)[0])}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold hover:bg-bg-secondary transition-all text-text-normal border border-border-color active:scale-95"
                    >
                      <Edit3 size={14} className="opacity-50" /> Rename
                    </button>
                    <button 
                      onClick={() => handleCopy(Array.from(selectedPaths)[0])}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold hover:bg-bg-secondary transition-all text-text-normal border border-border-color active:scale-95"
                    >
                      <Copy size={14} className="opacity-50" /> Copy
                    </button>
                    {Array.from(selectedPaths)[0].toLowerCase().endsWith('.zip') && (
                      <button 
                        onClick={() => handleUnzip(Array.from(selectedPaths)[0])}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold hover:bg-bg-secondary transition-all text-text-normal border border-border-color active:scale-95"
                      >
                        <FolderArchive size={14} className="text-orange-500" /> Extract
                      </button>
                    )}
                  </>
                )}
                
                <button 
                  onClick={handleZip}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold hover:bg-bg-secondary transition-all text-text-normal border border-border-color active:scale-95"
                >
                  <FileArchive size={14} className="opacity-50" /> Zip
                </button>

                <button 
                  onClick={handleDownloadSelected}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold hover:bg-bg-secondary transition-all text-text-normal border border-border-color active:scale-95"
                >
                  <Download size={14} className="opacity-50" /> Download
                </button>

                <div className="h-6 w-px bg-border-color mx-2 hidden sm:block" />
                
                <button 
                  onClick={handleBulkDelete}
                  className="flex items-center gap-2 px-6 py-2 rounded-xl text-xs font-black shadow-lg shadow-text-danger/20 bg-text-danger hover:bg-text-danger/90 transition-all text-white active:scale-95"
                >
                  <Trash2 size={14} /> DELETE
                </button>
              </div>
            </div>
          )}

          {/* Status Bar */}
          <div className="h-10 border-t border-border-color bg-bg-secondary/20 px-5 flex items-center justify-between text-[10px] text-text-muted font-bold tracking-wider select-none flex-shrink-0">
            <div className="flex items-center gap-6">
              <span className="flex items-center gap-2">
                <Database size={10} className="text-interactive-accent" />
                {currentItems.length} OBJECTS
              </span>
              <span className="opacity-40">{currentItems.filter(i => i.type === 'folder').length} FOLDERS, {currentItems.filter(i => i.type === 'file').length} FILES</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono bg-bg-secondary px-2 py-0.5 rounded border border-border-color/50 truncate max-w-[300px]">
                STORAGE/{currentPath || 'ROOT'}
              </span>
              {loading && <RefreshCw size={10} className="animate-spin text-interactive-accent" />}
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {/* Modern Context Menu */}
      {contextMenu && (
        <div 
          className="fixed z-[100] bg-bg-primary border border-border-color rounded-2xl shadow-[0_10px_40px_rgba(0,0,0,0.5)] py-2 w-56 animate-in fade-in zoom-in-95 duration-100 backdrop-blur-md"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-2 mb-1 border-b border-border-color/50">
            <p className="text-[10px] font-black text-text-muted uppercase tracking-[0.2em] truncate">
              {contextMenu.path.split('/').pop()}
            </p>
          </div>
          <button 
            onClick={() => { handleOpen(findNodeByPath(nodes, contextMenu.path)!); setContextMenu(null); }}
            className="w-full text-left px-4 py-2.5 text-xs flex items-center gap-3 hover:bg-interactive-hover transition-colors font-semibold"
          >
            {contextMenu.type === 'folder' ? <ChevronRight size={14} /> : <FilePlus2 size={14} />} 
            Open & View
          </button>
          <div className="h-px bg-border-color/50 my-1 mx-2" />
          <button 
            onClick={() => { handleRename(contextMenu.path); setContextMenu(null); }}
            className="w-full text-left px-4 py-2.5 text-xs flex items-center gap-3 hover:bg-interactive-hover transition-colors font-semibold"
          >
            <Edit3 size={14} className="opacity-40" /> Rename
          </button>
          <button 
            onClick={() => { handleCopy(contextMenu.path); setContextMenu(null); }}
            className="w-full text-left px-4 py-2.5 text-xs flex items-center gap-3 hover:bg-interactive-hover transition-colors font-semibold"
          >
            <Copy size={14} className="opacity-40" /> Copy To
          </button>
          <button 
            onClick={() => { handleZip(); setContextMenu(null); }}
            className="w-full text-left px-4 py-2.5 text-xs flex items-center gap-3 hover:bg-interactive-hover transition-colors font-semibold"
          >
            <FileArchive size={14} className="opacity-40" /> Compress (Zip)
          </button>
          {contextMenu.path.toLowerCase().endsWith('.zip') && (
            <button 
              onClick={() => { handleUnzip(contextMenu.path); setContextMenu(null); }}
              className="w-full text-left px-4 py-2.5 text-xs flex items-center gap-3 hover:bg-interactive-hover transition-colors font-semibold"
            >
              <FolderArchive size={14} className="text-orange-500" /> Extract Here
            </button>
          )}
          <button 
            onClick={() => { handleDownloadSelected(); setContextMenu(null); }}
            className="w-full text-left px-4 py-2.5 text-xs flex items-center gap-3 hover:bg-interactive-hover transition-colors font-semibold"
          >
            <Download size={14} className="opacity-40" /> Download
          </button>
          <div className="h-px bg-border-color/50 my-1 mx-2" />
          <button 
            onClick={() => { handleBulkDelete(); setContextMenu(null); }}
            className="w-full text-left px-4 py-2.5 text-xs flex items-center gap-3 text-text-danger hover:bg-text-danger/10 transition-colors font-bold"
          >
            <Trash2 size={14} /> Move to Trash
          </button>
        </div>
      )}

      {/* Metadata / Properties Modal */}
      {metadata && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-4">
          <div className="bg-bg-primary border border-border-color rounded-[2.5rem] shadow-2xl w-full max-w-sm overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
            <div className="p-6 border-b border-border-color flex items-center justify-between bg-bg-secondary/10">
              <h3 className="font-bold flex items-center gap-3 text-sm uppercase tracking-widest text-text-muted">
                <Info size={18} className="text-interactive-accent" />
                Metadata
              </h3>
              <button onClick={() => setMetadata(null)} className="p-2 hover:bg-bg-secondary rounded-full transition-colors">
                <X size={20} />
              </button>
            </div>
            <div className="p-8">
              <div className="flex flex-col items-center gap-4 py-8 bg-bg-secondary/30 rounded-[2rem] border border-border-color/30 mb-8 shadow-inner">
                {metadata.type === 'folder' 
                  ? <Folder size={64} className="text-interactive-accent drop-shadow-xl" /> 
                  : <File size={64} className="text-text-muted opacity-40 drop-shadow-lg" />
                }
                <div className="text-center px-6">
                  <p className="font-black text-xl break-all mb-1 tracking-tight">{metadata.name}</p>
                  <p className="text-[10px] text-interactive-accent font-black tracking-[0.3em] uppercase opacity-60">System {metadata.type}</p>
                </div>
              </div>

              <div className="space-y-4 text-xs font-semibold px-2">
                <div className="flex justify-between items-center border-b border-border-color/10 pb-3">
                  <span className="text-text-muted uppercase tracking-tighter opacity-60">Relative Path</span>
                  <span className="font-mono text-right break-all max-w-[180px] bg-bg-secondary px-2 py-1 rounded select-all tracking-tighter">{metadata.path}</span>
                </div>
                <div className="flex justify-between items-center border-b border-border-color/10 pb-3">
                  <span className="text-text-muted uppercase tracking-tighter opacity-60">Physical Size</span>
                  <span className="font-mono font-black text-interactive-accent text-sm">{formatSize(metadata.size)}</span>
                </div>
                <div className="flex justify-between items-center border-b border-border-color/10 pb-3">
                  <span className="text-text-muted uppercase tracking-tighter opacity-60">Modified</span>
                  <span className="text-right opacity-80">{formatDate(metadata.updatedAt)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-text-muted uppercase tracking-tighter opacity-60">Created</span>
                  <span className="text-right opacity-80">{formatDate(metadata.createdAt)}</span>
                </div>
              </div>
            </div>
            <div className="p-6 bg-bg-secondary/20 flex flex-col gap-3 border-t border-border-color">
              <div className="flex gap-3">
                <button 
                  onClick={() => {
                    handleDownloadSelected();
                    setMetadata(null);
                  }}
                  className="flex-1 py-3 bg-bg-primary border border-border-color rounded-2xl text-xs font-black hover:bg-bg-secondary transition-all"
                >
                  DOWNLOAD
                </button>
                <button 
                  onClick={() => setMetadata(null)}
                  className="flex-1 py-3 bg-bg-primary border border-border-color rounded-2xl text-xs font-black shadow-lg hover:bg-bg-secondary transition-all"
                >
                  CLOSE
                </button>
              </div>
              <button 
                onClick={() => {
                  handleBulkDelete();
                  setMetadata(null);
                }}
                className="w-full py-4 bg-text-danger text-white rounded-2xl text-xs font-black shadow-lg shadow-text-danger/20 hover:bg-text-danger/90 transition-all active:scale-95 flex items-center justify-center gap-3"
              >
                <Trash2 size={16} /> DELETE PERMANENTLY
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Prompts */}
      {promptConfig && (
        <PromptModal 
          isOpen={promptConfig.isOpen}
          title={promptConfig.title}
          defaultValue={promptConfig.defaultValue}
          mode={promptConfig.mode}
          onCancel={() => setPromptConfig(null)}
          onConfirm={promptConfig.onConfirm}
        />
      )}

      {/* Hidden Upload Input */}
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={onFileChange}
        className="hidden" 
      />

      {/* Modern Toast System */}
      <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[200] flex flex-col items-center gap-3">
        {toasts.map(toast => (
          <div 
            key={toast.id}
            className={`flex items-center gap-4 px-6 py-4 rounded-[2rem] shadow-[0_25px_60px_-15px_rgba(0,0,0,0.5)] border-2 backdrop-blur-xl animate-in slide-in-from-bottom-8 fade-in duration-500 fill-mode-both ${
              toast.type === 'success' ? 'bg-bg-primary/90 border-green-500/20' : 
              toast.type === 'error' ? 'bg-bg-primary/90 border-text-danger/20' : 
              'bg-bg-primary/90 border-interactive-accent/20'
            }`}
          >
            <div className={`p-1.5 rounded-full ${
              toast.type === 'success' ? 'bg-green-500/10 text-green-500' : 
              toast.type === 'error' ? 'bg-text-danger/10 text-text-danger' : 
              'bg-interactive-accent/10 text-interactive-accent'
            }`}>
              {toast.type === 'success' && <CheckCircle2 size={16} />}
              {toast.type === 'error' && <AlertCircle size={16} />}
              {toast.type === 'info' && <RefreshCw size={16} className="animate-spin" />}
            </div>
            <span className="text-xs font-black tracking-tight text-text-normal pr-4">{toast.message}</span>
            <button onClick={() => setToasts(t => t.filter(x => x.id !== toast.id))} className="opacity-30 hover:opacity-100 transition-opacity">
              <X size={14} strokeWidth={3} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
