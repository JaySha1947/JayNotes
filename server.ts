import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import archiver from 'archiver';
import AdmZip from 'adm-zip';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { promises as dnsPromises } from 'dns';
import net from 'net';
import crypto from 'crypto';

// =============================================================================
// Configuration & Startup Checks
// =============================================================================

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const baseVaultPath = path.resolve(
  process.env.VAULT_PATH || path.join(process.cwd(), 'vault')
);

// FIX: No fallback secret — fail loudly in ALL environments, not just production.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('\nFATAL: JWT_SECRET environment variable is required and must be at least 32 characters long.');
  console.error('Generate one with:\n  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n');
  process.exit(1);
}

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';
const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE) || 50 * 1024 * 1024; // 50 MB
const BCRYPT_ROUNDS = 12;
const ENABLE_IFRAME_PROXY = process.env.ENABLE_IFRAME_PROXY !== 'false';
const IS_DEV = process.env.NODE_ENV !== 'production';

// Allowed MIME types for user uploads
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'image/avif', 'image/heic', 'image/heif',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/csv',
  'application/zip', 'application/x-zip-compressed',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4',
  'video/mp4', 'video/webm', 'video/ogg',
]);

const usersFile = path.join(baseVaultPath, '.users.json');

if (!fs.existsSync(baseVaultPath)) {
  fs.mkdirSync(baseVaultPath, { recursive: true });
}

console.log(`[startup] Vault path:     ${baseVaultPath}`);
console.log(`[startup] Allowed origin: ${ALLOWED_ORIGIN}`);
console.log(`[startup] Port:           ${PORT}`);

// =============================================================================
// Security Helpers
// =============================================================================

/**
 * Safely resolve a user-supplied relative path against a root directory.
 * Returns null if the result would escape the root (path-traversal guard).
 */
function safeJoin(root: string, rel: string): string | null {
  if (typeof rel !== 'string') return null;
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, rel);
  if (resolved === rootResolved) return resolved;
  if (!resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}

/** Usernames must be 3-32 chars of alphanumerics, underscore, or dash. */
function validateUsername(name: any): name is string {
  return typeof name === 'string' && /^[a-zA-Z0-9_-]{3,32}$/.test(name);
}

/** Minimum 8 chars, maximum 256. */
function validatePassword(pw: any): pw is string {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 256;
}

/**
 * Sanitize a filename from an upload. Strips any path components and
 * replaces risky characters.
 */
function sanitizeFilename(name: string): string {
  const basename = path.basename(String(name));
  const cleaned = basename
    .replace(/[^\w\-. ]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 240);
  return cleaned || 'unnamed';
}

/** Identify private/loopback/link-local addresses to prevent SSRF. */
function isPrivateAddress(ip: string): boolean {
  if (!net.isIP(ip)) return true;
  if (ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '::1' || ip === '::') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true; // link-local incl. cloud metadata
  const m = ip.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  const low = ip.toLowerCase();
  if (low.startsWith('fc') || low.startsWith('fd')) return true;
  if (low.startsWith('fe80:')) return true;
  return false;
}

/** Validate a URL before fetching it on behalf of a user (SSRF guard). */
async function validateSafeFetchUrl(rawUrl: string): Promise<URL | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  try {
    const { address } = await dnsPromises.lookup(parsed.hostname);
    if (isPrivateAddress(address)) return null;
  } catch {
    return null;
  }
  return parsed;
}

