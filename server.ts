import express, { Request } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import archiver from 'archiver';
import AdmZip from 'adm-zip';

// Extend Express Request type
interface AuthenticatedRequest extends Request {
  user?: {
    username: string;
    role: string;
  };
}

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const baseVaultPath = process.env.VAULT_PATH || path.join(process.cwd(), 'vault');
const JWT_SECRET = process.env.JWT_SECRET || 'jays-notes-super-secret-key';
const usersFile = path.join(baseVaultPath, '.users.json');

// Ensure base dir exists
if (!fs.existsSync(baseVaultPath)) {
  fs.mkdirSync(baseVaultPath, { recursive: true });
}

// Helper: Get user-specific paths and ensure they exist
const getUserScope = (username: string) => {
  const userVaultPath = path.join(baseVaultPath, username);
  const attachmentsPath = path.join(userVaultPath, 'attachments');
  const templatesPath = path.join(userVaultPath, 'Templates');

  if (!fs.existsSync(userVaultPath)) {
    fs.mkdirSync(userVaultPath, { recursive: true });
    // Seed new user with a welcome file
    fs.writeFileSync(
      path.join(userVaultPath, 'Welcome.md'),
      `# Welcome to your Vault, ${username}!\n\nThis is your private workspace. No other users can see your files.\n\nTry creating a link like [[Another Note]] or adding some #tags.`
    );
  }
  if (!fs.existsSync(attachmentsPath)) fs.mkdirSync(attachmentsPath, { recursive: true });
  if (!fs.existsSync(templatesPath)) {
    fs.mkdirSync(templatesPath, { recursive: true });
    fs.writeFileSync(
      path.join(templatesPath, 'Daily Note.md'),
      '# Daily Note: {{date}}\n\n## Tasks\n- [ ] \n\n## Notes\n'
    );
  }

  return {
    vaultPath: userVaultPath,
    attachmentsPath,
    templatesPath
  };
};

const getUsers = () => {
  if (!fs.existsSync(usersFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
  } catch (e) {
    return {};
  }
};

const saveUsers = (users: any) => {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
};

// Auth Middleware
const authenticateToken = (req: any, res: any, next: any) => {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;

  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  jwt.verify(token, JWT_SECRET, (err: any, tokenUser: any) => {
    if (err) return res.status(403).json({ error: 'Forbidden' });
    
    // Safety check: ensure user still exists in DB
    const users = getUsers();
    if (!users[tokenUser.username]) {
      return res.status(401).json({ error: 'User account no longer exists' });
    }
    
    req.user = { 
      username: tokenUser.username, 
      role: users[tokenUser.username].role || 'user'
    };
    next();
  });
};

const adminOnly = (req: any, res: any, next: any) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  next();
};

// --- Auth Routes ---

app.get('/api/auth/status', (req, res) => {
  const users = getUsers();
  const hasAdmin = Object.values(users).some((u: any) => u.role === 'admin');
  res.json({ needsBootstrap: !hasAdmin });
});

app.post('/api/auth/bootstrap', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const users = getUsers();
  const hasAdmin = Object.values(users).some((u: any) => u.role === 'admin');
  if (hasAdmin) return res.status(403).json({ error: 'System already bootstrapped' });

  const hashedPassword = await bcrypt.hash(password, 10);
  users[username] = { 
    password: hashedPassword, 
    role: 'admin', 
    email: email || '',
    createdAt: new Date().toISOString() 
  };
  saveUsers(users);

  const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, role: 'admin', username });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const users = getUsers();
  const user = users[username];

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, role: user.role, username });
});

app.post('/api/auth/change-password', authenticateToken, async (req: any, res) => {
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ error: 'New password required' });

  const users = getUsers();
  users[req.user.username].password = await bcrypt.hash(newPassword, 10);
  saveUsers(users);
  res.json({ success: true });
});

// --- Admin Routes ---

