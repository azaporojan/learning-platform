require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const passwords = require('./passwords');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cookie = require('cookie');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./db');
const { runMigrations } = require('./db/migrate');

const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3001', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
// Optional: the first user who registers with this email is auto-promoted to admin.
const BOOTSTRAP_ADMIN_EMAIL = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();

// The JWT secret signs every session cookie. A missing/short secret in production would let
// anyone forge an admin session, so refuse to start rather than fall back to a known value.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  if (isProduction) {
    console.error('[FATAL] JWT_SECRET must be set and at least 32 characters long in production.');
    process.exit(1);
  }
  console.warn('[WARN] JWT_SECRET is missing or short — using an insecure development fallback.');
}
const jwtSecret = JWT_SECRET && JWT_SECRET.length >= 32 ? JWT_SECRET : 'insecure-development-only-secret-do-not-use';

// PASSWORD_PEPPER encrypts every stored password hash (see passwords.js): a copy of the database
// alone is useless for cracking. Like JWT_SECRET, production refuses to start without it.
try {
  console.log(`[Passwords] Hashes are sealed with key ${passwords.configure(process.env)}`);
} catch (err) {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
}

// CORS origins - only needed when the client is served from a different origin (local dev).
// In production the client build is served by this server, so the browser never sends CORS.
const allowedOrigins = isProduction
  ? [FRONTEND_URL]
  : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:4173', FRONTEND_URL];

// Running behind Dokploy's Traefik proxy: trust X-Forwarded-* for req.ip / secure cookies.
app.set('trust proxy', 1);
app.disable('x-powered-by');

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true
  }
});

// Track online users: Map<userId, {socketId, name, avatar_url}>
const onlineUsers = new Map();

// ---------------------------------------------------------------------------
// Socket.IO helpers — rooms keep chat traffic and notifications private.
//   user:<id>  → every socket of that user
//   chat:<id>  → every socket of every member of that chat
// ---------------------------------------------------------------------------
const userRoom = (userId) => `user:${userId}`;
const chatRoom = (chatId) => `chat:${chatId}`;
const emitToUser = (userId, event, payload) => io.to(userRoom(userId)).emit(event, payload);
const emitToChat = (chatId, event, payload) => io.to(chatRoom(chatId)).emit(event, payload);
const joinChatRoom = (userId, chatId) => io.in(userRoom(userId)).socketsJoin(chatRoom(chatId));
const leaveChatRoom = (userId, chatId) => io.in(userRoom(userId)).socketsLeave(chatRoom(chatId));

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------
app.use(helmet({
  // The client bundle loads Tailwind/fonts from CDNs; a strict CSP is a follow-up.
  contentSecurityPolicy: false,
  // Uploaded images are embedded cross-origin during local dev (5173 → 3001).
  crossOriginResourcePolicy: { policy: isProduction ? 'same-origin' : 'cross-origin' },
}));
app.use(cors({
  origin: function (origin, callback) {
    // Same-origin / non-browser requests carry no Origin header.
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Rate limits: a general per-IP ceiling for the API and a much tighter one for the
// credential endpoints (password login, 2FA code, registration).
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Math.max(1, parseInt(process.env.AUTH_RATE_LIMIT || '20', 10)),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

// All routes live under /api so the built client can be served from the same origin.
const api = express.Router();
api.use(apiLimiter);
// Every route id is a SERIAL integer: a malformed one is a 404, not a PostgreSQL cast error (500).
for (const name of ['id', 'pathId', 'lessonId', 'taskId', 'userId', 'chatId', 'messageId']) {
  api.param(name, (req, res, next, value) => {
    if (!/^\d{1,9}$/.test(String(value))) return res.status(404).json({ error: 'Not found' });
    next();
  });
}
app.use('/api', api);

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------
const uploadsDir = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const INLINE_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif']);

// Serve uploads. Only raster images are rendered inline; everything else (HTML, JS, CSS,
// PDFs, archives, ...) is forced to download so a student submission can never execute
// as a page on this origin (stored XSS).
// Lesson materials live in <uploads>/lesson-files and are only served through
// /api/lesson-files/:id/* (which applies the lesson's lock rules) — never by the public route.
// The check runs on the decoded, normalised path: express.static decodes it (lesson%2Dfiles,
// ./lesson-files, x/../lesson-files) after routing, so matching the raw route is not enough.
api.use('/uploads', (req, res, next) => {
  let decoded;
  try { decoded = decodeURIComponent(req.path); } catch { return res.status(404).json({ error: 'Not found' }); }
  const normalised = path.posix.normalize(`/${decoded.replace(/\\/g, '/')}`).toLowerCase();
  if (normalised === '/lesson-files' || normalised.startsWith('/lesson-files/')) return res.status(404).json({ error: 'Not found' });
  next();
});
api.use('/uploads', express.static(uploadsDir, {
  index: false,
  dotfiles: 'deny',
  setHeaders: (res, filePath) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!INLINE_IMAGE_EXT.has(path.extname(filePath).toLowerCase())) {
      res.setHeader('Content-Disposition', 'attachment');
      res.setHeader('Content-Type', 'application/octet-stream');
    }
  }
}));

// Keep only a safe basename: strip directories and anything outside [A-Za-z0-9._-].
function safeFilename(originalName) {
  const base = path.basename(originalName || 'file');
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return (cleaned || 'file').slice(0, 150);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(6).toString('hex');
    cb(null, uniqueSuffix + '-' + safeFilename(file.originalname));
  }
});

// Upload size limits (MB). Submissions default to 25 MB, images to 10 MB; raise via env if needed.
const MAX_UPLOAD_BYTES = Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '25', 10)) * 1024 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = Math.max(1, parseInt(process.env.MAX_IMAGE_UPLOAD_MB || '10', 10)) * 1024 * 1024;

const ALLOWED_UPLOAD_EXT = new Set([
  '.jpeg', '.jpg', '.png', '.gif', '.pdf', '.doc', '.docx', '.txt', '.zip', '.rar',
  '.html', '.htm', '.css', '.js'
]);

const upload = multer({
  storage: storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 10 },
  fileFilter: (req, file, cb) => {
    // Allow documents, images, PDFs, archives and web files (HTML, CSS, JS) for submissions.
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_UPLOAD_EXT.has(ext)) {
      return cb(null, true);
    }
    cb(new Error('Invalid file type. Allowed: documents, images, PDFs, HTML, CSS, JS.'));
  }
});

// Images only (avatars, rich-text images): these are rendered inline, so no HTML/JS here.
const uploadImage = multer({
  storage: storage,
  limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES, files: 10 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (INLINE_IMAGE_EXT.has(ext) && /^image\/(jpeg|png|gif)$/.test(file.mimetype)) {
      return cb(null, true);
    }
    cb(new Error('Invalid image type. Allowed: JPEG, PNG, GIF.'));
  }
});

// ---------------------------------------------------------------------------
// Email (Nodemailer)
// ---------------------------------------------------------------------------
const emailEnabled = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);
if (!emailEnabled) {
  console.warn('[Email] EMAIL_USER/EMAIL_PASS not set — outgoing emails (login codes, notifications) are disabled (set LOG_LOGIN_CODES=true in dev to print login codes).');
}
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  // Never let a slow SMTP server hang a login request indefinitely.
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 20000,
});

// Send an email, or log it when SMTP is not configured (dev / CI).
async function deliverMail(message) {
  if (!emailEnabled) {
    // Production logs never carry full email addresses (a***@example.com); dev/test keep them
    const to = isProduction ? String(message.to).replace(/^(.)[^@]*/, '$1***') : message.to;
    console.log(`[Email] (disabled) to=${to} subject="${message.subject}"${message.link ? ` link=${message.link}` : ''}`);
    return;
  }
  const { link, ...mail } = message; // `link` is only for the log line above
  await transporter.sendMail(mail);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function verifySessionToken(token) {
  return jwt.verify(token, jwtSecret, { algorithms: ['HS256'] }); // { id, role, sv }
}

// A session cookie is valid only while its session version matches the user's: changing the
// password bumps the version, which signs out every other device at once.
async function sessionFromToken(token) {
  if (!token) return null;
  let decoded;
  try { decoded = verifySessionToken(token); } catch (e) { return null; }
  const [rows] = await db.query('SELECT role, session_version FROM users WHERE id = ?', [decoded.id]);
  if (rows.length === 0 || rows[0].session_version !== (decoded.sv || 0)) return null;
  // The role is read fresh here (not trusted from the token), so requireAdmin can reuse it
  return { ...decoded, role: rows[0].role, roleFromDb: true };
}

const SESSION_MS = 24 * 60 * 60 * 1000;
function issueSession(res, user) {
  const token = jwt.sign({ id: user.id, role: user.role, sv: user.session_version || 0 }, jwtSecret, { algorithm: 'HS256', expiresIn: '24h' });
  res.cookie('token', token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'strict' : 'lax',
    maxAge: SESSION_MS,
  });
}

// ---------------------------------------------------------------------------
// API keys (automation / AI agents). Format: lp_<40 hex>. Only the SHA-256 hash is
// stored; the key acts as the admin who created it and must not be revoked.
// ---------------------------------------------------------------------------
const API_KEY_PREFIX = 'lp_';
const hashApiKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

function generateApiKey() {
  const key = API_KEY_PREFIX + crypto.randomBytes(20).toString('hex');
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 11) };
}