/** Write JSON atomically: write to a temp file, then rename. */
function atomicWriteJson(filePath: string, data: any) {
  const tmp = `${filePath}.tmp.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// =============================================================================
// User Store
// =============================================================================

const getUsers = () => {
  if (!fs.existsSync(usersFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
  } catch {
    return {};
  }
};
const saveUsers = (users: any) => atomicWriteJson(usersFile, users);

const getUserScope = (username: string) => {
  if (!validateUsername(username)) {
    throw new Error('Invalid username for scope lookup');
  }
  const userVaultPath = path.join(baseVaultPath, username);
  const attachmentsPath = path.join(userVaultPath, 'attachments');
  const templatesPath = path.join(userVaultPath, 'Templates');

  if (!fs.existsSync(userVaultPath)) {
    fs.mkdirSync(userVaultPath, { recursive: true });
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

  return { vaultPath: userVaultPath, attachmentsPath, templatesPath };
};

// =============================================================================
// Express App
// =============================================================================

const app = express();
app.set('trust proxy', 1); // trust Nginx / reverse proxy for correct client IPs

// FIX: Security headers via helmet (covers X-Frame-Options, Referrer-Policy,
// X-Content-Type-Options, Strict-Transport-Security, etc.)
app.use(helmet({
  contentSecurityPolicy: false, // We set our own per-route where needed
  crossOriginEmbedderPolicy: false, // needed for iframe proxy
}));

app.use(cors({ origin: ALLOWED_ORIGIN, credentials: false }));
app.use(express.json({ limit: '10mb' }));

// Global per-IP rate limit on all API endpoints
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Stricter limit on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// =============================================================================
// Auth Middleware
// =============================================================================

function verifyTokenAndAttachUser(token: string | null, req: any, res: any, next: any) {
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  jwt.verify(token, JWT_SECRET!, (err: any, tokenUser: any) => {
    if (err) return res.status(403).json({ error: 'Forbidden' });

    const users = getUsers();
    const userRecord = users[tokenUser.username];
    if (!userRecord) {
      return res.status(401).json({ error: 'User account no longer exists' });
    }

    const tokenVersion = tokenUser.tokenVersion ?? -1;
    const currentVersion = userRecord.tokenVersion ?? 0;
    if (tokenVersion !== currentVersion) {
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }

    req.user = { username: tokenUser.username, role: userRecord.role || 'user' };
    next();
  });
}

/** Accept JWT only from the Authorization header. */
function authHeaderOnly(req: any, res: any, next: any) {
  const authHeader = req.headers['authorization'];
  const match = authHeader && /^Bearer (.+)$/.exec(authHeader);
  const token = match ? match[1] : null;
  return verifyTokenAndAttachUser(token, req, res, next);
}

/**
 * Accept JWT from header OR query string. Only use on GET endpoints that are
 * loaded in contexts where headers can't be set (<img>, <iframe>, download links).
 */
function authHeaderOrQuery(req: any, res: any, next: any) {
  const authHeader = req.headers['authorization'];
  const match = authHeader && /^Bearer (.+)$/.exec(authHeader);
  const token = (match ? match[1] : null) || (req.query?.token as string) || null;
  return verifyTokenAndAttachUser(token, req, res, next);
}

const adminOnly = (req: any, res: any, next: any) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  next();
};

function issueToken(username: string, role: string, tokenVersion: number) {
  return jwt.sign({ username, role, tokenVersion }, JWT_SECRET!, { expiresIn: '30d' });
}

// =============================================================================
// Auth Routes
// =============================================================================

app.get('/api/auth/status', (req, res) => {
  const users = getUsers();
  const hasAdmin = Object.values(users).some((u: any) => u.role === 'admin');
  res.json({ needsBootstrap: !hasAdmin });
});

app.post('/api/auth/bootstrap', authLimiter, async (req, res) => {
  const { username, password, email } = req.body;
  if (!validateUsername(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 characters: letters, numbers, underscore, or dash.' });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const users = getUsers();
  const hasAdmin = Object.values(users).some((u: any) => u.role === 'admin');
  if (hasAdmin) return res.status(403).json({ error: 'System already bootstrapped' });

  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
  users[username] = {
    password: hashedPassword,
    role: 'admin',
    email: (typeof email === 'string' ? email : '').slice(0, 256),
    tokenVersion: 0,
    createdAt: new Date().toISOString(),
  };
  saveUsers(users);

  const token = issueToken(username, 'admin', 0);
  res.json({ token, role: 'admin', username });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const users = getUsers();
  const user = users[username];

  // Always run bcrypt to avoid user-enumeration via timing.
  const dummyHash = '$2a$12$CwTycUXWue0Thq9StjUM0uJ8mZEtUz7rSgVdSiKvMqvQMyxZJgZVC';
  const hashToCompare = user?.password || dummyHash;
  const ok = await bcrypt.compare(password, hashToCompare);

  if (!user || !ok) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = issueToken(username, user.role, user.tokenVersion ?? 0);
  res.json({ token, role: user.role, username });
});

app.post('/api/auth/change-password', authHeaderOnly, async (req: any, res) => {
  const { currentPassword, newPassword } = req.body;
  if (typeof currentPassword !== 'string' || !validatePassword(newPassword)) {
    return res.status(400).json({ error: 'Current password and a valid new password (min 8 chars) are required.' });
  }

  const users = getUsers();
  const user = users[req.user.username];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const ok = await bcrypt.compare(currentPassword, user.password);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

  user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  saveUsers(users);

  const token = issueToken(req.user.username, user.role, user.tokenVersion);
  res.json({ success: true, token });
});

// =============================================================================
// Admin: Users
// =============================================================================

app.get('/api/admin/users', authHeaderOnly, adminOnly, (req, res) => {
  const users = getUsers();
  const userList = Object.entries(users).map(([username, data]: [string, any]) => ({
    username,
    role: data.role,
    email: data.email || '',
    createdAt: data.createdAt,
  }));
  res.json(userList);
});

app.post('/api/admin/users', authHeaderOnly, adminOnly, async (req, res) => {
  const { username, password, role, email } = req.body;
  if (!validateUsername(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 characters: letters, numbers, underscore, or dash.' });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const users = getUsers();
  if (users[username]) return res.status(400).json({ error: 'User already exists' });

  const safeRole = role === 'admin' ? 'admin' : 'user';
  users[username] = {
    password: await bcrypt.hash(password, BCRYPT_ROUNDS),
    role: safeRole,
    email: (typeof email === 'string' ? email : '').slice(0, 256),
    tokenVersion: 0,
    createdAt: new Date().toISOString(),
  };
  saveUsers(users);
  getUserScope(username);
  res.json({ success: true });
});

app.post('/api/admin/users/update', authHeaderOnly, adminOnly, async (req, res) => {
  const { username, role, email } = req.body;
  if (!validateUsername(username)) return res.status(400).json({ error: 'Invalid username' });

  const users = getUsers();
  if (!users[username]) return res.status(404).json({ error: 'User not found' });

  if (role !== undefined) users[username].role = role === 'admin' ? 'admin' : 'user';
  if (email !== undefined) {
    users[username].email = typeof email === 'string' ? email.slice(0, 256) : '';
  }
  saveUsers(users);
  res.json({ success: true });
});

app.post('/api/admin/users/reset', authHeaderOnly, adminOnly, async (req, res) => {
  const { username, newPassword } = req.body;
  if (!validateUsername(username)) return res.status(400).json({ error: 'Invalid username' });
  if (!validatePassword(newPassword)) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  const users = getUsers();
  if (!users[username]) return res.status(404).json({ error: 'User not found' });

  users[username].password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  users[username].tokenVersion = (users[username].tokenVersion ?? 0) + 1;
  saveUsers(users);
  res.json({ success: true });
});

app.delete('/api/admin/users/:username', authHeaderOnly, adminOnly, (req: any, res) => {
  const { username } = req.params;
  if (!validateUsername(username)) return res.status(400).json({ error: 'Invalid username' });
  if (username === req.user.username) return res.status(400).json({ error: 'Cannot delete yourself' });

  const users = getUsers();
  if (!users[username]) return res.status(404).json({ error: 'User not found' });

  delete users[username];
  saveUsers(users);

  const userDir = path.join(baseVaultPath, username);
  const archiveDir = path.join(baseVaultPath, `.archive_${username}_${Date.now()}`);
  if (fs.existsSync(userDir)) {
    fs.renameSync(userDir, archiveDir);
  }

  res.json({ success: true });
});

// =============================================================================
// Admin: Storage
// =============================================================================

function isHiddenFromAdmin(name: string): boolean {
  return name.startsWith('.');
}

function assertAdminPathAllowed(relPath: string): boolean {
  const parts = relPath.split(/[\\\/]+/).filter(Boolean);
  return !parts.some(isHiddenFromAdmin);
}

app.get('/api/admin/storage/list', authHeaderOnly, adminOnly, (req, res) => {
  function scanDir(dir: string, relativePath = '') {
    const nodes: any[] = [];
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (isHiddenFromAdmin(file)) continue;
      const fullPath = path.join(dir, file);
      const relPath = path.join(relativePath, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        nodes.push({
          name: file, path: relPath, type: 'folder',
          children: scanDir(fullPath, relPath),
          createdAt: stat.birthtimeMs, updatedAt: stat.mtimeMs, size: 0,
        });
      } else {
        nodes.push({
          name: file, path: relPath, type: 'file',
          createdAt: stat.birthtimeMs, updatedAt: stat.mtimeMs, size: stat.size,
        });
      }
    }
    return nodes;
  }

  try {
    res.json(scanDir(baseVaultPath));
  } catch {
    res.status(500).json({ error: 'Failed to read storage' });
  }
});

app.get('/api/admin/storage/file', authHeaderOrQuery, adminOnly, (req, res) => {
  const relPath = req.query.path as string;
  if (!relPath) return res.status(400).json({ error: 'Path required' });
  if (!assertAdminPathAllowed(relPath)) return res.status(403).json({ error: 'Access denied' });

  const fullPath = safeJoin(baseVaultPath, relPath);
  if (!fullPath) return res.status(403).json({ error: 'Access denied' });
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' });

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('[archive]', err);
      try { res.status(500).end(); } catch {}
    });
    res.attachment(`${path.basename(fullPath)}.zip`);
    archive.pipe(res);
    archive.directory(fullPath, false);
    archive.finalize();
  } else {
    res.sendFile(fullPath);
  }
});

app.post('/api/admin/storage/download-bulk', authHeaderOnly, adminOnly, (req, res) => {
  const { paths: relPaths } = req.body;
  if (!Array.isArray(relPaths) || relPaths.length === 0) {
    return res.status(400).json({ error: 'Paths must be a non-empty array' });
  }

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('[archive]', err);
    try { res.status(500).end(); } catch {}
  });
  res.attachment('bulk-download.zip');
  archive.pipe(res);

  for (const relPath of relPaths) {
    if (typeof relPath !== 'string' || !assertAdminPathAllowed(relPath)) continue;
    const fullPath = safeJoin(baseVaultPath, relPath);
    if (!fullPath || !fs.existsSync(fullPath)) continue;

    const stat = fs.statSync(fullPath);
    const baseName = path.basename(fullPath);
    if (stat.isDirectory()) archive.directory(fullPath, baseName);
    else archive.file(fullPath, { name: baseName });
  }

  archive.finalize();
});

app.post('/api/admin/storage/zip', authHeaderOnly, adminOnly, (req, res) => {
  const { paths: relPaths, targetName } = req.body;
  if (!Array.isArray(relPaths) || relPaths.length === 0) {
    return res.status(400).json({ error: 'Paths must be a non-empty array' });
  }

  const firstAbs = safeJoin(baseVaultPath, relPaths[0]);
  if (!firstAbs) return res.status(403).json({ error: 'Access denied' });

  const cleanName = sanitizeFilename(typeof targetName === 'string' ? targetName : `archive_${Date.now()}`);
  const zipFileName = cleanName.endsWith('.zip') ? cleanName : `${cleanName}.zip`;
  const zipPath = path.join(path.dirname(firstAbs), zipFileName);

  if (!safeJoin(baseVaultPath, path.relative(baseVaultPath, zipPath))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  output.on('close', () =>
    res.json({ success: true, path: path.relative(baseVaultPath, zipPath) })
  );
  archive.on('error', (err) => {
    console.error('[archive]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Archive failed' });
  });

  archive.pipe(output);

  for (const relPath of relPaths) {
    if (typeof relPath !== 'string' || !assertAdminPathAllowed(relPath)) continue;
    const fullPath = safeJoin(baseVaultPath, relPath);
    if (!fullPath || !fs.existsSync(fullPath)) continue;

    const stat = fs.statSync(fullPath);
    const baseName = path.basename(fullPath);
    if (stat.isDirectory()) archive.directory(fullPath, baseName);
    else archive.file(fullPath, { name: baseName });
  }

  archive.finalize();
});

app.post('/api/admin/storage/bulk-delete', authHeaderOnly, adminOnly, (req, res) => {
  const { paths: relPaths } = req.body;
  if (!Array.isArray(relPaths)) return res.status(400).json({ error: 'Paths must be an array' });

  const results = { deleted: [] as string[], errors: [] as any[] };

  for (const relPath of relPaths) {
    if (typeof relPath !== 'string' || !assertAdminPathAllowed(relPath)) {
      results.errors.push({ path: relPath, error: 'Access denied' });
      continue;
    }
    const fullPath = safeJoin(baseVaultPath, relPath);
    if (!fullPath) {
      results.errors.push({ path: relPath, error: 'Access denied' });
      continue;
    }

    try {
      if (fs.existsSync(fullPath)) {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) fs.rmSync(fullPath, { recursive: true, force: true });
        else fs.unlinkSync(fullPath);
        results.deleted.push(relPath);
      } else {
        results.errors.push({ path: relPath, error: 'File not found' });
      }
    } catch (e: any) {
      console.error(`[admin delete]`, e);
      results.errors.push({ path: relPath, error: 'Delete failed' });
    }
  }

  res.status(results.errors.length > 0 ? 207 : 200).json(results);
});

app.post('/api/admin/storage/unzip', authHeaderOnly, adminOnly, (req, res) => {
  const { path: relPath, destination: destRelPath } = req.body;
  if (typeof relPath !== 'string') return res.status(400).json({ error: 'Path required' });
  if (!assertAdminPathAllowed(relPath)) return res.status(403).json({ error: 'Access denied' });

  const fullPath = safeJoin(baseVaultPath, relPath);
  if (!fullPath) return res.status(403).json({ error: 'Access denied' });

  const destPath = destRelPath
    ? safeJoin(baseVaultPath, destRelPath)
    : path.dirname(fullPath);
  if (!destPath || !destPath.startsWith(path.resolve(baseVaultPath))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Archive not found' });

  try {
    const zip = new AdmZip(fullPath);
    const destResolved = path.resolve(destPath);

    for (const entry of zip.getEntries()) {
      const rawName = entry.entryName;
      // FIX: Belt-and-suspenders zip-slip defense
      const normalized = rawName.replace(/\\/g, '/');
      const isAbsolute =
        normalized.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(normalized);
      const hasParentRef = normalized.split('/').some((seg) => seg === '..');
      const hasNul = rawName.includes('\0');

      if (isAbsolute || hasParentRef || hasNul) {
        console.warn(`[unzip] rejecting archive: unsafe entry name ${JSON.stringify(rawName)}`);
        return res.status(400).json({ error: 'Archive contains unsafe entries' });
      }

      const entryPath = path.resolve(destResolved, rawName);
      if (entryPath !== destResolved && !entryPath.startsWith(destResolved + path.sep)) {
        console.warn(`[unzip] rejecting: ${JSON.stringify(rawName)} resolves outside vault`);
        return res.status(400).json({ error: 'Archive contains unsafe entries' });
      }
    }

    zip.extractAllTo(destPath, true);
    res.json({ success: true });
  } catch (e: any) {
    console.error('[unzip]', e);
    res.status(500).json({ error: 'Failed to extract' });
  }
});

app.post('/api/admin/storage/file', authHeaderOnly, adminOnly, (req, res) => {
  const { path: relPath, content } = req.body;
  if (typeof relPath !== 'string') return res.status(400).json({ error: 'Path required' });
  if (!assertAdminPathAllowed(relPath)) return res.status(403).json({ error: 'Access denied' });
  const fullPath = safeJoin(baseVaultPath, relPath);
  if (!fullPath) return res.status(403).json({ error: 'Access denied' });

  try {
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, typeof content === 'string' ? content : '');
    res.json({ success: true });
  } catch (e) {
    console.error('[admin save]', e);
    res.status(500).json({ error: 'Failed to save file' });
  }
});

app.post('/api/admin/storage/new', authHeaderOnly, adminOnly, (req, res) => {
  const { path: relPath, type } = req.body;
  if (typeof relPath !== 'string') return res.status(400).json({ error: 'Path required' });
  if (!assertAdminPathAllowed(relPath)) return res.status(403).json({ error: 'Access denied' });
  const fullPath = safeJoin(baseVaultPath, relPath);
  if (!fullPath) return res.status(403).json({ error: 'Access denied' });

  try {
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (type === 'folder') fs.mkdirSync(fullPath, { recursive: true });
    else fs.writeFileSync(fullPath, '');
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to create' });
  }
});

app.post('/api/admin/storage/move', authHeaderOnly, adminOnly, (req, res) => {
  const { source, destination } = req.body;
  if (typeof source !== 'string' || typeof destination !== 'string')
    return res.status(400).json({ error: 'Invalid request' });
  if (!assertAdminPathAllowed(source) || !assertAdminPathAllowed(destination))
    return res.status(403).json({ error: 'Access denied' });

  const oldPath = safeJoin(baseVaultPath, source);
  const newPath = safeJoin(baseVaultPath, destination);
  if (!oldPath || !newPath) return res.status(403).json({ error: 'Access denied' });

  try {
    const destDir = path.dirname(newPath);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.renameSync(oldPath, newPath);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to move' });
  }
});

app.delete('/api/admin/storage/file', authHeaderOnly, adminOnly, (req, res) => {
  const relPath = req.query.path as string;
  if (!relPath) return res.status(400).json({ error: 'Path required' });
  if (!assertAdminPathAllowed(relPath)) return res.status(403).json({ error: 'Access denied' });
  const fullPath = safeJoin(baseVaultPath, relPath);
  if (!fullPath) return res.status(403).json({ error: 'Access denied' });

  try {
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) fs.rmSync(fullPath, { recursive: true, force: true });
    else fs.unlinkSync(fullPath);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

app.post('/api/admin/storage/copy', authHeaderOnly, adminOnly, (req, res) => {
  const { source, destination } = req.body;
  if (typeof source !== 'string' || typeof destination !== 'string')
    return res.status(400).json({ error: 'Invalid request' });
  if (!assertAdminPathAllowed(source) || !assertAdminPathAllowed(destination))
    return res.status(403).json({ error: 'Access denied' });

  const srcPath = safeJoin(baseVaultPath, source);
  const destPath = safeJoin(baseVaultPath, destination);
  if (!srcPath || !destPath) return res.status(403).json({ error: 'Access denied' });

  try {
    if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'Source not found' });
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) fs.cpSync(srcPath, destPath, { recursive: true });
    else fs.copyFileSync(srcPath, destPath);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to copy' });
  }
});

// FIX: MIME type validation added to multer file filter
function multerMimeFilter(allowedTypes: Set<string>) {
  return (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    if (allowedTypes.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type '${file.mimetype}' is not allowed`));
    }
  };
}

