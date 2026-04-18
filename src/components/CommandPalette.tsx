import React, { useState, useEffect, useRef } from 'react';
import { Search, FileText, Plus } from 'lucide-react';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectFile: (path: string) => void;
  onCreateFile: (name: string) => void;
}

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children?: FileNode[];
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose, onSelectFile, onCreateFile }) => {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<{name: string, path: string}[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      fetchFiles();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const fetchFiles = async () => {
    try {
      const res = await fetch('/api/files');
      const tree: FileNode[] = await res.json();
      
      const flatten = (nodes: FileNode[]): {name: string, path: string}[] => {
        let result: {name: string, path: string}[] = [];
        for (const node of nodes) {
          if (node.type === 'file') {
            result.push({ name: node.name, path: node.path });
          }
          if (node.children) {
            result.push(...flatten(node.children));
          }
        }
        return result;
      };
      
      setFiles(flatten(tree));
    } catch (error) {
      console.error('Failed to fetch files for palette', error);
    }
  };

  if (!isOpen) return null;

  const filteredFiles = files.filter(f => f.name.toLowerCase().includes(query.toLowerCase()));
  const showCreateOption = query.trim().length > 0 && !filteredFiles.find(f => f.name.toLowerCase() === query.trim().toLowerCase());
  
  const totalOptions = filteredFiles.length + (showCreateOption ? 1 : 0);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % totalOptions);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + totalOptions) % totalOptions);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex < filteredFiles.length) {
        onSelectFile(filteredFiles[selectedIndex].path);
      } else if (showCreateOption) {
        onCreateFile(query.trim());
      }
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div 
        className="bg-bg-secondary border border-border-color rounded-xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center px-4 py-3 border-b border-border-color">
          <Search size={18} className="text-text-muted mr-3" />
          <input
            ref={inputRef}
            type="text"
            className="flex-grow bg-transparent text-text-normal outline-none placeholder-text-muted text-lg"
            placeholder="Search files or type a command..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
        </div>
        
        <div className="max-h-[400px] overflow-y-auto py-2">
          {filteredFiles.map((file, index) => (
            <div
              key={file.path}
              className={`flex items-center px-4 py-2 cursor-pointer ${selectedIndex === index ? 'bg-interactive-hover text-interactive-accent' : 'text-text-normal hover:bg-interactive-hover'}`}
              onClick={() => {
                onSelectFile(file.path);
                onClose();
              }}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <FileText size={16} className="mr-3 text-text-muted" />
              <span>{file.name}</span>
            </div>
          ))}
          
          {showCreateOption && (
            <div
              className={`flex items-center px-4 py-2 cursor-pointer ${selectedIndex === filteredFiles.length ? 'bg-interactive-hover text-interactive-accent' : 'text-text-normal hover:bg-interactive-hover'}`}
              onClick={() => {
                onCreateFile(query.trim());
                onClose();
              }}
              onMouseEnter={() => setSelectedIndex(filteredFiles.length)}
            >
              <Plus size={16} className="mr-3 text-text-muted" />
              <span>Create note: <span className="font-semibold">"{query.trim()}"</span></span>
            </div>
          )}
          
          {filteredFiles.length === 0 && !showCreateOption && (
            <div className="px-4 py-8 text-center text-text-muted">
              No files found.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