// Resolve a bearer API key to its owning admin, or null when invalid/revoked.
async function authenticateApiKey(key) {
  if (typeof key !== 'string' || !key.startsWith(API_KEY_PREFIX) || key.length > 80) return null;
  const [rows] = await db.query(
    `SELECT k.id AS key_id, k.last_used_at, u.id AS user_id, u.role
       FROM api_keys k
       JOIN users u ON u.id = k.created_by
      WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
    [hashApiKey(key)]
  );
  if (rows.length === 0 || rows[0].role !== 'admin') return null;
  const row = rows[0];
  // Track usage (at most once a minute per key; fire-and-forget)
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60000) {
    db.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [row.key_id]).catch(() => {});
  }
  return { id: row.user_id, role: 'admin', apiKeyId: row.key_id };
}

// Authentication middleware: session cookie, or `Authorization: Bearer <api key>`.
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      const user = await authenticateApiKey(authHeader.slice(7).trim());
      if (!user) return res.status(401).json({ error: 'Invalid API key' });
      req.user = user;
      return next();
    } catch (err) {
      console.error('[Auth] API key lookup failed:', err);
      return res.status(500).json({ error: 'Server error.' });
    }
  }

  const token = req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const session = await sessionFromToken(token); // { id, role, sv }
    if (!session) return res.status(401).json({ error: 'Invalid token' });
    req.user = session;
    next();
  } catch (err) {
    console.error('[Auth] Session check failed:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};

// Admin-only middleware. The role is re-read from the database on every request so a
// demoted/deleted admin loses access immediately, not when their token expires.
const requireAdmin = async (req, res, next) => {
  try {
    // Session requests already carry the role read by sessionFromToken in this request
    const [rows] = req.user.roleFromDb ? [[{ role: req.user.role }]] : await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0 || rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.user.role = 'admin';
    next();
  } catch (err) {
    console.error('[Auth] requireAdmin error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
};

// Read the session from the cookie without rejecting anonymous requests.
async function optionalUserId(req) {
  const session = await sessionFromToken(req.cookies.token);
  return session ? session.id : null;
}

// Escape user-provided text before interpolating it into HTML emails.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Helper function to send email
const sendLoginCode = async (email, code) => {
  // Without SMTP, local dev / CI can opt in to printing the code (LOG_LOGIN_CODES=true) so you can
  // still log in. Never in production, and never by default (a staging box must not log codes).
  if (!emailEnabled && !isProduction && process.env.LOG_LOGIN_CODES === 'true') console.log(`[Email] (disabled) login code for ${email}: ${code}`);
  try {
    await deliverMail({
      from: `"Learning App" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Your Authentication Code',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px; max-width: 500px;">
          <h2 style="color: #333;">Learning App Login</h2>
          <p>Hello,</p>
          <p>Your authentication code is:</p>
          <h1 style="color: #4CAF50; letter-spacing: 5px; background: #f9f9f9; padding: 10px; text-align: center; border-radius: 5px;">${code}</h1>
          <p>This code expires in 10 minutes.</p>
          <p style="color: #999; font-size: 12px; margin-top: 20px;">If you didn't request this code, please ignore this email.</p>
        </div>
      `
    });
  } catch (error) {
    console.error('[ERROR] Failed to send email:', error);
    // Nu aruncam eroare aici ca sa nu blocam procesul, dar e bine de stiut
  }
};

// Absolute URL of an in-app path (deep link), e.g. '/courses/1?lesson=2&task=3'
const appUrl = (link) => `${FRONTEND_URL.replace(/\/+$/, '')}${link && link.startsWith('/') ? link : '/'}`;

// Helper function to send notification email. `message` is trusted HTML (escape user input
// before passing it); the button deep-links to `link` (an in-app path) when given.
const sendNotificationEmail = async (email, subject, message, link = null, actionLabel = 'Open in Learning Platform') => {

  try {
    const url = appUrl(link);
    await deliverMail({
      from: `"Learning Platform" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: subject,
      link: url,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px; max-width: 500px;">
          <h2 style="color: #333;">🎓 Learning Platform</h2>
          <p>${message}</p>
          <p style="margin-top: 20px;">
            <a href="${escapeHtml(url)}" style="background: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
              ${escapeHtml(actionLabel)}
            </a>
          </p>
          <p style="color: #999; font-size: 12px;">Or open: <a href="${escapeHtml(url)}" style="color: #999;">${escapeHtml(url)}</a></p>
          <p style="color: #999; font-size: 12px; margin-top: 20px;">This email was sent automatically by Learning Platform.</p>
        </div>
      `
    });
  } catch (error) {
    console.error('[ERROR] Failed to send notification email:', error);
  }
};

// Health check (Docker HEALTHCHECK / Dokploy)
api.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'db_unavailable' });
  }
});

// One wrong password (at login, or as the "current password" of a password change). The 10th in
// a row locks the account for 15 minutes, voids any login code already sent, and tells the owner.
async function recordFailedPassword(user) {
  const [after] = await db.query(
    `UPDATE users SET
       failed_login_attempts = CASE WHEN failed_login_attempts + 1 >= 10 THEN 0 ELSE failed_login_attempts + 1 END,
       locked_until = CASE WHEN failed_login_attempts + 1 >= 10 THEN NOW() + INTERVAL '15 minutes' ELSE locked_until END,
       login_code = CASE WHEN failed_login_attempts + 1 >= 10 THEN NULL ELSE login_code END,
       login_code_expires = CASE WHEN failed_login_attempts + 1 >= 10 THEN NULL ELSE login_code_expires END
     WHERE id = ? RETURNING locked_until`,
    [user.id]
  );
  const lockedNow = after[0] && after[0].locked_until && new Date(after[0].locked_until) > new Date() && !(user.locked_until && new Date(user.locked_until) > new Date());
  if (lockedNow) {
    sendNotificationEmail(
      user.email,
      'Your account was locked for 15 minutes 🔒',
      `There were 10 failed password attempts on your Learning Platform account, so logging in is paused for 15 minutes.<br><br>
       If this was you, wait and try again. If not, someone may be guessing your password: once you can log in,
       change it from your profile (or ask an administrator for help).`,
      '/courses',
      'Open the Learning Platform'
    );
  }
  return lockedNow;
}

api.post('/login', authLimiter, async (req, res) => {
  const { password } = req.body || {};
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : null;
  if (!email || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const [users] = await db.query(
      'SELECT id, email, password, role, is_approved, failed_login_attempts, locked_until FROM users WHERE email = ?',
      [email]
    );
    const user = users[0] || null;

    // Per-account lock (10 wrong passwords → 15 minutes), on top of the per-IP rate limit.
    // While locked, even the right password is refused — with the same answer, in the same time,
    // as a wrong password or an unknown email, so the lock reveals neither the account nor a
    // correct guess. The owner learns about the lock by email instead.
    const locked = Boolean(user && user.locked_until && new Date(user.locked_until) > new Date());

    // Unknown emails are checked against a dummy hash, so every case takes the same time
    const { ok, needsRehash, unreadable } = await passwords.verifyPassword(password, user && !locked ? user.password : null);
    if (!ok) {
      if (user && !locked && !unreadable) await recordFailedPassword(user);
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    if (user.failed_login_attempts > 0 || user.locked_until) {
      await db.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?', [user.id]);
    }
    // Verifică dacă contul e aprobat
    if (!user.is_approved && user.role !== 'admin') { // Adminii trec direct, de obicei, dar poți schimba
      return res.status(403).json({ error: 'Your account has not been approved by an administrator yet.' });
    }

    // Legacy / older hashes are upgraded transparently (after the approval check: no scrypt work
    // for an account that cannot log in anyway)
    if (needsRehash) {
      // Only if the hash is still the one just verified: a password changed meanwhile must win
      // Best effort: when the server is busy the upgrade simply waits for the next login
      try {
        await db.query('UPDATE users SET password = ? WHERE id = ? AND password = ?', [await passwords.hashPassword(password), user.id, user.password]);
      } catch (err) {
        if (!passwords.isBusy(err)) throw err;
      }
    }

    // Generează cod 6 cifre (CSPRNG)
    const code = crypto.randomInt(100000, 1000000).toString();

    // Salvează doar hash-ul codului în DB (expiră în 10 min)
    await db.query(
      "UPDATE users SET login_code = ?, login_code_expires = NOW() + INTERVAL '10 minutes', login_code_attempts = 0 WHERE id = ?",
      [passwords.hashLoginCode(code), user.id]
    );

    // Trimite email (sau loghează în consolă)
    await sendLoginCode(user.email, code);

    res.json({ message: 'Code sent via email.', step: 'code_required', userId: user.id });

  } catch (err) {
    if (passwords.isBusy(err)) return res.status(503).json({ error: 'The server is busy, please try again in a moment.' });
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// 2. Endpoint: Verificare Cod (Finalizează Login)
api.post('/verify-code', authLimiter, async (req, res) => {
  const { code } = req.body || {};
  // Same id rule as route params: digits only, int4-sized (1.5, "1e2" or a huge id would reach
  // PostgreSQL as a cast error)
  const userId = /^\d{1,9}$/.test(String(req.body?.userId)) ? Number(req.body.userId) : NaN;
  if (!Number.isInteger(userId) || typeof code !== 'string') {
    return res.status(400).json({ error: 'User ID and code are required.' });
  }

  try {
    const [users] = await db.query(
      'SELECT id, name, email, role, stars, avatar_url, is_approved, session_version, login_code, login_code_expires, login_code_attempts, locked_until FROM users WHERE id = ?',
      [userId]
    );
    if (users.length === 0) return res.status(404).json({ error: 'User not found.' });

    const user = users[0];

    // Approval is re-checked here too: an account un-approved after /login must not get a session
    if (!user.is_approved && user.role !== 'admin') {
      return res.status(403).json({ error: 'Your account has not been approved by an administrator yet.' });
    }

    // Verifică expirarea (și că există un cod activ); un cont blocat nu poate termina login-ul
    const now = new Date();
    if ((user.locked_until && new Date(user.locked_until) > now) || !user.login_code || !user.login_code_expires || new Date(user.login_code_expires) < now) {
      return res.status(400).json({ error: 'Code expired. Please try again.' });
    }

    // Verifică codul — max 5 încercări per cod, apoi codul este invalidat (anti brute-force)
    // Each try is claimed atomically BEFORE comparing, so parallel requests cannot exceed the
    // 5 tries per code (a read-then-write counter could be raced past its cap)
    const [claimed] = await db.query(
      `UPDATE users SET login_code_attempts = login_code_attempts + 1
       WHERE id = ? AND login_code IS NOT NULL AND login_code_attempts < 5 AND login_code_expires > NOW()
       RETURNING login_code, login_code_attempts`,
      [userId]
    );
    if (claimed.length === 0) {
      await db.query('UPDATE users SET login_code = NULL, login_code_expires = NULL, login_code_attempts = 0 WHERE id = ?', [userId]);
      return res.status(400).json({ error: 'Too many incorrect attempts. Please log in again.' });
    }
    if (!passwords.loginCodeMatches(code, claimed[0].login_code)) {
      if (claimed[0].login_code_attempts >= 5) {
        await db.query('UPDATE users SET login_code = NULL, login_code_expires = NULL, login_code_attempts = 0 WHERE id = ?', [userId]);
        return res.status(400).json({ error: 'Too many incorrect attempts. Please log in again.' });
      }
      return res.status(400).json({ error: 'Incorrect code.' });
    }

    // Login cu succes -> consumă codul (o singură dată: două cereri paralele nu pot folosi același cod)
    const [consumed] = await db.query(
      'UPDATE users SET login_code = NULL, login_code_expires = NULL, login_code_attempts = 0 WHERE id = ? AND login_code = ? RETURNING id',
      [userId, claimed[0].login_code]
    );
    if (consumed.length === 0) return res.status(400).json({ error: 'Code expired. Please try again.' });

    // Cookie HTTP-only cu JWT (poartă versiunea sesiunii)
    issueSession(res, user);

    res.json({
      message: 'Authentication successful!',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        stars: user.stars,
        avatar_url: user.avatar_url || null
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// 3. Endpoint: Check Session (Verifică dacă userul e logat prin cookie)
api.get('/me', async (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const decoded = await sessionFromToken(token);
    if (!decoded) return res.status(401).json({ error: 'Invalid token' });

    const [users] = await db.query('SELECT id, name, email, role, stars, avatar_url, password_changed_at FROM users WHERE id = ?', [decoded.id]);
    if (users.length === 0) return res.status(404).json({ error: 'User not found' });

    res.json({ user: users[0] });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// Update own profile (name + avatar) - must be authenticated
api.put('/me', async (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const decoded = await sessionFromToken(token);
    if (!decoded) return res.status(401).json({ error: 'Invalid token' });
    const { name, avatar_url } = req.body || {};

    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 255) {
      return res.status(400).json({ error: 'Name must be at least 2 characters.' });
    }
    // Avatars are always files uploaded through /upload-image on this server.
    if (avatar_url && (typeof avatar_url !== 'string' || !/^\/uploads\/[A-Za-z0-9._-]+$/.test(avatar_url))) {
      return res.status(400).json({ error: 'Invalid avatar URL.' });
    }

    await db.query(
      'UPDATE users SET name = ?, avatar_url = ? WHERE id = ?',
      [name.trim(), avatar_url || null, decoded.id]
    );

    const [users] = await db.query('SELECT id, name, email, role, stars, avatar_url FROM users WHERE id = ?', [decoded.id]);
    if (users.length === 0) return res.status(404).json({ error: 'User not found' });

    res.json({ user: users[0] });
  } catch (err) {
    console.error(err);
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// Change own password: needs the current one. Every other session is signed out (session version
// bump), this one gets a fresh cookie, and the user is told by email in case it was not them.
// Per user, not per IP: a classroom behind one NAT shares an IP (and the login limiter), and
// wrong current passwords already count toward the account lock
const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20, // above the 10-wrong-passwords account lock, so the lock decides first
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user.id}`,
  message: { error: 'Too many attempts. Please try again later.' },
});
api.put('/me/password', authenticateToken, passwordChangeLimiter, async (req, res) => {
  const { current_password: current, new_password: next } = req.body || {};
  if (typeof current !== 'string' || typeof next !== 'string') {
    return res.status(400).json({ error: 'current_password and new_password are required.' });
  }
  try {
    const [rows] = await db.query('SELECT id, name, email, role, password, locked_until FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = rows[0];
    // Guessing the current password from a stolen session counts like guessing it at login
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(429).json({ error: 'Too many wrong passwords. Please try again in 15 minutes.' });
    }
    const check = await passwords.verifyPassword(current, user.password);
    if (check.unreadable) {
      // A server key problem, not a wrong password: don't make the user retype it
      return res.status(503).json({ error: 'Password changes are temporarily unavailable. Please try again later.' });
    }
    if (!check.ok) {
      if (!check.unreadable && await recordFailedPassword(user)) {
        return res.status(429).json({ error: 'Too many wrong passwords. Please try again in 15 minutes.' });
      }
      return res.status(400).json({ error: 'Your current password is incorrect.' });
    }
    if (current === next) return res.status(400).json({ error: 'The new password must be different from the current one.' });
    const problem = await passwords.validateNewPassword(next, { email: user.email, name: user.name });
    if (problem) return res.status(400).json({ error: problem });

    const [updated] = await db.query(
      `UPDATE users SET password = ?, password_changed_at = NOW(), session_version = session_version + 1,
         failed_login_attempts = 0, locked_until = NULL, login_code = NULL, login_code_expires = NULL
       WHERE id = ? AND password = ? RETURNING id, role, session_version, password_changed_at`,
      [await passwords.hashPassword(next), user.id, user.password]
    );
    // Only if the password is still the one just verified: of two concurrent changes, one wins
    if (updated.length === 0) return res.status(409).json({ error: 'Your password was changed meanwhile. Please sign in again.' });
    issueSession(res, updated[0]);
    // Close every live socket of this user. Other devices cannot reconnect (their cookie is now
    // stale); this device reconnects at once with its fresh cookie (SocketContext).
    io.in(userRoom(user.id)).disconnectSockets(true);
    sendNotificationEmail(
      user.email,
      'Your password was changed 🔐',
      `Hello <strong>${escapeHtml(user.name)}</strong>,<br><br>The password of your Learning Platform account was just changed and every other device was signed out.<br><br>
       <strong>If this was not you</strong>, contact an administrator right away.`,
      '/courses',
      'Open the Learning Platform'
    );
    res.json({ success: true, password_changed_at: updated[0].password_changed_at });
  } catch (err) {
    if (passwords.isBusy(err)) return res.status(503).json({ error: 'The server is busy, please try again in a moment.' });
    console.error('[PUT /me/password] Error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// 4. Endpoint: Logout (Șterge cookie-ul)
api.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out successfully' });
});

// Helper function to create notification
async function createNotification(userId, type, title, message, link = null, metadata = null) {
  try {
    const [result] = await db.query(
      'INSERT INTO notifications (user_id, type, title, message, link, metadata) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, type, title, message, link, metadata ? JSON.stringify(metadata) : null]
    );

    // Get the created notification
    const [notifications] = await db.query('SELECT * FROM notifications WHERE id = ?', [result.insertId]);
    if (notifications.length > 0) {
      const notification = notifications[0];

      // Parse metadata if it's a string
      if (notification.metadata && typeof notification.metadata === 'string') {
        try {
          notification.metadata = JSON.parse(notification.metadata);
        } catch (e) {
          console.error('[Notification] Failed to parse metadata:', e);
          notification.metadata = null;
        }
      }

      // Emit to that user's sockets only
      emitToUser(userId, 'new_notification', { userId, notification });
    }
  } catch (error) {
    console.error('[Notification] Error creating notification:', error);
  }
}

// Every notification goes out twice, with the same deep link: in the app (bell) and by email.
//   link       in-app path the notification opens, e.g. taskLink(id) or '/courses'
//   emailHtml  (user) => HTML body for the email; defaults to the escaped message
//   email      false = in-app only
// The email is not awaited: a slow SMTP server must not hold up the request that caused it.
async function notifyUser(userId, { type, title, message, link = null, metadata = null, emailHtml = null, email = true, actionLabel }) {
  try {
    await createNotification(userId, type, title, message, link, metadata);
    if (!email) return;
    const [rows] = await db.query('SELECT name, email FROM users WHERE id = ?', [userId]);
    if (rows.length === 0) return;
    const body = emailHtml
      ? emailHtml(rows[0])
      : `Hello <strong>${escapeHtml(rows[0].name)}</strong>!<br><br>${escapeHtml(message).replace(/\n/g, '<br>')}`;
    sendNotificationEmail(rows[0].email, title, body, link, actionLabel);
  } catch (error) {
    console.error('[Notification] Error notifying user:', error);
  }
}

// Helper function to notify all admins (in the app and by email)
async function notifyAdmins(type, title, message, link = null, metadata = null, emailHtml = null) {
  try {
    const [admins] = await db.query("SELECT id FROM users WHERE role = 'admin'");
    for (const admin of admins) {
      await notifyUser(admin.id, { type, title, message, link, metadata, emailHtml });
    }
  } catch (error) {
    console.error('[Notification] Error notifying admins:', error);
  }
}

// Deep link to a task on its course road (CoursePage opens it from ?lesson=&task=; for an admin
// it opens the task's submissions). Falls back to the catalogue for a phase outside any course.
async function taskLink(taskId) {
  const [rows] = await db.query(
    `SELECT t.id, l.id AS lesson_id, p.course_id FROM tasks t
     INNER JOIN lessons l ON l.id = t.lesson_id INNER JOIN paths p ON p.id = l.path_id WHERE t.id = ?`,
    [taskId]
  );
  if (rows.length === 0 || rows[0].course_id === null) return '/courses';
  return `/courses/${rows[0].course_id}?lesson=${rows[0].lesson_id}&task=${rows[0].id}`;
}

// The account-approved notice, shared by POST /users/:id/approve and the admin user editor.
async function notifyAccountApproved(userId) {
  await db.query(
    "UPDATE notifications SET status = 'approved', is_read = TRUE WHERE type = 'new_user_pending' AND (metadata->>'userId')::int = ?",
    [userId]
  );
  await notifyUser(userId, {
    type: 'account_approved',
    title: 'Account Approved! 🎉',
    message: 'Your account has been approved by an administrator. You can now access the platform.',
    link: '/courses',
    actionLabel: 'Log in and start learning',
    emailHtml: (u) => `Hello <strong>${escapeHtml(u.name)}</strong>!<br><br>Your account on the Learning Platform has been approved by an administrator. You can now log in and start learning!`,
  });
}

// Register Endpoint
api.post('/register', authLimiter, async (req, res) => {
  let { name, email, password } = req.body || {};

  if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  name = name.trim();
  email = email.trim().toLowerCase();
  if (name.length < 2 || name.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
    return res.status(400).json({ error: 'A valid name and email are required.' });
  }
  // Synchronous rules first (cheap); the breach lookup runs below, once the email is known to be free
  const passwordError = passwords.passwordProblem(password, { email, name });
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }

  // The configured bootstrap admin is created approved + admin so the first login works
  // without shell access to the server.
  const isBootstrapAdmin = BOOTSTRAP_ADMIN_EMAIL && email === BOOTSTRAP_ADMIN_EMAIL;

  try {
    const [existingUsers] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      return res.status(409).json({ error: 'This email is already registered.' });
    }

    const breached = await passwords.validateNewPassword(password, { email, name });
    if (breached) return res.status(400).json({ error: breached });
    const hashedPassword = await passwords.hashPassword(password);

    const [result] = await db.query(
      'INSERT INTO users (name, email, password, role, stars, is_approved, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [name, email, hashedPassword, isBootstrapAdmin ? 'admin' : 'student', 0, isBootstrapAdmin]
    );

    if (isBootstrapAdmin) {
      console.log(`[Auth] Bootstrap admin account created for ${email}`);
      return res.status(201).json({ message: 'Admin account created successfully! You can log in now.', userId: result.insertId });
    }

    // Notify all admins about new user registration
    // ...in the app and by email, both opening the user's row on the Users page
    await notifyAdmins(
      'new_user_pending',
      'New User Registered',
      `${name} (${email}) is waiting for approval.`,
      `/users?user=${result.insertId}`,
      { userId: result.insertId, email, name },
      () => `A new user <strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) is waiting for approval on the Learning Platform.`
    );

    res.status(201).json({
      message: 'Account created successfully! Waiting for administrator approval.',
      userId: result.insertId
    });

  } catch (err) {
    if (passwords.isBusy(err)) return res.status(503).json({ error: 'The server is busy, please try again in a moment.' });
    console.error('Registration Error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// 5. Endpoint: Get All Users (Leaderboard) - Exclude admins and unapproved users
api.get('/users', async (req, res) => {
  try {
    const [users] = await db.query("SELECT id, name, stars, avatar_url FROM users WHERE role != 'admin' AND is_approved = TRUE ORDER BY stars DESC");
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Approve user (admin only)
api.post('/users/:id/approve', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user is admin
    const [userRows] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    if (userRows.length === 0 || userRows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Get user details
    const [targetUser] = await db.query('SELECT name, email FROM users WHERE id = ?', [id]);
    if (targetUser.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Approve user, then tell them (in the app and by email)
    await db.query('UPDATE users SET is_approved = TRUE WHERE id = ?', [id]);
    await notifyAccountApproved(id);

    res.json({ message: 'User approved successfully' });
  } catch (error) {
    console.error('[Approve User] Error:', error);
    res.status(500).json({ error: 'Failed to approve user' });
  }
});

// Clear a password lock early (admin only): the 15-minute lock after 10 wrong passwords can be
// triggered by anyone who knows the email, so an admin can lift it for the owner
api.post('/users/:id/unlock', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      'UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ? RETURNING id', [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('[Unlock User] Error:', error);
    res.status(500).json({ error: 'Failed to unlock user' });
  }
});

// Reject user (admin only)
api.post('/users/:id/reject', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user is admin
    const [userRows] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    if (userRows.length === 0 || userRows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Get user details
    const [targetUser] = await db.query('SELECT name, email FROM users WHERE id = ?', [id]);
    if (targetUser.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update all pending notifications for this user to rejected
    await db.query(
      "UPDATE notifications SET status = 'rejected', is_read = TRUE WHERE type = 'new_user_pending' AND (metadata->>'userId')::int = ?",
      [id]
    );

    // Email only: the account (and with it any in-app notification) is deleted right below
    sendNotificationEmail(
      targetUser[0].email,
      'Registration Request Rejected',
      `Hello <strong>${escapeHtml(targetUser[0].name)}</strong>.<br><br>Unfortunately, your registration request on the Learning Platform has been rejected by an administrator.`,
      '/',
      'Visit the Learning Platform'
    );

    // Delete user
    await db.query('DELETE FROM users WHERE id = ?', [id]);

    res.json({ message: 'User rejected and deleted' });
  } catch (error) {
    console.error('[Reject User] Error:', error);
    res.status(500).json({ error: 'Failed to reject user' });
  }
});

// ================================================
// USER MANAGEMENT ENDPOINTS (Admin only)
// ================================================

// Get all users (Admin only, including all fields)
api.get('/admin/users', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    const [currentUser] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    if (currentUser.length === 0 || currentUser[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const [users] = await db.query(
      'SELECT id, name, email, role, stars, avatar_url, is_approved, created_at FROM users ORDER BY created_at DESC'
    );
    const [enrolments] = await db.query(`
      SELECT ce.user_id, c.id, c.name FROM course_enrollments ce
      INNER JOIN courses c ON c.id = ce.course_id ORDER BY c.name ASC`);
    const byUser = new Map();
    enrolments.forEach((e) => {
      const list = byUser.get(e.user_id) || [];
      list.push({ id: e.id, name: e.name });
      byUser.set(e.user_id, list);
    });
    users.forEach((u) => { u.courses = byUser.get(u.id) || []; });

    res.json(users);
  } catch (error) {
    console.error('[Admin Get Users] Error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Update user (Admin only)
api.put('/admin/users/:id', authenticateToken, requireAdmin, uploadImage.single('avatar'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, role, is_approved } = req.body;

    // Check if user is admin
    const [currentUser] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    if (currentUser.length === 0 || currentUser[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Check if target user exists
    const [targetUser] = await db.query('SELECT * FROM users WHERE id = ?', [id]);
    if (targetUser.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prepare update fields
    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }

    if (email !== undefined) {
      // Stored lowercase, like registration, so the login lookup keeps matching
      const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 255) {
        return res.status(400).json({ error: 'A valid email is required.' });
      }
      const [taken] = await db.query('SELECT id FROM users WHERE email = ? AND id <> ?', [normalized, id]);
      if (taken.length > 0) return res.status(409).json({ error: 'This email is already used by another account.' });
      updates.push('email = ?');
      values.push(normalized);
    }

    if (role !== undefined) {
      if (role !== 'admin' && role !== 'student') {
        return res.status(400).json({ error: 'Invalid role' });
      }
      updates.push('role = ?');
      values.push(role);
    }

    if (is_approved !== undefined) {
      updates.push('is_approved = ?');
      values.push(is_approved === 'true' || is_approved === true);
    }

    // Handle avatar upload
    if (req.file) {
      const avatarPath = `/uploads/${req.file.filename}`;
      updates.push('avatar_url = ?');
      values.push(avatarPath);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);

    await db.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    // Approving from the editor is the same event as the Approve button: tell the user
    const before = targetUser[0];
    if (is_approved !== undefined && !before.is_approved && (is_approved === 'true' || is_approved === true)) {
      await notifyAccountApproved(Number(id));
    }
    if (role !== undefined && role !== before.role) {
      await notifyUser(Number(id), {
        type: 'role_changed',
        title: role === 'admin' ? 'You are now an administrator 🛠️' : 'Your role changed',
        message: role === 'admin'
          ? 'An administrator gave you admin rights on the Learning Platform.'
          : 'Your account is now a student account on the Learning Platform.',
        link: '/courses',
        metadata: { role },
      });
    }

    // Get updated user
    const [updatedUser] = await db.query(
      'SELECT id, name, email, role, stars, avatar_url, is_approved, created_at FROM users WHERE id = ?',
      [id]
    );

    res.json({ message: 'User updated successfully', user: updatedUser[0] });
  } catch (error) {
    console.error('[Admin Update User] Error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete user (Admin only)
api.delete('/admin/users/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user is admin
    const [currentUser] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    if (currentUser.length === 0 || currentUser[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Prevent admin from deleting themselves
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Check if target user exists
    const [targetUser] = await db.query('SELECT * FROM users WHERE id = ?', [id]);
    if (targetUser.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Delete user (CASCADE will handle related records)
    await db.query('DELETE FROM users WHERE id = ?', [id]);

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('[Admin Delete User] Error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Add stars to user (Admin only)
api.post('/admin/users/:id/add-stars', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { stars } = req.body;

    // Check if user is admin
    const [currentUser] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    if (currentUser.length === 0 || currentUser[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Validate stars amount
    if (!stars || isNaN(stars) || parseInt(stars) <= 0) {
      return res.status(400).json({ error: 'Invalid stars amount' });
    }

    const starsToAdd = parseInt(stars);

    // Check if target user exists
    const [targetUser] = await db.query('SELECT id, name, email, stars FROM users WHERE id = ?', [id]);
    if (targetUser.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Add stars to user
    await db.query('UPDATE users SET stars = stars + ? WHERE id = ?', [starsToAdd, id]);

    // Get updated user
    const [updatedUser] = await db.query('SELECT id, name, email, role, stars, avatar_url FROM users WHERE id = ?', [id]);

    // Create notification for user
    await notifyUser(parseInt(id), {
      type: 'stars_received',
      title: `⭐ +${starsToAdd} Stars Received!`,
      message: `You've received ${starsToAdd} star${starsToAdd > 1 ? 's' : ''} from the administrator! Keep up the great work!`,
      link: '/users',
      actionLabel: 'See the leaderboard',
      metadata: { starsAdded: starsToAdd, newTotal: updatedUser[0].stars },
    });

    // Emit Socket.IO events to update UI
    io.emit('leaderboard:update'); // Update leaderboard for everyone
    io.emit('user:stars_updated', { userId: parseInt(id), stars: updatedUser[0].stars }); // Update user's header

    res.json({ 
      message: 'Stars added successfully', 
      user: updatedUser[0],
      starsAdded: starsToAdd 
    });
  } catch (error) {
    console.error('[Admin Add Stars] Error:', error);
    res.status(500).json({ error: 'Failed to add stars' });
  }
});

// Get notifications for current user
api.get('/notifications', authenticateToken, async (req, res) => {
  try {
    const [notifications] = await db.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );

    // Parse metadata JSON safely
    const parsedNotifications = notifications.map(n => {
      let parsedMetadata = n.metadata;
      if (n.metadata && typeof n.metadata === 'string') {
        try {
          parsedMetadata = JSON.parse(n.metadata);
        } catch (e) {
          console.error('[Get Notifications] Failed to parse metadata for notification', n.id);
          parsedMetadata = null;
        }
      }
      return {
        ...n,
        metadata: parsedMetadata
      };
    });

    res.json(parsedNotifications);
  } catch (error) {
    console.error('[Get Notifications] Error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Mark notification as read
api.put('/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    await db.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    console.error('[Mark Notification Read] Error:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// Mark all notifications as read
api.put('/notifications/mark-all-read', authenticateToken, async (req, res) => {
  try {
    await db.query(
      'UPDATE notifications SET is_read = TRUE WHERE user_id = ?',
      [req.user.id]
    );

    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    console.error('[Mark All Read] Error:', error);
    res.status(500).json({ error: 'Failed to mark all notifications as read' });
  }
});

// Delete notification
api.delete('/notifications/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    await db.query(
      'DELETE FROM notifications WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    res.json({ message: 'Notification deleted' });
  } catch (error) {
    console.error('[Delete Notification] Error:', error);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

// Delete all notifications
api.delete('/notifications', authenticateToken, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM notifications WHERE user_id = ?',
      [req.user.id]
    );

    res.json({ message: 'All notifications deleted' });
  } catch (error) {
    console.error('[Delete All Notifications] Error:', error);
    res.status(500).json({ error: 'Failed to delete all notifications' });
  }
});

// Mark task as viewed by student (remove NEW badge)
api.post('/tasks/:taskId/mark-viewed', authenticateToken, async (req, res) => {
  const { taskId } = req.params;
  const userId = req.user.id;

  try {
    // Update viewed_at timestamp for this student-task combination
    await db.query(`
      INSERT INTO user_task_views (user_id, task_id, viewed_at)
      VALUES (?, ?, NOW())
      ON CONFLICT (user_id, task_id) DO UPDATE SET viewed_at = NOW()
    `, [userId, taskId]);

    // Emit Socket.IO event for live badge update
    io.emit('task:viewed', { taskId, userId });

    res.json({ success: true, message: 'Task marked as viewed' });
  } catch (error) {
    console.error('[Mark Task Viewed] Error:', error);
    res.status(500).json({ error: 'Failed to mark task as viewed' });
  }
});

// --- PATHS API ---

// Get all paths with unlock status for current user
// Courses (course → phases → lessons → tasks), enrolment and the users directory.
const courseRoutes = require('./courses');
courseRoutes.registerCourseRoutes({ api, db, io, authenticateToken, requireAdmin, optionalUserId });
const studySets = require('./studySets');
studySets.registerStudySetRoutes({ api, db, io, authenticateToken, requireAdmin, phaseLockReasons: courseRoutes.phaseLockReasons });
const lessonFiles = require('./lessonFiles').registerLessonFileRoutes({ api, db, io, authenticateToken, requireAdmin, phaseLockReasons: courseRoutes.phaseLockReasons, uploadsDir });

api.get('/paths', async (req, res) => {
  const userId = await optionalUserId(req);
  let userRole = 'student';

  try {
    const [paths] = await db.query('SELECT * FROM paths ORDER BY course_id ASC NULLS LAST, order_index ASC, stars_required ASC, id ASC');

    // Get user's stars, role, and unlocked paths
    let userStars = 0;
    let unlockedPathIds = new Set();

    if (userId) {
      const [userRows] = await db.query('SELECT stars, role FROM users WHERE id = ?', [userId]);
      if (userRows.length > 0) {
        userStars = userRows[0].stars || 0;
        userRole = userRows[0].role || 'student';
      }

      const [unlockedRows] = await db.query('SELECT path_id FROM user_paths WHERE user_id = ?', [userId]);
      unlockedRows.forEach(row => unlockedPathIds.add(row.path_id));
    }

    // Calculate status for each path
    const pathsWithStatus = paths.map(path => {
      let status = 'locked';

      // Admin has access to all paths automatically
      if (userRole === 'admin') {
        status = 'in-progress';
      } else if (unlockedPathIds.has(path.id)) {
        status = 'in-progress';
      } else if (path.stars_required === 0 || userStars >= path.stars_required) {
        status = 'unlocked'; // User can unlock this path
      }

      return {
        id: path.id.toString(),
        title: path.name,
        description: path.description,
        status,
        requiredScore: path.stars_required,
        course_id: path.course_id,
        order_index: path.order_index,
        requires_previous: path.requires_previous
      };
    });

    res.json(pathsWithStatus);
  } catch (error) {
    console.error('[/paths] Error:', error);
    res.status(500).json({ error: 'Failed to fetch paths' });
  }
});

// Create new path (admin only)
api.post('/paths', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, description, stars_required, course_id, requires_previous } = req.body;
    const phaseErrors = validatePhaseFields({ name, stars_required, course_id, requires_previous });
    if (phaseErrors.length > 0) return res.status(400).json({ error: phaseErrors.join('; ') });

    // A new phase goes to the end of its course's road (placePhase keeps the numbering 1..n).
    const courseId = course_id ?? null;
    const created = await db.transaction(async (tx) => {
      const [result] = await tx.query(
        'INSERT INTO paths (name, description, stars_required, course_id, order_index, requires_previous) VALUES (?, ?, ?, ?, ?, ?)',
        [name.trim(), description || '', stars_required || 0, null, 1, requires_previous ?? true]
      );
      await courseRoutes.placePhase(tx, result.insertId, courseId, null);
      const [rows] = await tx.query('SELECT * FROM paths WHERE id = ?', [result.insertId]);
      return rows[0];
    });
    if (courseId !== null) io.emit('course:updated', { courseId });

    res.json({
      id: created.id,
      name: created.name,
      description: created.description,
      stars_required: created.stars_required,
      course_id: created.course_id,
      order_index: created.order_index,
      requires_previous: created.requires_previous
    });
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: error.message });
    console.error('[POST /paths] Error:', error);
    res.status(500).json({ error: 'Failed to create path' });
  }
});

// Optional course fields of a path ("phase"): where it sits on a course road and how it is gated.
const MAX_PHASES = 1000; // keeps placePhase's position * 2 far from the INTEGER range
function validatePhaseFields({ name, stars_required, course_id, order_index, requires_previous }) {
  const errors = [];
  if (typeof name !== 'string' || !name.trim() || name.length > 255) errors.push('name is required (max 255 chars)');
  if (stars_required !== undefined && stars_required !== null && (!Number.isInteger(stars_required) || stars_required < 0)) errors.push('stars_required must be a non-negative integer');
  if (course_id !== undefined && course_id !== null && (!Number.isInteger(course_id) || course_id < 1)) errors.push('course_id must be a positive integer or null');
  if (order_index !== undefined && (!Number.isInteger(order_index) || order_index < 1 || order_index > MAX_PHASES)) errors.push(`order_index must be an integer between 1 and ${MAX_PHASES}`);
  if (requires_previous !== undefined && typeof requires_previous !== 'boolean') errors.push('requires_previous must be a boolean');
  return errors;
}

// Update path (admin only)
api.put('/paths/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, stars_required, course_id, order_index, requires_previous } = req.body;
    const phaseErrors = validatePhaseFields({ name, stars_required, course_id, order_index, requires_previous });
    if (phaseErrors.length > 0) return res.status(400).json({ error: phaseErrors.join('; ') });

    // Course / order / gating fields are optional so older callers (and the agent API) that
    // send only name/description/stars_required keep working. A change of course or order goes
    // through placePhase so the phases of each affected course stay numbered 1..n.
    const touched = await db.transaction(async (tx) => {
      // No row lock on the path here: placePhase locks the course rows first (fixed lock order),
      // and only then are path rows written.
      const [before] = await tx.query('SELECT course_id FROM paths WHERE id = ?', [id]);
      if (before.length === 0) { const err = new Error('Path not found'); err.status = 404; throw err; }
      const oldCourseId = before[0].course_id;
      const newCourseId = course_id === undefined ? oldCourseId : course_id;
      if (course_id !== undefined || order_index !== undefined) {
        // Same course + no explicit position → keep its place; new course + no position → append.
        const position = order_index !== undefined ? order_index : (newCourseId === oldCourseId ? undefined : null);
        if (position !== undefined) await courseRoutes.placePhase(tx, Number(id), newCourseId, position); // renumbers both courses
      }

      const sets = ['name = ?', 'description = ?', 'stars_required = ?'];
      const params = [name.trim(), description || '', stars_required || 0];
      if (requires_previous !== undefined) { sets.push('requires_previous = ?'); params.push(requires_previous); }
      params.push(id);
      const [result] = await tx.query(`UPDATE paths SET ${sets.join(', ')} WHERE id = ?`, params);
      if (result.affectedRows === 0) { const err = new Error('Path not found'); err.status = 404; throw err; }
      return [oldCourseId, newCourseId].filter((c) => c !== null && c !== undefined);
    });

    new Set(touched).forEach((courseId) => io.emit('course:updated', { courseId }));
    res.json({ success: true });
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: error.message });
    console.error('[PUT /paths/:id] Error:', error);
    res.status(500).json({ error: 'Failed to update path' });
  }
});

// Delete path (admin only)
api.delete('/paths/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Deleting a phase closes the gap in its course's numbering and refreshes open course pages.
    const dropFiles = await lessonFiles.filesOf({ pathId: id });
    const courseId = await db.transaction(async (tx) => {
      const [rows] = await tx.query('SELECT course_id FROM paths WHERE id = ?', [id]);
      if (rows.length === 0) { const err = new Error('Path not found'); err.status = 404; throw err; }
      // Same lock order as placePhase: the course row first, then the path rows.
      await courseRoutes.lockCourses(tx, [rows[0].course_id]);
      const [deleted] = await tx.query('DELETE FROM paths WHERE id = ?', [id]);
      if (deleted.affectedRows === 0) { const err = new Error('Path not found'); err.status = 404; throw err; }
      if (rows[0].course_id !== null) await courseRoutes.renumberCourse(tx, rows[0].course_id);
      return rows[0].course_id;
    });
    dropFiles(); // lesson materials of the deleted phase
    if (courseId !== null) io.emit('course:updated', { courseId });
    res.json({ success: true });
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: error.message });
    console.error('[DELETE /paths/:id] Error:', error);
    res.status(500).json({ error: 'Failed to delete path' });
  }
});

// Access to a phase is decided by course enrolment and the phase gates (see courses.js);
// the former POST /paths/:id/unlock (stars-only) is gone. user_paths is kept only for the
// legacy "status" of GET /paths and for task-notification recipients.

// --- PATH & LESSONS API ---

// Get Lessons for a Path (including tasks and status for current user)
api.get('/paths/:pathId/details', async (req, res) => {
  const { pathId } = req.params;
  const userId = await optionalUserId(req);

  try {
    // 1. Get Lessons
    // Explicit columns: `script` (the admin-only teaching notes) must never travel with lesson rows.
    const [lessons] = await db.query(
      'SELECT id, path_id, title, description, position_x, position_y, order_index, parent_id, created_at, updated_at FROM lessons WHERE path_id = ? ORDER BY order_index ASC',
      [pathId]
    );

    // 2. Get Tasks for these lessons
    const lessonIds = lessons.map(l => l.id);
    let tasks = [];
    if (lessonIds.length > 0) {
      const [rows] = await db.query('SELECT * FROM tasks WHERE lesson_id = ANY(?)', [lessonIds]);
      tasks = rows;

      // Calculate unviewed submissions for admin
      if (userId && tasks.length > 0) {
        const [userRows] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (userRows.length > 0 && userRows[0].role === 'admin') {
          const [unviewedCounts] = await db.query(`
             SELECT task_id, COUNT(*) as count 
             FROM task_submissions 
             WHERE task_id = ANY(?)
             AND status != 'rejected'
             AND (is_viewed = FALSE OR is_viewed IS NULL)
             GROUP BY task_id
           `, [tasks.map(t => t.id)]);

          unviewedCounts.forEach(c => {
            const t = tasks.find(task => task.id === c.task_id);
            if (t) t.unviewed_count = c.count;
          });
        } else if (userRows.length > 0 && userRows[0].role === 'student') {
          // For students, check which tasks are NEW (not viewed yet)
          const [taskViews] = await db.query(`
            SELECT task_id, viewed_at
            FROM user_task_views
            WHERE user_id = ? AND task_id = ANY(?)
          `, [userId, tasks.map(t => t.id)]);

          // Create a map of task_id -> viewed_at
          const viewMap = new Map();
          taskViews.forEach(v => viewMap.set(v.task_id, v.viewed_at));

          // Mark tasks as NEW if they don't have a viewed_at timestamp
          tasks.forEach(task => {
            const viewed = viewMap.get(task.id);
            task.is_new = !viewed; // NEW if viewed_at is NULL
          });
        }
      }
    }

    // 3. Get User Progress (if logged in)
    let completedEntityIds = new Set();
    if (userId) {
      const [progress] = await db.query('SELECT entity_type, entity_id FROM user_progress WHERE user_id = ?', [userId]);
      progress.forEach(p => completedEntityIds.add(`${p.entity_type}_${p.entity_id}`));
    }

    // Same visibility rule as GET /courses/:id: in a phase the caller has not reached, task
    // briefs are withheld (titles and lesson summaries stay visible).
    const phaseLocked = (await courseRoutes.phaseLockReasons(db, userId, pathId)).length > 0;

    // Construct the response tree
    const result = lessons.map(lesson => {
      const lessonTasks = tasks.filter(t => t.lesson_id === lesson.id);
      const isLessonCompleted = completedEntityIds.has(`lesson_${lesson.id}`);

      // Check if unlocked: Previous lesson must be completed OR it's the first lesson
      // In a real app, you'd implement more complex logic based on mandatory tasks of previous lesson
      // For now, let's say Lesson N is unlocked if Lesson N-1 mandatory tasks are done.

      return {
        ...lesson,
        completed: isLessonCompleted,
        tasks: lessonTasks.map(t => ({
          ...t,
          description: phaseLocked ? '' : t.description,
          completed: completedEntityIds.has(`task_${t.id}`)
        }))
      };
    });

    res.json(result);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching path details.' });
  }
});

// Create New Lesson (Admin only)
api.post('/lessons', authenticateToken, requireAdmin, async (req, res) => {
  const { pathId, title, description, x, y, order, parentId } = req.body;

  try {
    const [result] = await db.query(
      'INSERT INTO lessons (path_id, title, description, position_x, position_y, order_index, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [pathId, title, description || '', x || 0, y || 0, order, parentId || null]
    );

    // Emit Socket.IO event for live lesson creation
    io.emit('lesson:created', { lessonId: result.insertId, pathId, title });

    res.status(201).json({ id: result.insertId, message: 'Lesson created' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create lesson' });
  }
});

// Optional graph fields shared by PUT /lessons/:id and PUT /tasks/:id. Each one is applied only
// when present, so existing callers that send title/description alone keep working.
function validateGraphFields({ order, x, y }) {
  const errors = [];
  if (order !== undefined && (!Number.isInteger(order) || order < 1)) errors.push('order must be a positive integer');
  if (x !== undefined && !Number.isInteger(x)) errors.push('x must be an integer');
  if (y !== undefined && !Number.isInteger(y)) errors.push('y must be an integer');
  return errors;
}

// Update Lesson (Admin only)
api.put('/lessons/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, description, order, x, y, parentId } = req.body;

  if (typeof title !== 'string' || !title.trim() || title.length > 255) {
    return res.status(400).json({ error: 'title is required (max 255 chars)' });
  }
  const errors = validateGraphFields({ order, x, y });
  if (parentId !== undefined && parentId !== null && (!Number.isInteger(parentId) || parentId < 1)) {
    errors.push('parentId must be a positive integer or null');
  }
  if (parentId !== undefined && parentId !== null && Number(parentId) === Number(id)) {
    errors.push('a lesson cannot be its own parent');
  }
  if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

  try {
    // Optional graph fields (order / position / parent) let an admin or the agent API move a
    // node without deleting it — deleting would cascade to tasks and student submissions.
    const sets = ['title = ?', 'description = ?'];
    const params = [title, description || ''];
    if (order !== undefined) { sets.push('order_index = ?'); params.push(order); }
    if (x !== undefined) { sets.push('position_x = ?'); params.push(x); }
    if (y !== undefined) { sets.push('position_y = ?'); params.push(y); }
    if (parentId !== undefined) { sets.push('parent_id = ?'); params.push(parentId); }
    params.push(id);
    const result = await db.query(`UPDATE lessons SET ${sets.join(', ')} WHERE id = ?`, params);
    if (result[0].affectedRows === 0) return res.status(404).json({ error: 'Lesson not found' });

    io.emit('lesson:updated', { lessonId: Number(id), title });
    res.json({ message: 'Lesson updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update lesson' });
  }
});

// Lesson script (Admin only): the teacher's Markdown notes for a lesson. Never sent to students —
// the course/road endpoints do not select this column, and /paths/:id/details strips it.
const MAX_SCRIPT_CHARS = 200000;
api.get('/lessons/:id/script', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, title, script, script_updated_at FROM lessons WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Lesson not found' });
    res.json({ id: rows[0].id, title: rows[0].title, script: rows[0].script || '', script_updated_at: rows[0].script_updated_at });
  } catch (err) {
    console.error('[GET /lessons/:id/script] Error:', err);
    res.status(500).json({ error: 'Failed to fetch lesson script' });
  }
});

api.put('/lessons/:id/script', authenticateToken, requireAdmin, async (req, res) => {
  const { script, expected_script_updated_at: expected } = req.body || {};
  if (typeof script !== 'string') return res.status(400).json({ error: 'script must be a string' });
  if (script.length > MAX_SCRIPT_CHARS) return res.status(400).json({ error: `script is too long (max ${MAX_SCRIPT_CHARS} characters)` });
  if (expected !== undefined && expected !== null && (typeof expected !== 'string' || Number.isNaN(Date.parse(expected)))) {
    return res.status(400).json({ error: 'expected_script_updated_at must be an ISO timestamp or null' });
  }
  try {
    // Optimistic concurrency in one statement: the write only happens if the script's own save
    // stamp still equals what the caller last read (null = "never saved" is a valid expectation).
    // Keep the date_trunc + IS NOT DISTINCT FROM: the column holds microseconds but the stamp the
    // client echoes back went through JSON/Date (milliseconds), so a plain `=` would never match;
    // IS NOT DISTINCT FROM is what lets `null` (never saved) compare as equal.
    const checked = expected !== undefined;
    const [updated] = await db.query(
      `UPDATE lessons SET script = ?, script_updated_at = NOW()
       WHERE id = ? ${checked ? "AND date_trunc('milliseconds', script_updated_at) IS NOT DISTINCT FROM ?::timestamptz" : ''}
       RETURNING script_updated_at`,
      checked ? [script, req.params.id, expected] : [script, req.params.id]
    );
    if (updated.length === 0) {
      const [current] = await db.query('SELECT script_updated_at FROM lessons WHERE id = ?', [req.params.id]);
      if (current.length === 0) return res.status(404).json({ error: 'Lesson not found' });
      return res.status(409).json({ error: 'This lesson script was changed elsewhere. Reload to see the latest version.', script_updated_at: current[0].script_updated_at });
    }
    res.json({ success: true, script_updated_at: updated[0].script_updated_at });
  } catch (err) {
    console.error('[PUT /lessons/:id/script] Error:', err);
    res.status(500).json({ error: 'Failed to save lesson script' });
  }
});

// Delete Lesson (Admin only)
api.delete('/lessons/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    // Get lesson info before deleting for Socket.IO event
    const [lessons] = await db.query('SELECT path_id FROM lessons WHERE id = ?', [id]);
    const pathId = lessons.length > 0 ? lessons[0].path_id : null;

    // Tasks (and lesson files) will be deleted automatically due to CASCADE; the files' bytes too
    const dropFiles = await lessonFiles.filesOf({ lessonId: id });
    await db.query('DELETE FROM lessons WHERE id = ?', [id]);
    dropFiles();

    // Emit Socket.IO event for live lesson deletion
    if (pathId) {
      io.emit('lesson:deleted', { lessonId: id, pathId });
    }

    res.json({ message: 'Lesson deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete lesson' });
  }
});

// Create New Task (Admin only)
api.post('/tasks', authenticateToken, requireAdmin, async (req, res) => {
  const { lessonId, title, type, xp, deadline, x, y, order, description } = req.body;

  try {
    // Normalise the deadline to an ISO timestamp (or null if not provided)
    let deadlineTs = null;
    if (deadline) {
      // If deadline is just a date (YYYY-MM-DD), use the end of that day
      const date = deadline.length === 10 ? new Date(deadline + 'T23:59:59') : new Date(deadline);
      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({ error: 'Invalid deadline' });
      }
      deadlineTs = date.toISOString();
    }

    const [result] = await db.query(
      'INSERT INTO tasks (lesson_id, title, type, xp_reward, deadline, position_x, position_y, order_index, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [lessonId, title, type, xp, deadlineTs, x || 0, y || 0, order || 1, description || '']
    );

    // Get lesson and path info for notification
    const [lessons] = await db.query(`
      SELECT l.title as lesson_title, l.path_id, p.name as path_name 
      FROM lessons l
      INNER JOIN paths p ON l.path_id = p.id
      WHERE l.id = ?
    `, [lessonId]);

    if (lessons.length > 0) {
      const lesson = lessons[0];
      const taskType = type === 'mandatory' ? 'Mandatory' : 'Optional';

      // Notify all students who have unlocked this path
      const [students] = await db.query(`
        SELECT DISTINCT u.id, u.name, u.email
        FROM users u
        WHERE u.role = 'student' AND u.is_approved = TRUE AND (
          EXISTS (SELECT 1 FROM user_paths up WHERE up.user_id = u.id AND up.path_id = ?)
          OR EXISTS (SELECT 1 FROM course_enrollments ce
                     INNER JOIN paths p ON p.course_id = ce.course_id
                     WHERE ce.user_id = u.id AND p.id = ?)
        )
      `, [lesson.path_id, lesson.path_id]);

      const link = await taskLink(result.insertId);
      for (const student of students) {
        // In the app and by email, both opening the task on the road
        await notifyUser(student.id, {
          type: 'new_task',
          title: 'New Task Available! 📝',
          message: `Task: "${title}" (${taskType})\nPath: ${lesson.path_name}\nLesson: ${lesson.lesson_title}`,
          link,
          actionLabel: 'Open the task',
          metadata: { taskId: result.insertId, lessonId, pathId: lesson.path_id, type, deadline: deadlineTs },
          emailHtml: () => `Hello <strong>${escapeHtml(student.name)}</strong>!<br><br>
          A new task has been added to your learning path:<br><br>
          <strong>Task:</strong> ${escapeHtml(title)}<br>
          <strong>Type:</strong> <span style="color: ${type === 'mandatory' ? '#dc2626' : '#16a34a'};">${taskType}</span><br>
          <strong>Path:</strong> ${escapeHtml(lesson.path_name)}<br>
          <strong>Lesson:</strong> ${escapeHtml(lesson.lesson_title)}<br>
          ${deadline ? `<strong>Deadline:</strong> ${new Date(deadline).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}<br>` : ''}
          <br>
          Log in to the platform to view the task details and start working on it!`,
        });
      }

      // Mark task as NEW for all these students (viewed_at = NULL means it's new)
      if (students.length > 0) {
        const values = students.map(student => [student.id, result.insertId, null]);
        await db.query(`
          INSERT INTO user_task_views (user_id, task_id, viewed_at)
          VALUES ?
        `, [values]);
      }
    }

    // Emit Socket.IO event for live task creation
    io.emit('task:created', {
      taskId: result.insertId,
      lessonId,
      title,
      type
    });

    res.status(201).json({ id: result.insertId, message: 'Task created' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// Update Task (Admin only)
api.put('/tasks/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, type, xp, deadline, description, order, x, y } = req.body;

  const errors = validateGraphFields({ order, x, y });
  if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

  try {
    // Normalise the deadline to an ISO timestamp (or null)
    let deadlineTs = null;
    if (deadline) {
      const date = new Date(deadline);
      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({ error: 'Invalid deadline' });
      }
      deadlineTs = date.toISOString();
    }

    const sets = ['title = ?', 'type = ?', 'xp_reward = ?', 'deadline = ?', 'description = ?'];
    const params = [title, type, xp || 0, deadlineTs, description || ''];
    if (order !== undefined) { sets.push('order_index = ?'); params.push(order); }
    if (x !== undefined) { sets.push('position_x = ?'); params.push(x); }
    if (y !== undefined) { sets.push('position_y = ?'); params.push(y); }
    params.push(id);
    const result = await db.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params);
    if (result[0].affectedRows === 0) return res.status(404).json({ error: 'Task not found' });

    // Emit Socket.IO event for live task update
    io.emit('task:updated', {
      taskId: id,
      title,
      type,
      xp,
      deadline
    });

    res.json({ message: 'Task updated' });
  } catch (err) {
    console.error('Error updating task:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// Delete Task (Admin only)
api.delete('/tasks/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    await db.query('DELETE FROM tasks WHERE id = ?', [id]);

    // Emit Socket.IO event for live task deletion
    io.emit('task:deleted', { taskId: id });

    res.json({ message: 'Task deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// Get Task Details
api.get('/tasks/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db.query(
      'SELECT * FROM tasks WHERE id = ?',
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }
    // The brief of a task in a phase the caller has not reached is withheld (see GET /courses/:id)
    const locked = ((await courseRoutes.taskLockReasons(db, req.user.id, id)) || []).length > 0;
    res.json(locked ? { ...rows[0], description: '' } : rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

// Upload Task Submission
api.post('/tasks/:id/submit', authenticateToken, upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id; // always the authenticated user — never trust the body
  const dropUpload = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  // multer decodes multipart file names as latin1: keep "Temă – Ștefan.docx" readable
  if (req.file) req.file.originalname = require('./lessonFiles').utf8Name(req.file.originalname);

  // A submission is a comment (pull-request link, Jira ticket, note), a file, or both.
  const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';
  if (comment.length > 4000) {
    dropUpload();
    return res.status(400).json({ error: 'Comment is too long (max 4000 characters)' });
  }
  if (!req.file && !comment) {
    return res.status(400).json({ error: 'Add a comment (e.g. a link to your work) or a file' });
  }

  try {
    // Phase gating is enforced here, not only in the UI: a student cannot submit to a task of a
    // phase they have not reached (not enrolled, previous phase unfinished, stars gate).
    const lockReasons = await courseRoutes.taskLockReasons(db, userId, id);
    if (lockReasons === null) {
      dropUpload();
      return res.status(404).json({ error: 'Task not found' });
    }
    if (lockReasons.length > 0) {
      dropUpload();
      return res.status(403).json({ error: 'This phase is locked for you', lockReasons });
    }

    const [result] = await db.query(
      'INSERT INTO task_submissions (task_id, user_id, file_name, file_path, file_size, comment) VALUES (?, ?, ?, ?, ?, ?)',
      [id, userId, req.file ? req.file.originalname : null, req.file ? req.file.filename : null, req.file ? req.file.size : null, comment || null]
    );

    // The submission is saved at this point: a failure while notifying admins must not turn
    // into a 500 (the student would retry and create a duplicate).
    try {
    // Get task, lesson, path and user info
    const [tasks] = await db.query('SELECT title, lesson_id, type FROM tasks WHERE id = ?', [id]);
    const [users] = await db.query('SELECT name, email FROM users WHERE id = ?', [userId]);

    if (tasks.length > 0 && users.length > 0) {
      const task = tasks[0];

      // Get lesson and path details
      const [lessons] = await db.query('SELECT title as lesson_title, path_id FROM lessons WHERE id = ?', [task.lesson_id]);
      let pathName = 'Unknown Path';
      let lessonTitle = 'Unknown Lesson';

      if (lessons.length > 0) {
        lessonTitle = lessons[0].lesson_title;
        const [paths] = await db.query('SELECT name FROM paths WHERE id = ?', [lessons[0].path_id]);
        if (paths.length > 0) {
          pathName = paths[0].name;
        }
      }

      // Create detailed notification message
      const notificationMessage = `${users[0].name} has submitted ${req.file ? 'a file' : 'a comment'} for task "${task.title}" (${task.type.charAt(0).toUpperCase() + task.type.slice(1)}) in lesson "${lessonTitle}" from path "${pathName}".`;

      // Notify all admins about the submission
      await notifyAdmins(
        'task_submission',
        'New Task Submission! 📤',
        notificationMessage,
        await taskLink(id), // opens the task's submissions on the road
        {
          taskId: id,
          userId,
          submissionId: result.insertId,
          fileName: req.file ? req.file.originalname : null,
          comment: comment ? (comment.length > 200 ? `${comment.slice(0, 200)}…` : comment) : null, // preview only
          taskTitle: task.title,
          taskType: task.type,
          lessonTitle,
          pathName
        },
        () => `A student has submitted a task:<br><br>
          <strong>Student:</strong> ${escapeHtml(users[0].name)}<br>
          <strong>Task:</strong> ${escapeHtml(task.title)}<br>
          <strong>Type:</strong> ${task.type.charAt(0).toUpperCase() + task.type.slice(1)}<br>
          <strong>Lesson:</strong> ${escapeHtml(lessonTitle)}<br>
          <strong>Path:</strong> ${escapeHtml(pathName)}<br>
          ${req.file ? `<strong>File:</strong> ${escapeHtml(req.file.originalname)}<br>` : ''}
          ${comment ? `<strong>Comment:</strong> ${escapeHtml(comment)}<br>` : ''}
          <br>Please review the submission in the platform.`
      );

      // Emit live event for Admin graph update
      io.emit('task:submission_uploaded', { taskId: id });
    }
    } catch (notifyErr) {
      console.error('[Submit] Saved, but notifying admins failed:', notifyErr);
    }

    res.status(201).json({
      id: result.insertId,
      message: 'Submission uploaded successfully',
      fileName: req.file ? req.file.originalname : null,
      comment: comment || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload submission' });
  }
});

// Get Task Submissions (Admin)
api.get('/tasks/:id/submissions', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const [roleRows] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    const isAdmin = roleRows.length > 0 && roleRows[0].role === 'admin';

    // If admin, mark as viewed
    if (isAdmin) {
      await db.query('UPDATE task_submissions SET is_viewed = TRUE WHERE task_id = ?', [id]);
    }

    // Admins see every submission; students only their own.
    const [rows] = await db.query(
      `SELECT s.*, u.name as user_name, u.email as user_email 
       FROM task_submissions s
       JOIN users u ON s.user_id = u.id
       WHERE s.task_id = ? ${isAdmin ? '' : 'AND s.user_id = ?'}
       ORDER BY s.submitted_at DESC`,
      isAdmin ? [id] : [id, req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

// All submissions across courses (Admin only): who submitted what, where it sits in the course,
// and its review status — the review inbox. ?status=pending|approved|rejected|all (default pending).
// Newest first, paged by cursor: pass `before=<next_cursor>` from the previous page to get older rows.
api.get('/admin/submissions', authenticateToken, requireAdmin, async (req, res) => {
  const status = ['pending', 'approved', 'rejected', 'all'].includes(req.query.status) ? req.query.status : 'pending';
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
  // A malformed cursor is an error, not "start over": restarting would repeat rows in an infinite scroll.
  if (req.query.before !== undefined && !/^\d{1,9}$/.test(String(req.query.before))) {
    return res.status(400).json({ error: 'before must be a submission id' });
  }
  const before = req.query.before !== undefined ? Number(req.query.before) : null;
  try {
    // task_submissions.status is NOT NULL DEFAULT 'pending' (001), so plain comparisons keep the
    // (status) index usable.
    const where = [];
    const params = [];
    if (status !== 'all') { where.push('s.status = ?'); params.push(status); }
    if (before !== null) { where.push('s.id < ?'); params.push(before); }
    const [rows] = await db.query(
      `SELECT s.id, s.status, s.submitted_at, s.is_viewed, s.file_name, s.file_size,
              LEFT(COALESCE(s.comment, ''), 300) AS comment,
              u.id AS user_id, u.name AS user_name, u.avatar_url AS user_avatar,
              t.id AS task_id, t.title AS task_title, t.type AS task_type, t.xp_reward,
              l.id AS lesson_id, l.title AS lesson_title,
              p.id AS path_id, p.name AS path_name, p.order_index AS phase_order,
              c.id AS course_id, c.name AS course_name
       FROM task_submissions s
       INNER JOIN users u ON u.id = s.user_id
       INNER JOIN tasks t ON t.id = s.task_id
       INNER JOIN lessons l ON l.id = t.lesson_id
       INNER JOIN paths p ON p.id = l.path_id
       LEFT JOIN courses c ON c.id = p.course_id
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.id DESC
       LIMIT ${limit + 1}`,
      params
    );
    // One extra row is fetched only to know whether an older page exists (no false "has_more"
    // when the total is an exact multiple of the page size).
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    // Per-status totals are computed for the first page only (an infinite scroll re-reads them
    // when it reloads the first page, not on every older page).
    let summary = null;
    if (before === null) {
      const [counts] = await db.query('SELECT status, COUNT(*)::int AS n FROM task_submissions GROUP BY status');
      summary = { pending: 0, approved: 0, rejected: 0 };
      counts.forEach((c) => { summary[c.status] = c.n; });
    }
    // A page of `limit` rows; `next_cursor` (when `has_more`) is the id to pass as `before` for the next page.
    res.json({ submissions: rows, counts: summary, limit, has_more: hasMore, next_cursor: hasMore ? rows[rows.length - 1].id : null });
  } catch (err) {
    console.error('[GET /admin/submissions] Error:', err);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

// Download Submission File by ID (with student name in filename)
api.get('/submissions/download/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db.query(
      `SELECT s.file_name, s.file_path, s.user_id, u.name as user_name 
       FROM task_submissions s 
       JOIN users u ON s.user_id = u.id 
       WHERE s.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const submission = rows[0];

    // Only the submitting student or an admin may download the file.
    if (submission.user_id !== req.user.id) {
      const [roleRows] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
      if (roleRows.length === 0 || roleRows[0].role !== 'admin') {
        return res.status(403).json({ error: 'Not authorized to download this submission' });
      }
    }

    if (!submission.file_path) {
      return res.status(404).json({ error: 'This submission has no file (comment only)' });
    }
    const filePath = path.join(uploadsDir, path.basename(submission.file_path));

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    const studentName = submission.user_name.replace(/[^a-zA-Z0-9_\-\s]/g, '').replace(/\s+/g, '_');
    const downloadName = `${studentName}-${submission.file_name}`;

    res.download(filePath, downloadName);
  } catch (err) {
    console.error('[Download] Error:', err);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// Delete Submission
api.delete('/submissions/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    // Get submission details first
    const [submissions] = await db.query('SELECT * FROM task_submissions WHERE id = ?', [id]);

    if (submissions.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const submission = submissions[0];

    // Check permissions: Owner or Admin
    if (submission.user_id !== req.user.id) {
      const [userRows] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
      if (userRows.length === 0 || userRows[0].role !== 'admin') {
        return res.status(403).json({ error: 'Not authorized to delete this submission' });
      }
    }

    // NEW: Prevent deletion if approved (unless admin, maybe? User said "student cant delete", usually admin can do anything. 
    // But let's stick to "if approved, it's final" logic for now, or allow admin to delete.
    // The user said "student cant delete them". Safest is to allow Admin to delete, but Student cannot.
    // Let's refine the check above or add a specific one.

    // If user is NOT admin (meaning it's the student owner), check status
    // We already checked ownership or admin above. Now we need to know if it's admin specifically to bypass this check.
    const [currentUser] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    const isRequestAdmin = currentUser.length > 0 && currentUser[0].role === 'admin';

    if (!isRequestAdmin && submission.status === 'approved') {
      return res.status(403).json({ error: 'Cannot delete an approved submission.' });
    }

    // Delete file from filesystem
    if (submission.file_path) {
      const filePath = path.join(uploadsDir, path.basename(submission.file_path));
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.error('[Delete Submission] Failed to delete file:', e);
          // Continue deleting the record even if file deletion fails
        }
      }
    }

    // Delete from database
    await db.query('DELETE FROM task_submissions WHERE id = ?', [id]);

    res.json({ message: 'Submission deleted successfully' });
  } catch (err) {
    console.error('[Delete Submission] Error:', err);
    res.status(500).json({ error: 'Failed to delete submission' });
  }
});

// Approve Submission
api.post('/submissions/:id/approve', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    // Check if user is admin
    const [userRows] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    if (userRows.length === 0 || userRows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Get submission details
    const [submissions] = await db.query('SELECT * FROM task_submissions WHERE id = ?', [id]);
    if (submissions.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    const submission = submissions[0];

    // Update submission status
    await db.query("UPDATE task_submissions SET status = 'approved' WHERE id = ?", [id]);

    // Mark task as completed for the user in user_progress
    // Check if tasks is already completed
    const [progress] = await db.query(
      "SELECT * FROM user_progress WHERE user_id = ? AND entity_type = 'task' AND entity_id = ?",
      [submission.user_id, submission.task_id]
    );

    if (progress.length === 0) {
      await db.query(
        "INSERT INTO user_progress (user_id, entity_type, entity_id) VALUES (?, 'task', ?)",
        [submission.user_id, submission.task_id]
      );
    }

    // Notify the user
    const [task] = await db.query('SELECT title FROM tasks WHERE id = ?', [submission.task_id]);
    const taskTitle = task.length > 0 ? task[0].title : 'Task';

    await notifyUser(submission.user_id, {
      type: 'submission_approved',
      title: 'Submission Approved! ✅',
      message: `Your submission for "${taskTitle}" has been approved! The next step is now unlocked.`,
      link: await taskLink(submission.task_id),
      metadata: { taskId: submission.task_id, submissionId: id },
      emailHtml: (u) => `Hello <strong>${escapeHtml(u.name)}</strong>!<br><br>
            Great news! Your submission for task <strong>"${escapeHtml(taskTitle)}"</strong> has been approved by an administrator.<br>
            You can now proceed to the next task in your learning path.`,
    });

    // Emit Socket.IO events for live updates
    // 1. Notify all users about leaderboard change
    io.emit('leaderboard:update');

    // 2. Notify about task completion for this specific user
    io.emit('task:completed', {
      userId: submission.user_id,
      taskId: submission.task_id
    });

    res.json({ message: 'Submission approved successfully' });
  } catch (err) {
    console.error('[Approve Submission] Error:', err);
    res.status(500).json({ error: 'Failed to approve submission' });
  }
});

// Approve All Submissions for a user and task
api.post('/tasks/:taskId/approve-all', authenticateToken, async (req, res) => {
  const { taskId } = req.params;
  const { studentId } = req.body;

  if (!studentId) return res.status(400).json({ error: 'Student ID required' });

  try {
    // Check if user is admin
    const [userRows] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    if (userRows.length === 0 || userRows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Get task info first
    const [taskRows] = await db.query('SELECT title, type, xp_reward FROM tasks WHERE id = ?', [taskId]);
    if (taskRows.length === 0) return res.status(404).json({ error: 'Task not found' });

    const task = taskRows[0];
    const taskTitle = task.title;
    const isMandatory = task.type === 'mandatory';
    const xpReward = task.xp_reward || 0;

    // Update all submissions for this user and task to approved
    await db.query(
      "UPDATE task_submissions SET status = 'approved' WHERE task_id = ? AND user_id = ?",
      [taskId, studentId]
    );

    // Mark task as completed for the user in user_progress
    const [progress] = await db.query(
      "SELECT * FROM user_progress WHERE user_id = ? AND entity_type = 'task' AND entity_id = ?",
      [studentId, taskId]
    );

    if (progress.length === 0) {
      await db.query(
        "INSERT INTO user_progress (user_id, entity_type, entity_id) VALUES (?, 'task', ?)",
        [studentId, taskId]
      );

      // Grant Stars
      if (xpReward > 0) {
        await db.query("UPDATE users SET stars = stars + ? WHERE id = ?", [xpReward, studentId]);
      }
    }

    // Notify the user
    await notifyUser(studentId, {
      type: 'submission_approved',
      title: 'Task Approved! ✅',
      message: `Your submissions for "${taskTitle}" have been approved! ${isMandatory ? 'The next step is now unlocked.' : 'XP has been granted.'}`,
      link: await taskLink(taskId),
      metadata: { taskId },
      emailHtml: (u) => `Hello <strong>${escapeHtml(u.name)}</strong>!<br><br>
            Great news! Your submissions for task <strong>"${escapeHtml(taskTitle)}"</strong> have been approved by an administrator.<br>
            You can now proceed to the next task in your learning path.`,
    });

    // Emit Socket.IO events for live updates
    io.emit('leaderboard:update');
    io.emit('task:completed', {
      userId: parseInt(studentId),
      taskId: parseInt(taskId)
    });

    res.json({ message: 'All submissions approved successfully' });
  } catch (err) {
    console.error('[Approve All] Error:', err);
    res.status(500).json({ error: 'Failed to approve submissions' });
  }
});

// Reject all submissions for a task (Admin only)
api.post('/tasks/:taskId/reject-all', authenticateToken, async (req, res) => {
  const { taskId } = req.params;
  const { studentId, comment } = req.body;

  if (!studentId) return res.status(400).json({ error: 'Student ID required' });
  if (!comment || !comment.trim()) return res.status(400).json({ error: 'Rejection comment required' });

  try {
    // Check if user is admin
    const [userRows] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    if (userRows.length === 0 || userRows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Get task info first
    const [taskRows] = await db.query('SELECT title FROM tasks WHERE id = ?', [taskId]);
    if (taskRows.length === 0) return res.status(404).json({ error: 'Task not found' });

    const taskTitle = taskRows[0].title;

    // Update all submissions for this user and task to rejected
    await db.query(
      "UPDATE task_submissions SET status = 'rejected' WHERE task_id = ? AND user_id = ?",
      [taskId, studentId]
    );

    // Notify the user with the rejection comment
    await notifyUser(studentId, {
      type: 'submission_rejected',
      title: 'Task Rejected ❌',
      message: `Your submissions for "${taskTitle}" were rejected. Reason: ${comment.trim()}`,
      link: await taskLink(taskId),
      actionLabel: 'Open the task and resubmit',
      metadata: { taskId, comment: comment.trim() },
      emailHtml: (u) => `Hello <strong>${escapeHtml(u.name)}</strong>!<br><br>
            Your submissions for task <strong>"${escapeHtml(taskTitle)}"</strong> have been reviewed and rejected by an administrator.<br><br>
            <strong>Reason:</strong><br>
            <div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin-top: 10px; border-left: 4px solid #ef4444;">
              ${escapeHtml(comment.trim()).replace(/\n/g, '<br>')}
            </div><br>
            Please review the feedback and resubmit your work when ready.`,
    });

    // Emit Socket.IO event for live updates
    io.emit('task:rejected', {
      userId: parseInt(studentId),
      taskId: parseInt(taskId)
    });

    res.json({ message: 'All submissions rejected successfully' });
  } catch (err) {
    console.error('[Reject All] Error:', err);
    res.status(500).json({ error: 'Failed to reject submissions' });
  }
});

// Upload Image for Task Description
api.post('/upload-image', authenticateToken, uploadImage.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }

  // Return the relative path to access the uploaded image
  const imageUrl = `/uploads/${req.file.filename}`;
  res.json({ url: imageUrl });
});

// ==================== API KEYS (Admin only) ====================

// List API keys (never returns the key itself)
api.get('/admin/api-keys', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT k.id, k.name, k.key_prefix, k.created_at, k.last_used_at, k.revoked_at,
             u.name AS created_by_name, u.email AS created_by_email
        FROM api_keys k
        JOIN users u ON u.id = k.created_by
       ORDER BY k.created_at DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error('[API Keys] Error listing keys:', error);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// Create an API key. The plaintext key is returned exactly once.
api.post('/admin/api-keys', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (name.length < 2 || name.length > 100) {
      return res.status(400).json({ error: 'Key name must be between 2 and 100 characters' });
    }
    const { key, hash, prefix } = generateApiKey();
    const [result] = await db.query(
      'INSERT INTO api_keys (name, key_prefix, key_hash, created_by) VALUES (?, ?, ?, ?)',
      [name, prefix, hash, req.user.id]
    );
    res.status(201).json({
      id: result.insertId,
      name,
      key_prefix: prefix,
      key,
      message: 'Store this key now — it cannot be shown again.'
    });
  } catch (error) {
    console.error('[API Keys] Error creating key:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// Revoke an API key
api.delete('/admin/api-keys/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      'UPDATE api_keys SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL RETURNING id',
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'API key not found or already revoked' });
    }
    res.json({ message: 'API key revoked' });
  } catch (error) {
    console.error('[API Keys] Error revoking key:', error);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

// ==================== PATH IMPORT (Admin only) ====================
//
// Create a whole learning path (or append to an existing one) from one JSON
// document — the endpoint an AI agent uses. Positions are laid out exactly like
// the admin UI does it (lessons left→right, task chains alternating up/down).
//
// Body: {
//   name, description?, stars_required?,          // new path  (or)
//   pathId,                                        // append lessons to an existing path
//   lessons: [{ title, description?, tasks?: [{ title, description?, type?, xp?, deadline? }] }]
//            (each lesson may also carry study_sets?: [{ kind, title, description?, items }] — see studySets.js)
// }
const LAYOUT = {
  firstX: 80,            // x of the first lesson
  centerY: 250,          // y of the lesson row
  lessonSpacingX: 250,   // x gap between consecutive lessons
  firstTaskOffset: 120,  // first task sits diagonally (+x, ±y) from its lesson by this much
  taskSpacingX: 150      // x gap between consecutive tasks of a lesson
};
const TASK_TYPES = new Set(['mandatory', 'optional']);

function parseDeadline(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('deadline must be a string');
  const date = value.length === 10 ? new Date(value + 'T23:59:59') : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid deadline "${value}"`);
  return date.toISOString();
}

function validateImportBody(body) {
  const errors = [];
  const b = body || {};
  const creatingPath = b.pathId === undefined || b.pathId === null;
  const isOptionalString = (v) => v === undefined || v === null || typeof v === 'string';
  if (creatingPath) {
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 255) errors.push('name is required (max 255 chars)');
    if (b.courseId !== undefined && b.courseId !== null && (!Number.isInteger(b.courseId) || b.courseId < 1)) errors.push('courseId must be a positive integer');
    if (b.requires_previous !== undefined && typeof b.requires_previous !== 'boolean') errors.push('requires_previous must be a boolean');
    if (!isOptionalString(b.description)) errors.push('description must be a string');
    if (b.stars_required !== undefined && (!Number.isInteger(b.stars_required) || b.stars_required < 0)) errors.push('stars_required must be a non-negative integer');
  } else if (!Number.isInteger(Number(b.pathId))) {
    errors.push('pathId must be an integer');
  }
  if (!Array.isArray(b.lessons)) errors.push('lessons must be an array');
  else if (b.lessons.length > 200) errors.push('at most 200 lessons per request');
  else b.lessons.forEach((l, i) => {
    if (!l || typeof l.title !== 'string' || !l.title.trim() || l.title.length > 255) errors.push(`lessons[${i}].title is required (max 255 chars)`);
    if (l && !isOptionalString(l.description)) errors.push(`lessons[${i}].description must be a string`);
    if (l && l.tasks !== undefined) {
      if (!Array.isArray(l.tasks)) errors.push(`lessons[${i}].tasks must be an array`);
      else if (l.tasks.length > 50) errors.push(`lessons[${i}]: at most 50 tasks`);
      else l.tasks.forEach((t, j) => {
        if (!t || typeof t.title !== 'string' || !t.title.trim() || t.title.length > 255) errors.push(`lessons[${i}].tasks[${j}].title is required (max 255 chars)`);
        if (t && !isOptionalString(t.description)) errors.push(`lessons[${i}].tasks[${j}].description must be a string`);
        if (t && t.type !== undefined && !TASK_TYPES.has(t.type)) errors.push(`lessons[${i}].tasks[${j}].type must be "mandatory" or "optional"`);
        if (t && t.xp !== undefined && (!Number.isInteger(t.xp) || t.xp < 0)) errors.push(`lessons[${i}].tasks[${j}].xp must be a non-negative integer`);
        try { if (t) parseDeadline(t.deadline); } catch (e) { errors.push(`lessons[${i}].tasks[${j}]: ${e.message}`); }
      });
    }
    if (l && l.study_sets !== undefined) {
      if (!Array.isArray(l.study_sets)) errors.push(`lessons[${i}].study_sets must be an array`);
      else if (l.study_sets.length > studySets.MAX_SETS_PER_LESSON) errors.push(`lessons[${i}]: at most ${studySets.MAX_SETS_PER_LESSON} study sets`);
      else l.study_sets.forEach((set, k) => {
        errors.push(...studySets.validateStudySet(set, { prefix: `lessons[${i}].study_sets[${k}]` }).errors);
      });
    }
  });
  return errors;
}

api.post('/admin/paths/import', authenticateToken, requireAdmin, async (req, res) => {
  const errors = validateImportBody(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Invalid import document', details: errors });
  }
  const body = req.body;

  try {
    const created = await db.transaction(async (tx) => {
      let pathId;
      let pathName;
      let parentId = null;
      let x = LAYOUT.firstX;
      let order = 1;

      if (body.pathId === undefined || body.pathId === null) {
        const courseId = body.courseId ?? null;
        if (courseId !== null) {
          const [courses] = await tx.query('SELECT id FROM courses WHERE id = ?', [courseId]);
          if (courses.length === 0) { const err = new Error('Course not found'); err.status = 404; throw err; }
        }
        const [result] = await tx.query(
          'INSERT INTO paths (name, description, stars_required, course_id, order_index, requires_previous) VALUES (?, ?, ?, ?, ?, ?)',
          [body.name.trim(), body.description || '', body.stars_required || 0, null, 1, body.requires_previous ?? true]
        );
        pathId = result.insertId;
        pathName = body.name.trim();
        await courseRoutes.placePhase(tx, pathId, courseId, null); // appends; numbering stays 1..n
      } else {
        pathId = Number(body.pathId);
        // Lock the path row for the rest of the transaction so two concurrent appends
        // (or an append racing a UI edit) cannot both read the same "last lesson".
        const [paths] = await tx.query('SELECT id, name FROM paths WHERE id = ? FOR UPDATE', [pathId]);
        if (paths.length === 0) {
          const err = new Error('Path not found'); err.status = 404; throw err;
        }
        pathName = paths[0].name;
        // Append after the last lesson of the existing path
        const [last] = await tx.query(
          'SELECT id, position_x, order_index FROM lessons WHERE path_id = ? ORDER BY order_index DESC, id DESC LIMIT 1',
          [pathId]
        );
        if (last.length > 0) {
          parentId = last[0].id;
          x = last[0].position_x + LAYOUT.lessonSpacingX;
          order = last[0].order_index + 1;
        }
      }

      const lessons = [];
      for (const lesson of body.lessons) {
        const y = LAYOUT.centerY;
        const [lr] = await tx.query(
          'INSERT INTO lessons (path_id, title, description, position_x, position_y, order_index, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [pathId, lesson.title.trim(), lesson.description || '', x, y, order, parentId]
        );
        const lessonId = lr.insertId;

        // Task chain: first task diagonal (up for odd lessons, down for even), then to the right
        const direction = order % 2 !== 0 ? -1 : 1;
        let taskX = x + LAYOUT.firstTaskOffset;
        const taskY = y + LAYOUT.firstTaskOffset * direction;
        const tasks = [];
        (lesson.tasks || []).forEach((task, index) => {
          tasks.push({ ...task, _x: taskX, _y: taskY, _order: index + 1 });
          taskX += LAYOUT.taskSpacingX;
        });
        const createdTasks = [];
        for (const task of tasks) {
          const [tr] = await tx.query(
            'INSERT INTO tasks (lesson_id, title, type, xp_reward, deadline, position_x, position_y, order_index, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [lessonId, task.title.trim(), task.type || 'mandatory', task.xp ?? 10, parseDeadline(task.deadline), task._x, task._y, task._order, task.description || '']
          );
          createdTasks.push({ id: tr.insertId, title: task.title.trim(), type: task.type || 'mandatory', order_index: task._order });
        }

        const createdSets = [];
        for (const [index, set] of (lesson.study_sets || []).entries()) {
          const { kind, items } = studySets.validateStudySet(set);
          const [sr] = await tx.query(
            'INSERT INTO study_sets (lesson_id, kind, title, description, order_index, items) VALUES (?, ?, ?, ?, ?, ?::jsonb)',
            [lessonId, kind, set.title.trim(), (set.description || '').trim(), index + 1, JSON.stringify(items)]
          );
          createdSets.push({ id: sr.insertId, kind, title: set.title.trim(), item_count: items.length });
        }

        lessons.push({ id: lessonId, title: lesson.title.trim(), order_index: order, tasks: createdTasks, study_sets: createdSets });
        parentId = lessonId;
        x += LAYOUT.lessonSpacingX;
        order += 1;
      }

      return { pathId, pathName, lessons };
    });

    // Let open admin/student views refresh
    io.emit('course:updated', { pathId: created.pathId });
    for (const lesson of created.lessons) {
      io.emit('lesson:created', { lessonId: lesson.id, pathId: created.pathId, title: lesson.title });
      for (const task of lesson.tasks) {
        io.emit('task:created', { taskId: task.id, lessonId: lesson.id, title: task.title, type: task.type });
      }
    }

    res.status(201).json({
      path: { id: created.pathId, name: created.pathName },
      lessons: created.lessons,
      counts: {
        lessons: created.lessons.length,
        tasks: created.lessons.reduce((n, l) => n + l.tasks.length, 0),
        study_sets: created.lessons.reduce((n, l) => n + l.study_sets.length, 0)
      }
    });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('[Path Import] Error:', err);
    res.status(500).json({ error: 'Failed to import path' });
  }
});

// ==================== CHAT ENDPOINTS ====================

// Get all chats for current user
api.get('/chats', authenticateToken, async (req, res) => {
  try {
    const [chats] = await db.query(`
      SELECT DISTINCT c.id, c.name, c.created_by, c.created_at, c.updated_at,
        (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) as message_count,
        (SELECT content FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_at
      FROM chats c
      INNER JOIN chat_members cm ON c.id = cm.chat_id
      WHERE cm.user_id = ?
      ORDER BY last_message_at DESC NULLS LAST, c.updated_at DESC
    `, [req.user.id]);

    res.json(chats);
  } catch (error) {
    console.error('[Chat] Error fetching chats:', error);
    res.status(500).json({ error: 'Failed to fetch chats' });
  }
});

// Create new chat
api.post('/chats', authenticateToken, async (req, res) => {
  try {
    const { name, memberIds } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Chat name is required' });
    }

    // Create chat
    const [result] = await db.query(
      'INSERT INTO chats (name, created_by) VALUES (?, ?)',
      [name.trim(), req.user.id]
    );

    const chatId = result.insertId;

    // Add creator as member
    await db.query(
      'INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)',
      [chatId, req.user.id]
    );

    // Add other members if provided
    const extraMembers = Array.isArray(memberIds)
      ? [...new Set(memberIds.map(Number).filter(id => Number.isInteger(id) && id > 0 && id !== req.user.id))]
      : [];
    if (extraMembers.length > 0) {
      // Only existing users can be members (unknown ids are silently ignored)
      await db.query(
        'INSERT INTO chat_members (chat_id, user_id) SELECT ?, id FROM users WHERE id = ANY(?) ON CONFLICT DO NOTHING',
        [chatId, extraMembers]
      );
    }

    // Get created chat with details
    const [chats] = await db.query(
      'SELECT * FROM chats WHERE id = ?',
      [chatId]
    );

    // Subscribe every member's sockets to the chat room, then notify them
    for (const memberId of [req.user.id, ...extraMembers]) {
      joinChatRoom(memberId, chatId);
    }
    emitToChat(chatId, 'chat_created', { chatId: parseInt(chatId), chat: chats[0] });

    res.status(201).json(chats[0]);
  } catch (error) {
    console.error('[Chat] Error creating chat:', error);
    res.status(500).json({ error: 'Failed to create chat' });
  }
});

// Update chat (rename)
api.put('/chats/:id', authenticateToken, async (req, res) => {
  try {
    const chatId = req.params.id;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Chat name is required' });
    }

    // Check if user is member of chat
    const [members] = await db.query(
      'SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?',
      [chatId, req.user.id]
    );

    if (members.length === 0) {
      return res.status(403).json({ error: 'Not a member of this chat' });
    }

    await db.query(
      'UPDATE chats SET name = ? WHERE id = ?',
      [name.trim(), chatId]
    );

    // Get updated chat
    const [chats] = await db.query('SELECT * FROM chats WHERE id = ?', [chatId]);

    // Notify all members via Socket.IO
    emitToChat(chatId, 'chat_updated', { chatId: parseInt(chatId), chat: chats[0] });

    res.json(chats[0]);
  } catch (error) {
    console.error('[Chat] Error updating chat:', error);
    res.status(500).json({ error: 'Failed to update chat' });
  }
});

// Delete chat
api.delete('/chats/:id', authenticateToken, async (req, res) => {
  try {
    const chatId = req.params.id;

    // Check if user is the creator
    const [chats] = await db.query(
      'SELECT * FROM chats WHERE id = ? AND created_by = ?',
      [chatId, req.user.id]
    );

    if (chats.length === 0) {
      return res.status(403).json({ error: 'Only chat creator can delete the chat' });
    }

    await db.query('DELETE FROM chats WHERE id = ?', [chatId]);

    // Notify all members via Socket.IO, then dissolve the room
    emitToChat(chatId, 'chat_deleted', { chatId: parseInt(chatId) });
    io.in(chatRoom(chatId)).socketsLeave(chatRoom(chatId));

    res.json({ message: 'Chat deleted successfully' });
  } catch (error) {
    console.error('[Chat] Error deleting chat:', error);
    res.status(500).json({ error: 'Failed to delete chat' });
  }
});

// Get chat members
api.get('/chats/:id/members', authenticateToken, async (req, res) => {
  try {
    const chatId = req.params.id;

    // Check if user is member of chat
    const [isMember] = await db.query(
      'SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?',
      [chatId, req.user.id]
    );

    if (isMember.length === 0) {
      return res.status(403).json({ error: 'Not a member of this chat' });
    }

    const [members] = await db.query(`
      SELECT u.id, u.name, u.email, u.role, u.avatar_url, cm.joined_at
      FROM chat_members cm
      INNER JOIN users u ON cm.user_id = u.id
      WHERE cm.chat_id = ?
      ORDER BY cm.joined_at ASC
    `, [chatId]);

    res.json(members);
  } catch (error) {
    console.error('[Chat] Error fetching members:', error);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// Add member to chat
api.post('/chats/:id/members', authenticateToken, async (req, res) => {
  try {
    const chatId = req.params.id;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Check if requester is member of chat
    const [isMember] = await db.query(
      'SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?',
      [chatId, req.user.id]
    );

    if (isMember.length === 0) {
      return res.status(403).json({ error: 'Not a member of this chat' });
    }

    // Get added user details
    const [users] = await db.query(
      'SELECT id, name, email, role, avatar_url FROM users WHERE id = ?',
      [userId]
    );
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Add new member
    await db.query(
      'INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
      [chatId, userId]
    );

    // Subscribe the new member's sockets and notify all members via Socket.IO
    joinChatRoom(users[0].id, chatId);
    emitToChat(chatId, 'member_added', { chatId: parseInt(chatId), user: users[0] });

    res.json({ message: 'Member added successfully', user: users[0] });
  } catch (error) {
    console.error('[Chat] Error adding member:', error);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// Remove member from chat
api.delete('/chats/:id/members/:userId', authenticateToken, async (req, res) => {
  try {
    const chatId = req.params.id;
    const userIdToRemove = req.params.userId;

    // Check if chat exists and get creator
    const [chats] = await db.query('SELECT created_by FROM chats WHERE id = ?', [chatId]);
    if (chats.length === 0) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    // Only creator or the user themselves can remove a member
    if (req.user.id !== chats[0].created_by && req.user.id != userIdToRemove) {
      return res.status(403).json({ error: 'Not authorized to remove this member' });
    }

    await db.query(
      'DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?',
      [chatId, userIdToRemove]
    );

    // Notify all members via Socket.IO, then unsubscribe the removed member
    emitToChat(chatId, 'member_removed', { chatId: parseInt(chatId), userId: userIdToRemove });
    leaveChatRoom(userIdToRemove, chatId);

    res.json({ message: 'Member removed successfully' });
  } catch (error) {
    console.error('[Chat] Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// Get messages from chat
api.get('/chats/:id/messages', authenticateToken, async (req, res) => {
  try {
    const chatId = req.params.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    // Check if user is member of chat
    const [isMember] = await db.query(
      'SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?',
      [chatId, req.user.id]
    );

    if (isMember.length === 0) {
      return res.status(403).json({ error: 'Not a member of this chat' });
    }

    const [messages] = await db.query(`
      SELECT m.*, u.name as user_name, u.avatar_url as user_avatar, u.role as user_role
      FROM messages m
      INNER JOIN users u ON m.user_id = u.id
      WHERE m.chat_id = ?
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `, [chatId, limit, offset]);

    res.json(messages.reverse()); // Reverse to get chronological order
  } catch (error) {
    console.error('[Chat] Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Send message
api.post('/chats/:id/messages', authenticateToken, uploadImage.array('images', 10), async (req, res) => {
  try {
    const chatId = req.params.id;
    const { content } = req.body;
    const files = req.files || [];

    if ((!content || !content.trim()) && files.length === 0) {
      return res.status(400).json({ error: 'Message content or images are required' });
    }

    // Check if user is member of chat
    const [isMember] = await db.query(
      'SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?',
      [chatId, req.user.id]
    );

    if (isMember.length === 0) {
      return res.status(403).json({ error: 'Not a member of this chat' });
    }

    // Prepare image paths
    const imagePaths = files.map(file => `/uploads/${file.filename}`);
    const imagesJSON = imagePaths.length > 0 ? JSON.stringify(imagePaths) : null;

    // Insert message
    const [result] = await db.query(
      'INSERT INTO messages (chat_id, user_id, content, images) VALUES (?, ?, ?, ?)',
      [chatId, req.user.id, content ? content.trim() : '', imagesJSON]
    );

    // Get message with user details
    const [messages] = await db.query(`
      SELECT m.*, u.name as user_name, u.avatar_url as user_avatar, u.role as user_role
      FROM messages m
      INNER JOIN users u ON m.user_id = u.id
      WHERE m.id = ?
    `, [result.insertId]);

    // Emit to the chat's members via Socket.IO
    emitToChat(chatId, 'new_message', { chatId: parseInt(chatId), message: messages[0] });

    res.status(201).json(messages[0]);
  } catch (error) {
    console.error('[Chat] Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Edit message
api.put('/chats/:chatId/messages/:messageId', authenticateToken, async (req, res) => {
  try {
    const { chatId, messageId } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    // Check if message exists and user owns it
    const [messages] = await db.query(
      'SELECT * FROM messages WHERE id = ? AND chat_id = ? AND user_id = ?',
      [messageId, chatId, req.user.id]
    );

    if (messages.length === 0) {
      return res.status(404).json({ error: 'Message not found or unauthorized' });
    }

    // Update message
    await db.query(
      'UPDATE messages SET content = ? WHERE id = ?',
      [content.trim(), messageId]
    );

    // Get updated message with user details
    const [updatedMessages] = await db.query(`
      SELECT m.*, u.name as user_name, u.avatar_url as user_avatar, u.role as user_role
      FROM messages m
      INNER JOIN users u ON m.user_id = u.id
      WHERE m.id = ?
    `, [messageId]);

    // Emit to the chat's members via Socket.IO
    emitToChat(chatId, 'message_edited', { chatId: parseInt(chatId), message: updatedMessages[0] });

    res.json(updatedMessages[0]);
  } catch (error) {
    console.error('[Chat] Error editing message:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// Delete message
api.delete('/chats/:chatId/messages/:messageId', authenticateToken, async (req, res) => {
  try {
    const { chatId, messageId } = req.params;

    // Check if message exists and user owns it
    const [messages] = await db.query(
      'SELECT * FROM messages WHERE id = ? AND chat_id = ? AND user_id = ?',
      [messageId, chatId, req.user.id]
    );

    if (messages.length === 0) {
      return res.status(404).json({ error: 'Message not found or unauthorized' });
    }

    // Delete message
    await db.query('DELETE FROM messages WHERE id = ?', [messageId]);

    // Emit to the chat's members via Socket.IO
    emitToChat(chatId, 'message_deleted', { chatId: parseInt(chatId), messageId: parseInt(messageId) });

    res.json({ success: true });
  } catch (error) {
    console.error('[Chat] Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// ==================== END CHAT ENDPOINTS ====================

// Socket.IO - authenticate the handshake with the same session cookie as the REST API.
io.use(async (socket, next) => {
  try {
    const cookies = cookie.parse(socket.handshake.headers.cookie || '');
    const decoded = await sessionFromToken(cookies.token);
    if (!decoded) return next(new Error('unauthorized'));
    socket.data.userId = decoded.id;
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

// Socket.IO - Real-time Online Presence
io.on('connection', async (socket) => {
  const authedUserId = socket.data.userId;

  // Private room for this user + one room per chat they belong to
  socket.join(userRoom(authedUserId));
  try {
    const [memberships] = await db.query('SELECT chat_id FROM chat_members WHERE user_id = ?', [authedUserId]);
    memberships.forEach(m => socket.join(chatRoom(m.chat_id)));
  } catch (error) {
    console.error('[Socket.IO] Failed to join chat rooms:', error);
  }

  // Handle request for current online users
  socket.on('request_online_users', () => {
    const onlineUsersList = Array.from(onlineUsers.values()).map(u => ({
      id: u.id,
      name: u.name,
      avatar_url: u.avatar_url
    }));
    socket.emit('online_users_update', onlineUsersList);
  });

  // Handle user going online (identity comes from the authenticated socket, not the payload)
  socket.on('user_online', async () => {
    const userId = authedUserId;
    try {
      // Get user info from database
      const [users] = await db.query('SELECT id, name, avatar_url FROM users WHERE id = ?', [userId]);
      if (users.length > 0) {
        const user = users[0];
        onlineUsers.set(userId.toString(), {
          socketId: socket.id,
          id: user.id,
          name: user.name,
          avatar_url: user.avatar_url
        });

        // Broadcast updated online users list to all clients
        const onlineUsersList = Array.from(onlineUsers.values()).map(u => ({
          id: u.id,
          name: u.name,
          avatar_url: u.avatar_url
        }));
        io.emit('online_users_update', onlineUsersList);
      }
    } catch (error) {
      console.error('[Socket.IO] Error setting user online:', error);
    }
  });

  // Handle typing indicator — only to members of that chat
  socket.on('user_typing', (data) => {
    const { chatId, userName } = data || {};
    if (!chatId) return;
    socket.to(chatRoom(chatId)).emit('user_typing', { chatId, userId: authedUserId, userName });
  });

  socket.on('user_stopped_typing', (data) => {
    const { chatId } = data || {};
    if (!chatId) return;
    socket.to(chatRoom(chatId)).emit('user_stopped_typing', { chatId, userId: authedUserId });
  });

  // Handle user going offline (disconnect)
  socket.on('disconnect', () => {
    // Find and remove user by socketId
    for (const [userId, userData] of onlineUsers.entries()) {
      if (userData.socketId === socket.id) {
        onlineUsers.delete(userId);

        // Broadcast updated online users list to all clients
        const onlineUsersList = Array.from(onlineUsers.values()).map(u => ({
          id: u.id,
          name: u.name,
          avatar_url: u.avatar_url
        }));
        io.emit('online_users_update', onlineUsersList);
        break;
      }
    }
  });
});

// API endpoint to get current online users
api.get('/online-users', authenticateToken, (req, res) => {
  const onlineUsersList = Array.from(onlineUsers.values()).map(u => ({
    id: u.id,
    name: u.name,
    avatar_url: u.avatar_url
  }));
  res.json(onlineUsersList);
});

// ---------------------------------------------------------------------------
// Error handling for the API (multer / CORS / JSON parse errors → JSON, no stack traces)
// ---------------------------------------------------------------------------
api.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large' : err.message });
  }
  if (err && /Invalid (file|image) type/.test(err.message || '')) {
    return res.status(400).json({ error: err.message });
  }
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Not allowed by CORS' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  console.error('[API] Unhandled error:', err);
  res.status(err.status || 500).json({ error: 'Server error.' });
});

api.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Static client (production): the Vite build is copied to server/public by the
// Dockerfile and served from the same origin as the API.
// ---------------------------------------------------------------------------
const publicDir = process.env.PUBLIC_DIR
  ? path.resolve(process.env.PUBLIC_DIR)
  : path.join(__dirname, 'public');
if (fs.existsSync(path.join(publicDir, 'index.html'))) {
  app.use(express.static(publicDir, { index: 'index.html', maxAge: '1h' }));
  app.get(/^(?!\/api\/|\/socket\.io\/).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  console.log(`[Static] Serving client from ${publicDir}`);
}

// Start Server
(async () => {
  try {
    await runMigrations(db.pool);
  } catch (err) {
    console.error('[FATAL] Database migration failed:', err.message || err);
    process.exit(1);
  }
  lessonFiles.quarantineOrphanFiles(); // files without a row are set aside (never deleted)

  // Encrypt any hash not yet sealed with the current key (first start after this release,
  // or after rotating PASSWORD_PEPPER)
  const { failed } = await passwords.sealAllPasswords(db);
  // Same rule as the key itself (passwords.js): only an explicit development/test setup may carry on
  if (failed > 0 && !['development', 'test'].includes(process.env.NODE_ENV)) {
    // Every login would be refused: stop loudly instead
    console.error('[FATAL] Some password hashes are sealed with a key this server does not have. Restore the previous PASSWORD_PEPPER, or add it to PASSWORD_PEPPER_PREVIOUS.');
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT} (${NODE_ENV})`);
  });

  const shutdown = (signal) => {
    console.log(`[Server] ${signal} received, shutting down`);
    server.close(() => {
      db.pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();
