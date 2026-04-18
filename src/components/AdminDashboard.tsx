import React, { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api';
import { UserPlus, Shield, Key, Trash2, X, Check, Edit3 } from 'lucide-react';

export const AdminDashboard: React.FC = () => {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isAddingUser, setIsAddingUser] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'user', email: '' });
  const [editingUser, setEditingUser] = useState<any | null>(null);
  const [resettingUser, setResettingUser] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetStatus, setResetStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      const res = await apiFetch('/api/admin/users');
      if (!res.ok) throw new Error('Failed to fetch users');
      const data = await res.json();
      setUsers(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newUser.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newUser.email)) {
      alert('Invalid email format');
      return;
    }
    try {
      const res = await apiFetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newUser)
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create user');
      }
      setIsAddingUser(false);
      setNewUser({ username: '', password: '', role: 'user', email: '' });
      fetchUsers();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingUser.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editingUser.email)) {
      alert('Invalid email format');
      return;
    }
    try {
      const res = await apiFetch('/api/admin/users/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: editingUser.username,
          role: editingUser.role,
          email: editingUser.email
        })
      });
      if (!res.ok) throw new Error('Failed to update user');
      setEditingUser(null);
      fetchUsers();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleResetPassword = async (username: string) => {
    setResetStatus(null);
    if (!newPassword) return;
    try {
      const res = await apiFetch('/api/admin/users/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, newPassword })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to reset password');
      }
      setResetStatus({ type: 'success', message: 'Password reset successfully!' });
      setNewPassword('');
      setTimeout(() => {
        setResettingUser(null);
        setResetStatus(null);
      }, 2000);
    } catch (err: any) {
      setResetStatus({ type: 'error', message: err.message });
    }
  };

  const handleDeleteUser = async (username: string) => {
    if (!confirm(`Are you sure you want to delete user "${username}"? Their data will be archived.`)) return;
    try {
      const res = await apiFetch(`/api/admin/users/${username}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete user');
      fetchUsers();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) return <div className="p-8 text-center text-text-muted">Loading user management...</div>;

  return (
    <div className="h-full flex flex-col bg-bg-primary p-8 overflow-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold mb-1">User Management</h1>
          <p className="text-text-muted text-sm">Create and manage accounts and storage isolation.</p>
        </div>
        <button
          onClick={() => setIsAddingUser(true)}
          className="flex items-center gap-2 bg-interactive-accent hover:bg-interactive-accent/90 text-white px-4 py-2 rounded-lg transition-colors"
        >
          <UserPlus size={18} />
          <span>New User</span>
        </button>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-error/10 border border-error/20 text-error rounded-lg">
          {error}
        </div>
      )}

      <div className="bg-bg-secondary border border-border-color rounded-xl overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-bg-primary/50 text-text-muted text-xs uppercase tracking-wider">
              <th className="px-6 py-4 font-semibold border-b border-border-color">Username</th>
              <th className="px-6 py-4 font-semibold border-b border-border-color">Email</th>
              <th className="px-6 py-4 font-semibold border-b border-border-color">Role</th>
              <th className="px-6 py-4 font-semibold border-b border-border-color">Created At</th>
              <th className="px-6 py-4 font-semibold border-b border-border-color text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-color">
            {users.map((user) => (
              <tr key={user.username} className="hover:bg-bg-primary/30 transition-colors">
                <td className="px-6 py-4 font-medium">{user.username}</td>
                <td className="px-6 py-4 text-sm text-text-muted">{user.email || <span className="italic opacity-30">No email</span>}</td>
                <td className="px-6 py-4">
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                    user.role === 'admin' ? 'bg-interactive-accent/10 text-interactive-accent' : 'bg-text-muted/10 text-text-muted'
                  }`}>
                    {user.role === 'admin' && <Shield size={12} />}
                    {user.role === 'admin' ? 'Administrator' : 'Regular User'}
                  </span>
                </td>
                <td className="px-6 py-4 text-sm text-text-muted">
                  {new Date(user.createdAt).toLocaleDateString()}
                </td>
                <td className="px-6 py-4 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setEditingUser(user)}
                      title="Edit User"
                      className="p-2 hover:bg-bg-primary rounded text-text-muted hover:text-interactive-accent transition-colors"
                    >
                      <Edit3 size={16} />
                    </button>
                    <button
                      onClick={() => setResettingUser(user.username)}
                      title="Reset Password"
                      className="p-2 hover:bg-bg-primary rounded text-text-muted hover:text-interactive-accent transition-colors"
                    >
                      <Key size={16} />
                    </button>
                    <button
                      onClick={() => handleDeleteUser(user.username)}
                      title="Delete User"
                      className="p-2 hover:bg-error/10 rounded text-text-muted hover:text-error transition-colors"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Edit User Modal */}
      {editingUser && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-bg-secondary border border-border-color rounded-xl shadow-2xl w-full max-w-md p-6">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold">Edit User: {editingUser.username}</h2>
              <button onClick={() => setEditingUser(null)} className="text-text-muted hover:text-text-normal">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleUpdateUser} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Email Address</label>
                <input
                  type="email"
                  value={editingUser.email}
                  onChange={(e) => setEditingUser({...editingUser, email: e.target.value})}
                  className="w-full bg-bg-primary border border-border-color rounded px-3 py-2 outline-none focus:border-interactive-accent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Role</label>
                <select
                  value={editingUser.role}
                  onChange={(e) => setEditingUser({...editingUser, role: e.target.value})}
                  className="w-full bg-bg-primary border border-border-color rounded px-3 py-2 outline-none focus:border-interactive-accent"
                >
                  <option value="user">Regular User</option>
                  <option value="admin">Administrator</option>
                </select>
              </div>
              <button
                type="submit"
                className="w-full bg-interactive-accent hover:bg-interactive-accent/90 text-white font-medium py-2 rounded transition-colors"
              >
                Save Changes
              </button>
            </form>
          </div>
        </div>
      )}
      {isAddingUser && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-bg-secondary border border-border-color rounded-xl shadow-2xl w-full max-w-md p-6">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold">Create New User</h2>
              <button onClick={() => setIsAddingUser(false)} className="text-text-muted hover:text-text-normal">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleCreateUser} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Username</label>
                <input
                  type="text"
                  value={newUser.username}
                  onChange={(e) => setNewUser({...newUser, username: e.target.value})}
                  className="w-full bg-bg-primary border border-border-color rounded px-3 py-2 outline-none focus:border-interactive-accent"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Email Address (Optional)</label>
                <input
                  type="email"
                  value={newUser.email}
                  onChange={(e) => setNewUser({...newUser, email: e.target.value})}
                  className="w-full bg-bg-primary border border-border-color rounded px-3 py-2 outline-none focus:border-interactive-accent"
                  placeholder="user@example.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Initial Password</label>
                <input
                  type="password"
                  value={newUser.password}
                  onChange={(e) => setNewUser({...newUser, password: e.target.value})}
                  className="w-full bg-bg-primary border border-border-color rounded px-3 py-2 outline-none focus:border-interactive-accent"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Role</label>
                <select
                  value={newUser.role}
                  onChange={(e) => setNewUser({...newUser, role: e.target.value})}
                  className="w-full bg-bg-primary border border-border-color rounded px-3 py-2 outline-none focus:border-interactive-accent"
                >
                  <option value="user">Regular User</option>
                  <option value="admin">Administrator</option>
                </select>
              </div>
              <button
                type="submit"
                className="w-full bg-interactive-accent hover:bg-interactive-accent/90 text-white font-medium py-2 rounded transition-colors"
              >
                Create User
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {resettingUser && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-bg-secondary border border-border-color rounded-xl shadow-2xl w-full max-w-md p-6">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold">Reset Password: {resettingUser}</h2>
              <button onClick={() => { setResettingUser(null); setResetStatus(null); setNewPassword(''); }} className="text-text-muted hover:text-text-normal">
                <X size={20} />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">New Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full bg-bg-primary border border-border-color rounded px-3 py-2 outline-none focus:border-interactive-accent"
                  placeholder="Enter new secure password"
                  autoFocus
                />
              </div>
              {resetStatus && (
                <div className={`text-sm px-3 py-2 rounded font-medium ${resetStatus.type === 'success' ? 'bg-green-500/20 text-green-500' : 'bg-red-500/20 text-red-500'}`}>
                  {resetStatus.type === 'success' ? '✓ ' : '× '}
                  {resetStatus.message}
                </div>
              )}
              <button
                onClick={() => handleResetPassword(resettingUser)}
                className="w-full bg-interactive-accent hover:bg-interactive-accent/90 text-white font-medium py-2 rounded transition-colors disabled:opacity-50"
                disabled={!newPassword.trim() || resetStatus?.type === 'success'}
              >
                Reset Password
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
