import React from 'react';
import { X, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { AdminFileExplorer } from './AdminFileExplorer';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = React.useState('editor');
  const [theme, setTheme] = React.useState(localStorage.getItem('jays_notes_theme') || 'Dark');
  const [accentColor, setAccentColor] = React.useState(() => {
    const saved = localStorage.getItem('jays_notes_accent');
    return (saved === '#7d4698' || saved === '#D85A30') ? '#00c882' : (saved || '#00c882');
  });
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [passwordChangeStatus, setPasswordChangeStatus] = React.useState<{ type: 'success' | 'error', message: string } | null>(null);
  const [agentSpaceFolder, setAgentSpaceFolder] = React.useState(
    localStorage.getItem('jays_notes_agent_space_folder') || '2 - Agent Space'
  );
  const [agentFolderSaved, setAgentFolderSaved] = React.useState(false);
  const userRole = localStorage.getItem('jays_notes_role');
  const isAdmin = userRole === 'admin';

  React.useEffect(() => {
    if (theme === 'Light') {
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.remove('light');
    }
    localStorage.setItem('jays_notes_theme', theme);
  }, [theme]);

  React.useEffect(() => {
    document.documentElement.style.setProperty('--interactive-accent', accentColor);
    localStorage.setItem('jays_notes_accent', accentColor);
  }, [accentColor]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div 
        className={`bg-bg-primary border border-border-color rounded-xl shadow-2xl h-[70vh] flex overflow-hidden transition-all duration-300 ${activeTab === 'admin_storage' ? 'w-[90vw] max-w-6xl' : 'w-full max-w-3xl'}`}
        onClick={e => e.stopPropagation()}
      >
        {/* Settings Sidebar */}
        <div className="w-48 bg-bg-secondary border-r border-border-color py-4 flex flex-col flex-shrink-0">
          <div className="px-4 pb-2 text-xs font-semibold text-text-muted uppercase tracking-wider">
            Options
          </div>
          <button 
            className={`text-left px-4 py-2 ${activeTab === 'editor' ? 'bg-interactive-hover text-interactive-accent' : 'text-text-normal hover:bg-interactive-hover'}`}
            onClick={() => setActiveTab('editor')}
          >
            Editor
          </button>
          <button 
            className={`text-left px-4 py-2 ${activeTab === 'files' ? 'bg-interactive-hover text-interactive-accent' : 'text-text-normal hover:bg-interactive-hover'}`}
            onClick={() => setActiveTab('files')}
          >
            Files & Links
          </button>
          <button 
            className={`text-left px-4 py-2 ${activeTab === 'appearance' ? 'bg-interactive-hover text-interactive-accent' : 'text-text-normal hover:bg-interactive-hover'}`}
            onClick={() => setActiveTab('appearance')}
          >
            Appearance
          </button>
          <button 
            className={`text-left px-4 py-2 ${activeTab === 'security' ? 'bg-interactive-hover text-interactive-accent' : 'text-text-normal hover:bg-interactive-hover'}`}
            onClick={() => setActiveTab('security')}
          >
            Security
          </button>
          <button
            className={`text-left px-4 py-2 flex items-center gap-1.5 ${activeTab === 'agent_space' ? 'bg-interactive-hover text-interactive-accent' : 'text-text-normal hover:bg-interactive-hover'}`}
            onClick={() => setActiveTab('agent_space')}
          >
            <span style={{ fontSize: 13 }}>✦</span> Agent Space
          </button>
          
          {isAdmin && (
            <>
              <div className="px-4 pt-4 mt-2 border-t border-border-color pb-2 text-xs font-semibold text-interactive-accent uppercase tracking-wider flex items-center gap-1">
                <ShieldCheck size={12} /> Admin
              </div>
              <button 
                className={`text-left px-4 py-2 ${activeTab === 'admin_storage' ? 'bg-interactive-hover text-interactive-accent' : 'text-text-normal hover:bg-interactive-hover'}`}
                onClick={() => setActiveTab('admin_storage')}
              >
                Master Storage
              </button>
            </>
          )}

          <div className="flex-grow" />
          <div className="px-4 pt-4 border-t border-border-color pb-2 text-xs font-semibold text-text-muted uppercase tracking-wider">
            About
          </div>
          <div className="px-4 text-sm text-text-muted">
            Primal Notes v1.0.0
          </div>
        </div>

        {/* Settings Content */}
        <div className="flex-grow flex flex-col bg-bg-primary">
          <div className="h-12 border-b border-border-color flex items-center justify-between px-6">
            <h2 className="text-lg font-semibold text-text-normal capitalize">
              {activeTab === 'files' ? 'Files & Links' : activeTab === 'admin_storage' ? 'Master Storage (All Users)' : activeTab === 'agent_space' ? '✦ Agent Space' : activeTab}
            </h2>
            <button onClick={onClose} className="text-text-muted hover:text-text-normal">
              <X size={20} />
            </button>
          </div>
          <div className="p-6 overflow-y-auto h-full overflow-x-hidden">
            {activeTab === 'editor' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-text-normal font-medium mb-1">Spellcheck</h3>
                  <p className="text-sm text-text-muted mb-3">Enable spellcheck in the editor.</p>
                  <label className="flex items-center cursor-pointer">
                    <div className="relative">
                      <input type="checkbox" className="sr-only" />
                      <div className="block bg-interactive-accent w-10 h-6 rounded-full"></div>
                      <div className="dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition transform translate-x-4"></div>
                    </div>
                  </label>
                </div>
                
                <div className="pt-6 border-t border-border-color">
                  <h3 className="text-text-normal font-medium mb-1">Auto-pair brackets</h3>
                  <p className="text-sm text-text-muted mb-3">Automatically pair brackets, parentheses, and quotes.</p>
                  <label className="flex items-center cursor-pointer">
                    <div className="relative">
                      <input type="checkbox" className="sr-only" />
                      <div className="block bg-interactive-accent w-10 h-6 rounded-full"></div>
                      <div className="dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition transform translate-x-4"></div>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {activeTab === 'files' && (
              <div className="space-y-6">
                <div className="pt-6 border-t border-border-color">
                  <h3 className="text-text-normal font-medium mb-1">Confirm file deletion</h3>
                  <p className="text-sm text-text-muted mb-3">Show a confirmation prompt before deleting a file.</p>
                  <label className="flex items-center cursor-pointer">
                    <div className="relative">
                      <input type="checkbox" className="sr-only" />
                      <div className="block bg-interactive-accent w-10 h-6 rounded-full"></div>
                      <div className="dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition transform translate-x-4"></div>
                    </div>
                  </label>
                </div>
                <div className="pt-6 border-t border-border-color">
                  <h3 className="text-text-normal font-medium mb-1">Use WikiLinks</h3>
                  <p className="text-sm text-text-muted mb-3">Generate [[WikiLinks]] instead of standard markdown links.</p>
                  <label className="flex items-center cursor-pointer">
                    <div className="relative">
                      <input type="checkbox" className="sr-only" />
                      <div className="block bg-interactive-accent w-10 h-6 rounded-full"></div>
                      <div className="dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition transform translate-x-4"></div>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {activeTab === 'appearance' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-text-normal font-medium mb-1">Base color scheme</h3>
                  <p className="text-sm text-text-muted mb-3">Choose Obsidian's default color scheme.</p>
                  <select 
                    className="bg-bg-secondary border border-border-color text-text-normal rounded px-3 py-1.5 outline-none focus:border-interactive-accent"
                    value={theme}
                    onChange={(e) => setTheme(e.target.value)}
                  >
                    <option value="Dark">Dark</option>
                    <option value="Light">Light</option>
                  </select>
                </div>
                <div className="pt-6 border-t border-border-color">
                  <h3 className="text-text-normal font-medium mb-1">Accent color</h3>
                  <p className="text-sm text-text-muted mb-3">Choose the accent color used throughout the app.</p>
                  <div className="flex flex-wrap gap-3 items-center">
                    {['#00c882', '#2563eb', '#059669', '#dc2626', '#d97706', '#4f46e5', '#0891b2', '#be123c', '#4d7c0f', '#475569'].map(color => (
                      <button 
                        key={color} 
                        className={`w-6 h-6 rounded-full border ${accentColor === color ? 'border-text-normal ring-2 ring-offset-2 ring-offset-bg-primary ring-interactive-accent' : 'border-border-color'}`}
                        style={{ backgroundColor: color }} 
                        onClick={() => setAccentColor(color)}
                      />
                    ))}
                    <div className="h-6 border-l border-border-color mx-1"></div>
                    <input 
                      type="color" 
                      value={accentColor}
                      onChange={(e) => setAccentColor(e.target.value)}
                      className="w-8 h-8 rounded cursor-pointer bg-transparent border-0 p-0"
                      title="Custom color"
                    />
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'security' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-text-normal font-medium mb-1">Change Password</h3>
                  <p className="text-sm text-text-muted mb-4">Set a new password for your account.</p>
                  
                  <div className="space-y-4 max-w-sm">
                    <input
                      type="password"
                      placeholder="Current Password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      autoComplete="current-password"
                      className="w-full bg-bg-secondary border border-border-color rounded px-3 py-2 outline-none focus:border-interactive-accent transition-colors text-sm"
                    />
                    <input 
                      type="password" 
                      placeholder="New Password (min 8 characters)"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      autoComplete="new-password"
                      className="w-full bg-bg-secondary border border-border-color rounded px-3 py-2 outline-none focus:border-interactive-accent transition-colors text-sm"
                    />
                    {passwordChangeStatus && (
                      <div className={`text-sm px-3 py-2 rounded font-medium ${passwordChangeStatus.type === 'success' ? 'bg-green-500/20 text-green-500' : 'bg-red-500/20 text-red-500'}`}>
                        {passwordChangeStatus.type === 'success' ? '✓ ' : '× '}
                        {passwordChangeStatus.message}
                      </div>
                    )}
                    <button 
                      onClick={async () => {
                        setPasswordChangeStatus(null);
                        if (!currentPassword) {
                          setPasswordChangeStatus({ type: 'error', message: 'Please enter your current password' });
                          return;
                        }
                        if (newPassword.length < 8) {
                          setPasswordChangeStatus({ type: 'error', message: 'New password must be at least 8 characters' });
                          return;
                        }
                        
                        try {
                          const res = await apiFetch('/api/auth/change-password', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ currentPassword, newPassword })
                          });
                          const data = await res.json();
                          if (res.ok) {
                            // Server issues a fresh token after password change so current session stays valid.
                            if (data.token) {
                              localStorage.setItem('jays_notes_token', data.token);
                            }
                            setPasswordChangeStatus({ type: 'success', message: 'Password updated successfully!' });
                            setCurrentPassword('');
                            setNewPassword('');
                            setTimeout(() => setPasswordChangeStatus(null), 3000);
                          } else {
                            throw new Error(data.error || 'Failed to update password');
                          }
                        } catch (err: any) {
                          setPasswordChangeStatus({ type: 'error', message: err.message });
                        }
                      }}
                      className="bg-interactive-accent hover:bg-interactive-accent/90 text-white px-4 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50"
                      disabled={!currentPassword || newPassword.length < 8}
                    >
                      Update Password
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'admin_storage' && isAdmin && (
              <AdminFileExplorer />
            )}

            {activeTab === 'agent_space' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-text-normal font-medium mb-1">Agent Space Folder</h3>
                  <p className="text-sm text-text-muted mb-1">
                    The folder where project knowledge, meeting summaries, and project files are stored.
                  </p>
                  <p className="text-xs text-amber-500 mb-3">
                    ⚠ This folder must exist at the <strong>root level</strong> of your vault — not inside any subfolder.
                    Example: if your vault root is <code className="bg-bg-secondary px-1 rounded">/vault/username/</code>, create the folder directly inside it.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={agentSpaceFolder}
                      onChange={e => { setAgentSpaceFolder(e.target.value); setAgentFolderSaved(false); }}
                      placeholder="e.g. 2 - Agent Space"
                      className="flex-1 bg-bg-secondary border border-border-color rounded px-3 py-2 outline-none focus:border-interactive-accent transition-colors text-sm text-text-normal"
                    />
                    <button
                      onClick={() => {
                        const trimmed = agentSpaceFolder.trim();
                        if (!trimmed) return;
                        localStorage.setItem('jays_notes_agent_space_folder', trimmed);
                        setAgentFolderSaved(true);
                        setTimeout(() => setAgentFolderSaved(false), 2500);
                      }}
                      className="bg-interactive-accent hover:bg-interactive-accent/90 text-white px-4 py-2 rounded text-sm font-medium transition-colors"
                    >
                      Save
                    </button>
                  </div>
                  {agentFolderSaved && (
                    <p className="text-sm text-green-500 mt-2">✓ Saved — new summaries will use this folder.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