app.get('/api/admin/users', authenticateToken, adminOnly, (req: any, res) => {
  const users = getUsers();
  const userList = Object.entries(users).map(([username, data]: [string, any]) => ({
    username,
    role: data.role,
    email: data.email || '',
    createdAt: data.createdAt
  }));
  res.json(userList);
});

app.get('/api/admin/storage/list', authenticateToken, adminOnly, (req, res) => {
  function scanDir(dir: string, relativePath = '') {
    const nodes: any[] = [];
    if (!fs.existsSync(dir)) return [];
    
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const relPath = path.join(relativePath, file);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        nodes.push({
          name: file,
          path: relPath,
          type: 'folder',
          children: scanDir(fullPath, relPath),
          createdAt: stat.birthtimeMs,
          updatedAt: stat.mtimeMs,
          size: 0
        });
      } else {
        nodes.push({
          name: file,
          path: relPath,
          type: 'file',
          createdAt: stat.birthtimeMs,
          updatedAt: stat.mtimeMs,
          size: stat.size
        });
      }
    }
    return nodes;
  }

  try {
    res.json(scanDir(baseVaultPath));
  } catch (error) {
    res.status(500).json({ error: 'Failed to read storage' });
  }
});

app.get('/api/admin/storage/file', authenticateToken, adminOnly, (req, res) => {
  const relPath = req.query.path as string;
  if (!relPath) return res.status(400).json({ error: 'Path required' });
  const fullPath = path.join(baseVaultPath, relPath);
  if (!fullPath.startsWith(baseVaultPath)) return res.status(403).json({ error: 'Access denied' });

  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' });

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    // If it's a directory, ZIP it and stream it
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.attachment(`${path.basename(fullPath)}.zip`);
    archive.pipe(res);
    archive.directory(fullPath, false);
    archive.finalize();
  } else {
    res.sendFile(fullPath);
  }
});

app.post('/api/admin/storage/download-bulk', authenticateToken, adminOnly, (req, res) => {
  const { paths: relPaths } = req.body;
  if (!relPaths || !Array.isArray(relPaths) || relPaths.length === 0) {
    return res.status(400).json({ error: 'Paths must be a non-empty array' });
  }

  const archive = archiver('zip', { zlib: { level: 9 } });
  res.attachment('bulk-download.zip');
  archive.pipe(res);

  for (const relPath of relPaths) {
    const fullPath = path.join(baseVaultPath, relPath);
    if (!fullPath.startsWith(baseVaultPath)) continue;
    if (!fs.existsSync(fullPath)) continue;

    const stat = fs.statSync(fullPath);
    const baseName = path.basename(fullPath);

    if (stat.isDirectory()) {
      archive.directory(fullPath, baseName);
    } else {
      archive.file(fullPath, { name: baseName });
    }
  }

  archive.finalize();
});

app.post('/api/admin/storage/zip', authenticateToken, adminOnly, (req, res) => {
  const { paths: relPaths, targetName } = req.body;
  if (!relPaths || !Array.isArray(relPaths) || relPaths.length === 0) {
    return res.status(400).json({ error: 'Paths must be a non-empty array' });
  }

  const zipName = targetName || `archive_${Date.now()}.zip`;
  // Ensure we are in the directory of the first item or root
  const firstItemDir = path.dirname(path.join(baseVaultPath, relPaths[0]));
  const zipPath = path.join(firstItemDir, zipName.endsWith('.zip') ? zipName : `${zipName}.zip`);

  if (!zipPath.startsWith(baseVaultPath)) return res.status(403).json({ error: 'Access denied' });

  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  output.on('close', () => res.json({ success: true, path: path.relative(baseVaultPath, zipPath) }));
  archive.on('error', (err) => res.status(500).json({ error: err.message }));

  archive.pipe(output);

  for (const relPath of relPaths) {
    const fullPath = path.join(baseVaultPath, relPath);
    if (!fullPath.startsWith(baseVaultPath)) continue;
    if (!fs.existsSync(fullPath)) continue;

    const stat = fs.statSync(fullPath);
    const baseName = path.basename(fullPath);

    if (stat.isDirectory()) {
      archive.directory(fullPath, baseName);
    } else {
      archive.file(fullPath, { name: baseName });
    }
  }

  archive.finalize();
});