// Admin file-upload (auth runs BEFORE multer)
const adminUpload = multer({
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: multerMimeFilter(ALLOWED_MIME_TYPES),
  storage: multer.diskStorage({
    destination: (req: any, _file, cb) => {
      const relPath = (req.query?.path as string) || '';
      if (relPath && !assertAdminPathAllowed(relPath)) return cb(new Error('Access denied'), '');
      const abs = relPath ? safeJoin(baseVaultPath, relPath) : baseVaultPath;
      if (!abs) return cb(new Error('Access denied'), '');
      if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
      cb(null, abs);
    },
    filename: (_req, file, cb) => cb(null, sanitizeFilename(file.originalname)),
  }),
});

app.post('/api/admin/storage/upload', authHeaderOnly, adminOnly, (req, res, next) => {
  adminUpload.single('file')(req, res, (err) => {
    if (err) {
      console.error('[admin upload]', err);
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}, (req: any, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ success: true });
});

// =============================================================================
// Scoped (per-user) File Operations
// =============================================================================

app.get('/api/files', authHeaderOnly, (req: any, res) => {
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
          name: file, path: relPath, type: 'folder',
          children: scanDir(fullPath, relPath),
          createdAt: stat.birthtimeMs, updatedAt: stat.mtimeMs,
        });
      } else if (file.endsWith('.md') || file.endsWith('.canvas')) {
        nodes.push({
          name: file.replace(/\.(md|canvas)$/, ''),
          path: relPath,
          type: file.endsWith('.canvas') ? 'canvas' : 'file',
          createdAt: stat.birthtimeMs, updatedAt: stat.mtimeMs,
        });
      }
    }
    return nodes;
  }

  try { res.json(scanDir(vaultPath)); }
  catch { res.status(500).json({ error: 'Failed to read vault' }); }
});

