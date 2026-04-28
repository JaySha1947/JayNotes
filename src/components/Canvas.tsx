import React, { useCallback, useState, useEffect, useRef, useMemo } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Node,
  Edge,
  Connection,
  Panel,
  Handle,
  Position,
  NodeProps,
  EdgeProps,
  getBezierPath,
  BaseEdge,
  EdgeLabelRenderer,
  useReactFlow,
  ReactFlowProvider,
  NodeResizer,
  SelectionMode,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { 
  FileText, Type, Image as ImageIcon, Link as LinkIcon, Plus, X, Maximize, MousePointer2, Settings, HelpCircle, Trash2, Copy, Layers, ExternalLink, ClipboardList, FileUp, 
  Square, Circle, Triangle, Star, Minus, ZoomIn, ZoomOut, Palette, Check, ChevronDown, RotateCw, MoveRight, MoveHorizontal, Hand, Grab
} from 'lucide-react';
import * as MarkdownModule from 'react-markdown';
const MarkdownComp = ((MarkdownModule as any).default || MarkdownModule) as any;
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { apiFetch } from '../lib/api';

// --- Custom Node Components ---

const NODE_COLORS = [
  { name: 'Default', value: '' },
  { name: 'Paper White', value: 'bg-[#fafafa] border-slate-200 text-slate-800' },
  { name: 'Obsidian', value: 'bg-[#1a1a1b] border-slate-800 text-slate-200' },
  { name: 'Soft Slate', value: 'bg-[#334155] border-slate-700 text-slate-100' },
  { name: 'Royal Indigo', value: 'bg-[#3730a3] border-indigo-900 text-indigo-50' },
  { name: 'Emerald Moss', value: 'bg-[#064e3b] border-emerald-900 text-emerald-50' },
  { name: 'Amber Sand', value: 'bg-[#b45309] border-amber-800 text-amber-50' },
  { name: 'Crimson Clay', value: 'bg-[#7f1d1d] border-red-900 text-red-50' },
  { name: 'Midnight Teal', value: 'bg-[#134e4a] border-teal-900 text-teal-50' },
  { name: 'Pebble Gray', value: 'bg-[#71717a] border-zinc-700 text-zinc-50' },
  { name: 'Lavender Mist', value: 'bg-[#5b21b6] border-violet-900 text-violet-50' },
  { name: 'Ocean Depth', value: 'bg-[#1e3a8a] border-blue-900 text-blue-50' },
  { name: 'Rose Quartz', value: 'bg-[#fce7f3] border-pink-200 text-pink-900' },
  { name: 'Sage Green', value: 'bg-[#dcfce7] border-emerald-200 text-emerald-900' },
  { name: 'Sky Blue', value: 'bg-[#e0f2fe] border-sky-200 text-sky-900' },
  { name: 'Desert Sun', value: 'bg-[#ffedd5] border-orange-200 text-orange-900' },
  { name: 'Deep Forest', value: 'bg-[#052e16] border-emerald-950 text-emerald-100' },
  { name: 'Aubergine', value: 'bg-[#2e1065] border-violet-950 text-violet-100' },
  { name: 'Cyber Lime', value: 'bg-[#bef264] border-lime-400 text-lime-950' },
  { name: 'Neon Pink', value: 'bg-[#f472b6] border-pink-500 text-pink-950' },
  { name: 'Electric Blue', value: 'bg-[#38bdf8] border-sky-500 text-sky-950' },
  { name: 'Dark Chocolate', value: 'bg-[#451a03] border-orange-950 text-orange-100' },
  { name: 'Slate 900', value: 'bg-[#0f172a] border-slate-950 text-slate-100' },
  { name: 'Zinc 800', value: 'bg-[#27272a] border-zinc-900 text-zinc-100' },
];

const TEXT_COLORS = [
  { name: 'Default', value: '' },
  { name: 'Snow', value: '#ffffff' },
  { name: 'Charcoal', value: '#2d3436' },
  { name: 'Coral', value: '#ff7675' },
  { name: 'Azure', value: '#0984e3' },
  { name: 'Sunlight', value: '#fdcb6e' },
  { name: 'Mint', value: '#55efc4' },
  { name: 'Amethyst', value: '#a29bfe' },
  { name: 'Rose', value: '#ec4899' },
  { name: 'Sage', value: '#10b981' },
  { name: 'Sky', value: '#0ea5e9' },
  { name: 'Slate', value: '#64748b' },
  { name: 'Plum', value: '#7c3aed' },
  { name: 'Goldenrod', value: '#eab308' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Emerald', value: '#10b981' },
  { name: 'Violet', value: '#8b5cf6' },
  { name: 'Crimson', value: '#e11d48' },
];

const RotationHandle = ({ id, onUpdate }: { id: string, onUpdate: (rotation: number) => void }) => {
  const onRotateStart = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const nodeElement = document.querySelector(`[data-id="${id}"]`);
    if (!nodeElement) return;

    const rect = nodeElement.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - centerX;
      const dy = moveEvent.clientY - centerY;
      // Calculate angle in degrees, add 90 because the handle is at the top
      const angle = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
      onUpdate(angle);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [id, onUpdate]);

  return (
    <div 
      onMouseDown={onRotateStart}
      className="absolute -top-10 left-1/2 -translate-x-1/2 w-5 h-5 rounded-full bg-white border-2 border-interactive-accent cursor-alias z-[1001] shadow-lg flex items-center justify-center group/rotate nodrag"
      title="Drag to Rotate"
    >
      <RotateCw size={10} className="text-interactive-accent group-hover/rotate:scale-110 transition-transform" />
      <div className="absolute top-5 left-1/2 -translate-x-1/2 w-[2px] h-5 bg-interactive-accent/50" />
    </div>
  );
};