app.post('/api/admin/storage/bulk-delete', authenticateToken, adminOnly, (req, res) => {
  const { paths: relPaths } = req.body;
  if (!relPaths || !Array.isArray(relPaths)) return res.status(400).json({ error: 'Paths must be an array' });

  const results = { deleted: [] as string[], errors: [] as any[] };

  for (const relPath of relPaths) {
    const fullPath = path.join(baseVaultPath, relPath);
    // Secure path check
    const normalizedBase = path.resolve(baseVaultPath);
    const normalizedPath = path.resolve(fullPath);
    if (!normalizedPath.startsWith(normalizedBase)) {
      results.errors.push({ path: relPath, error: 'Access denied' });
      continue;
    }

    try {
      if (fs.existsSync(fullPath)) {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
        results.deleted.push(relPath);
      } else {
        results.errors.push({ path: relPath, error: 'File not found on disk' });
      }
    } catch (e: any) {
      console.error(`[Admin Storage] Failed to delete ${fullPath}:`, e);
      results.errors.push({ path: relPath, error: e.message });
    }
  }

  res.status(results.errors.length > 0 ? 207 : 200).json(results);
});

app.post('/api/admin/storage/unzip', authenticateToken, adminOnly, (req, res) => {
  const { path: relPath, destination: destRelPath } = req.body;
  const fullPath = path.join(baseVaultPath, relPath);
  const destPath = destRelPath ? path.join(baseVaultPath, destRelPath) : path.dirname(fullPath);

  if (!fullPath.startsWith(baseVaultPath) || !destPath.startsWith(baseVaultPath)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Archive not found' });

  try {
    const zip = new AdmZip(fullPath);
    zip.extractAllTo(destPath, true);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to extract' });
  }
});

app.post('/api/admin/storage/file', authenticateToken, adminOnly, (req, res) => {
  const { path: relPath, content } = req.body;
  const fullPath = path.join(baseVaultPath, relPath);
  if (!fullPath.startsWith(baseVaultPath)) return res.status(403).json({ error: 'Access denied' });

  try {
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save file' });
  }
});

app.post('/api/admin/storage/new', authenticateToken, adminOnly, (req, res) => {
  const { path: relPath, type } = req.body;
  const fullPath = path.join(baseVaultPath, relPath);
  if (!fullPath.startsWith(baseVaultPath)) return res.status(403).json({ error: 'Access denied' });

  try {
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (type === 'folder') {
      fs.mkdirSync(fullPath, { recursive: true });
    } else {
      fs.writeFileSync(fullPath, '');
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create' });
  }
});

app.post('/api/admin/storage/move', authenticateToken, adminOnly, (req, res) => {
  const { source, destination } = req.body;
  const oldPath = path.join(baseVaultPath, source);
  const newPath = path.join(baseVaultPath, destination);

  if (!oldPath.startsWith(baseVaultPath) || !newPath.startsWith(baseVaultPath)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const destDir = path.dirname(newPath);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.renameSync(oldPath, newPath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to move' });
  }
});

app.delete('/api/admin/storage/file', authenticateToken, adminOnly, (req, res) => {
  const relPath = req.query.path as string;
  if (!relPath) return res.status(400).json({ error: 'Path required' });
  const fullPath = path.join(baseVaultPath, relPath);
  const normalizedBase = path.resolve(baseVaultPath);
  const normalizedPath = path.resolve(fullPath);

  if (!normalizedPath.startsWith(normalizedBase)) return res.status(403).json({ error: 'Access denied' });

  try {
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// Bulk delete endpoint at line 430 is already handled above (removed duplicate here)

app.post('/api/admin/storage/copy', authenticateToken, adminOnly, (req, res) => {
  const { source, destination } = req.body;
  const srcPath = path.resolve(baseVaultPath, source);
  const destPath = path.resolve(baseVaultPath, destination);

  if (!srcPath.startsWith(path.resolve(baseVaultPath)) || !destPath.startsWith(path.resolve(baseVaultPath))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'Source not found' });
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      fs.cpSync(srcPath, destPath, { recursive: true });
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to copy' });
  }
});

const adminUpload = multer({ 
  storage: multer.diskStorage({
    destination: (req: any, file, cb) => {
      const targetDir = req.query.path ? path.join(baseVaultPath, req.query.path) : baseVaultPath;
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      cb(null, targetDir);
    },
    filename: (req, file, cb) => {
      cb(null, file.originalname);
    }
  })
});

app.post('/api/admin/storage/upload', authenticateToken, adminOnly, adminUpload.single('file'), (req, res) => {
  res.json({ success: true });
});

app.post('/api/admin/users', authenticateToken, adminOnly, async (req, res) => {
  const { username, password, role, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const users = getUsers();
  if (users[username]) return res.status(400).json({ error: 'User already exists' });

  users[username] = {
    password: await bcrypt.hash(password, 10),
    role: role || 'user',
    email: email || '',
    createdAt: new Date().toISOString()
  };
  saveUsers(users);
  
  // Pre-initialize folder
  getUserScope(username);
  
  res.json({ success: true });
});

app.post('/api/admin/users/update', authenticateToken, adminOnly, async (req, res) => {
  const { username, role, email } = req.body;
  const users = getUsers();
  if (!users[username]) return res.status(404).json({ error: 'User not found' });

  if (role) users[username].role = role;
  if (email !== undefined) users[username].email = email;
  saveUsers(users);
  res.json({ success: true });
});

app.post('/api/admin/users/reset', authenticateToken, adminOnly, async (req, res) => {
  const { username, newPassword } = req.body;
  const users = getUsers();
  if (!users[username]) return res.status(404).json({ error: 'User not found' });

  users[username].password = await bcrypt.hash(newPassword, 10);
  saveUsers(users);
  res.json({ success: true });
});

app.delete('/api/admin/users/:username', authenticateToken, adminOnly, (req: any, res) => {
  const { username } = req.params;
  if (username === req.user.username) return res.status(400).json({ error: 'Cannot delete yourself' });

  const users = getUsers();
  if (!users[username]) return res.status(404).json({ error: 'User not found' });

  delete users[username];
  saveUsers(users);
  
  // Archive folder
  const userDir = path.join(baseVaultPath, username);
  const archiveDir = path.join(baseVaultPath, `.archive_${username}_${Date.now()}`);
  if (fs.existsSync(userDir)) {
    fs.renameSync(userDir, archiveDir);
  }

  res.json({ success: true });
});

// --- Scoped File Operations ---

app.get('/api/files', authenticateToken, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  
  function scanDir(dir: string, relativePath = '') {
    const nodes: any[] = [];
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith('.')) continue;
      const fullPath = path.join(dir, file);
      const relPath = path.join(relativePath, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        nodes.push({
          name: file,
          path: relPath,
          type: 'folder',
          children: scanDir(fullPath, relPath),
          createdAt: stat.birthtimeMs,
          updatedAt: stat.mtimeMs
        });
      } else if (file.endsWith('.md') || file.endsWith('.canvas')) {
        nodes.push({
          name: file.replace(/\.(md|canvas)$/, ''),
          path: relPath,
          type: file.endsWith('.canvas') ? 'canvas' : 'file',
          createdAt: stat.birthtimeMs,
          updatedAt: stat.mtimeMs
        });
      }
    }
    return nodes;
  }

  try {
    res.json(scanDir(vaultPath));
  } catch (error) {
    res.status(500).json({ error: 'Failed to read vault' });
  }
});

app.get('/api/file', authenticateToken, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const relPath = req.query.path as string;
  if (!relPath) return res.status(400).json({ error: 'Path required' });

  const filePath = path.join(vaultPath, relPath);
  if (!filePath.startsWith(vaultPath)) return res.status(403).json({ error: 'Access denied' });

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

app.post('/api/file', authenticateToken, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const { path: relPath, content } = req.body;
  const filePath = path.join(vaultPath, relPath);
  
  if (!filePath.startsWith(vaultPath)) return res.status(403).json({ error: 'Access denied' });

  try {
    fs.writeFileSync(filePath, content);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save file' });
  }
});

app.post('/api/file/new', authenticateToken, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const { path: relPath, type } = req.body;
  const filePath = path.join(vaultPath, relPath);

  if (!filePath.startsWith(vaultPath)) return res.status(403).json({ error: 'Access denied' });

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (type === 'folder') {
    fs.mkdirSync(filePath, { recursive: true });
  } else if (type === 'canvas') {
    fs.writeFileSync(filePath, JSON.stringify({ nodes: [], edges: [] }, null, 2));
  } else {
    fs.writeFileSync(filePath, '# New Note');
  }
  res.json({ success: true });
});

app.post('/api/file/move', authenticateToken, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const { source, destination } = req.body;
  const oldFullPath = path.join(vaultPath, source);
  const newFullPath = path.join(vaultPath, destination);

  if (!oldFullPath.startsWith(vaultPath) || !newFullPath.startsWith(vaultPath)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    fs.renameSync(oldFullPath, newFullPath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to move/rename' });
  }
});

app.delete('/api/file', authenticateToken, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const relPath = req.query.path as string;
  const filePath = path.join(vaultPath, relPath);

  if (!filePath.startsWith(vaultPath)) return res.status(403).json({ error: 'Access denied' });

  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
    }
    res.json({ success: true });
  } catch (error: any) {
    console.error(`[User File] Failed to delete ${filePath}:`, error);
    res.status(500).json({ error: 'Failed to delete' });
  }
});

