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
import dotenv from 'dotenv';
dotenv.config(); // picks up .env in dev; in Docker, compose injects env vars directly

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

// =============================================================================
// Agent Space — OpenRouter Configuration
// =============================================================================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-5.5';
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

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

/**
 * Extract all [[wikilink]] targets from markdown content.
 * Handles BOTH the current unescaped format ([[...]]) AND the legacy
 * remark-stringify-escaped format (\[\[...\]\]) that old saves produced,
 * so existing notes continue to work after the serializer fix.
 * Returns de-aliased, de-anchored target names, e.g. "Note B".
 */
function extractWikilinks(content: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const t = raw.split('|')[0].split('#')[0].trim();
    if (t && !seen.has(t)) { seen.add(t); results.push(t); }
  };
  // Unescaped: [[target]] or [[target|alias]] or [[target#anchor]]
  const reUnescaped = /\[\[([^\]\n]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = reUnescaped.exec(content)) !== null) add(m[1]);
  // Escaped by old remark-stringify: \[\[target\]\] or \[\[target]]
  const reEscaped = /\\\[\\\[([^\]\n]+?)(?:\\\]\\]|\]\])/g;
  while ((m = reEscaped.exec(content)) !== null) add(m[1]);
  return results;
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
    // Build a flat file list AND a name→relPath index (same approach as /api/graph)
    const flatFiles: { path: string; name: string }[] = [];
    const fileNameToPath = new Map<string, string>(); // baseName (no ext) → relPath

    function scanDir(dir: string, relativePath = '') {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.startsWith('.')) continue;
        const fullPath = path.join(dir, file);
        const relPath = path.join(relativePath, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) { scanDir(fullPath, relPath); continue; }
        if (!file.endsWith('.md')) continue;
        const name = file.replace('.md', '');
        flatFiles.push({ path: relPath, name });
        // Last-write wins for duplicate names — same behaviour as graph
        fileNameToPath.set(name, relPath);
      }
    }
    scanDir(vaultPath);

    // ── Outgoing links (forwardlinks) ─────────────────────────────────────────
    const forwardlinks: { path: string; name: string }[] = [];

    if (fs.existsSync(targetFullPath)) {
      const content = fs.readFileSync(targetFullPath, 'utf-8');
      for (const rawTarget of extractWikilinks(content)) {
        const resolvedPath = fileNameToPath.get(rawTarget);
        if (resolvedPath && resolvedPath !== targetPath) {
          forwardlinks.push({ path: resolvedPath, name: rawTarget });
        }
      }
    }

    // ── Backlinks ─────────────────────────────────────────────────────────────
    const targetName = path.basename(targetPath, '.md');
    const backlinks: { path: string; name: string }[] = [];

    for (const file of flatFiles) {
      if (file.path === targetPath) continue;
      const fullPath = path.join(vaultPath, file.path);
      const content = fs.readFileSync(fullPath, 'utf-8');
      // extractWikilinks handles both escaped and unescaped formats
      if (extractWikilinks(content).includes(targetName)) {
        backlinks.push({ path: file.path, name: file.name });
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
        for (const targetName of extractWikilinks(content)) {
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
  const rawQuery = ((req.query.q as string) || '').trim();
  const query = rawQuery.toLowerCase();

  const results: any[] = [];
  const recentFiles: any[] = [];

  // If query starts with `#`, treat as a tag query and match the whole tag word.
  // Example: `#tag` matches `#tag` but NOT `#tagging`.
  let tagMatcher: RegExp | null = null;
  if (rawQuery.startsWith('#') && rawQuery.length > 1) {
    const tagName = rawQuery.slice(1).toLowerCase();
    const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    tagMatcher = new RegExp(`(?:^|[^\\w#])#${escaped}(?![\\w-])`, 'i');
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

      const content = fs.readFileSync(fullPath, 'utf-8');
      recentFiles.push({ path: relPath, mtime: stat.mtimeMs });
      if (!query) continue;

      if (tagMatcher) {
        const lines = content.split('\n');
        let found = -1;
        for (let i = 0; i < lines.length; i++) {
          if (tagMatcher.test(lines[i])) { found = i; break; }
        }
        if (found >= 0) {
          results.push({
            path: relPath,
            content: lines[found].trim().slice(0, 160),
            line: found + 1,
          });
        }
      } else {
        if (file.toLowerCase().includes(query)) {
          results.push({ path: relPath, content: file, line: 1 });
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(query)) {
            results.push({
              path: relPath,
              content: lines[i].trim().slice(0, 160),
              line: i + 1,
            });
            break;
          }
        }
      }
    }
  }
  scanDir(vaultPath);

  if (!query) {
    recentFiles.sort((a, b) => b.mtime - a.mtime);
    res.json(recentFiles.slice(0, 10).map((f) => ({ path: f.path, content: 'Recent', line: 1 })));
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
      // Match #tag after start-of-string, whitespace, or non-word/non-#/non-& chars.
      // Tag must start with a letter; allow letters/digits/underscore/hyphen after.
      // Exclude HTML/XML hex entity suffixes: #x20, #x72 etc (from &#x20; &#x72;).
      const tagRegex = /(?:^|[^\w&#])#([a-zA-Z][a-zA-Z0-9_-]*)/g;
      const isEntitySuffix = (t: string) => /^x[0-9a-fA-F]+$/i.test(t);
      let match;
      while ((match = tagRegex.exec(content)) !== null) {
        const tag = match[1].toLowerCase();
        if (isEntitySuffix(tag)) continue;
        if (!tagMap.has(tag)) tagMap.set(tag, { count: 0, files: new Set() });
        const tagData = tagMap.get(tag)!;
        tagData.count++;
        tagData.files.add(relPath);
      }
    }
  }
  scanDir(vaultPath);
  const out = Array.from(tagMap.entries())
    .map(([tag, data]) => ({ tag, count: data.count, files: Array.from(data.files) }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
  res.json(out);
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
// Agent Space Routes
// =============================================================================

/**
 * Call OpenRouter with a system + user prompt.
 * Returns the assistant message text.
 */
async function callOpenRouter(systemPrompt: string, userPrompt: string): Promise<string> {
  // Read at call-time (not module load) so a pm2 restart picks up .env changes.
  const apiKey = process.env.OPENROUTER_API_KEY || OPENROUTER_API_KEY;
  const model   = process.env.OPENROUTER_MODEL   || OPENROUTER_MODEL;
  const baseUrl = process.env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL;

  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set in .env — add it and run: pm2 restart <app>');

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://jaynotes.app',
      'X-Title': 'JayNotes Agent Space',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${err}`);
  }

  const data: any = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Unexpected OpenRouter response shape');
  return content.trim();
}

/**
 * Derive the AgentSpace mirror path for a note.
 *
 * Given:
 *   notePath       = "1 - Raw/01 Clients/01 Pfizer/01 AI Transformation Journey/meeting-01.md"
 *   agentSpaceRoot = "2 - Agent Space"   (relative to vault)
 *
 * Returns:
 *   mirrorRelDir  = "2 - Agent Space/01 Clients/01 Pfizer/01 AI Transformation Journey"
 *   projectName   = "01 AI Transformation Journey"
 *
 * Strategy: strip the first path segment (e.g. "1 - Raw") and the filename,
 * then prepend agentSpaceRoot. This keeps the client / project hierarchy intact.
 */
function deriveMirrorPaths(notePath: string, agentSpaceRoot: string) {
  // Normalise separators
  const parts = notePath.split(/[\\/]/).filter(Boolean);
  // parts[0]  = top-level user folder ("1 - Raw")
  // parts[-1] = filename ("meeting-01.md")
  // parts[1..-2] = the hierarchy we want to mirror
  const hierarchy = parts.slice(1, -1); // drop first folder + filename
  const projectName = hierarchy[hierarchy.length - 1] || 'Unknown Project';
  const mirrorRelDir = [agentSpaceRoot, ...hierarchy].join('/');
  const meetingSummaryRelDir = `${mirrorRelDir}/Meeting Summary`;
  const projectMdRelPath = `${mirrorRelDir}/Project.md`;
  return { mirrorRelDir, meetingSummaryRelDir, projectMdRelPath, projectName, hierarchy };
}

/** Skeleton Project.md written on first encounter of a project. */
function buildSkeletonProjectMd(projectName: string): string {
  const slug = projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return `# ${projectName}

## Project Context
Client:
Project: ${projectName}
**Client Stakeholders:**
**Internal Stakeholders:**
Project Summary:

## Current Status
No current status available yet.

## Active Action Items
(none yet)

## Completed Action Items
(none yet)

## Key Decisions
(none yet)

Tags: #active-project #${slug}
Links: [[${projectName}]]
`;
}

// =============================================================================
// Agent Space Routes
// =============================================================================

// Helper: parse known stakeholders from Project.md content — handles both marker and marker-free formats
function parseKnownStakeholders(projectMdContent: string): string[] {
  const names: Set<string> = new Set();

  // 1. New marker-free format: "**Client Stakeholders:** Name — Role, Name — Role"
  const clientLine = projectMdContent.match(/\*\*Client Stakeholders:\*\*\s*(.+)/);
  if (clientLine) {
    clientLine[1].split(',').forEach(part => {
      const name = part.trim().split(/\s*—\s*/)[0].trim().replace(/\*\*/g, '');
      if (name && name.length > 1) names.add(name);
    });
  }
  const internalLine = projectMdContent.match(/\*\*Internal Stakeholders:\*\*\s*(.+)/);
  if (internalLine) {
    internalLine[1].split(',').forEach(part => {
      const name = part.trim().split(/\s*—\s*/)[0].trim().replace(/\*\*/g, '');
      if (name && name.length > 1) names.add(name);
    });
  }

  // 2. Old marker format fallback: "  - Name — Role" lines inside USER:START block
  const contextMatch = projectMdContent.match(/<!-- USER:START project_context -->([\s\S]*?)<!-- USER:END project_context -->/);
  if (contextMatch) {
    const block = contextMatch[1];
    const linePattern = /^\s*[-•]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)(?:\s*[—\-–]|\s*\()/gm;
    let m;
    while ((m = linePattern.exec(block)) !== null) {
      const name = m[1].trim();
      if (!['Client', 'Internal', 'Project', 'Stakeholders'].includes(name)) names.add(name);
    }
  }

  // 3. Bold names **Name** in action items / decisions
  const boldNames = projectMdContent.matchAll(/\*\*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\*\*/g);
  for (const m of boldNames) {
    const n = m[1];
    if (!['Client Stakeholders', 'Internal Stakeholders'].includes(n)) names.add(n);
  }

  return [...names].filter(n => n.split(' ').length >= 2); // Only full names (2+ words)
}

// POST /api/agent/extract
// Phase 1: Read note, extract project context + attendees via LLM.
// Creates Project.md skeleton (first time) or reads existing.
// Does NOT generate the meeting summary yet.
// Body: { notePath, agentSpaceFolder }
app.post('/api/agent/extract', authHeaderOnly, async (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const { notePath, agentSpaceFolder } = req.body;

  if (typeof notePath !== 'string' || !notePath.endsWith('.md'))
    return res.status(400).json({ error: 'notePath must be a .md file path' });
  if (typeof agentSpaceFolder !== 'string' || !agentSpaceFolder.trim())
    return res.status(400).json({ error: 'agentSpaceFolder is required' });

  const noteAbsPath = safeJoin(vaultPath, notePath);
  if (!noteAbsPath) return res.status(403).json({ error: 'Access denied' });
  if (!fs.existsSync(noteAbsPath)) return res.status(404).json({ error: 'Note not found' });

  const noteContent = fs.readFileSync(noteAbsPath, 'utf-8');
  const noteStat = fs.statSync(noteAbsPath);
  const dateStr = new Date(noteStat.mtimeMs).toISOString().slice(0, 10);
  const noteBaseName = path.basename(notePath, '.md');
  const summaryFileName = `${dateStr} — ${noteBaseName}.md`;

  const { meetingSummaryRelDir, projectMdRelPath, projectName, mirrorRelDir } =
    deriveMirrorPaths(notePath, agentSpaceFolder.trim());

  const meetingSummaryAbsDir = safeJoin(vaultPath, meetingSummaryRelDir);
  const projectMdAbsPath = safeJoin(vaultPath, projectMdRelPath);
  const summaryAbsPath = safeJoin(vaultPath, `${meetingSummaryRelDir}/${summaryFileName}`);

  if (!meetingSummaryAbsDir || !projectMdAbsPath || !summaryAbsPath)
    return res.status(403).json({ error: 'Derived paths escape vault' });

  if (!fs.existsSync(meetingSummaryAbsDir)) fs.mkdirSync(meetingSummaryAbsDir, { recursive: true });

  const isFirstTime = !fs.existsSync(projectMdAbsPath);
  if (isFirstTime) {
    fs.writeFileSync(projectMdAbsPath, buildSkeletonProjectMd(projectName), 'utf-8');
  }

  const projectMdContent = fs.readFileSync(projectMdAbsPath, 'utf-8');
  const knownStakeholders = parseKnownStakeholders(projectMdContent);

  // LLM call: extract structured context from the note
  const extractSystemPrompt = `You are extracting structured context from a meeting note.
Return ONLY a valid JSON object. No markdown, no explanation, no code fences.
JSON shape:
{
  "company": "client company name or empty string",
  "project": "project or engagement name or empty string",
  "summary": "1-2 sentence project description or empty string",
  "attendees": [
    { "name": "Full Name", "role": "their role or title", "org": "their company or team" }
  ],
  "unmappedNames": ["Name1", "Name2"]
}
unmappedNames: names that appear in the note but whose full identity is unclear or ambiguous.
If nothing can be extracted, return empty strings and empty arrays.`;

  const extractUserPrompt = `Meeting note:
${noteContent}

Known stakeholders from Project.md (use these to validate names):
${knownStakeholders.length ? knownStakeholders.join(', ') : 'None yet'}

Extract the JSON context now.`;

  let extracted = { company: '', project: projectName, summary: '', attendees: [] as any[], unmappedNames: [] as string[] };
  try {
    const raw = await callOpenRouter(extractSystemPrompt, extractUserPrompt);
    // Strip any accidental markdown fences
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    extracted = { ...extracted, ...parsed };
  } catch (err: any) {
    console.error('[agent/extract] context extraction failed:', err.message);
    // Non-fatal — proceed with defaults
  }

  // For returning projects: detect new stakeholders not in Project.md
  let newStakeholders: any[] = [];
  if (!isFirstTime && extracted.attendees.length > 0) {
    const knownLower = knownStakeholders.map(n => n.toLowerCase());
    newStakeholders = extracted.attendees.filter(
      (a: any) => !knownLower.some(k => k.includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(k))
    );
  }

  res.json({
    success: true,
    isFirstTime,
    projectName,
    projectMdPath: projectMdRelPath,
    summaryFileName,
    meetingSummaryRelDir,
    mirrorRelDir,
    notePath,
    agentSpaceFolder,
    extracted,          // { company, project, summary, attendees, unmappedNames }
    newStakeholders,    // attendees not in existing Project.md
    knownStakeholders,
  });
});

// POST /api/agent/generate-summary
// Phase 2: Called after user has saved/confirmed Project.md.
// Reads final Project.md, generates meeting summary, updates Project.md.
// Body: { notePath, agentSpaceFolder, summaryFileName, nameAliases? }
app.post('/api/agent/generate-summary', authHeaderOnly, async (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const { notePath, agentSpaceFolder, summaryFileName, nameAliases } = req.body;

  if (typeof notePath !== 'string' || typeof agentSpaceFolder !== 'string' || typeof summaryFileName !== 'string')
    return res.status(400).json({ error: 'notePath, agentSpaceFolder and summaryFileName are required' });

  const noteAbsPath = safeJoin(vaultPath, notePath);
  if (!noteAbsPath || !fs.existsSync(noteAbsPath))
    return res.status(404).json({ error: 'Note not found' });

  let noteContent = fs.readFileSync(noteAbsPath, 'utf-8');
  const noteStat = fs.statSync(noteAbsPath);
  const dateStr = new Date(noteStat.mtimeMs).toISOString().slice(0, 10);
  const noteBaseName = path.basename(notePath, '.md');

  // Apply name aliases — replace unmapped/informal names with canonical names
  if (nameAliases && typeof nameAliases === 'object') {
    for (const [informal, canonical] of Object.entries(nameAliases)) {
      if (informal && canonical) {
        noteContent = noteContent.replace(new RegExp(`\\b${informal}\\b`, 'gi'), canonical as string);
      }
    }
  }

  const { meetingSummaryRelDir, projectMdRelPath } = deriveMirrorPaths(notePath, agentSpaceFolder.trim());
  const meetingSummaryAbsDir = safeJoin(vaultPath, meetingSummaryRelDir);
  const projectMdAbsPath = safeJoin(vaultPath, projectMdRelPath);
  const summaryAbsPath = safeJoin(vaultPath, `${meetingSummaryRelDir}/${summaryFileName}`);

  if (!meetingSummaryAbsDir || !projectMdAbsPath || !summaryAbsPath)
    return res.status(403).json({ error: 'Paths escape vault' });

  if (!fs.existsSync(meetingSummaryAbsDir)) fs.mkdirSync(meetingSummaryAbsDir, { recursive: true });
  if (!fs.existsSync(projectMdAbsPath))
    return res.status(404).json({ error: 'Project.md not found — save it first' });

  // Read the FINAL Project.md (after user has filled it in)
  const projectMdContent = fs.readFileSync(projectMdAbsPath, 'utf-8');

  // --- Meeting Summary LLM ---
  const projectName = path.basename(path.dirname(projectMdRelPath));
  const projectSlug = projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  // Extract client name from Project.md for Links line
  const clientMatch = projectMdContent.match(/^Client:\s*(.+)$/m);
  const clientName = clientMatch ? clientMatch[1].trim() : '';

  const summarizeSystemPrompt = `You are a project memory assistant for a markdown notes app.
Your job is to convert a raw meeting note into a clean, structured meeting summary.

Rules:
- Use ONLY the raw note and project context provided. Do not invent facts.
- If something is unclear, mark it as "unclear".
- Summary length must be proportional to the input. Short note = short summary. Never pad.
- If a section has nothing to put in it, write "None." Do not invent content.
- No [[wikilinks]] anywhere in the output except the Links line at the bottom.
- Use plain bold **Name** for people in Attendees and Action Items.
- Use the project context to classify attendees as Client or Internal.
- No ## heading for Tags or Links — they are plain inline lines at the bottom.
- No blank lines between bullets inside a section.
- Return only valid markdown. No preamble or explanation.`;

  const summarizeUserPrompt = `## Project Context (Project.md)
${projectMdContent}

## Raw Meeting Note
File: ${notePath}
Date: ${dateStr}

${noteContent}

---

Produce the meeting summary using EXACTLY this template. Do not add, remove, or rename any section.

# ${noteBaseName} — ${dateStr}
**Source:** [[${noteBaseName}]]
**Meeting Type:** (Client Workshop / Internal Sync / Stakeholder Review / Discovery / Other)

## Attendees
**Client:** **Name** — Role, **Name** — Role
**Internal:** **Name** — Role, **Name** — Role
(One line for Client listing ALL client attendees comma-separated. One line for Internal listing ALL internal attendees comma-separated. Plain bold names, no [[wikilinks]]. Omit a line if no one in that group.)

## Discussion Summary
(Group by THEME. Bold theme name on its own line, then 1-3 plain bullets below. No [[wikilinks]].)

**Theme Name**
- Key point or decision (plain text)

## Open Questions
(Only real unresolved questions. Omit section entirely if none.)
- Question — Name who raised it

## Action Items
### Internal
- [ ] **Owner**: Task (Due: date or TBD)

### Client
- [ ] **Owner**: Task (Due: date or TBD)

Tags: #meetingsummary #${projectSlug}
Links: [[${projectName}]]${clientName ? ` [[${clientName}]]` : ''}`;

  let summaryContent: string;
  try {
    summaryContent = await callOpenRouter(summarizeSystemPrompt, summarizeUserPrompt);
  } catch (err: any) {
    console.error('[agent/generate-summary] summary LLM failed:', err.message);
    return res.status(502).json({ error: `Summary generation failed: ${err.message}` });
  }

  fs.writeFileSync(summaryAbsPath, summaryContent, 'utf-8');

  // --- Project.md merge LLM (always runs — every meeting updates Project.md) ---
  let allSummariesContent = summaryContent;
  try {
    if (fs.existsSync(meetingSummaryAbsDir)) {
      const summaryFiles = fs.readdirSync(meetingSummaryAbsDir)
        .filter(f => f.endsWith('.md'))
        .sort();
      allSummariesContent = summaryFiles.map(f => {
        const content = fs.readFileSync(`${meetingSummaryAbsDir}/${f}`, 'utf-8');
        return `### ${f}\n${content}`;
      }).join('\n\n---\n\n');
    }
  } catch { /* use latest summary as fallback */ }

  // Get meeting summary filenames for Links line
  let summaryFileNames: string[] = [];
  try {
    if (fs.existsSync(meetingSummaryAbsDir)) {
      summaryFileNames = fs.readdirSync(meetingSummaryAbsDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .map(f => path.basename(f, '.md'));
    }
  } catch { /* ignore */ }

  const mergeSystemPrompt = `You are a project memory assistant updating a living Project.md file.
You receive the current Project.md and all meeting summaries. Update the Project.md based on the summaries.

The Project.md has this exact structure — reproduce it with updates:

# [Project Name]

## Project Context
Client: [client name — NEVER change this]
Project: [project name — NEVER change this]
**Client Stakeholders:** [comma-separated names — NEVER change this]
**Internal Stakeholders:** [comma-separated names — NEVER change this]
Project Summary: [summary — NEVER change this]

## Current Status
[1-2 sentences. Update based on latest meeting. No bullets.]

## Active Action Items
- [ ] **Name**: Task (Due: date)
[Add new items. Keep existing unchecked items. Move - [x] items to Completed.]

## Completed Action Items
- [x] **Name**: Task (Completed: date)
[Only checked-off items here.]

## Key Decisions
- Decision description — **Owner**
[Add new decisions. Keep existing ones. No duplicates.]

Tags: #tag1 #tag2 #tag3
Links: [[ProjectName]] [[ClientName]]

ABSOLUTE RULES:
1. Output ONLY the Project.md content — nothing else before or after.
2. NEVER modify ## Project Context block — copy it character-for-character.
3. No [[wikilinks]] except on the Links line.
4. No blank lines between bullets within a section.
5. No ## heading for Tags or Links — they stay as inline "Tags:" and "Links:" lines.
6. No meeting summary content in the output — extract only what changed.
7. Consolidate action items — no duplicates across meetings.
8. Preserve - [x] checked items exactly.`;

  const mergeUserPrompt = `## Current Project.md
${projectMdContent}

---

## Meeting Summaries (read to update Project.md — do NOT include in output)
${allSummariesContent}

---

Output the updated Project.md only. Keep ## Project Context exactly as-is.
Tags line: Tags: #active-project #${projectSlug} [add relevant tags from meetings]
Links line: Links: [[${projectName}]]${clientName ? ` [[${clientName}]]` : ''}${summaryFileNames.slice(-3).map(f => ` [[${f}]]`).join('')}`;

  try {
    const updatedProjectMd = await callOpenRouter(mergeSystemPrompt, mergeUserPrompt);
    fs.writeFileSync(projectMdAbsPath, updatedProjectMd, 'utf-8');
  } catch (err: any) {
    console.error('[agent/generate-summary] Project.md merge failed:', err.message);
    // Non-fatal — summary was saved
  }

  res.json({
    success: true,
    summaryPath: `${meetingSummaryRelDir}/${summaryFileName}`,
    projectMdPath: projectMdRelPath,
  });
});
// POST /api/agent/project-md
// Body: { projectMdPath: string, content: string }
// Saves user-edited Project.md content.
app.post('/api/agent/project-md', authHeaderOnly, (req: any, res) => {
  const { vaultPath } = getUserScope(req.user.username);
  const { projectMdPath, content } = req.body;

  if (typeof projectMdPath !== 'string' || !projectMdPath.endsWith('.md'))
    return res.status(400).json({ error: 'projectMdPath must be a .md path' });
  if (typeof content !== 'string')
    return res.status(400).json({ error: 'content is required' });

  const absPath = safeJoin(vaultPath, projectMdPath);
  if (!absPath) return res.status(403).json({ error: 'Access denied' });

  try {
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to save Project.md' });
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