const NodeHeader = ({ 
  color, 
  title, 
  icon: Icon, 
  onDelete, 
  onOpen, 
  onTitleChange, 
  onColorChange, 
  onTextColorChange,
  customTextColor,
  onDuplicate,
  actions 
}: { 
  color?: string, 
  title: string, 
  icon: any, 
  onDelete?: () => void, 
  onOpen?: () => void, 
  onTitleChange?: (newTitle: string) => void,
  onColorChange?: (color: string) => void,
  onTextColorChange?: (color: string) => void,
  customTextColor?: string,
  onDuplicate?: () => void,
  actions?: React.ReactNode
}) => {
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isColorMenuOpen, setIsColorMenuOpen] = useState(false);
  const [isTextMenuOpen, setIsTextMenuOpen] = useState(false);

  // If color is provided and is part of NODE_COLORS, we use a different bg for header
  const isCustomColor = !!color;
  const headerBg = isCustomColor ? 'bg-black/20' : 'bg-bg-secondary';
  const textColor = isCustomColor && color.includes('text-white') ? 'text-white' : 'text-text-normal';
  const mutedTextColor = isCustomColor && color.includes('text-white') ? 'text-white/70' : 'text-text-muted';

  return (
    <div className={`flex items-center justify-between px-2 py-1.5 rounded-t-lg ${headerBg} border-b border-border-color/20 group/header relative`}>
      <div className="flex items-center gap-2 flex-grow min-w-0">
        <Icon size={12} className={isCustomColor ? 'text-current' : 'text-interactive-accent'} />
        {isEditingTitle ? (
          <input
            autoFocus
            className={`bg-bg-primary text-xs font-bold px-1 py-0.5 rounded outline-none border border-interactive-accent w-full ${isCustomColor ? 'text-text-normal' : ''}`}
            style={{ color: customTextColor || 'inherit' }}
            value={title}
            onChange={(e) => onTitleChange?.(e.target.value)}
            onBlur={() => setIsEditingTitle(false)}
            onKeyDown={(e) => e.key === 'Enter' && setIsEditingTitle(false)}
          />
        ) : (
          <span 
            className={`text-xs font-bold truncate cursor-text hover:bg-black/10 px-1 py-0.5 rounded transition-colors ${textColor}`}
            style={{ color: customTextColor || 'inherit' }}
            onClick={() => setIsEditingTitle(true)}
          >
            {title}
          </span>
        )}
      </div>
      
      <div className="flex items-center gap-0.5 opacity-0 group-hover/header:opacity-100 transition-opacity ml-2 shrink-0">
        {actions}
        {onTextColorChange && (
          <div className="relative">
            <button 
              onClick={() => setIsTextMenuOpen(!isTextMenuOpen)} 
              className={`p-1 hover:bg-black/10 rounded transition-colors ${mutedTextColor} hover:${textColor}`}
              title="Text Color"
            >
              <Type size={12} />
            </button>
            {isTextMenuOpen && (
              <div className="absolute top-full right-0 mt-1 bg-bg-secondary border border-border-color rounded shadow-xl z-[110] grid grid-cols-4 gap-1 p-1 w-32">
                {TEXT_COLORS.map((c) => (
                  <button
                    key={c.name}
                    onClick={() => {
                      onTextColorChange(c.value);
                      setIsTextMenuOpen(false);
                    }}
                    className="w-6 h-6 rounded flex items-center justify-center border border-border-color hover:scale-110 transition-transform"
                    style={{ backgroundColor: c.value || 'white' }}
                    title={c.name}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {onColorChange && (
          <div className="relative">
            <button 
              onClick={() => setIsColorMenuOpen(!isColorMenuOpen)} 
              className={`p-1 hover:bg-black/10 rounded transition-colors ${mutedTextColor} hover:${textColor}`}
              title="Change Color"
            >
              <Palette size={12} />
            </button>
            {isColorMenuOpen && (
              <div className="absolute top-full right-0 mt-1 bg-bg-secondary border border-border-color rounded shadow-xl z-[110] grid grid-cols-4 gap-1 p-1 w-32">
                {NODE_COLORS.map((c) => (
                  <button
                    key={c.name}
                    onClick={() => {
                      onColorChange(c.value);
                      setIsColorMenuOpen(false);
                    }}
                    className={`w-6 h-6 rounded flex items-center justify-center border border-border-color hover:scale-110 transition-transform ${c.value ? (c.value.includes('bg-[') ? '' : c.value.split(' ')[0]) : 'bg-bg-primary'}`}
                    style={{ backgroundColor: c.value && c.value.includes('bg-[') ? c.value.split('[')[1].split(']')[0] : undefined }}
                    title={c.name}
                  >
                    {color === c.value && <Check size={10} className="text-text-normal" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {onDuplicate && (
          <button onClick={onDuplicate} className={`p-1 hover:bg-black/10 rounded transition-colors ${mutedTextColor} hover:${textColor}`} title="Duplicate">
            <Copy size={12} />
          </button>
        )}
        {onOpen && (
          <button onClick={onOpen} className={`p-1 hover:bg-black/10 rounded transition-colors ${mutedTextColor} hover:${textColor}`} title="Open">
            <ExternalLink size={12} />
          </button>
        )}
        {onDelete && (
          <button onClick={onDelete} className={`p-1 hover:bg-red-500/20 rounded transition-colors ${mutedTextColor} hover:text-red-500`} title="Delete">
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  );
};

const TextNode = ({ data, selected, id, width, height }: NodeProps<any>) => {
  const [isEditing, setIsEditing] = useState(false);
  const [text, setText] = useState(data.text as string || '');
  const [fontSize, setFontSize] = useState(data.fontSize || 14);
  const { setNodes } = useReactFlow();

  const onBlur = () => {
    setIsEditing(false);
    data.onUpdate?.(id, { text, fontSize });
  };

  const onDelete = () => {
    setNodes((nds) => nds.filter((node) => node.id !== id));
  };

  const onDuplicate = () => {
    setNodes((nds) => [...nds, {
      ...nds.find(n => n.id === id)!,
      id: `node-${Date.now()}`,
      position: { x: (nds.find(n => n.id === id)?.position.x || 0) + 20, y: (nds.find(n => n.id === id)?.position.y || 0) + 20 }
    }]);
  };

  const onResize = (_: any, { width, height }: { width: number, height: number }) => {
    setNodes((nds) => nds.map((n) => n.id === id ? { ...n, width, height } : n));
  };

  const nodeColorClass = data.color || 'bg-bg-primary border-border-color';
  const isCustomColor = !!data.color;
  const textColorClass = isCustomColor && data.color.includes('text-white') ? 'text-white' : 'text-text-normal';
  const customTextColor = data.textColor || '';
  const rotation = data.rotation || 0;

  return (
    <div 
      className={`group relative border-2 rounded-lg shadow-xl flex flex-col transition-shadow ${selected ? 'border-interactive-accent shadow-interactive-accent/20' : nodeColorClass.includes('border') ? '' : 'border-border-color'} ${nodeColorClass} ${selected ? '!border-interactive-accent' : ''}`}
      style={{ width: width || 400, height: height || 300, transform: `rotate(${rotation}deg)` }}
    >
      <NodeResizer minWidth={150} minHeight={100} isVisible={selected} lineClassName="border-interactive-accent" handleClassName="h-3 w-3 bg-white border-2 border-interactive-accent rounded" onResize={onResize} />
      
      {selected && <RotationHandle id={id} onUpdate={(angle) => data.onUpdate?.(id, { rotation: angle })} />}

      <Handle type="source" position={Position.Top} id="top" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      <Handle type="source" position={Position.Left} id="left" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      <Handle type="source" position={Position.Right} id="right" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      
      <NodeHeader 
        color={data.color as string} 
        title={data.title || "Card"} 
        icon={Type} 
        onDelete={onDelete} 
        onTitleChange={(newTitle) => data.onUpdate?.(id, { title: newTitle })}
        onColorChange={(newColor) => data.onUpdate?.(id, { color: newColor })}
        onTextColorChange={(newColor) => data.onUpdate?.(id, { textColor: newColor })}
        customTextColor={customTextColor}
        onDuplicate={onDuplicate}
        actions={
          <div className="flex items-center mr-1">
            <select 
              className={`bg-bg-secondary text-[10px] rounded px-1 py-0.5 border border-border-color outline-none ${textColorClass} cursor-pointer hover:bg-bg-primary transition-colors`}
              value={fontSize}
              onChange={(e) => {
                const size = parseInt(e.target.value);
                setFontSize(size);
                data.onUpdate?.(id, { fontSize: size });
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {[10, 12, 14, 16, 18, 20, 24, 28, 32, 40].map(s => (
                <option key={s} value={s} className="bg-bg-secondary text-text-normal">{s}px</option>
              ))}
            </select>
          </div>
        }
      />
      
      <div 
        className={`p-4 flex-grow overflow-auto whitespace-pre-wrap ${textColorClass} font-medium`} 
        style={{ fontSize: `${fontSize}px`, lineHeight: 1.2, color: customTextColor || undefined }}
        onDoubleClick={() => setIsEditing(true)}
        onWheel={(e) => {
          // Only stop propagation if we are actually scrolling internally
          const target = e.currentTarget;
          const isScrollable = target.scrollHeight > target.clientHeight;
          if (isScrollable) {
            e.stopPropagation();
          }
        }}
      >
        {isEditing ? (
          <textarea
            autoFocus
            className={`w-full h-full bg-transparent outline-none resize-none font-sans font-medium ${textColorClass}`}
            style={{ lineHeight: 1.2, color: customTextColor || 'inherit' }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={onBlur}
          />
        ) : (
          <div className={`prose prose-sm max-w-none prose-slate prose-invert ${textColorClass.includes('text-white') ? 'prose-invert' : ''}`} style={{ fontSize: 'inherit', lineHeight: 1.2, color: customTextColor || 'inherit', fontWeight: 'inherit' }}>
            <MarkdownComp 
              remarkPlugins={[remarkBreaks, remarkGfm]}
              components={{
                p: ({ children }: any) => <p style={{ fontSize: 'inherit', lineHeight: 1.2, margin: 0, color: 'inherit', fontWeight: 'inherit' }}>{children}</p>,
                img: ({ node, ...props }: any) => {
                  const alt = props.alt || '';
                  let width = undefined;
                  if (alt.includes('|')) width = alt.split('|')[1];
                  return (
                    <img 
                      {...props} 
                      style={{ width: width ? `${width}px` : 'auto' }} 
                      className="rounded shadow-sm border border-border-color"
                      referrerPolicy="no-referrer"
                    />
                  );
                }
              }}
            >
              {text || '*Double click to edit*'}
            </MarkdownComp>
          </div>
        )}
      </div>
    </div>
  );
};

const FileNode = ({ data, selected, id, width, height }: NodeProps<any>) => {
  const [content, setContent] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const { setNodes } = useReactFlow();

  const onResize = (_: any, { width, height }: { width: number, height: number }) => {
    setNodes((nds) => nds.map((n) => n.id === id ? { ...n, width, height } : n));
  };

  useEffect(() => {
    const loadFile = async () => {
      if (data.file) {
        const res = await apiFetch(`/api/file?path=${encodeURIComponent(data.file as string)}`);
        if (res.ok) {
          setContent(await res.text());
        }
      }
    };
    loadFile();
  }, [data.file]);

  const onSave = async (newContent: string) => {
    if (data.file) {
      await apiFetch('/api/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: data.file, content: newContent }),
      });
      setContent(newContent);
    }
  };

  const onDelete = () => {
    setNodes((nds) => nds.filter((node) => node.id !== id));
  };

  const onDuplicate = () => {
    setNodes((nds) => [...nds, {
      ...nds.find(n => n.id === id)!,
      id: `node-${Date.now()}`,
      position: { x: (nds.find(n => n.id === id)?.position.x || 0) + 20, y: (nds.find(n => n.id === id)?.position.y || 0) + 20 }
    }]);
  };

  const onTitleChange = (newTitle: string) => {
    data.onUpdate?.(id, { title: newTitle });
  };

  const onColorChange = (newColor: string) => {
    data.onUpdate?.(id, { color: newColor });
  };

  const nodeColorClass = data.color || 'bg-bg-primary border-border-color';
  const rotation = data.rotation || 0;

  return (
    <div 
      className={`group relative border-2 rounded-lg shadow-xl flex flex-col transition-shadow ${selected ? 'border-interactive-accent shadow-interactive-accent/20' : nodeColorClass.includes('border') ? '' : 'border-border-color'} ${nodeColorClass} ${selected ? '!border-interactive-accent' : ''}`}
      style={{ width: width || 400, height: height || 300, transform: `rotate(${rotation}deg)` }}
    >
      <NodeResizer minWidth={200} minHeight={150} isVisible={selected} lineClassName="border-interactive-accent" handleClassName="h-3 w-3 bg-white border-2 border-interactive-accent rounded" onResize={onResize} />

      {selected && <RotationHandle id={id} onUpdate={(angle) => data.onUpdate?.(id, { rotation: angle })} />}

      <Handle type="source" position={Position.Top} id="top" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      <Handle type="source" position={Position.Left} id="left" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      <Handle type="source" position={Position.Right} id="right" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />

      <NodeHeader 
        color={data.color as string} 
        title={data.title || (data.file as string || '').split('/').pop()?.replace('.md', '') || 'Note'} 
        icon={FileText} 
        onDelete={onDelete}
        onOpen={() => data.onOpenFile?.(data.file)}
        onTitleChange={onTitleChange}
        onColorChange={onColorChange}
        onTextColorChange={(newColor) => data.onUpdate?.(id, { textColor: newColor })}
        customTextColor={data.textColor}
        onDuplicate={onDuplicate}
      />
      
      <div className="p-4 flex-grow overflow-auto text-sm text-text-normal whitespace-pre-wrap" onDoubleClick={() => setIsEditing(true)}>
        {isEditing ? (
          <textarea
            autoFocus
            className="w-full h-full bg-transparent outline-none resize-none font-sans leading-relaxed"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onBlur={() => {
              setIsEditing(false);
              onSave(content);
            }}
          />
        ) : (
          <div className="prose prose-sm prose-invert max-w-none dark:prose-invert prose-slate">
            <MarkdownComp remarkPlugins={[remarkBreaks, remarkGfm]}>{content || '*Empty note*'}</MarkdownComp>
          </div>
        )}
      </div>
    </div>
  );
};

const MediaNode = ({ data, selected, id, width, height }: NodeProps<any>) => {
  const isVideo = (data.file as string || '').endsWith('.mp4');
  const isPdf = (data.file as string || '').endsWith('.pdf');
  const { setNodes } = useReactFlow();

  const onDelete = () => {
    setNodes((nds) => nds.filter((node) => node.id !== id));
  };

  const onResize = (_: any, { width, height }: { width: number, height: number }) => {
    setNodes((nds) => nds.map((n) => n.id === id ? { ...n, width, height } : n));
  };

  const onDuplicate = () => {
    setNodes((nds) => [...nds, {
      ...nds.find(n => n.id === id)!,
      id: `node-${Date.now()}`,
      position: { x: (nds.find(n => n.id === id)?.position.x || 0) + 20, y: (nds.find(n => n.id === id)?.position.y || 0) + 20 }
    }]);
  };

  const onTitleChange = (newTitle: string) => {
    data.onUpdate?.(id, { title: newTitle });
  };

  const onColorChange = (newColor: string) => {
    data.onUpdate?.(id, { color: newColor });
  };

  const getMediaUrl = (file: string) => {
    if (!file) return '';
    if (file.startsWith('http') || file.startsWith('/api/')) return file;
    // Server route is /api/attachments/:filename (plural)
    const token = localStorage.getItem('jays_notes_token') || '';
    return `/api/attachments/${file}?token=${encodeURIComponent(token)}`;
  };

  const colorClasses = data.color || 'bg-bg-primary border-border-color';
  const rotation = data.rotation || 0;

  return (
    <div 
      className={`group relative border-2 rounded-lg shadow-xl flex flex-col transition-shadow ${selected ? 'border-interactive-accent shadow-interactive-accent/20' : colorClasses.includes('border') ? '' : 'border-border-color'} ${colorClasses} ${selected ? '!border-interactive-accent' : ''}`}
      style={{ width: width || '100%', height: height || '100%', transform: `rotate(${rotation}deg)` }}
    >
      <NodeResizer minWidth={150} minHeight={100} isVisible={selected} lineClassName="border-interactive-accent" handleClassName="h-3 w-3 bg-white border-2 border-interactive-accent rounded" onResize={onResize} />

      {selected && <RotationHandle id={id} onUpdate={(angle) => data.onUpdate?.(id, { rotation: angle })} />}

      <Handle type="source" position={Position.Top} id="top" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      <Handle type="source" position={Position.Left} id="left" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      <Handle type="source" position={Position.Right} id="right" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />

      <NodeHeader 
        color={data.color as string} 
        title={data.title || (data.file as string || '').split('/').pop() || 'Media'} 
        icon={ImageIcon} 
        onDelete={onDelete} 
        onTitleChange={onTitleChange}
        onColorChange={onColorChange}
        onTextColorChange={(newColor) => data.onUpdate?.(id, { textColor: newColor })}
        customTextColor={data.textColor}
        onDuplicate={onDuplicate}
      />
      
      <div className="p-0 flex-grow overflow-hidden flex items-center justify-center bg-black/5 dark:bg-black/20">
        {isVideo ? (
          <video src={getMediaUrl(data.file)} controls className="w-full h-full object-contain" />
        ) : isPdf ? (
          <iframe src={getMediaUrl(data.file)} className="w-full h-full min-h-[400px]" />
        ) : (
          <img src={getMediaUrl(data.file)} alt="Media" className="w-full h-full object-contain" referrerPolicy="no-referrer" />
        )}
      </div>
    </div>
  );
};

const LinkNode = ({ data, selected, id, width, height }: NodeProps<any>) => {
  const { setNodes } = useReactFlow();
  const [zoom, setZoom] = useState(data.zoom || 1);

  const onDelete = () => {
    setNodes((nds) => nds.filter((node) => node.id !== id));
  };

  const onResize = (_: any, { width, height }: { width: number, height: number }) => {
    setNodes((nds) => nds.map((n) => n.id === id ? { ...n, width, height } : n));
  };

  const onTitleChange = (newTitle: string) => {
    data.onUpdate?.(id, { title: newTitle });
  };

  const onColorChange = (newColor: string) => {
    data.onUpdate?.(id, { color: newColor });
  };

  const onDuplicate = () => {
    setNodes((nds) => [...nds, {
      ...nds.find(n => n.id === id)!,
      id: `node-${Date.now()}`,
      position: { x: (nds.find(n => n.id === id)?.position.x || 0) + 20, y: (nds.find(n => n.id === id)?.position.y || 0) + 20 }
    }]);
  };

  const handleZoom = (delta: number) => {
    const newZoom = Math.min(Math.max(zoom + delta, 0.1), 3);
    setZoom(newZoom);
    data.onUpdate?.(id, { zoom: newZoom });
  };

  const nodeColorClass = data.color || 'bg-bg-primary border-border-color';
  const rotation = data.rotation || 0;

  return (
    <div 
      className={`group relative border-2 rounded-lg shadow-xl flex flex-col transition-shadow ${selected ? 'border-interactive-accent shadow-interactive-accent/20' : nodeColorClass.includes('border') ? '' : 'border-border-color'} ${nodeColorClass} ${selected ? '!border-interactive-accent' : ''}`}
      style={{ width: width || 500, height: height || 400, transform: `rotate(${rotation}deg)` }}
    >
      <NodeResizer minWidth={250} minHeight={200} isVisible={selected} lineClassName="border-interactive-accent" handleClassName="h-3 w-3 bg-white border-2 border-interactive-accent rounded" onResize={onResize} />

      {selected && <RotationHandle id={id} onUpdate={(angle) => data.onUpdate?.(id, { rotation: angle })} />}

      <Handle type="source" position={Position.Top} id="top" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      <Handle type="source" position={Position.Left} id="left" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      <Handle type="source" position={Position.Right} id="right" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />

      <NodeHeader 
        color={data.color as string} 
        title={data.title || "Webpage"} 
        icon={LinkIcon} 
        onDelete={onDelete} 
        onOpen={() => window.open(data.url as string, '_blank')}
        onTitleChange={onTitleChange}
        onColorChange={onColorChange}
        onTextColorChange={(newColor) => data.onUpdate?.(id, { textColor: newColor })}
        customTextColor={data.textColor}
        onDuplicate={onDuplicate}
        actions={
          <div className="flex items-center gap-0.5 mr-1">
            <button 
              onClick={(e) => { e.stopPropagation(); handleZoom(-0.1); }} 
              className={`p-1 hover:bg-black/10 rounded transition-colors ${data.color ? (data.color.includes('text-white') ? 'text-white/70 hover:text-white' : 'text-text-normal') : 'text-text-muted hover:text-interactive-accent'}`} 
              title="Zoom Out"
            >
              <ZoomOut size={12} />
            </button>
            <span className={`text-[10px] min-w-[30px] text-center ${data.color && data.color.includes('text-white') ? 'text-white' : 'text-text-normal'}`}>
              {Math.round(zoom * 100)}%
            </span>
            <button 
              onClick={(e) => { e.stopPropagation(); handleZoom(0.1); }} 
              className={`p-1 hover:bg-black/10 rounded transition-colors ${data.color ? (data.color.includes('text-white') ? 'text-white/70 hover:text-white' : 'text-text-normal') : 'text-text-muted hover:text-interactive-accent'}`} 
              title="Zoom In"
            >
              <ZoomIn size={12} />
            </button>
          </div>
        }
      />
      
      <WebPageIframeBody url={data.url as string} zoom={zoom} />
    </div>
  );
};

const WebPageIframeBody = ({ url, zoom }: { url: string; zoom: number }) => {
  const [proxyOk, setProxyOk] = useState<boolean | null>(null);

  useEffect(() => {
    // Ask the server whether the proxy is enabled — avoids a HEAD request
    // to the proxy itself which doesn't support HEAD and requires a real URL.
    const token = localStorage.getItem('jays_notes_token') || '';
    fetch(`/api/proxy/status?token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(d => setProxyOk(d.enabled === true))
      .catch(() => setProxyOk(false));
  }, []);

  if (proxyOk === false) {
    return (
      <div className="flex-grow flex flex-col items-center justify-center bg-bg-secondary rounded-b-lg gap-3 p-4 text-center">
        <span style={{ fontSize: 28 }}>🔒</span>
        <p className="text-sm font-medium text-text-normal">Web preview unavailable</p>
        <p className="text-xs text-text-muted max-w-[260px]">
          The iframe proxy is disabled on this server. Set <code className="bg-bg-primary px-1 rounded">ENABLE_IFRAME_PROXY=true</code> in your environment to enable web previews.
        </p>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs px-3 py-1.5 rounded-lg border border-border-color text-text-normal hover:text-interactive-accent hover:border-interactive-accent transition-colors mt-1"
        >
          Open in browser ↗
        </a>
      </div>
    );
  }

  return (
    <div className="flex-grow overflow-hidden bg-white rounded-b-lg relative">
      <div style={{
        width: `${100 / zoom}%`,
        height: `${100 / zoom}%`,
        transform: `scale(${zoom})`,
        transformOrigin: 'top left',
        position: 'absolute',
        top: 0,
        left: 0
      }}>
        <iframe
          src={`/api/proxy/iframe?url=${encodeURIComponent(url)}&token=${localStorage.getItem('jays_notes_token') || ''}`}
          className="w-full h-full border-none pointer-events-none group-hover:pointer-events-auto"
          title="Web Embed"
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
};

const ShapeNode = ({ data, selected, id, width, height }: NodeProps<any>) => {
  const { setNodes } = useReactFlow();
  const [content, setContent] = useState(data.content || '');
  const [isColorMenuOpen, setIsColorMenuOpen] = useState(false);

  const rotation = data.rotation || 0;

  const onDelete = () => {
    setNodes((nds) => nds.filter((node) => node.id !== id));
  };

  const onUpdateField = useCallback((field: string, value: any) => {
    data.onUpdate?.(id, { [field]: value });
  }, [id, data.onUpdate]);

  const onResize = (_: any, { width, height }: { width: number, height: number }) => {
    setNodes((nds) => nds.map((n) => n.id === id ? { ...n, width, height } : n));
  };

  const onDuplicate = () => {
    setNodes((nds) => {
      const original = nds.find(n => n.id === id);
      if (!original) return nds;
      return [...nds, {
        ...original,
        id: `shape-${Date.now()}`,
        position: { x: original.position.x + 20, y: original.position.y + 20 }
      }];
    });
  };

  const strokeColorValue = data.strokeColor || '#71717a';
  const fillColorValue = data.fillColor || 'transparent';
  const nodeWidth = width || 100;
  const nodeHeight = height || 100;

  const isLine = data.shape === 'line';

  const getShapeSvg = () => {
    const strokeWidth = 2;
    const w = nodeWidth;
    const h = nodeHeight;

    switch (data.shape) {
      case 'circle':
        return <circle cx={w/2} cy={h/2} r={Math.min(w, h)/2 - strokeWidth} fill={fillColorValue} stroke={strokeColorValue} strokeWidth={strokeWidth} />;
      case 'square':
      case 'rectangle':
      case 'text-box':
        return <rect x={strokeWidth} y={strokeWidth} width={w - strokeWidth*2} height={h - strokeWidth*2} fill={fillColorValue} stroke={strokeColorValue} strokeWidth={strokeWidth} />;
      case 'rounded-rectangle':
        return <rect x={strokeWidth} y={strokeWidth} width={w - strokeWidth*2} height={h - strokeWidth*2} rx={16} ry={16} fill={fillColorValue} stroke={strokeColorValue} strokeWidth={strokeWidth} />;
      case 'triangle':
        return <path d={`M ${w/2} ${strokeWidth} L ${w - strokeWidth} ${h - strokeWidth} L ${strokeWidth} ${h - strokeWidth} Z`} fill={fillColorValue} stroke={strokeColorValue} strokeWidth={strokeWidth} />;
      case 'triangle-right':
        return <path d={`M ${strokeWidth} ${strokeWidth} L ${w - strokeWidth} ${h - strokeWidth} L ${strokeWidth} ${h - strokeWidth} Z`} fill={fillColorValue} stroke={strokeColorValue} strokeWidth={strokeWidth} />;
      case 'star':
        return <path d={`M ${w/2} ${strokeWidth} L ${w*0.65} ${h*0.35} L ${w-strokeWidth} ${h*0.4} L ${w*0.7} ${h*0.65} L ${w*0.8} ${h-strokeWidth} L ${w/2} ${h*0.8} L ${w*0.2} ${h-strokeWidth} L ${w*0.3} ${h*0.65} L ${strokeWidth} ${h*0.4} L ${w*0.35} ${h*0.35} Z`} fill={fillColorValue} stroke={strokeColorValue} strokeWidth={strokeWidth} />;
      case 'arrow':
        return (
          <>
            <line x1={strokeWidth} y1={h/2} x2={w - strokeWidth - 6} y2={h/2} stroke={strokeColorValue} strokeWidth={strokeWidth} />
            <path d={`M ${w - 10} ${h/2 - 5} L ${w - strokeWidth} ${h/2} L ${w - 10} ${h/2 + 5}`} fill="none" stroke={strokeColorValue} strokeWidth={strokeWidth} />
          </>
        );
      case 'arrow-double':
        return (
          <>
            <line x1={strokeWidth + 6} y1={h/2} x2={w - strokeWidth - 6} y2={h/2} stroke={strokeColorValue} strokeWidth={strokeWidth} />
            <path d={`M ${w - 10} ${h/2 - 5} L ${w - strokeWidth} ${h/2} L ${w - 10} ${h/2 + 5}`} fill="none" stroke={strokeColorValue} strokeWidth={strokeWidth} />
            <path d={`M 10 ${h/2 - 5} L ${strokeWidth} ${h/2} L 10 ${h/2 + 5}`} fill="none" stroke={strokeColorValue} strokeWidth={strokeWidth} />
          </>
        );
      case 'line':
        return <line x1={strokeWidth} y1={h/2} x2={w - strokeWidth} y2={h/2} stroke={strokeColorValue} strokeWidth={strokeWidth} strokeDasharray={data.dotted ? "4 4" : "0"} />;
      default:
        return null;
    }
  };

  return (
    <div 
      className={`group relative flex flex-col transition-shadow ${selected ? 'z-[1000]' : ''}`}
      style={{ 
        width: nodeWidth, 
        height: nodeHeight,
        transform: `rotate(${rotation}deg)`
      }}
    >
      <NodeResizer minWidth={10} minHeight={10} isVisible={selected} lineClassName="border-interactive-accent" handleClassName="h-3 w-3 bg-white border-2 border-interactive-accent rounded" onResize={onResize} />

      {selected && <RotationHandle id={id} onUpdate={(angle) => onUpdateField('rotation', angle)} />}

      <Handle type="source" position={Position.Top} id="top" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary opacity-0 group-hover:opacity-100 transition-all hover:scale-125 nopan nodrag" />
      <Handle type="source" position={Position.Left} id="left" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary opacity-0 group-hover:opacity-100 transition-all hover:scale-125 nopan nodrag" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary opacity-0 group-hover:opacity-100 transition-all hover:scale-125 nopan nodrag" />
      <Handle type="source" position={Position.Right} id="right" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary opacity-0 group-hover:opacity-100 transition-all hover:scale-125 nopan nodrag" />

      {selected && (
        <div className="absolute -top-12 left-1/2 -translate-x-1/2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20 bg-bg-secondary p-1 rounded-lg border border-border-color shadow-xl items-center no-drag">
          <div className="relative">
            <button onClick={(e) => { e.stopPropagation(); setIsColorMenuOpen(!isColorMenuOpen); }} className="p-1 hover:bg-interactive-hover rounded text-text-muted transition-colors" title="Edit Colors">
              <Palette size={14} />
            </button>
            {isColorMenuOpen && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-bg-secondary border border-border-color rounded-lg shadow-2xl p-3 z-30 min-w-[200px]">
                <div className="mb-3">
                  <div className="text-[10px] font-bold text-text-muted uppercase mb-1">Outline Color</div>
                  <div className="grid grid-cols-5 gap-1">
                    {['#71717a', '#ff7675', '#55efc4', '#0984e3', '#fdcb6e', '#1a1a1b', '#ffffff', '#3730a3', '#064e3b', '#b45309'].map(c => (
                      <button 
                        key={c} 
                        onClick={() => { onUpdateField('strokeColor', c); setIsColorMenuOpen(false); }} 
                        className="w-5 h-5 rounded border border-border-color" 
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </div>
                {!isLine && (
                  <div>
                    <div className="text-[10px] font-bold text-text-muted uppercase mb-1">Fill Color</div>
                    <div className="grid grid-cols-5 gap-1">
                      {['transparent', '#71717a', '#ff7675', '#55efc4', '#0984e3', '#fdcb6e', '#1a1a1b', '#ffffff', '#3730a3', '#064e3b'].map(c => (
                        <button 
                          key={c} 
                          onClick={() => { onUpdateField('fillColor', c); setIsColorMenuOpen(false); }} 
                          className="w-5 h-5 rounded border border-border-color" 
                          style={{ backgroundColor: c === 'transparent' ? 'transparent' : c, backgroundImage: c === 'transparent' ? 'linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 50%, #ccc 50%, #ccc 75%, transparent 75%, transparent)' : 'none', backgroundSize: '4px 4px' }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="w-[1px] h-4 bg-border-color mx-1" />
          
          <div className="relative">
            <button 
              onClick={(e) => { e.stopPropagation(); onUpdateField('isTextColorMenuOpen', !data.isTextColorMenuOpen); }} 
              className="p-1 hover:bg-interactive-hover rounded text-text-muted transition-colors" 
              title="Text Color"
            >
              <Type size={14} />
            </button>
            {data.isTextColorMenuOpen && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-bg-secondary border border-border-color rounded-lg shadow-2xl p-1 z-30 grid grid-cols-4 gap-1 w-32">
                {TEXT_COLORS.map((c) => (
                  <button
                    key={c.name}
                    onClick={() => {
                      onUpdateField('textColor', c.value);
                      onUpdateField('isTextColorMenuOpen', false);
                    }}
                    className="w-6 h-6 rounded flex items-center justify-center border border-border-color hover:scale-110 transition-transform"
                    style={{ backgroundColor: c.value || 'white' }}
                    title={c.name}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="w-[1px] h-4 bg-border-color mx-1" />
          <button onClick={(e) => { e.stopPropagation(); onDuplicate(); }} className="p-1 hover:bg-interactive-hover rounded text-text-muted transition-colors" title="Duplicate">
            <Copy size={14} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="p-1 hover:bg-red-500/20 rounded text-text-muted hover:text-red-500 transition-colors" title="Delete">
            <Trash2 size={14} />
          </button>
        </div>
      )}

      <div className={`absolute inset-0 pointer-events-none overflow-visible ${isLine ? '' : 'border border-transparent group-hover:border-border-color/50 rounded'}`}>
        <svg width="100%" height="100%" className="overflow-visible" preserveAspectRatio="none">
          {getShapeSvg()}
        </svg>
      </div>

      <div 
        className="absolute inset-4 flex items-center justify-center text-center outline-none overflow-auto text-sm nodrag"
        style={{ color: data.textColor || 'inherit' }}
        contentEditable
        suppressContentEditableWarning
        onBlur={(e) => {
          const newContent = e.currentTarget.textContent || '';
          setContent(newContent);
          onUpdateField('content', newContent);
        }}
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => {
          const target = e.currentTarget;
          const isScrollable = target.scrollHeight > target.clientHeight;
          if (isScrollable) {
            e.stopPropagation();
          }
        }}
      >
        {content}
      </div>
    </div>
  );
};

const GroupNode = ({ data, selected, id }: NodeProps<any>) => {
  return (
    <div className={`group relative bg-interactive-accent/5 border-2 border-dashed rounded-lg flex flex-col transition-all ${selected ? 'border-interactive-accent ring-2 ring-interactive-accent/20' : 'border-border-color/50'}`}>
      <Handle type="source" position={Position.Top} id="top" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      <Handle type="source" position={Position.Left} id="left" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      <Handle type="source" position={Position.Right} id="right" className="w-3.5 h-3.5 bg-interactive-accent !border-bg-primary hover:scale-125 transition-transform nopan nodrag" />
      
      <div className="absolute -top-6 left-0 text-xs font-bold text-text-muted uppercase tracking-wider">
        {data.label as string || 'Group'}
      </div>
    </div>
  );
};

// --- Custom Edge Component ---

const CustomEdge = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  data,
  selected,
}: EdgeProps) => {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetPosition,
    targetX,
    targetY,
  });

  const colors: Record<string, string> = {
    '1': '#ef4444',
    '2': '#f97316',
    '3': '#eab308',
    '4': '#22c55e',
    '5': '#06b6d4',
    '6': '#a855f7',
  };

  const edgeColor = data?.color ? (colors[data.color as string] || data.color as string) : '#D85A30';

  return (
    <>
      <path
        id={id}
        style={{ ...style, strokeWidth: 20, stroke: 'transparent', fill: 'none', cursor: 'pointer' }}
        className="react-flow__edge-interaction"
        d={edgePath}
      />
      <BaseEdge 
        path={edgePath} 
        markerEnd={markerEnd} 
        style={{ 
          ...style, 
          fill: 'none',
          stroke: selected ? '#38bdf8' : edgeColor, 
          strokeWidth: selected ? 3 : 2,
          transition: 'all 0.2s ease',
          opacity: selected ? 1 : 0.8
        }} 
      />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
            }}
            className={`px-2 py-1 rounded border text-[10px] font-bold shadow-sm transition-all ${selected ? 'bg-interactive-accent text-white border-interactive-accent scale-110' : 'bg-bg-secondary border-border-color text-text-normal'}`}
          >
            {data.label as string}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
};

// --- Main Canvas Component ---

const nodeTypes = {
  text: TextNode,
  file: FileNode,
  media: MediaNode,
  link: LinkNode,
  group: GroupNode,
  shape: ShapeNode,
};

const edgeTypes = {
  custom: CustomEdge,
};

const SHAPES = [
  { id: 'circle', icon: Circle, label: 'Circle' },
  { id: 'square', icon: Square, label: 'Square' },
  { id: 'triangle', icon: Triangle, label: 'Triangle' },
  { id: 'triangle-right', icon: Triangle, label: 'Right Triangle' },
  { id: 'rounded-rectangle', icon: Square, label: 'Rounded Rect' },
  { id: 'arrow', icon: MoveRight, label: 'Arrow' },
  { id: 'arrow-double', icon: MoveHorizontal, label: 'Double Arrow' },
  { id: 'line', icon: Minus, label: 'Line' },
  { id: 'line-dotted', icon: Minus, label: 'Dotted Line' },
  { id: 'star', icon: Star, label: 'Star' },
  { id: 'text-box', icon: Type, label: 'Text Box' },
];

const CanvasInner: React.FC<{ filePath?: string, onOpenFile?: (path: string) => void, templates?: { name: string, path: string, type: string }[] }> = ({ filePath, onOpenFile, templates = [] }) => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [isSelectMode, setIsSelectMode] = useState(true);
  const [loading, setLoading] = useState(true);
  const [isTemplateMenuOpen, setIsTemplateMenuOpen] = useState(false);
  const [isShapeMenuOpen, setIsShapeMenuOpen] = useState(false);
  const [promptConfig, setPromptConfig] = useState<{ show: boolean, title: string, placeholder: string, value: string, onConfirm: (val: string) => void } | null>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleNodeUpdate = useCallback((id: string, newData: any) => {
    setNodes((nds) => nds.map((node) => node.id === id ? { ...node, data: { ...node.data, ...newData } } : node));
  }, [setNodes]);

  const addShape = (shapeId: string, parentNodeId?: string) => {
    const id = `node-${Date.now()}`;
    const pos = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    
    let newNode: Node;
    newNode = {
      id,
      type: 'shape',
      position: pos,
      data: { 
        shape: shapeId.replace('-dotted', ''), 
        dotted: shapeId.includes('dotted'),
        onUpdate: handleNodeUpdate,
        content: shapeId === 'text-box' ? 'Text Box' : ''
      },
      width: shapeId === 'text-box' ? 200 : 100,
      height: 100,
      parentId: parentNodeId,
    };
    
    setNodes((nds) => [...nds, newNode]);
    setIsShapeMenuOpen(false);
  };

  // Load canvas data
  useEffect(() => {
    if (!filePath) return;

    const loadCanvas = async () => {
      setLoading(true);
      try {
        const res = await apiFetch(`/api/file?path=${encodeURIComponent(filePath)}`);
        if (res.ok) {
          const text = await res.text();
          let data: any = { nodes: [], edges: [] };
          if (text.trim()) {
            try {
              data = JSON.parse(text);
            } catch (e) {
              console.error('Canvas file is corrupted or not valid JSON');
            }
          }
          setNodes((data.nodes || []).map((n: any) => ({
            ...n,
            data: { ...n.data, onUpdate: handleNodeUpdate, onOpenFile }
          })));
          setEdges(data.edges || []);
          setTimeout(() => fitView(), 100);
        }
      } catch (error) {
        console.error('Failed to load canvas', error);
      } finally {
        setLoading(false);
      }
    };

    loadCanvas();
  }, [filePath, onOpenFile, handleNodeUpdate, fitView, setNodes, setEdges]);

  // Auto-save
  const saveTimeoutRef = useRef<NodeJS.Timeout>(undefined);
  useEffect(() => {
    if (loading || !filePath) return;

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    saveTimeoutRef.current = setTimeout(async () => {
      const canvasData = {
        nodes: nodes.map(({ data, ...n }) => ({ ...n, data: { ...data, onUpdate: undefined, onOpenFile: undefined } })),
        edges
      };
      try {
        await apiFetch('/api/file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, content: JSON.stringify(canvasData, null, 2) }),
        });
      } catch (error) {
        console.error('Failed to save canvas', error);
      }
    }, 1000);

    return () => clearTimeout(saveTimeoutRef.current);
  }, [nodes, edges, filePath, loading]);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge({ ...params, type: 'custom' }, eds)),
    [setEdges],
  );

  const onPaste = useCallback((event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (!file) continue;

        const formData = new FormData();
        formData.append('file', file);

        const token = localStorage.getItem('jays_notes_token');
        fetch('/api/upload', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: formData
        }).then(res => res.json()).then(data => {
          if (data.path) {
            // Server returns { path: "attachments/filename.ext" } — store just the filename
            const filename = data.path.split('/').pop();
            const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
            const newNode: Node = {
              id: `node-${Date.now()}`,
              type: 'media',
              position,
              data: { file: filename, onUpdate: handleNodeUpdate },
              width: 400,
              height: 300,
            };
            setNodes((nds) => [...nds, newNode]);
          }
        });
      }
    }
  }, [screenToFlowPosition, setNodes, handleNodeUpdate]);

  // Reliable Global Paste for Canvas
  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      // Only process if we are not editing an input/textarea elsewhere
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
        const isEditingNode = document.activeElement.closest('.react-flow__node');
        if (!isEditingNode) return;
      }
      
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          if (!file) continue;

          const formData = new FormData();
          formData.append('file', file);

          const token = localStorage.getItem('jays_notes_token');
          fetch('/api/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
          }).then(res => res.json()).then(data => {
            if (data.path) {
              const filename = data.path.split('/').pop();
              const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
              const newNode: Node = {
                id: `node-${Date.now()}`,
                type: 'media',
                position,
                data: { file: filename, onUpdate: handleNodeUpdate },
                width: 400,
                height: 300,
                style: { width: 400, height: 300 }
              };
              setNodes((nds) => [...nds, newNode]);
            }
          });
          e.preventDefault();
        }
      }
    };

    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, [screenToFlowPosition, setNodes, handleNodeUpdate]);

  const addTextCard = () => {
    const id = `node-${Date.now()}`;
    const newNode: Node = {
      id,
      type: 'text',
      position: screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }),
      data: { text: 'New Card', onUpdate: handleNodeUpdate },
      width: 400,
      height: 300,
      style: { width: 400, height: 300 }
    };
    setNodes((nds) => [...nds, newNode]);
  };

  const addNoteFromVault = async () => {
    setPromptConfig({
      show: true,
      title: 'Enter note path',
      placeholder: 'Welcome.md',
      value: '',
      onConfirm: (path) => {
        if (!path) return;
        const newNode: Node = {
          id: `node-${Date.now()}`,
          type: 'file',
          position: screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }),
          data: { file: path, onUpdate: handleNodeUpdate, onOpenFile },
          width: 400,
          height: 300,
        };
        setNodes((nds) => [...nds, newNode]);
      }
    });
  };

  const addWebPage = () => {
    setPromptConfig({
      show: true,
      title: 'Enter webpage URL',
      placeholder: 'https://google.com',
      value: '',
      onConfirm: (url) => {
        if (!url) return;
        const formattedUrl = url.startsWith('http') ? url : `https://${url}`;
        const id = `node-${Date.now()}`;
        const newNode: Node = {
          id,
          type: 'link',
          position: screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }),
          data: { url: formattedUrl, onUpdate: handleNodeUpdate },
          width: 500,
          height: 400,
          style: { width: 500, height: 400 }
        };
        setNodes((nds) => [...nds, newNode]);
      }
    });
  };

  const addImage = () => {
    // Directly trigger file upload as requested
    fileInputRef.current?.click();
  };

  const handleApplyTemplate = async (template: { name: string, path: string, type: string }) => {
    try {
      const res = await apiFetch(`/api/file?path=${encodeURIComponent(template.path)}`);
      if (res.ok) {
        const content = await res.text();
        try {
          const templateData = JSON.parse(content);
          if (templateData.nodes) {
            const offset = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
            const newNodes = templateData.nodes.map((n: any) => ({
              ...n,
              id: `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              position: { x: (n.position?.x || 0) + offset.x, y: (n.position?.y || 0) + offset.y },
              data: { ...n.data, onUpdate: handleNodeUpdate, onOpenFile }
            }));
            setNodes((nds) => [...nds, ...newNodes]);
            if (templateData.edges) {
              setEdges((eds) => [...eds, ...templateData.edges]);
            }
          }
        } catch (e) {
          // If not JSON, treat as text card template
          const newNode: Node = {
            id: `node-${Date.now()}`,
            type: 'text',
            position: screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }),
            data: { text: content, onUpdate: handleNodeUpdate },
            width: 400,
            height: 300,
          };
          setNodes((nds) => [...nds, newNode]);
        }
        setIsTemplateMenuOpen(false);
      }
    } catch (error) {
      console.error('Failed to apply template', error);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so the same file can be re-selected next time
    e.target.value = '';
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    const token = localStorage.getItem('jays_notes_token');
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      const data = await res.json();
      if (data.path) {
        // Server returns { path: "attachments/filename.ext" } — store just the filename
        const filename = data.path.split('/').pop();
        const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
        const newNode: Node = {
          id: `node-${Date.now()}`,
          type: 'media',
          position,
          data: { file: filename, onUpdate: handleNodeUpdate },
          width: 400,
          height: 300,
          style: { width: 400, height: 300 }
        };
        setNodes((nds) => [...nds, newNode]);
      } else {
        console.error('Upload response missing path:', data);
      }
    } catch (error) {
      console.error('File upload failed', error);
    }
  };

  if (loading && filePath) {
    return <div className="h-full flex items-center justify-center text-text-muted">Loading Canvas...</div>;
  }

  return (
    <div className="w-full h-full bg-bg-primary relative">
      <ReactFlow
        className={isSelectMode ? "selection-mode" : "pan-mode"}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaste={onPaste as any}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={"loose" as any}
        fitView
        snapToGrid
        snapGrid={[12, 12]}
        panOnScroll={true}
        panOnScrollMode={"free" as any}
        panOnScrollSpeed={1.5}
        selectionOnDrag={isSelectMode}
        selectionMode={SelectionMode.Partial}
        panOnDrag={isSelectMode ? [1, 2] : [0]}
        colorMode={document.documentElement.classList.contains('light') ? 'light' : 'dark'}
        deleteKeyCode={['Backspace', 'Delete']}
        multiSelectionKeyCode={['Control', 'Meta']}
        elementsSelectable={true}
      >
        <Controls />
        <MiniMap />
        <Background variant={"dots" as any} gap={12} size={1} />
        
        {/* Bottom Toolbar */}
        <Panel position="bottom-center" className="mb-4">
          <div className="bg-bg-secondary border border-border-color rounded-full shadow-2xl p-1 flex items-center gap-1">
            <div className="flex bg-bg-primary/50 rounded-full p-0.5 mr-1 border border-border-color/50">
              <button 
                onClick={() => setIsSelectMode(true)}
                className={`p-2.5 rounded-full transition-all ${isSelectMode ? 'bg-interactive-accent text-white shadow-lg' : 'text-text-muted hover:bg-interactive-hover'}`}
                title="Selection Mode"
              >
                <MousePointer2 size={18} />
              </button>
              <button 
                onClick={() => setIsSelectMode(false)}
                className={`p-2.5 rounded-full transition-all ${!isSelectMode ? 'bg-interactive-accent text-white shadow-lg' : 'text-text-muted hover:bg-interactive-hover'}`}
                title="Pan Mode"
              >
                <Hand size={18} />
              </button>
            </div>

            <div className="w-[1px] h-6 bg-border-color/50 mx-1" />

            <button 
              onClick={addTextCard}
              className="p-3 hover:bg-interactive-hover rounded-full text-text-muted hover:text-interactive-accent transition-all"
              title="Add Card"
            >
              <Type size={20} />
            </button>
            
            <div className="relative group/shapes">
              <button 
                onClick={() => setIsShapeMenuOpen(!isShapeMenuOpen)}
                className={`p-3 hover:bg-interactive-hover rounded-full transition-all ${isShapeMenuOpen ? 'text-interactive-accent' : 'text-text-muted hover:text-interactive-accent'}`}
                title="Add Shape"
              >
                <Plus size={20} />
              </button>
              {isShapeMenuOpen && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 bg-bg-secondary border border-border-color rounded-xl shadow-2xl p-2 grid grid-cols-3 gap-1 w-48 z-[100]">
                  {SHAPES.map(s => (
                    <button
                      key={s.id}
                      onClick={() => addShape(s.id)}
                      className="flex flex-col items-center justify-center p-2 hover:bg-bg-primary rounded-lg transition-colors group/shapeitem"
                    >
                      <s.icon size={20} className="text-text-muted group-hover/shapeitem:text-interactive-accent" />
                      <span className="text-[10px] mt-1 text-text-muted">{s.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button 
              onClick={addWebPage}
              className="p-3 hover:bg-interactive-hover rounded-full text-text-muted hover:text-interactive-accent transition-all"
              title="Add Web Link Card"
            >
              <LinkIcon size={20} />
            </button>
            <button 
              onClick={addImage}
              className="p-3 hover:bg-interactive-hover rounded-full text-text-muted hover:text-interactive-accent transition-all"
              title="Add Image"
            >
              <ImageIcon size={20} />
            </button>
            <input 
              type="file" 
              ref={fileInputRef} 
              className="hidden" 
              accept="image/*" 
              onChange={handleFileUpload} 
            />
          </div>
        </Panel>

        {/* Top Left Templates */}
        <Panel position="top-left" className="mt-4 ml-4">
          <div className="relative">
            <button 
              onClick={() => setIsTemplateMenuOpen(!isTemplateMenuOpen)}
              className={`p-2 bg-bg-secondary border border-border-color rounded shadow hover:bg-interactive-hover transition-colors ${isTemplateMenuOpen ? 'text-interactive-accent' : 'text-text-muted'}`}
              title="Templates"
            >
              <ClipboardList size={16} />
            </button>
            {isTemplateMenuOpen && (
              <div className="absolute left-0 mt-2 w-48 bg-bg-secondary border border-border-color rounded-md shadow-xl z-50 py-1 overflow-hidden">
                <div className="px-3 py-1.5 text-[10px] font-bold text-text-muted uppercase tracking-wider border-b border-border-color">
                  Canvas Templates
                </div>
                <div className="max-h-60 overflow-y-auto custom-scrollbar">
                  {templates.filter(t => t.type === 'canvas').length === 0 ? (
                    <div className="px-3 py-2 text-xs text-text-muted italic">No canvas templates found</div>
                  ) : (
                    templates.filter(t => t.type === 'canvas').map(t => (
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
        </Panel>

        {/* Top Right Controls */}
        <Panel position="top-right" className="mt-4 mr-4 flex flex-col gap-2">
          <button 
            onClick={() => fitView({ padding: 0.2 })}
            className="p-2 bg-bg-secondary border border-border-color rounded shadow hover:bg-interactive-hover text-text-muted transition-colors"
            title="Zoom to Fit"
          >
            <Maximize size={16} />
          </button>
        </Panel>

        {/* Custom Prompt Modal */}
        {promptConfig?.show && (
          <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="bg-bg-secondary border border-border-color rounded-xl shadow-2xl w-full max-w-md p-6 animate-in fade-in zoom-in duration-200">
              <h3 className="text-lg font-bold text-text-normal mb-4">{promptConfig.title}</h3>
              <input 
                autoFocus
                type="text"
                className="w-full bg-bg-primary border border-border-color rounded-lg px-4 py-3 text-text-normal focus:border-interactive-accent outline-none mb-6"
                placeholder={promptConfig.placeholder}
                value={promptConfig.value}
                onChange={(e) => setPromptConfig({ ...promptConfig, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    promptConfig.onConfirm(promptConfig.value);
                    setPromptConfig(null);
                  }
                  if (e.key === 'Escape') setPromptConfig(null);
                }}
              />
              <div className="flex justify-end gap-3">
                <button 
                  onClick={() => setPromptConfig(null)}
                  className="px-4 py-2 border border-border-color rounded-lg text-text-muted hover:bg-bg-primary transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => {
                    promptConfig.onConfirm(promptConfig.value);
                    setPromptConfig(null);
                  }}
                  className="px-6 py-2 bg-interactive-accent text-white rounded-lg hover:bg-interactive-accent/90 transition-colors font-bold"
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>
        )}
      </ReactFlow>
    </div>
  );
};

export const Canvas: React.FC<{ filePath?: string, onOpenFile?: (path: string) => void, templates?: { name: string, path: string, type: string }[] }> = ({ filePath, onOpenFile, templates }) => {
  return (
    <ReactFlowProvider>
      <CanvasInner filePath={filePath} onOpenFile={onOpenFile} templates={templates} />
    </ReactFlowProvider>
  );
};