app.post('/api/file/duplicate', authenticateToken, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const { path: relPath } = req.body;
  const oldFullPath = path.join(vaultPath, relPath);
  
  if (!oldFullPath.startsWith(vaultPath)) return res.status(403).json({ error: 'Access denied' });

  const ext = path.extname(relPath);
  const base = relPath.slice(0, -ext.length);
  let newRelPath = `${base} (copy)${ext}`;
  let counter = 1;
  while (fs.existsSync(path.join(vaultPath, newRelPath))) {
    newRelPath = `${base} (copy ${counter})${ext}`;
    counter++;
  }
  const newFullPath = path.join(vaultPath, newRelPath);

  try {
    fs.copyFileSync(oldFullPath, newFullPath);
    res.json({ success: true });
  } catch (error: any) {
    console.error(`[User File] Failed to duplicate ${oldFullPath} to ${newFullPath}:`, error);
    res.status(500).json({ error: 'Failed to duplicate' });
  }
});

app.get('/api/links', authenticateToken, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const targetPath = req.query.path as string;
  if (!targetPath) return res.status(400).json({ error: 'Path required' });

  try {
    const flatFiles: any[] = [];
    function scanDir(dir: string, relativePath = '') {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.startsWith('.')) continue;
        const fullPath = path.join(dir, file);
        const relPath = path.join(relativePath, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          scanDir(fullPath, relPath);
        } else if (file.endsWith('.md')) {
          flatFiles.push({ path: relPath, name: file.replace('.md', '') });
        }
      }
    }
    scanDir(vaultPath);

    const backlinks: string[] = [];
    let forwardlinks: string[] = [];

    const targetFullPath = path.join(vaultPath, targetPath);
    if (fs.existsSync(targetFullPath)) {
      const content = fs.readFileSync(targetFullPath, 'utf-8');
      const matches = content.match(/\[\[(.*?)\]\]/g);
      if (matches) {
        forwardlinks = matches.map(m => m.slice(2, -2).split('|')[0]);
      }
    }

    const targetName = path.basename(targetPath, '.md');
    for (const file of flatFiles) {
      if (file.path === targetPath) continue;
      const fullPath = path.join(vaultPath, file.path);
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (content.includes(`[[${targetName}]]`) || content.includes(`[[${targetName}|`)) {
        backlinks.push(file.path);
      }
    }

    res.json({ backlinks, forwardlinks });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get links' });
  }
});