app.get('/api/file', authHeaderOrQuery, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const relPath = req.query.path as string;
  if (!relPath) return res.status(400).json({ error: 'Path required' });

  const filePath = safeJoin(vaultPath, relPath);
  if (!filePath) return res.status(403).json({ error: 'Access denied' });

  if (fs.existsSync(filePath)) res.sendFile(filePath);
  else res.status(404).json({ error: 'File not found' });
});

app.post('/api/file', authHeaderOnly, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const { path: relPath, content } = req.body;
  if (typeof relPath !== 'string') return res.status(400).json({ error: 'Path required' });

  const filePath = safeJoin(vaultPath, relPath);
  if (!filePath) return res.status(403).json({ error: 'Access denied' });

  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, typeof content === 'string' ? content : '');
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to save file' });
  }
});

app.post('/api/file/new', authHeaderOnly, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const { path: relPath, type } = req.body;
  if (typeof relPath !== 'string') return res.status(400).json({ error: 'Path required' });

  const filePath = safeJoin(vaultPath, relPath);
  if (!filePath) return res.status(403).json({ error: 'Access denied' });

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (type === 'folder') fs.mkdirSync(filePath, { recursive: true });
  else if (type === 'canvas') fs.writeFileSync(filePath, JSON.stringify({ nodes: [], edges: [] }, null, 2));
  else fs.writeFileSync(filePath, '# New Note');

  res.json({ success: true });
});

