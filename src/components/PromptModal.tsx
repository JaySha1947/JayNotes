import React, { useState, useEffect, useRef } from 'react';

interface PromptModalProps {
  isOpen: boolean;
  title: string;
  defaultValue?: string;
  mode?: 'prompt' | 'confirm';
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export const PromptModal: React.FC<PromptModalProps> = ({ 
  isOpen, 
  title, 
  defaultValue = '', 
  mode = 'prompt',
  onConfirm, 
  onCancel 
}) => {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue);
      setTimeout(() => {
        inputRef.current?.focus();
        if (mode === 'prompt') {
          inputRef.current?.select();
        }
      }, 50);
    }
  }, [isOpen, defaultValue, mode]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'confirm' || value.trim()) {
      onConfirm(mode === 'confirm' ? '' : value.trim());
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onCancel}>
      <div 
        className="bg-bg-primary border border-border-color rounded-xl shadow-2xl w-full max-w-md p-6"
        onClick={e => e.stopPropagation()}
      >
        <h2 className={`text-lg font-semibold text-text-normal mb-4 ${mode === 'confirm' ? 'mb-6 text-center' : ''}`}>{title}</h2>
        <form onSubmit={handleSubmit}>
          {mode === 'prompt' && (
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full bg-bg-secondary border border-border-color rounded px-3 py-2 outline-none focus:border-interactive-accent transition-colors text-text-normal mb-6"
            />
          )}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 py-2 text-sm text-text-muted bg-bg-secondary hover:bg-interactive-hover rounded-lg transition-colors font-medium border border-border-color"
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`flex-1 py-2 text-sm text-white rounded-lg transition-colors font-bold ${
                mode === 'confirm' ? 'bg-text-danger hover:bg-text-danger/90' : 'bg-interactive-accent hover:bg-opacity-90'
              }`}
              disabled={mode === 'prompt' && !value.trim()}
              ref={mode === 'confirm' ? (inputRef as any) : null}
            >
              {mode === 'confirm' ? 'Delete' : 'Confirm'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
