import React, { useState, useEffect, useRef } from 'react';
import { Group, Panel as PanelOrig, Separator } from 'react-resizable-panels';
const PanelGroup = Group as any;
const Panel = PanelOrig as any;
const PanelResizeHandle = Separator as any;
import { Settings, Search, Network, FileText, Plus, X, Calendar, Clock, Bookmark, LayoutDashboard, HelpCircle, ArrowLeft, ArrowRight, LogOut, DoorOpen, PanelRight, ChevronLeft, ChevronRight, ClipboardList, Layers, Edit3, Trash2, Copy, LayoutGrid, FolderTree, FilePlus2, SquarePlus, Users, User, ShieldAlert, Shield, Pencil, Check } from 'lucide-react';
import { FileExplorer } from './components/FileExplorer';
import { MilkdownEditor } from './components/MilkdownEditor';
import { Canvas } from './components/Canvas';
import { Graph } from './components/Graph';
import { CommandPalette } from './components/CommandPalette';
import { SettingsModal } from './components/SettingsModal';
import { Auth } from './components/Auth';
import { AdminDashboard } from './components/AdminDashboard';
import { apiFetch } from './lib/api';

export type TabType = 'editor' | 'graph' | 'canvas' | 'admin' | 'profile';
export interface TabData {
  id: string;
  type: TabType;
  title: string;
  path?: string;
}

