import React, { useEffect, useState, useRef, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { apiFetch } from '../lib/api';
import { Folder, ChevronRight, ChevronDown, Filter, X, LayoutGrid } from 'lucide-react';

interface GraphData {
  nodes: { id: string; name: string }[];
  links: { source: string | any; target: string | any }[];
}

interface FolderNode {
  name: string;
  path: string;
  type: 'folder';
  children: (FolderNode | any)[];
}

interface GraphProps {
  onNodeClick: (nodeId: string) => void;
}

const FolderSelectItem: React.FC<{
  node: FolderNode;
  selectedPath: string;
  onSelect: (path: string) => void;
  level: number;
}> = ({ node, selectedPath, onSelect, level }) => {
  const [isOpen, setIsOpen] = useState(false);
  const isSelected = selectedPath === node.path;
  const hasChildren = node.children && node.children.some(c => c.type === 'folder');

  return (
    <div>
      <div 
        className={`flex items-center py-1 px-2 cursor-pointer text-xs rounded hover:bg-interactive-hover transition-colors ${isSelected ? 'text-interactive-accent bg-interactive-accent/10 font-medium' : 'text-text-normal'}`}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(node.path);
        }}
      >
        <div 
          className="mr-1 p-0.5 hover:bg-black/10 rounded" 
          onClick={(e) => {
            if (hasChildren) {
              e.stopPropagation();
              setIsOpen(!isOpen);
            }
          }}
        >
          {hasChildren ? (
            isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />
          ) : (
            <div className="w-3" />
          )}
        </div>
        <Folder size={12} className="mr-2 opacity-70" />
        <span className="truncate">{node.name}</span>
      </div>
      {isOpen && node.children && node.children
        .filter(c => c.type === 'folder')
        .map((child) => (
          <FolderSelectItem 
            key={child.path} 
            node={child} 
            selectedPath={selectedPath} 
            onSelect={onSelect} 
            level={level + 1} 
          />
        ))
      }
    </div>
  );
};