app.post('/api/file/move', authHeaderOnly, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const { source, destination } = req.body;
  if (typeof source !== 'string' || typeof destination !== 'string')
    return res.status(400).json({ error: 'Invalid request' });

  const oldFullPath = safeJoin(vaultPath, source);
  const newFullPath = safeJoin(vaultPath, destination);
  if (!oldFullPath || !newFullPath) return res.status(403).json({ error: 'Access denied' });

  try { fs.renameSync(oldFullPath, newFullPath); res.json({ success: true }); }
  catch { res.status(500).json({ error: 'Failed to move/rename' }); }
});

app.delete('/api/file', authHeaderOnly, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const relPath = req.query.path as string;
  if (!relPath) return res.status(400).json({ error: 'Path required' });

  const filePath = safeJoin(vaultPath, relPath);
  if (!filePath) return res.status(403).json({ error: 'Access denied' });

  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
    else fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (e) {
    console.error(`[user file delete]`, e);
    res.status(500).json({ error: 'Failed to delete' });
  }
});

app.post('/api/file/delete', authHeaderOnly, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const relPath = req.body.path as string;
  if (!relPath) return res.status(400).json({ error: 'Path required' });

  const filePath = safeJoin(vaultPath, relPath);
  if (!filePath) return res.status(403).json({ error: 'Access denied' });

  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
    else fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (e) {
    console.error(`[user file delete post]`, e);
    res.status(500).json({ error: 'Failed to delete' });
  }
});