// Multipart Upload (Dynamic)
const upload = multer({ 
  storage: multer.diskStorage({
    destination: (req: any, file, cb) => {
      const { attachmentsPath } = getUserScope(req.user.username);
      if (!fs.existsSync(attachmentsPath)) {
        fs.mkdirSync(attachmentsPath, { recursive: true });
      }
      cb(null, attachmentsPath);
    },
    filename: (req, file, cb) => {
      cb(null, file.originalname);
    }
  })
});

app.post('/api/upload', authenticateToken, (req: any, res: any, next: any) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('[Upload Error]', err);
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}, (req: any, res: any) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ path: `attachments/${req.file.originalname}` });
});

app.get('/api/attachments/:filename', authenticateToken, (req: any, res) => {
  const { attachmentsPath } = getUserScope(req.user.username);
  const filePath = path.join(attachmentsPath, req.params.filename);
  
  if (!filePath.startsWith(attachmentsPath)) return res.status(403).json({ error: 'Access denied' });

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Attachment not found' });
  }
});

app.get('/api/proxy/iframe', authenticateToken, async (req: any, res: any) => {
  const targetUrl = req.query.url as string;
  if (!targetUrl) return res.status(400).send('No URL provided');
  
  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    const contentType = response.headers.get('content-type') || 'text/html';
    
    // For non-HTML, just redirect or pipe
    if (!contentType.includes('text/html')) {
      return res.redirect(targetUrl);
    }

    let body = await response.text();
    
    // Inject a base tag so relative links and assets load correctly
    const parsedUrl = new URL(targetUrl);
    const baseHref = `${parsedUrl.protocol}//${parsedUrl.host}`;
    
    if (body.match(/<head[^>]*>/i)) {
      body = body.replace(/(<head[^>]*>)/i, `$1\n<base href="${baseHref}/">`);
    } else {
      body = `<head><base href="${baseHref}/"></head>` + body;
    }

    res.set('Content-Type', contentType);
    res.send(body);
  } catch (error) {
    res.status(500).send(`
      <html>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f9fafb; color: #6b7280; text-align: center;">
          <div>
            <svg style="width: 48px; height: 48px; margin: 0 auto 16px; opacity: 0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <h2 style="margin: 0 0 8px; font-size: 1.125rem; font-weight: 600; color: #374151;">Failed to load preview</h2>
            <p style="margin: 0; font-size: 0.875rem;">The website refused to connect or is invalid.</p>
            <a href="${targetUrl}" target="_blank" style="display: inline-block; margin-top: 16px; padding: 8px 16px; background: #3b82f6; color: white; border-radius: 6px; text-decoration: none; font-size: 0.875rem; font-weight: 500;">Open in new tab</a>
          </div>
        </body>
      </html>
    `);
  }
});