export const Graph: React.FC<GraphProps> = ({ onNodeClick }) => {
  const [data, setData] = useState<GraphData>({ nodes: [], links: [] });
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);

  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    data.links.forEach(link => {
      const source = typeof link.source === 'object' ? link.source.id : link.source;
      const target = typeof link.target === 'object' ? link.target.id : link.target;
      if (!map.has(source)) map.set(source, new Set());
      if (!map.has(target)) map.set(target, new Set());
      map.get(source)!.add(target);
      map.get(target)!.add(source);
    });
    return map;
  }, [data]);

  const fetchGraph = async () => {
    try {
      const url = selectedFolder 
        ? `/api/graph?folder=${encodeURIComponent(selectedFolder)}`
        : '/api/graph';
      const res = await apiFetch(url);
      const json = await res.json();
      setData(json);
    } catch (error) {
      console.error('Failed to load graph data', error);
    }
  };

  useEffect(() => {
    fetchGraph();
  }, [selectedFolder]);

  useEffect(() => {
    const fetchFolders = async () => {
      try {
        const res = await apiFetch('/api/files');
        const json = await res.json();
        // Filter recursive structure for folders only
        const filterFolders = (nodes: any[]): FolderNode[] => {
          return nodes
            .filter(n => n.type === 'folder')
            .map(n => ({
              ...n,
              children: n.children ? filterFolders(n.children) : []
            }));
        };
        setFolders(filterFolders(json));
      } catch (error) {
        console.error('Failed to load folders', error);
      }
    };
    fetchFolders();
  }, []);

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.offsetWidth,
          height: containerRef.current.offsetHeight,
        });
      }
    };

    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  const isLight = document.documentElement.classList.contains('light');
  const textColor = isLight ? '#2e3338' : '#dcddde';
  const bgColor = isLight ? '#ffffff' : '#1e1e1e';
  const mutedColor = isLight ? '#b9bbbe' : '#555555'; // More visible in dark mode
  const accentColor = '#00c882';
  const hoverAccentColor = '#05e093';

  return (
    <div ref={containerRef} className="h-full w-full bg-bg-primary relative overflow-hidden">
      {/* Controls Overlay */}
      <div className="absolute top-4 right-4 z-10 flex flex-col gap-2 pointer-events-none">
        {/* Visibility Controls */}
        <div className="bg-bg-secondary border border-border-color rounded-lg p-3 flex flex-col gap-3 shadow-xl pointer-events-auto min-w-[150px]">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Settings</span>
          </div>
          <label className="text-xs text-text-normal flex items-center justify-between cursor-pointer hover:text-interactive-accent transition-colors">
            Show Names
            <input 
              type="checkbox" 
              checked={showLabels} 
              onChange={(e) => setShowLabels(e.target.checked)}
              className="accent-interactive-accent ml-2 w-3 h-3"
            />
          </label>
        </div>

        {/* Folder Filter Control */}
        <div className="bg-bg-secondary border border-border-color rounded-lg shadow-xl pointer-events-auto min-w-[200px] max-w-[300px] flex flex-col max-h-[400px]">
          <div 
            className="p-3 border-b border-border-color flex items-center justify-between cursor-pointer hover:bg-interactive-hover transition-colors rounded-t-lg"
            onClick={() => setIsFilterOpen(!isFilterOpen)}
          >
            <div className="flex items-center gap-2 overflow-hidden">
              <Filter size={14} className={selectedFolder ? 'text-interactive-accent' : 'text-text-muted'} />
              <div className="flex flex-col min-w-0">
                <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider leading-none mb-1">Scope</span>
                <span className="text-xs text-text-normal truncate max-w-[140px]">
                  {selectedFolder ? selectedFolder.split('/').pop() : 'Full Vault'}
                </span>
              </div>
            </div>
            {isFilterOpen ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
          </div>

          {isFilterOpen && (
            <div className="flex-grow overflow-y-auto p-2 border-t border-border-color/50 bg-bg-primary/30">
              <div 
                className={`flex items-center py-1 px-2 cursor-pointer text-xs rounded hover:bg-interactive-hover transition-colors mb-1 ${!selectedFolder ? 'text-interactive-accent bg-interactive-accent/10 font-medium' : 'text-text-normal'}`}
                onClick={() => {
                  setSelectedFolder('');
                  setIsFilterOpen(false);
                }}
              >
                <div className="w-3 mr-2" />
                <LayoutGrid size={12} className="mr-2 opacity-70" />
                <span>Full Vault</span>
              </div>
              <div className="space-y-0.5">
                {folders.map((folder) => (
                  <FolderSelectItem 
                    key={folder.path} 
                    node={folder} 
                    selectedPath={selectedFolder} 
                    onSelect={(path) => {
                      setSelectedFolder(path);
                      setIsFilterOpen(false);
                    }} 
                    level={0} 
                  />
                ))}
              </div>
              {folders.length === 0 && (
                <div className="p-4 text-center text-text-muted text-[10px] italic">No folders found</div>
              )}
            </div>
          )}
          
          {selectedFolder && (
            <div className="p-2 border-t border-border-color bg-bg-primary/10 flex justify-end">
              <button 
                onClick={() => setSelectedFolder('')}
                className="text-[10px] text-text-muted hover:text-error flex items-center gap-1 transition-colors"
              >
                <X size={10} /> Clear Filter
              </button>
            </div>
          )}
        </div>
      </div>

      {dimensions.width > 0 && (
        <ForceGraph2D
          width={dimensions.width}
          height={dimensions.height}
          graphData={data}
          nodeLabel="name"
          nodeColor={(node: any) => {
            if (!hoverNode) return accentColor;
            if (node.id === hoverNode) return hoverAccentColor;
            if (neighbors.get(hoverNode)?.has(node.id)) return accentColor;
            return mutedColor;
          }}
          linkColor={(link: any) => {
            const source = typeof link.source === 'object' ? link.source.id : link.source;
            const target = typeof link.target === 'object' ? link.target.id : link.target;
            if (!hoverNode) return mutedColor;
            if (source === hoverNode || target === hoverNode) return accentColor;
            return isLight ? '#f2f3f5' : '#2d2d2d'; // Brighter in dark mode fallback
          }}
          nodeCanvasObject={(node: any, ctx, globalScale) => {
            const label = node.name;
            const fontSize = 12 / globalScale;
            ctx.font = `${fontSize}px Sans-Serif`;
            
            // Draw node
            ctx.beginPath();
            ctx.arc(node.x, node.y, 6, 0, 2 * Math.PI, false);
            
            let color = accentColor;
            if (hoverNode) {
              if (node.id === hoverNode) color = hoverAccentColor;
              else if (neighbors.get(hoverNode)?.has(node.id)) color = accentColor;
              else color = mutedColor;
            }
            ctx.fillStyle = color;
            ctx.fill();

            // Draw label
            if (showLabels) {
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillStyle = hoverNode && node.id !== hoverNode && !neighbors.get(hoverNode)?.has(node.id) ? mutedColor : textColor;
              ctx.fillText(label, node.x, node.y + 10);
            }
          }}
          backgroundColor={bgColor}
          onNodeClick={(node) => onNodeClick(node.id as string)}
          onNodeHover={(node) => setHoverNode(node ? (node.id as string) : null)}
          nodeRelSize={6}
          linkWidth={(link: any) => {
            const source = typeof link.source === 'object' ? link.source.id : link.source;
            const target = typeof link.target === 'object' ? link.target.id : link.target;
            if (hoverNode && (source === hoverNode || target === hoverNode)) return 2;
            return 1;
          }}
        />
      )}
    </div>
  );
};