app.post('/api/file/duplicate', authHeaderOnly, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const { path: relPath } = req.body;
  if (typeof relPath !== 'string') return res.status(400).json({ error: 'Path required' });

  const oldFullPath = safeJoin(vaultPath, relPath);
  if (!oldFullPath) return res.status(403).json({ error: 'Access denied' });

  const ext = path.extname(relPath);
  const base = relPath.slice(0, -ext.length);
  let newRelPath = `${base} (copy)${ext}`;
  let counter = 1;
  while (fs.existsSync(path.join(vaultPath, newRelPath))) {
    newRelPath = `${base} (copy ${counter})${ext}`;
    counter++;
  }
  const newFullPath = safeJoin(vaultPath, newRelPath);
  if (!newFullPath) return res.status(403).json({ error: 'Access denied' });

  try { fs.copyFileSync(oldFullPath, newFullPath); res.json({ success: true }); }
  catch (e) {
    console.error(`[user file duplicate]`, e);
    res.status(500).json({ error: 'Failed to duplicate' });
  }
});

app.get('/api/links', authHeaderOnly, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const targetPath = req.query.path as string;
  if (!targetPath) return res.status(400).json({ error: 'Path required' });

  const targetFullPath = safeJoin(vaultPath, targetPath);
  if (!targetFullPath) return res.status(403).json({ error: 'Access denied' });

  try {
    const flatFiles: any[] = [];
    function scanDir(dir: string, relativePath = '') {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.startsWith('.')) continue;
        const fullPath = path.join(dir, file);
        const relPath = path.join(relativePath, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) scanDir(fullPath, relPath);
        else if (file.endsWith('.md')) flatFiles.push({ path: relPath, name: file.replace('.md', '') });
      }
    }
    scanDir(vaultPath);

    const backlinks: string[] = [];
    let forwardlinks: string[] = [];

    if (fs.existsSync(targetFullPath)) {
      const content = fs.readFileSync(targetFullPath, 'utf-8');
      const matches = content.match(/\[\[(.*?)\]\]/g);
      if (matches) forwardlinks = matches.map((m) => m.slice(2, -2).split('|')[0]);
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
  } catch {
    res.status(500).json({ error: 'Failed to get links' });
  }
});