app.get('/api/graph', authenticateToken, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const filterFolder = req.query.folder as string || '';
  
  try {
    const nodes: any[] = [];
    const links: any[] = [];
    const nodeSet = new Set<string>();
    const fileNameToPath = new Map<string, string>();
    
    function indexFiles(dir: string, relativePath = '') {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.startsWith('.')) continue;
        const fullPath = path.join(dir, file);
        const relPath = path.join(relativePath, file);
        if (fs.statSync(fullPath).isDirectory()) {
          indexFiles(fullPath, relPath);
        } else if (file.endsWith('.md')) {
          fileNameToPath.set(file.replace('.md', ''), relPath);
        }
      }
    }

    function scanDir(dir: string, relativePath = '') {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.startsWith('.')) continue;
        const fullPath = path.join(dir, file);
        const relPath = path.join(relativePath, file);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          scanDir(fullPath, relPath);
        } else if (file.endsWith('.md')) {
          if (filterFolder && !relPath.startsWith(filterFolder)) continue;

          const id = relPath;
          const name = file.replace(/\.(md|canvas)$/, '');
          
          if (!nodeSet.has(id)) {
            nodes.push({ id, name });
            nodeSet.add(id);
          }
          
          const content = fs.readFileSync(fullPath, 'utf-8');
          const wikiLinkRegex = /\[\[(.*?)\]\]/g;
          let match;
          while ((match = wikiLinkRegex.exec(content)) !== null) {
            let targetName = match[1].split('|')[0].split('#')[0];
            const targetRelPath = fileNameToPath.get(targetName);
            if (targetRelPath) {
              if (!filterFolder || targetRelPath.startsWith(filterFolder)) {
                links.push({ source: id, target: targetRelPath });
                if (!nodeSet.has(targetRelPath)) {
                  nodes.push({ id: targetRelPath, name: targetName });
                  nodeSet.add(targetRelPath);
                }
              }
            }
          }
        }
      }
    }
    
    indexFiles(vaultPath);
    scanDir(vaultPath);
    res.json({ nodes, links });
  } catch (error) {
    res.status(500).json({ error: 'Graph failed' });
  }
});

