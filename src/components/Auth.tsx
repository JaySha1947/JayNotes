import React, { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api';

interface AuthProps {
  onLogin: (token: string, role: string, username: string) => void;
}

export const Auth: React.FC<AuthProps> = ({ onLogin }) => {
  const [mode, setMode] = useState<'login' | 'bootstrap'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(true);

  useEffect(() => {
    checkStatus();
  }, []);

  const checkStatus = async () => {
    try {
      const res = await apiFetch('/api/auth/status');
      const data = await res.json();
      if (data.needsBootstrap) {
        setMode('bootstrap');
      }
    } catch (err) {
      console.error('Failed to check auth status', err);
    } finally {
      setCheckingStatus(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const endpoint = mode === 'bootstrap' ? '/api/auth/bootstrap' : '/api/auth/login';
      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Authentication failed');
      }

      localStorage.setItem('jays_notes_token', data.token);
      localStorage.setItem('jays_notes_role', data.role);
      localStorage.setItem('jays_notes_username', data.username);
      onLogin(data.token, data.role, data.username);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (checkingStatus) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-primary">
        <div className="text-interactive-accent animate-pulse">Initializing Vault...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary text-text-normal p-4">
      <div className="w-full max-w-md bg-bg-secondary border border-border-color rounded-xl shadow-2xl p-8">
        <div className="text-center mb-8">
          <img src="https://raw.githubusercontent.com/JaySha1947/JayNotes-20260218/refs/heads/main/logo.png" alt="Jay's Apex" className="h-40 mx-auto object-contain" referrerPolicy="no-referrer" />
          <p className="text-text-muted mt-2">
            {mode === 'login' ? 'Sign in to your private vault' : 'Initial Setup: Create Admin Account'}
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-error/10 border border-error/20 text-error rounded text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-bg-primary border border-border-color rounded px-3 py-2 outline-none focus:border-interactive-accent transition-colors"
              required
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-bg-primary border border-border-color rounded px-3 py-2 outline-none focus:border-interactive-accent transition-colors"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-interactive-accent hover:bg-interactive-accent/90 text-white font-medium py-2 px-4 rounded transition-colors disabled:opacity-50"
          >
            {loading ? 'Processing...' : mode === 'login' ? 'Sign In' : 'Setup Admin account'}
          </button>
        </form>

        {mode === 'bootstrap' && (
          <div className="mt-6 p-4 bg-interactive-accent/5 border border-interactive-accent/20 rounded-lg">
            <p className="text-xs text-text-muted leading-relaxed">
              <span className="font-bold text-text-normal">Note:</span> This is a one-time setup. The first account created will have full administrative privileges to manage other users and system folders.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