// =============================================================================
// User attachment uploads
// =============================================================================

const userUpload = multer({
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: multerMimeFilter(ALLOWED_MIME_TYPES),
  storage: multer.diskStorage({
    destination: (req: any, _file, cb) => {
      try {
        const { attachmentsPath } = getUserScope(req.user.username);
        if (!fs.existsSync(attachmentsPath)) fs.mkdirSync(attachmentsPath, { recursive: true });
        cb(null, attachmentsPath);
      } catch (e: any) {
        cb(e, '');
      }
    },
    filename: (_req, file, cb) => cb(null, sanitizeFilename(file.originalname)),
  }),
});

app.post('/api/upload', authHeaderOnly, (req, res, next) => {
  userUpload.single('file')(req, res, (err) => {
    if (err) {
      console.error('[user upload]', err);
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}, (req: any, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ path: `attachments/${req.file.filename}` });
});

app.get('/api/attachments/:filename', authHeaderOrQuery, (req: any, res) => {
  const { attachmentsPath } = getUserScope(req.user.username);
  const filePath = safeJoin(attachmentsPath, req.params.filename);
  if (!filePath) return res.status(403).json({ error: 'Access denied' });

  if (fs.existsSync(filePath)) {
    // FIX: Set Content-Disposition to prevent MIME-sniff XSS via uploaded files
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Attachment not found' });
  }
});

// =============================================================================
// Iframe proxy (SSRF-guarded)
// =============================================================================

app.get('/api/proxy/iframe', authHeaderOrQuery, async (req: any, res: any) => {
  if (!ENABLE_IFRAME_PROXY) return res.status(404).send('Proxy disabled');
  const targetUrl = req.query.url as string;
  if (!targetUrl) return res.status(400).send('No URL provided');

  const parsed = await validateSafeFetchUrl(targetUrl);
  if (!parsed) {
    return res.status(400).send('URL is not allowed (must be http/https and non-private).');
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'manual', // don't auto-follow redirects into private space
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
    });
    clearTimeout(timeout);

    // FIX: For redirects, validate the redirect target before following
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return res.status(502).send('Invalid redirect');
      const redirectTarget = await validateSafeFetchUrl(
        location.startsWith('http') ? location : `${parsed.protocol}//${parsed.host}${location}`
      );
      if (!redirectTarget) return res.status(400).send('Redirect target is not allowed.');
      return res.redirect(redirectTarget.toString());
    }

    const contentType = response.headers.get('content-type') || 'text/html';
    if (!contentType.includes('text/html')) {
      return res.status(400).send('Only HTML content can be proxied.');
    }

    let body = await response.text();
    const baseHref = `${parsed.protocol}//${parsed.host}`;
    if (body.match(/<head[^>]*>/i)) {
      body = body.replace(/(<head[^>]*>)/i, `$1\n<base href="${baseHref}/">`);
    } else {
      body = `<head><base href="${baseHref}/"></head>` + body;
    }

    res.set('Content-Security-Policy',
      "sandbox allow-same-origin allow-popups; default-src * 'unsafe-inline' data: blob:; script-src 'none'; object-src 'none'; base-uri *;");
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', contentType);
    res.send(body);
  } catch {
    res.status(502).send(`
      <html>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f9fafb; color: #6b7280; text-align: center;">
          <div>
            <h2 style="margin: 0 0 8px; font-size: 1.125rem; font-weight: 600; color: #374151;">Failed to load preview</h2>
            <p style="margin: 0; font-size: 0.875rem;">The website refused to connect or is invalid.</p>
          </div>
        </body>
      </html>
    `);
  }
});