app.get('/api/search', authenticateToken, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const query = (req.query.q as string || '').toLowerCase();
  
  const results: any[] = [];
  const recentFiles: any[] = [];

  function scanDir(dir: string, relativePath = '') {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith('.')) continue;
      const fullPath = path.join(dir, file);
      const relPath = path.join(relativePath, file);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        scanDir(fullPath, relPath);
      } else if (file.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        recentFiles.push({ path: relPath, mtime: stat.mtimeMs });
        if (!query) continue;

        if (file.toLowerCase().includes(query) || content.toLowerCase().includes(query)) {
          results.push({ path: relPath, content: file });
        }
      }
    }
  }
  
  scanDir(vaultPath);
  if (!query) {
    recentFiles.sort((a, b) => b.mtime - a.mtime);
    res.json(recentFiles.slice(0, 10).map(f => ({ path: f.path, content: 'Recent' })));
  } else {
    res.json(results);
  }
});

app.get('/api/tags', authenticateToken, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const tagMap = new Map<string, { count: number, files: Set<string> }>();

  function scanDir(dir: string, relativePath = '') {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith('.')) continue;
      const fullPath = path.join(dir, file);
      const relPath = path.join(relativePath, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        scanDir(fullPath, relPath);
      } else if (file.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const tagRegex = /(?:^|\s)#([a-zA-Z0-9_-]+)/g;
        let match;
        while ((match = tagRegex.exec(content)) !== null) {
          const tag = match[1].toLowerCase();
          if (!tagMap.has(tag)) tagMap.set(tag, { count: 0, files: new Set() });
          const tagData = tagMap.get(tag)!;
          tagData.count++;
          tagData.files.add(relPath);
        }
      }
    }
  }
  
  scanDir(vaultPath);
  res.json(Array.from(tagMap.entries()).map(([tag, data]) => ({
    tag,
    count: data.count,
    files: Array.from(data.files)
  })));
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Global Error Handler to intercept errors and prevent HTML leak
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('[Global Error]', err);
    if (res.headersSent) {
      return next(err);
    }
    res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