export default function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('jays_notes_token'));
  const [role, setRole] = useState<string | null>(localStorage.getItem('jays_notes_role'));
  const [username, setUsername] = useState<string | null>(localStorage.getItem('jays_notes_username'));
  
  const defaultHome = localStorage.getItem('jays_notes_home') || 'Welcome.md';
  // Restore the last-opened file; fall back to home if none saved
  const lastFile = localStorage.getItem('jn-last-file') || defaultHome;
  const lastFileTitle = lastFile.split('/').pop()?.replace(/\.(md|canvas)$/, '') || 'Home';
  const [tabs, setTabs] = useState<TabData[]>([{ id: 'home', type: 'editor', title: lastFileTitle, path: lastFile }]);
  const [activeTabId, setActiveTabId] = useState<string | null>('home');
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isRecentNotesOpen, setIsRecentNotesOpen] = useState(false);
  const [isLogoutConfirmOpen, setIsLogoutConfirmOpen] = useState(false);
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(true);
  const [leftSidebarTab, setLeftSidebarTab] = useState<'files' | 'search' | 'bookmarks' | 'templates'>('files');
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(true);
  const [history, setHistory] = useState<string[]>(['Welcome.md']);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [links, setLinks] = useState<{ backlinks: { path: string; name: string }[], forwardlinks: { path: string; name: string }[] }>({ backlinks: [], forwardlinks: [] });
  const [bookmarks, setBookmarks] = useState<string[]>(() => {
    const saved = localStorage.getItem('jays_notes_bookmarks');
    return saved ? JSON.parse(saved) : [];
  });
  const [splitTabId, setSplitTabId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabTitle, setEditingTabTitle] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [tags, setTags] = useState<{tag: string, count: number, files: string[]}[]>([]);
  const [rightSidebarTab, setRightSidebarTab] = useState<'links' | 'tags'>('links');
  const [templates, setTemplates] = useState<{ name: string, path: string, type: string }[]>([]);
  const [renamingTemplatePath, setRenamingTemplatePath] = useState<string | null>(null);
  const [renamingTemplateValue, setRenamingTemplateValue] = useState('');
  
  const [newPassword, setNewPassword] = useState('');
  const [passwordChangeStatus, setPasswordChangeStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);

  // Agent Space state
  const [agentSpaceStatus, setAgentSpaceStatus] = useState<{
    show: boolean;
    state: 'loading' | 'success' | 'error' | 'first-time';
    message: string;
    projectMdPath?: string;
    projectMdContent?: string;
    summaryPath?: string;
  }>({ show: false, state: 'loading', message: '' });

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordChangeStatus(null);
    if (!newPassword.trim()) return;

    try {
      const res = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword })
      });
      if (res.ok) {
        setPasswordChangeStatus({ type: 'success', message: 'Password updated successfully!' });
        setNewPassword('');
        setTimeout(() => setPasswordChangeStatus(null), 5000);
      } else {
        const data = await res.json();
        setPasswordChangeStatus({ type: 'error', message: data.error || 'Failed to update password' });
      }
    } catch (err) {
      setPasswordChangeStatus({ type: 'error', message: 'Connection error' });
    }
  };

  const tabsRef = useRef<HTMLDivElement>(null);

  // -------------------------------------------------------------------------
  // Agent Space — Add to Project Knowledge
  // -------------------------------------------------------------------------
  const handleAddToProjectKnowledge = async (notePath: string) => {
    const agentSpaceFolder = localStorage.getItem('jays_notes_agent_space_folder') || '2 - Agent Space';

    setAgentSpaceStatus({ show: true, state: 'loading', message: 'Summarizing note — this may take a moment…' });

    try {
      const res = await apiFetch('/api/agent/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notePath, agentSpaceFolder }),
      });

      const data = await res.json();

      if (!res.ok) {
        setAgentSpaceStatus({ show: true, state: 'error', message: data.error || 'Summarization failed.' });
        setTimeout(() => setAgentSpaceStatus(s => ({ ...s, show: false })), 5000);
        return;
      }

      if (data.isFirstTime) {
        // First time for this project — prompt user to review Project.md skeleton
        setAgentSpaceStatus({
          show: true,
          state: 'first-time',
          message: `New project "${data.projectName}" — Project.md skeleton created. Fill in description, stakeholders, and context, then save. The summary has already been stored.`,
          projectMdPath: data.projectMdPath,
          projectMdContent: data.projectMdContent,
          summaryPath: data.summaryPath,
        });
      } else {
        setAgentSpaceStatus({
          show: true,
          state: 'success',
          message: `✓ Summary saved and Project.md updated.`,
          summaryPath: data.summaryPath,
          projectMdPath: data.projectMdPath,
        });
        setRefreshTrigger(t => t + 1);
        setTimeout(() => setAgentSpaceStatus(s => ({ ...s, show: false })), 4000);
      }
    } catch (err: any) {
      setAgentSpaceStatus({ show: true, state: 'error', message: `Error: ${err.message}` });
      setTimeout(() => setAgentSpaceStatus(s => ({ ...s, show: false })), 5000);
    }
  };

  const handleAgentSpaceProjectMdSave = async (content: string) => {
    if (!agentSpaceStatus.projectMdPath) return;
    try {
      await apiFetch('/api/agent/project-md', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectMdPath: agentSpaceStatus.projectMdPath, content }),
      });
      setRefreshTrigger(t => t + 1);
      setAgentSpaceStatus({ show: false, state: 'success', message: '' });
    } catch {
      // silently close — file was already written by server at skeleton stage
      setAgentSpaceStatus({ show: false, state: 'success', message: '' });
    }
  };

  const handleLogin = (newToken: string, newRole: string, newUsername: string) => {
    setToken(newToken);
    setRole(newRole);
    setUsername(newUsername);
    const h = localStorage.getItem('jays_notes_home') || 'Welcome.md';
    const ht = h.split('/').pop()?.replace(/\.(md|canvas)$/, '') || 'Home';
    setTabs([{ id: 'home', type: 'editor', title: ht, path: h }]);
    setActiveTabId('home');
  };

  const handleLogout = () => {
    setIsLogoutConfirmOpen(true);
  };

  const doLogout = () => {
    localStorage.removeItem('jays_notes_token');
    localStorage.removeItem('jays_notes_role');
    localStorage.removeItem('jays_notes_username');
    localStorage.removeItem('jn-last-file');
    setToken(null);
    setRole(null);
    setUsername(null);
    setIsLogoutConfirmOpen(false);
  };

  useEffect(() => {
    if (!token) return;
    const fetchTemplates = async () => {
      try {
        const res = await apiFetch('/api/files');
        if (!res.ok) return;
        const data = await res.json();
        if (!Array.isArray(data)) return;
        const findTemplates = (nodes: any[]) => {
          for (const node of nodes) {
            if (node.name === 'Templates' && node.type === 'folder') {
              return node.children?.map((c: any) => ({
                name: c.name,
                path: c.path,
                type: c.type // 'file' or 'canvas'
              })) || [];
            }
            if (node.children) {
              const found: any[] = findTemplates(node.children);
              if (found.length > 0) return found;
            }
          }
          return [];
        };
        setTemplates(findTemplates(data));
      } catch (error) {
        console.error('Failed to fetch templates', error);
      }
    };
    fetchTemplates();
  }, [refreshTrigger, token]);

  const handleNewFromTemplate = async (template: { name: string, path: string, type: string }) => {
    try {
      const res = await apiFetch(`/api/file?path=${encodeURIComponent(template.path)}`);
      if (res.ok) {
        let content = await res.text();
        const today = new Date().toISOString().split('T')[0];
        content = content.replace(/{{date}}/g, today);
        
        const isCanvas = template.type === 'canvas' || template.path.endsWith('.canvas');
        const baseName = template.name.replace(/\.(md|canvas)$/i, '');
        const extension = isCanvas ? '.canvas' : '.md';

        // Check for existing files to find a unique name
        const filesRes = await apiFetch('/api/files');
        if (!filesRes.ok) throw new Error('Failed to fetch file list');
        const tree = await filesRes.json();
        if (!Array.isArray(tree)) throw new Error('Invalid file list received');
        
        const getAllPaths = (nodes: any[]): string[] => {
          let paths: string[] = [];
          for (const node of nodes) {
            paths.push(node.path);
            if (node.children) paths.push(...getAllPaths(node.children));
          }
          return paths;
        };
        const existingPaths = getAllPaths(tree);

        let counter = 1;
        let finalPath = isCanvas ? `${baseName}.canvas` : `${baseName}.md`;
        
        while (existingPaths.includes(finalPath)) {
          finalPath = isCanvas ? `${baseName} ${counter}.canvas` : `${baseName} ${counter}.md`;
          counter++;
        }

        await apiFetch('/api/file/new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: finalPath, type: isCanvas ? 'canvas' : 'file' }),
        });
        await apiFetch('/api/file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: finalPath, content }),
        });
        handleSelectFile(finalPath);
        setRefreshTrigger(prev => prev + 1);
        setLeftSidebarTab('files');
      }
    } catch (error) {
      console.error('Failed to create note from template', error);
    }
  };

  const handleDuplicateFile = async (path: string) => {
    try {
      const res = await apiFetch('/api/file/duplicate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (res.ok) {
        setRefreshTrigger(prev => prev + 1);
      }
    } catch (error) {
      console.error('Failed to duplicate file', error);
    }
  };

  const handleDeleteFile = async (path: string) => {
    if (!confirm(`Are you sure you want to delete ${path.split('/').pop()}?`)) return;
    try {
      const res = await apiFetch('/api/file/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (res.ok) {
        setTabs(prev => prev.filter(t => t.path !== path));
        if (activeTabId === path) setActiveTabId(null);
        setRefreshTrigger(prev => prev + 1);
        window.dispatchEvent(new CustomEvent('file-saved'));
      }
    } catch (error) {
      console.error('Failed to delete file', error);
    }
  };

  const handleRenameTemplate = async (oldPath: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) { setRenamingTemplatePath(null); return; }
    const ext = oldPath.endsWith('.canvas') ? '.canvas' : '.md';
    const folder = oldPath.split('/').slice(0, -1).join('/');
    const newPath = folder ? `${folder}/${trimmed}${ext}` : `${trimmed}${ext}`;
    if (newPath === oldPath) { setRenamingTemplatePath(null); return; }
    try {
      const res = await apiFetch('/api/file/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: oldPath, destination: newPath }),
      });
      if (res.ok) {
        setTabs(prev => prev.map(t => t.path === oldPath ? { ...t, path: newPath, title: trimmed } : t));
        setRefreshTrigger(prev => prev + 1);
      }
    } catch (e) { console.error('Failed to rename template', e); }
    setRenamingTemplatePath(null);
  };

  const scrollTabs = (direction: 'left' | 'right') => {
    if (tabsRef.current) {
      tabsRef.current.scrollBy({ left: direction === 'left' ? -200 : 200, behavior: 'smooth' });
    }
  };

  const activeTab = tabs.find(t => t.id === activeTabId);
  const splitTab = tabs.find(t => t.id === splitTabId);

  useEffect(() => {
    localStorage.setItem('jays_notes_bookmarks', JSON.stringify(bookmarks));
  }, [bookmarks]);

  useEffect(() => {
    const fetchTags = async () => {
      try {
        const res = await apiFetch('/api/tags');
        if (res.ok) {
          const data = await res.json();
          setTags(data);
        }
      } catch (error) {
        console.error('Failed to fetch tags', error);
      }
    };
    fetchTags();

    const handleFileSaved = () => {
      fetchTags();
    };

    window.addEventListener('file-saved', handleFileSaved);
    return () => window.removeEventListener('file-saved', handleFileSaved);
  }, [refreshTrigger]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const delayDebounceFn = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await apiFetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
        if (res.ok) {
          const data = await res.json();
          setSearchResults(data);
        }
      } catch (error) {
        console.error('Search failed', error);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(delayDebounceFn);
  }, [searchQuery]);

  useEffect(() => {
    const handleAuthExpired = () => setToken(null);
    window.addEventListener('auth-expired', handleAuthExpired);
    
    const theme = localStorage.getItem('jays_notes_theme');
    if (theme === 'Light') {
      document.documentElement.classList.add('light');
    }
    let accent = localStorage.getItem('jays_notes_accent');
    if (accent === '#7d4698' || accent === '#D85A30') {
      accent = '#00c882';
      localStorage.setItem('jays_notes_accent', accent);
    }
    if (accent) {
      document.documentElement.style.setProperty('--interactive-accent', accent);
    }
    
    return () => window.removeEventListener('auth-expired', handleAuthExpired);
  }, []);

  useEffect(() => {
    const fetchLinks = async () => {
      if (activeTabId && activeTab?.type === 'editor' && activeTab.path) {
        try {
          const res = await apiFetch(`/api/links?path=${encodeURIComponent(activeTab.path)}`);
          if (res.ok) {
            const data = await res.json();
            setLinks(data);
          }
        } catch (error) {
          console.error(error);
        }
      } else {
        setLinks({ backlinks: [], forwardlinks: [] });
      }
    };
    fetchLinks();
  }, [activeTabId, activeTab, refreshTrigger]);

  // Separate stable listener: re-fetch links whenever any file is saved
  // Uses refs to avoid stale closure — always reads current activeTab
  const activeTabRef = React.useRef(activeTab);
  activeTabRef.current = activeTab;
  useEffect(() => {
    const onSaved = () => {
      const tab = activeTabRef.current;
      if (tab?.type === 'editor' && tab.path) {
        apiFetch(`/api/links?path=${encodeURIComponent(tab.path)}`)
          .then(r => r.ok ? r.json() : null)
          .then(data => { if (data) setLinks(data); })
          .catch(() => {});
      }
    };
    window.addEventListener('file-saved', onSaved);
    return () => window.removeEventListener('file-saved', onSaved);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        setIsCommandPaletteOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        handleNewFile();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setIsSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleNewFile = async (customName?: string, folderPath?: string, type: 'file' | 'canvas' = 'file') => {
    let nameToUse = customName;
    const extension = type === 'canvas' ? '.canvas' : '.md';

    try {
      const res = await apiFetch('/api/files');
      if (!res.ok) throw new Error('Failed to fetch files');
      const tree = await res.json();
      if (!Array.isArray(tree)) throw new Error('Invalid file list received');
      
      const getAllPaths = (nodes: any[]): string[] => {
        let paths: string[] = [];
        for (const node of nodes) {
          paths.push(node.path);
          if (node.children) paths.push(...getAllPaths(node.children));
        }
        return paths;
      };
      const existingPaths = getAllPaths(tree);

      if (!nameToUse) {
        const baseName = type === 'canvas' ? 'Untitled Canvas' : 'Untitled';
        nameToUse = baseName;
        
        let testPath = folderPath ? `${folderPath}/${nameToUse}${extension}` : `${nameToUse}${extension}`;
        let counter = 1;
        
        while (existingPaths.includes(testPath)) {
          nameToUse = `${baseName} ${counter}`;
          testPath = folderPath ? `${folderPath}/${nameToUse}${extension}` : `${nameToUse}${extension}`;
          counter++;
        }
      } else {
        // If customName is provided, still check for collisions and auto-increment if needed
        let testPath = folderPath ? `${folderPath}/${nameToUse}${extension}` : `${nameToUse}${extension}`;
        if (existingPaths.includes(testPath)) {
          const baseName = nameToUse;
          let counter = 1;
          while (existingPaths.includes(testPath)) {
            nameToUse = `${baseName} ${counter}`;
            testPath = folderPath ? `${folderPath}/${nameToUse}${extension}` : `${nameToUse}${extension}`;
            counter++;
          }
        }
      }
    } catch (e) {
      console.error('Error checking for existing files:', e);
      // Fallback to what was provided if tree fetch fails
      if (!nameToUse) nameToUse = type === 'canvas' ? 'Untitled Canvas' : 'Untitled';
    }

    let finalPath = nameToUse.toLowerCase().endsWith(extension) ? nameToUse : `${nameToUse}${extension}`;
    if (folderPath && !finalPath.startsWith(`${folderPath}/`)) {
      finalPath = `${folderPath}/${finalPath}`;
    }
    
    try {
      const res = await apiFetch('/api/file/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: finalPath, type }),
      });
      if (res.ok) {
        handleSelectFile(finalPath);
        setRefreshTrigger(prev => prev + 1);
        
        // Immediately trigger renaming for new files
        setEditingTabId(finalPath);
        setEditingTabTitle(nameToUse);
      } else {
        try {
          const err = await res.json();
          console.error('Failed to create file:', err.error);
          alert(`Failed to create file: ${err.error}`);
        } catch (e) {
          console.error('Failed to create file');
          alert('Failed to create file');
        }
      }
    } catch (error) {
      console.error(error);
    }
  };

  const handleRenameTab = async (tabId: string, newName: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !tab.path) {
      setEditingTabId(null);
      return;
    }

    const safeNewName = newName.trim();
    if (!safeNewName || safeNewName === tab.title) {
      setEditingTabId(null);
      return;
    }

    const isCanvas = tab.path.endsWith('.canvas');
    const extension = isCanvas ? '.canvas' : '.md';
    const folderPath = tab.path.split('/').slice(0, -1).join('/');
    const newPath = folderPath ? `${folderPath}/${safeNewName}${extension}` : `${safeNewName}${extension}`;

    try {
      const res = await apiFetch('/api/file/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: tab.path, destination: newPath }),
      });

      if (res.ok) {
        setTabs(prev => prev.map(t => {
          if (t.id === tabId) {
            return { ...t, id: newPath, path: newPath, title: safeNewName };
          }
          return t;
        }));
        if (activeTabId === tabId) setActiveTabId(newPath);
        setRefreshTrigger(prev => prev + 1);
      } else {
        const err = await res.json();
        alert(`Rename failed: ${err.error}`);
      }
    } catch (e) {
      console.error(e);
    }
    setEditingTabId(null);
  };

  const handleSelectFile = (path: string) => {
    const existingTab = tabs.find(t => t.id === path);
    if (!existingTab) {
      const isCanvas = path.endsWith('.canvas');
      const newTab: TabData = { 
        id: path, 
        type: isCanvas ? 'canvas' : 'editor', 
        title: path.split('/').pop()?.replace(/\.(md|canvas)$/, '') || path, 
        path 
      };
      setTabs(prev => [...prev, newTab]);
    }
    setActiveTabId(path);
    // Persist so the same file reopens after a page refresh
    try { localStorage.setItem('jn-last-file', path); } catch (_) { /* quota */ }
    
    // Update history
    if (history[historyIndex] !== path) {
      const newHistory = history.slice(0, historyIndex + 1);
      newHistory.push(path);
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
    }
  };

  const handleToggleSplit = (tabId: string) => {
    if (splitTabId === tabId) {
      setSplitTabId(null);
    } else {
      setSplitTabId(tabId);
    }
  };

  const handleGoBack = () => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      const path = history[newIndex];
      setActiveTabId(path);
    }
  };

  const handleGoForward = () => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      const path = history[newIndex];
      setActiveTabId(path);
    }
  };

  const handleOpenGraph = () => {
    const existingTab = tabs.find(t => t.id === 'graph-view');
    if (!existingTab) {
      const newTab: TabData = { id: 'graph-view', type: 'graph', title: 'Graph View' };
      setTabs(prev => [...prev, newTab]);
    }
    setActiveTabId('graph-view');
  };

  const handleOpenCanvas = () => {
    const existingTab = tabs.find(t => t.id === 'canvas-view');
    if (!existingTab) {
      const newTab: TabData = { id: 'canvas-view', type: 'canvas', title: 'Canvas' };
      setTabs(prev => [...prev, newTab]);
    }
    setActiveTabId('canvas-view');
  };

  const handleCloseTab = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const newTabs = tabs.filter(t => t.id !== id);
    setTabs(newTabs);
    if (activeTabId === id) {
      setActiveTabId(newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null);
    }
  };

  const handleDailyNote = async () => {
    const today = new Date().toISOString().split('T')[0];
    const fileName = `${today}.md`;
    
    try {
      // Find if we already have this file
      const checkRes = await apiFetch(`/api/file?path=${encodeURIComponent(fileName)}`);
      if (checkRes.ok) {
        handleSelectFile(fileName);
        return;
      }

      // Get the strict path to the default Daily Note template
      const templatePath = 'Templates/Daily Note.md';

      // Try to use template if it exists
      const templateRes = await apiFetch(`/api/file?path=${encodeURIComponent(templatePath)}`);
      let content = '# Daily Note: ' + today;
      if (templateRes.ok) {
        content = await templateRes.text();
        content = content.replace(/{{date}}/g, today);
      } else {
        // Fallback default content if no template exists
        content = `# Daily Note: ${today}\n\n## Tasks\n- [ ] \n\n## Notes\n`;
      }

      const res = await apiFetch('/api/file/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fileName }),
      });
      
      if (res.ok) {
        await apiFetch('/api/file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: fileName, content }),
        });
      }
      
      handleSelectFile(fileName);
      setRefreshTrigger(prev => prev + 1);
    } catch (error) {
      console.error(error);
    }
  };

  if (!token) {
    return <Auth onLogin={handleLogin} />;
  }

  return (
    <div className="absolute inset-0 flex bg-bg-primary text-text-normal overflow-hidden">
      <CommandPalette 
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        onSelectFile={handleSelectFile}
        onCreateFile={handleNewFile}
      />
      
      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={() => setIsSettingsOpen(false)} 
      />

      {/* ------------------------------------------------------------------ */}
      {/* Agent Space — Status overlay                                         */}
      {/* ------------------------------------------------------------------ */}
      {agentSpaceStatus.show && agentSpaceStatus.state === 'loading' && (
        <div className="fixed bottom-6 right-6 z-[300] flex items-center gap-3 bg-bg-secondary border border-border-color rounded-xl shadow-2xl px-5 py-4 min-w-[300px] max-w-sm">
          <div className="w-5 h-5 border-2 rounded-full animate-spin flex-shrink-0" style={{ borderColor: 'var(--interactive-accent)', borderTopColor: 'transparent' }} />
          <div>
            <p className="text-xs font-semibold" style={{ color: 'var(--interactive-accent)' }}>✦ Agent Space</p>
            <p className="text-sm text-text-normal mt-0.5">{agentSpaceStatus.message}</p>
          </div>
        </div>
      )}

      {agentSpaceStatus.show && agentSpaceStatus.state === 'success' && (
        <div className="fixed bottom-6 right-6 z-[300] flex items-center gap-3 bg-bg-secondary border border-border-color rounded-xl shadow-2xl px-5 py-4 min-w-[300px] max-w-sm">
          <span className="text-xl flex-shrink-0">✓</span>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold" style={{ color: 'var(--interactive-accent)' }}>✦ Agent Space</p>
            <p className="text-sm text-text-normal mt-0.5">{agentSpaceStatus.message}</p>
            {agentSpaceStatus.summaryPath && (
              <button
                className="text-xs underline mt-1 truncate max-w-full text-left"
                style={{ color: 'var(--interactive-accent)' }}
                onClick={() => {
                  if (agentSpaceStatus.summaryPath) handleSelectFile(agentSpaceStatus.summaryPath);
                  setAgentSpaceStatus(s => ({ ...s, show: false }));
                }}
              >
                Open summary →
              </button>
            )}
          </div>
          <button onClick={() => setAgentSpaceStatus(s => ({ ...s, show: false }))} className="text-text-muted hover:text-text-normal flex-shrink-0 ml-1">✕</button>
        </div>
      )}

      {agentSpaceStatus.show && agentSpaceStatus.state === 'error' && (
        <div className="fixed bottom-6 right-6 z-[300] flex items-center gap-3 bg-bg-secondary border border-red-500/40 rounded-xl shadow-2xl px-5 py-4 min-w-[300px] max-w-sm">
          <span className="text-red-500 text-xl flex-shrink-0">✕</span>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-red-500">✦ Agent Space — Error</p>
            <p className="text-sm text-text-normal mt-0.5">{agentSpaceStatus.message}</p>
          </div>
          <button onClick={() => setAgentSpaceStatus(s => ({ ...s, show: false }))} className="text-text-muted hover:text-text-normal flex-shrink-0 ml-1">✕</button>
        </div>
      )}

      {/* First-time Project.md review modal */}
      {agentSpaceStatus.show && agentSpaceStatus.state === 'first-time' && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-bg-primary border border-border-color rounded-xl shadow-2xl flex flex-col w-full max-w-2xl mx-4" style={{ maxHeight: '85vh' }}>
            {/* Header */}
            <div className="flex items-center gap-3 px-6 py-4 border-b border-border-color flex-shrink-0">
              <span style={{ color: 'var(--interactive-accent)', fontSize: 20 }}>✦</span>
              <div className="flex-1 min-w-0">
                <h2 className="font-semibold text-text-normal">New Project Detected</h2>
                <p className="text-xs text-text-muted mt-0.5">{agentSpaceStatus.message}</p>
              </div>
            </div>
            {/* Editor */}
            <div className="flex-1 overflow-y-auto p-4 min-h-0">
              <p className="text-xs text-text-muted mb-2">
                Edit <code className="bg-bg-secondary px-1 rounded">{agentSpaceStatus.projectMdPath}</code> — fill in project description, stakeholders, and context. This becomes the persistent memory agents use to answer your questions.
              </p>
              <textarea
                className="w-full bg-bg-secondary border border-border-color rounded-lg p-3 text-sm text-text-normal outline-none focus:border-interactive-accent transition-colors resize-none font-mono"
                style={{ minHeight: 380 }}
                defaultValue={agentSpaceStatus.projectMdContent || ''}
                onChange={e => setAgentSpaceStatus(s => ({ ...s, projectMdContent: e.target.value }))}
              />
            </div>
            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-border-color flex-shrink-0 gap-3">
              <p className="text-xs text-text-muted">
                Summary was saved to <code className="bg-bg-secondary px-1 rounded">{agentSpaceStatus.summaryPath}</code>
              </p>
              <div className="flex gap-2 flex-shrink-0">
                <button
                  onClick={() => {
                    setAgentSpaceStatus(s => ({ ...s, show: false }));
                    setRefreshTrigger(t => t + 1);
                  }}
                  className="px-4 py-1.5 text-sm rounded-lg border border-border-color text-text-muted hover:text-text-normal hover:bg-bg-secondary transition-colors"
                >
                  Skip for now
                </button>
                <button
                  onClick={() => handleAgentSpaceProjectMdSave(agentSpaceStatus.projectMdContent || '')}
                  className="px-4 py-1.5 text-sm rounded-lg text-white font-medium transition-colors"
                  style={{ background: 'var(--interactive-accent)' }}
                >
                  Save Project.md
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Logout confirmation dialog */}
      {isLogoutConfirmOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-bg-secondary border border-border-color rounded-xl shadow-2xl p-6 w-full max-w-sm mx-4">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-error/10 flex items-center justify-center flex-shrink-0">
                <DoorOpen size={20} className="text-error" />
              </div>
              <div>
                <h3 className="font-semibold text-text-normal text-sm">Log Out?</h3>
                <p className="text-xs text-text-muted mt-0.5">You'll need to sign in again to access your vault.</p>
              </div>
            </div>
            <div className="flex gap-2 mt-5 justify-end">
              <button
                onClick={() => setIsLogoutConfirmOpen(false)}
                className="px-4 py-1.5 text-sm rounded-lg border border-border-color text-text-muted hover:text-text-normal hover:bg-bg-primary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={doLogout}
                className="px-4 py-1.5 text-sm rounded-lg bg-error text-white hover:bg-error/90 transition-colors font-medium"
              >
                Log Out
              </button>
            </div>
          </div>
        </div>
      )}

      {role === 'admin' && (
        <div className="fixed top-3 right-14 z-[60] bg-red-600 shadow-lg shadow-red-600/20 text-white text-[10px] font-black px-2.5 py-1 rounded-md flex items-center gap-1.5 select-none border border-white/20 pointer-events-none tracking-tighter">
          <ShieldAlert size={12} className="text-white" />
          ADMIN
        </div>
      )}

      {isRecentNotesOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/50 backdrop-blur-sm" onClick={() => setIsRecentNotesOpen(false)}>
          <div 
            className="bg-bg-primary border border-border-color rounded-xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="p-4 border-b border-border-color">
              <h2 className="text-lg font-semibold text-text-normal">Recent Notes</h2>
            </div>
            <div className="p-2 max-h-[50vh] overflow-y-auto">
              {tabs.filter(t => t.type === 'editor').map(tab => (
                <button
                  key={tab.id}
                  className="w-full text-left px-4 py-2 text-sm text-text-normal hover:bg-interactive-hover hover:text-interactive-accent rounded flex items-center gap-2"
                  onClick={() => {
                    handleSelectFile(tab.id);
                    setIsRecentNotesOpen(false);
                  }}
                >
                  <Clock size={14} className="text-text-muted" />
                  {tab.title}
                </button>
              ))}
              {tabs.filter(t => t.type === 'editor').length === 0 && (
                <div className="p-4 text-center text-text-muted text-sm">No recent notes.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Ribbon (Far Left) */}
      <div className="w-12 flex-shrink-0 bg-bg-secondary border-r border-border-color flex flex-col items-center py-4 space-y-6 z-10">
        <button 
          className="text-text-muted hover:text-text-normal transition-colors"
          onClick={() => {
            handleNewFile();
            setLeftSidebarTab('files');
          }}
          title="New Note"
        >
          <FilePlus2 size={20} />
        </button>
        <button 
          className="text-text-muted hover:text-text-normal transition-colors"
          onClick={() => {
            handleNewFile(undefined, undefined, 'canvas');
            setLeftSidebarTab('files');
          }}
          title="New Canvas"
        >
          <SquarePlus size={20} />
        </button>
        <button 
          className={`hover:text-text-normal transition-colors ${isLeftSidebarOpen && leftSidebarTab === 'files' ? 'text-interactive-accent' : 'text-text-muted'}`}
          title="Files"
          onClick={() => {
            if (isLeftSidebarOpen && leftSidebarTab === 'files') {
              setIsLeftSidebarOpen(false);
            } else {
              setIsLeftSidebarOpen(true);
              setLeftSidebarTab('files');
            }
          }}
        >
          <FolderTree size={20} />
        </button>
        <button 
          className={`hover:text-text-normal transition-colors ${isLeftSidebarOpen && leftSidebarTab === 'search' ? 'text-interactive-accent' : 'text-text-muted'}`}
          onClick={() => {
            if (isLeftSidebarOpen && leftSidebarTab === 'search') {
              setIsLeftSidebarOpen(false);
            } else {
              setIsLeftSidebarOpen(true);
              setLeftSidebarTab('search');
            }
          }}
          title="Search"
        >
          <Search size={20} />
        </button>
        <button 
          className={`hover:text-text-normal transition-colors ${isLeftSidebarOpen && leftSidebarTab === 'bookmarks' ? 'text-interactive-accent' : 'text-text-muted'}`}
          title="Bookmarks"
          onClick={() => {
            if (isLeftSidebarOpen && leftSidebarTab === 'bookmarks') {
              setIsLeftSidebarOpen(false);
            } else {
              setIsLeftSidebarOpen(true);
              setLeftSidebarTab('bookmarks');
            }
          }}
        >
          <Bookmark size={20} />
        </button>
        <button 
          className={`hover:text-text-normal transition-colors ${leftSidebarTab === 'templates' ? 'text-interactive-accent' : 'text-text-muted'}`}
          title="Templates"
          onClick={() => {
            if (isLeftSidebarOpen && leftSidebarTab === 'templates') {
              setIsLeftSidebarOpen(false);
            } else {
              setIsLeftSidebarOpen(true);
              setLeftSidebarTab('templates');
            }
          }}
        >
          <ClipboardList size={20} />
        </button>
        <button 
          className="text-text-muted hover:text-text-normal transition-colors"
          onClick={() => {
            handleDailyNote();
            setLeftSidebarTab('files');
          }}
          title="Daily Notes"
        >
          <Calendar size={20} />
        </button>
        <button 
          className={`text-text-muted hover:text-text-normal transition-colors ${activeTab?.type === 'graph' ? 'text-interactive-accent' : ''}`}
          onClick={() => {
            handleOpenGraph();
            setLeftSidebarTab('files');
          }}
          title="Graph View"
        >
          <Network size={20} />
        </button>
        <div className="flex-grow" />
        {role === 'admin' && (
          <button 
            className={`hover:text-text-normal transition-colors ${activeTab?.type === 'admin' ? 'text-interactive-accent' : 'text-text-muted'}`}
            onClick={() => {
              const tabId = 'admin-dashboard';
              if (!tabs.find(t => t.id === tabId)) {
                setTabs(prev => [...prev, { id: tabId, type: 'admin', title: 'User Management' }]);
              }
              setActiveTabId(tabId);
            }}
            title="User Management"
          >
            <Users size={20} />
          </button>
        )}
        <button 
          className={`hover:text-text-normal transition-colors ${activeTab?.type === 'profile' ? 'text-interactive-accent' : 'text-text-muted'}`}
          onClick={() => {
            const tabId = 'profile-settings';
            if (!tabs.find(t => t.id === tabId)) {
              setTabs(prev => [...prev, { id: tabId, type: 'profile', title: 'My Profile' }]);
            }
            setActiveTabId(tabId);
          }}
          title="My Profile"
        >
          <User size={20} />
        </button>
        <button 
          className="text-text-muted hover:text-text-normal transition-colors"
          onClick={() => setIsSettingsOpen(true)}
          title="Settings"
        >
          <Settings size={20} />
        </button>
        <button 
          className={`hover:text-text-normal transition-colors ${isRightSidebarOpen ? 'text-interactive-accent' : 'text-text-muted'}`}
          onClick={() => setIsRightSidebarOpen(!isRightSidebarOpen)}
          title="Toggle Right Sidebar"
        >
          <PanelRight size={20} />
        </button>
        <button 
          className="text-text-muted hover:text-error transition-colors"
          onClick={handleLogout}
          title="Log Out"
        >
          <DoorOpen size={20} />
        </button>
      </div>

      {/* Main Layout */}
      <div className="flex-1 flex min-w-0 overflow-hidden">
        <PanelGroup direction="horizontal" className="flex-1 w-full h-full">
          {/* Left Sidebar */}
          {isLeftSidebarOpen && (
            <>
              <Panel id="sidebar-left" order={1} defaultSize={20} minSize={10} className="bg-bg-secondary border-r border-border-color flex flex-col min-w-0 overflow-hidden">
                {leftSidebarTab === 'files' && (
                  <>
                    <div className="p-3 flex items-center gap-2 border-b border-border-color">
                      <div 
                        className="flex-grow bg-bg-primary rounded px-2 py-1 flex items-center text-text-muted text-sm border border-border-color cursor-pointer hover:border-interactive-accent transition-colors"
                        onClick={() => setIsCommandPaletteOpen(true)}
                      >
                        <Search size={14} className="mr-2" />
                        <span>Search...</span>
                      </div>
                    </div>
                    <div className="flex-grow overflow-hidden">
                      <FileExplorer 
                        activeFile={activeTab?.type === 'editor' ? activeTab.path || null : null} 
                        refreshTrigger={refreshTrigger}
                        onSelectFile={handleSelectFile} 
                        onCreateFile={(folderPath, type) => handleNewFile(undefined, folderPath, type as 'file' | 'canvas')}
                        onAddToProjectKnowledge={handleAddToProjectKnowledge}
                      />
                    </div>
                  </>
                )}
                {leftSidebarTab === 'search' && (
                  <div className="flex flex-col h-full">
                    <div className="p-4 border-b border-border-color">
                      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">Search</h3>
                      <div className="relative">
                        <Search size={14} className="absolute left-2 top-2.5 text-text-muted" />
                        <input 
                          type="text" 
                          placeholder="Search files..." 
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="w-full bg-bg-primary border border-border-color rounded pl-8 pr-3 py-1.5 outline-none focus:border-interactive-accent transition-colors text-sm text-text-normal"
                        />
                      </div>
                    </div>
                    <div className="flex-grow overflow-y-auto p-2">
                      {isSearching ? (
                        <div className="p-4 text-center text-text-muted text-sm">Searching...</div>
                      ) : searchResults.length > 0 ? (
                        <ul className="space-y-2">
                          {searchResults.map((result, i) => (
                            <li key={i} className="group px-2 py-1.5 hover:bg-interactive-hover rounded cursor-pointer" onClick={() => handleSelectFile(result.path)}>
                              <div className="text-sm text-interactive-accent truncate font-medium">{result.path.split('/').pop()?.replace('.md', '')}</div>
                              <div className="text-xs text-text-muted truncate mt-1 bg-bg-primary p-1 rounded border border-border-color/50">
                                <span className="text-interactive-accent mr-1 opacity-50">{result.line}:</span>
                                {result.content}
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="flex flex-col h-full">
                          <div className="px-2 py-4">
                            <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                              <Clock size={12} /> Recent History
                            </h4>
                            {history.slice().reverse().slice(0, 15).map((path, i) => (
                              <button
                                key={i}
                                className="w-full text-left px-3 py-2 text-sm text-text-normal hover:bg-interactive-hover hover:text-interactive-accent rounded-md flex items-center gap-2 mb-1 transition-colors group"
                                onClick={() => handleSelectFile(path)}
                              >
                                {path.endsWith('.canvas') ? <LayoutGrid size={14} className="text-text-muted group-hover:text-interactive-accent" /> : <FileText size={14} className="text-text-muted group-hover:text-interactive-accent" />}
                                <span className="truncate">{path.split('/').pop()?.replace(/\.(md|canvas)$/, '')}</span>
                              </button>
                            ))}
                            {history.length === 0 && (
                              <div className="text-center py-10 opacity-30">
                                <Clock size={32} className="mx-auto mb-2" />
                                <p className="text-xs">No recent history</p>
                              </div>
                            )}
                          </div>
                          
                          {searchQuery && !isSearching && searchResults.length === 0 && (
                            <div className="p-4 text-center text-text-muted text-sm border-t border-border-color mt-auto">
                              No results found for "{searchQuery}"
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {leftSidebarTab === 'bookmarks' && (
                  <div className="flex flex-col h-full">
                    <div className="p-4 border-b border-border-color">
                      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Bookmarks</h3>
                    </div>
                    <div className="flex-grow overflow-y-auto p-2">
                      {bookmarks.length === 0 ? (
                        <div className="p-4 text-center text-text-muted text-sm">No bookmarks yet.</div>
                      ) : (
                        <ul className="space-y-1">
                          {bookmarks.map((bookmark, i) => (
                            <li key={i} className="flex items-center justify-between group px-2 py-1.5 hover:bg-interactive-hover rounded">
                              <button 
                                className="text-sm text-text-normal hover:text-interactive-accent text-left truncate flex-grow"
                                onClick={() => handleSelectFile(bookmark)}
                              >
                                {bookmark.split('/').pop()?.replace('.md', '')}
                              </button>
                              <button 
                                className="text-text-muted hover:text-error opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={() => setBookmarks(prev => prev.filter(b => b !== bookmark))}
                                title="Remove bookmark"
                              >
                                <X size={14} />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
                {leftSidebarTab === 'templates' && (
                  <div className="flex flex-col h-full overflow-hidden">
                    <div className="p-4 border-b border-border-color flex justify-between items-center bg-bg-secondary sticky top-0 z-10">
                      <div>
                        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Templates</h3>
                        <p className="text-[10px] text-text-muted mt-1">Manage reusable note templates</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => handleNewFile(undefined, 'Templates')}
                          className="p-1.5 text-text-muted hover:text-interactive-accent hover:bg-bg-primary rounded transition-colors"
                          title="New Note Template"><FilePlus2 size={14} /></button>
                        <button onClick={() => handleNewFile(undefined, 'Templates', 'canvas')}
                          className="p-1.5 text-text-muted hover:text-interactive-accent hover:bg-bg-primary rounded transition-colors"
                          title="New Canvas Template"><LayoutGrid size={14} /></button>
                      </div>
                    </div>
                    <div className="flex-grow overflow-y-auto p-2 space-y-1">
                      {templates.length === 0 ? (
                        <div className="p-8 text-center text-text-muted text-[10px] italic border border-dashed border-border-color/30 rounded-xl mt-4">
                          <FilePlus2 size={24} className="mx-auto mb-2 opacity-20" />
                          No templates yet
                        </div>
                      ) : templates.map((template, i) => {
                        const isDailyNote = template.path === 'Templates/Daily Note.md';
                        const isRenaming = renamingTemplatePath === template.path;
                        return (
                          <div key={i}
                            className="px-3 py-2 hover:bg-interactive-hover rounded-lg cursor-pointer text-xs text-text-normal flex items-center gap-2 group transition-colors"
                            onClick={() => !isRenaming && handleSelectFile(template.path)}
                          >
                            {isDailyNote
                              ? <Calendar size={12} className="text-interactive-accent flex-shrink-0" />
                              : template.type === 'canvas'
                                ? <LayoutGrid size={12} className="text-purple-400 flex-shrink-0" />
                                : <FileText size={12} className="text-interactive-accent flex-shrink-0" />}
                            {isRenaming ? (
                              <input
                                autoFocus
                                className="flex-grow bg-bg-primary border border-interactive-accent rounded px-1 py-0.5 text-xs outline-none"
                                value={renamingTemplateValue}
                                onChange={e => setRenamingTemplateValue(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') handleRenameTemplate(template.path, renamingTemplateValue);
                                  if (e.key === 'Escape') setRenamingTemplatePath(null);
                                }}
                                onClick={e => e.stopPropagation()}
                              />
                            ) : (
                              <span className="truncate flex-grow font-medium">
                                {template.name.replace(/\.(md|canvas)$/i, '')}
                                {isDailyNote && <span className="ml-1 text-[9px] text-interactive-accent opacity-60">daily</span>}
                              </span>
                            )}
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                              {/* Use: create new note from this template */}
                              <button onClick={e => { e.stopPropagation(); handleNewFromTemplate(template); }}
                                className="p-0.5 text-text-muted hover:text-interactive-accent" title="New note from template">
                                <Plus size={12} />
                              </button>
                              {/* Edit: open template for editing */}
                              <button onClick={e => { e.stopPropagation(); handleSelectFile(template.path); }}
                                className="p-0.5 text-text-muted hover:text-interactive-accent" title="Edit template">
                                <Pencil size={10} />
                              </button>
                              {/* Rename */}
                              <button onClick={e => { e.stopPropagation(); setRenamingTemplatePath(template.path); setRenamingTemplateValue(template.name.replace(/\.(md|canvas)$/i, '')); }}
                                className="p-0.5 text-text-muted hover:text-interactive-accent" title="Rename template">
                                <Edit3 size={10} />
                              </button>
                              {/* Delete */}
                              <button onClick={e => { e.stopPropagation(); handleDeleteFile(template.path); }}
                                className="p-0.5 text-text-muted hover:text-error" title="Delete template">
                                <Trash2 size={10} />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </Panel>

              <PanelResizeHandle className="w-2 relative flex items-center justify-center cursor-col-resize group flex-shrink-0 z-10">
                <div className="w-[1px] h-full bg-border-color group-hover:bg-interactive-accent group-hover:w-1 transition-all" />
              </PanelResizeHandle>
            </>
          )}

          {/* Main Workspace */}
          <Panel id="workspace" order={2} defaultSize={65} minSize={20} className="bg-bg-primary flex flex-col relative min-w-0 overflow-hidden">
            {/* Tabs */}
            <div className="h-10 bg-bg-secondary border-b border-border-color flex items-end px-2 pt-2 flex-shrink-0 relative">
              <div className="flex items-center gap-1 mr-2 mb-1 text-text-muted flex-shrink-0">
                <button 
                  className={`p-1 rounded hover:bg-bg-primary ${isLeftSidebarOpen ? 'text-interactive-accent' : ''}`}
                  onClick={() => setIsLeftSidebarOpen(!isLeftSidebarOpen)}
                  title="Toggle Left Sidebar"
                >
                  <ChevronLeft size={16} className={`transition-transform ${isLeftSidebarOpen ? '' : 'rotate-180'}`} />
                </button>
              </div>
              
              <button onClick={() => scrollTabs('left')} className="p-1 mb-1 text-text-muted hover:text-text-normal hover:bg-bg-primary rounded flex-shrink-0 z-10 bg-bg-secondary shadow-[2px_0_4px_rgba(0,0,0,0.1)]">
                <ChevronLeft size={16} />
              </button>
              
              <div ref={tabsRef} className="flex gap-1 overflow-x-auto hide-scrollbar scroll-smooth flex-grow">
                {tabs.map(tab => (
                  <div 
                    key={tab.id}
                    onClick={() => setActiveTabId(tab.id)}
                    className={`group flex items-center gap-2 px-3 py-1.5 text-sm rounded-t-md min-w-[120px] max-w-[200px] cursor-pointer border-t border-l border-r flex-shrink-0 ${
                      activeTabId === tab.id 
                        ? 'bg-bg-primary border-border-color text-text-normal z-10' 
                        : 'bg-bg-secondary border-transparent text-text-muted hover:bg-bg-primary/50'
                    }`}
                  >
                    {tab.type === 'editor' && <FileText size={14} className={activeTabId === tab.id ? 'text-interactive-accent' : ''} />}
                    {tab.type === 'graph' && <Network size={14} className={activeTabId === tab.id ? 'text-interactive-accent' : ''} />}
                    {tab.type === 'canvas' && <LayoutGrid size={14} className={activeTabId === tab.id ? 'text-interactive-accent' : ''} />}
                    {editingTabId === tab.id ? (
                      <input
                        autoFocus
                        className="bg-bg-primary text-text-normal text-sm border border-interactive-accent rounded px-1 w-full outline-none"
                        value={editingTabTitle}
                        onChange={(e) => setEditingTabTitle(e.target.value)}
                        onBlur={() => handleRenameTab(tab.id, editingTabTitle)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRenameTab(tab.id, editingTabTitle);
                          if (e.key === 'Escape') setEditingTabId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span 
                        className="truncate flex-grow"
                        onDoubleClick={(e) => {
                          if (tab.path) {
                            setEditingTabId(tab.id);
                            setEditingTabTitle(tab.title);
                          }
                        }}
                      >
                        {tab.title}
                      </span>
                    )}
                    <button 
                      onClick={(e) => handleCloseTab(e, tab.id)}
                      className={`p-0.5 rounded hover:bg-bg-secondary ${activeTabId === tab.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
              
              <button onClick={() => scrollTabs('right')} className="p-1 mb-1 text-text-muted hover:text-text-normal hover:bg-bg-primary rounded flex-shrink-0 z-10 bg-bg-secondary shadow-[-2px_0_4px_rgba(0,0,0,0.1)]">
                <ChevronRight size={16} />
              </button>

              <button 
                onClick={() => handleNewFile()}
                className="p-1.5 ml-1 text-text-muted hover:text-text-normal hover:bg-bg-secondary rounded mb-1 flex-shrink-0"
                title="New Tab"
              >
                <Plus size={16} />
              </button>
            </div>

            {/* Content Area */}
            <div className="flex-grow overflow-hidden relative">
              {!activeTab ? (
                <div className="h-full w-full flex items-center justify-center text-text-muted">
                  <div className="text-center">
                    <div className="text-4xl mb-4 font-bold opacity-20">Jay's Notes</div>
                    <p>Open a file or create a new one to start.</p>
                  </div>
                </div>
              ) : activeTab.type === 'admin' ? (
                <AdminDashboard />
              ) : activeTab.type === 'profile' ? (
                <div className="h-full bg-bg-primary flex items-center justify-center p-8 relative">
                  <div className="w-full max-w-md bg-bg-secondary border border-border-color rounded-xl shadow-xl overflow-hidden">
                    <div className="flex items-center justify-between p-6 border-b border-border-color bg-bg-primary/30">
                      <h2 className="text-xl font-bold flex items-center gap-2">
                        <User className="text-interactive-accent" />
                        My Profile
                      </h2>
                      <button 
                        onClick={() => handleCloseTab({ stopPropagation: () => {} } as any, 'profile-settings')}
                        className="p-1.5 text-text-muted hover:text-error hover:bg-error/10 rounded-md transition-all"
                        title="Close Profile"
                      >
                        <X size={20} />
                      </button>
                    </div>
                    
                    <div className="p-8 space-y-6">
                      <div className="p-4 bg-bg-primary rounded-lg border border-border-color">
                        <label className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-1">Username</label>
                        <div className="text-lg font-medium">{username}</div>
                        <div className="text-xs text-text-muted mt-1">Role: <span className="capitalize">{role}</span></div>
                      </div>
                      
                      <div className="space-y-3">
                        <h3 className="text-sm font-semibold border-b border-border-color pb-2 mb-4">Account Actions</h3>
                        
                        <form onSubmit={handleChangePassword} className="space-y-3 mb-6 p-4 bg-bg-primary rounded-lg border border-border-color">
                          <label className="block text-xs font-bold text-text-muted uppercase tracking-wider">Change Password</label>
                          <div className="flex gap-2">
                            <input 
                              type="password" 
                              placeholder="New Password"
                              value={newPassword}
                              onChange={(e) => setNewPassword(e.target.value)}
                              className="flex-grow bg-bg-secondary border border-border-color rounded px-3 py-1.5 text-sm outline-none focus:border-interactive-accent transition-colors"
                            />
                            <button 
                              type="submit"
                              className="px-4 py-1.5 bg-interactive-accent text-white rounded text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                              disabled={!newPassword.trim()}
                            >
                              Update
                            </button>
                          </div>
                          {passwordChangeStatus && (
                            <div className={`text-xs mt-2 px-3 py-2 rounded font-medium ${passwordChangeStatus.type === 'success' ? 'bg-green-500/20 text-green-500' : 'bg-red-500/20 text-red-500'}`}>
                              {passwordChangeStatus.type === 'success' ? '✓ ' : '× '}
                              {passwordChangeStatus.message}
                            </div>
                          )}
                        </form>

                        <button 
                          onClick={() => setIsSettingsOpen(true)}
                          className="w-full text-left px-4 py-2 hover:bg-bg-primary rounded-lg border border-transparent hover:border-border-color transition-all flex items-center justify-between group"
                        >
                          <span className="text-sm">Application Settings</span>
                          <Settings size={16} className="text-text-muted group-hover:text-interactive-accent" />
                        </button>
                        <button 
                          onClick={handleLogout}
                          className="w-full text-left px-4 py-2 hover:bg-error/5 rounded-lg border border-transparent hover:border-error/20 transition-all flex items-center justify-between group"
                        >
                          <span className="text-sm text-error">Log Out</span>
                          <DoorOpen size={16} className="text-error" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : activeTab.type === 'graph' ? (
                <Graph onNodeClick={(id) => handleSelectFile(id)} />
              ) : activeTab.type === 'canvas' ? (
                <Canvas filePath={activeTab.path} onOpenFile={handleSelectFile} templates={templates} />
              ) : activeTab.path ? (
                <PanelGroup direction="horizontal" className="w-full h-full">
                  <Panel id="editor-main" className="h-full">
                    <MilkdownEditor
                      filePath={activeTab.path}
                      onOpenFile={handleSelectFile}
                      isBookmarked={bookmarks.includes(activeTab.path)}
                      onToggleBookmark={() => {
                        if (activeTab.path) {
                          const path = activeTab.path;
                          setBookmarks(prev =>
                            prev.includes(path) ? prev.filter(b => b !== path) : [...prev, path]
                          );
                        }
                      }}
                      templates={templates}
                    />
                  </Panel>
                  {splitTab && splitTab.path && (
                    <>
                      <PanelResizeHandle className="w-2 relative flex items-center justify-center cursor-col-resize group flex-shrink-0 z-10">
                        <div className="w-[1px] h-full bg-border-color group-hover:bg-interactive-accent group-hover:w-1 transition-all" />
                      </PanelResizeHandle>
                      <Panel id="editor-split" className="h-full relative">
                        <button 
                          onClick={() => setSplitTabId(null)}
                          className="absolute top-4 right-4 z-10 p-1 bg-bg-secondary border border-border-color rounded text-text-muted hover:text-error hover:border-error transition-colors"
                        >
                          <X size={14} />
                        </button>
                        <MilkdownEditor
                          filePath={splitTab.path}
                          onOpenFile={handleSelectFile}
                        />
                      </Panel>
                    </>
                  )}
                </PanelGroup>
              ) : null}
            </div>
          </Panel>

          <PanelResizeHandle className="w-2 relative flex items-center justify-center cursor-col-resize group flex-shrink-0 z-10">
            <div className="w-[1px] h-full bg-border-color group-hover:bg-interactive-accent group-hover:w-1 transition-all" />
          </PanelResizeHandle>

          {/* Right Sidebar (Backlinks/Outline/Tags) */}
          {isRightSidebarOpen && (
            <Panel id="sidebar-right" order={3} defaultSize={15} minSize={10} className="bg-bg-secondary border-l border-border-color min-w-0 flex flex-col overflow-hidden">
              <div className="p-2 border-b border-border-color flex justify-between items-center">
                <div className="flex gap-1">
                  <button 
                    className={`px-3 py-1 text-xs font-semibold uppercase tracking-wider rounded ${rightSidebarTab === 'links' ? 'bg-bg-primary text-text-normal' : 'text-text-muted hover:text-text-normal'}`}
                    onClick={() => setRightSidebarTab('links')}
                  >
                    Links
                  </button>
                  <button 
                    className={`px-3 py-1 text-xs font-semibold uppercase tracking-wider rounded ${rightSidebarTab === 'tags' ? 'bg-bg-primary text-text-normal' : 'text-text-muted hover:text-text-normal'}`}
                    onClick={() => setRightSidebarTab('tags')}
                  >
                    Tags
                  </button>
                </div>
                <button onClick={() => setIsRightSidebarOpen(false)} className="text-text-muted hover:text-text-normal p-1"><X size={14}/></button>
              </div>
              <div className="flex-grow overflow-y-auto p-4 space-y-6">
                {rightSidebarTab === 'links' && (
                  <>
                    <div>
                      <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
                        Backlinks {links.backlinks.length > 0 && <span className="text-interactive-accent">({links.backlinks.length})</span>}
                      </h4>
                      {links.backlinks.length === 0 ? (
                        <p className="text-sm text-text-muted">No backlinks found.</p>
                      ) : (
                        <ul className="space-y-1">
                          {links.backlinks.map((link, i) => (
                            <li key={i}>
                              <button
                                className="text-sm text-interactive-accent hover:underline text-left w-full truncate"
                                onClick={() => handleSelectFile(link.path)}
                                title={link.path}
                              >
                                {link.name}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
                        Outgoing Links {links.forwardlinks.length > 0 && <span className="text-interactive-accent">({links.forwardlinks.length})</span>}
                      </h4>
                      {links.forwardlinks.length === 0 ? (
                        <p className="text-sm text-text-muted">No outgoing links found.</p>
                      ) : (
                        <ul className="space-y-1">
                          {links.forwardlinks.map((link, i) => (
                            <li key={i}>
                              <button
                                className="text-sm text-interactive-accent hover:underline text-left w-full truncate"
                                onClick={() => handleSelectFile(link.path)}
                                title={link.path}
                              >
                                {link.name}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                )}
                {rightSidebarTab === 'tags' && (
                  <div className="space-y-6">
                    {(() => {
                      const currentPath = activeTab?.type === 'editor' ? activeTab.path : null;
                      const inNote = currentPath
                        ? tags.filter(t => t.files.includes(currentPath))
                        : [];
                      const renderTag = (tagObj: { tag: string; count: number; files: string[] }, i: number) => (
                        <li key={`${tagObj.tag}-${i}`} className="group">
                          <button
                            className="flex items-center justify-between w-full px-2 py-1.5 hover:bg-interactive-hover rounded transition-colors"
                            onClick={() => {
                              setIsLeftSidebarOpen(true);
                              setLeftSidebarTab('search');
                              setSearchQuery(`#${tagObj.tag}`);
                            }}
                            title={`Show all files with #${tagObj.tag}`}
                          >
                            <span className="text-sm text-interactive-accent font-medium truncate">#{tagObj.tag}</span>
                            <span className="text-xs text-text-muted bg-bg-primary px-1.5 py-0.5 rounded-full border border-border-color">{tagObj.count}</span>
                          </button>
                        </li>
                      );
                      return (
                        <>
                          {currentPath && (
                            <div>
                              <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">In this note</h4>
                              {inNote.length === 0 ? (
                                <p className="text-sm text-text-muted">No tags in this note.</p>
                              ) : (
                                <ul className="space-y-1">{inNote.map(renderTag)}</ul>
                              )}
                            </div>
                          )}
                          <div>
                            <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">All tags</h4>
                            {tags.length === 0 ? (
                              <p className="text-sm text-text-muted">No tags found in vault.</p>
                            ) : (
                              <ul className="space-y-1">{tags.map(renderTag)}</ul>
                            )}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            </Panel>
          )}
        </PanelGroup>
      </div>
    </div>
  );
}