// =============================================================================
// Graph / Search / Tags
// =============================================================================

app.get('/api/graph', authHeaderOnly, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const filterFolder = (req.query.folder as string) || '';

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
        if (fs.statSync(fullPath).isDirectory()) indexFiles(fullPath, relPath);
        else if (file.endsWith('.md')) fileNameToPath.set(file.replace('.md', ''), relPath);
      }
    }

    function scanDir(dir: string, relativePath = '') {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.startsWith('.')) continue;
        const fullPath = path.join(dir, file);
        const relPath = path.join(relativePath, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) { scanDir(fullPath, relPath); continue; }
        if (!file.endsWith('.md')) continue;
        if (filterFolder && !relPath.startsWith(filterFolder)) continue;

        const id = relPath;
        const name = file.replace(/\.(md|canvas)$/, '');
        if (!nodeSet.has(id)) { nodes.push({ id, name }); nodeSet.add(id); }

        const content = fs.readFileSync(fullPath, 'utf-8');
        const wikiLinkRegex = /\[\[(.*?)\]\]/g;
        let match;
        while ((match = wikiLinkRegex.exec(content)) !== null) {
          const targetName = match[1].split('|')[0].split('#')[0];
          const targetRelPath = fileNameToPath.get(targetName);
          if (targetRelPath && (!filterFolder || targetRelPath.startsWith(filterFolder))) {
            links.push({ source: id, target: targetRelPath });
            if (!nodeSet.has(targetRelPath)) {
              nodes.push({ id: targetRelPath, name: targetName });
              nodeSet.add(targetRelPath);
            }
          }
        }
      }
    }

    indexFiles(vaultPath);
    scanDir(vaultPath);
    res.json({ nodes, links });
  } catch {
    res.status(500).json({ error: 'Graph failed' });
  }
});

app.get('/api/search', authHeaderOnly, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const query = ((req.query.q as string) || '').toLowerCase();

  const results: any[] = [];
  const recentFiles: any[] = [];

  function scanDir(dir: string, relativePath = '') {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith('.')) continue;
      const fullPath = path.join(dir, file);
      const relPath = path.join(relativePath, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) { scanDir(fullPath, relPath); continue; }
      if (!file.endsWith('.md')) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');
      recentFiles.push({ path: relPath, mtime: stat.mtimeMs });
      if (!query) continue;
      if (file.toLowerCase().includes(query) || content.toLowerCase().includes(query)) {
        results.push({ path: relPath, content: file });
      }
    }
  }
  scanDir(vaultPath);

  if (!query) {
    recentFiles.sort((a, b) => b.mtime - a.mtime);
    res.json(recentFiles.slice(0, 10).map((f) => ({ path: f.path, content: 'Recent' })));
  } else {
    res.json(results);
  }
});

app.get('/api/tags', authHeaderOnly, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const tagMap = new Map<string, { count: number; files: Set<string> }>();

  function scanDir(dir: string, relativePath = '') {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith('.')) continue;
      const fullPath = path.join(dir, file);
      const relPath = path.join(relativePath, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) { scanDir(fullPath, relPath); continue; }
      if (!file.endsWith('.md')) continue;

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
  scanDir(vaultPath);
  res.json(Array.from(tagMap.entries()).map(([tag, data]) => ({
    tag, count: data.count, files: Array.from(data.files),
  })));
});

app.get('/api/templates', authHeaderOnly, (req: any, res) => {
  const { templatesPath, vaultPath } = getUserScope(req.user.username);
  if (!fs.existsSync(templatesPath)) return res.json([]);

  try {
    const files = fs.readdirSync(templatesPath);
    const templates = files
      .filter(f => f.endsWith('.md'))
      .map(f => ({
        name: f.replace('.md', ''),
        path: path.relative(vaultPath, path.join(templatesPath, f)),
        type: 'template'
      }));
    res.json(templates);
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// =============================================================================
// Server Boot
// =============================================================================

async function startServer() {
  if (IS_DEV) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Global error handler — registered last
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('[Global Error]', err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: 'Internal Server Error' });
  });

  app.listen(PORT, HOST, () => {
    console.log(`[startup] Server listening on http://${HOST}:${PORT}`);
  });
}

startServer();
