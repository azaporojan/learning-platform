require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
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
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

// All routes live under /api so the built client can be served from the same origin.
const api = express.Router();
api.use(apiLimiter);
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
  console.warn('[Email] EMAIL_USER/EMAIL_PASS not set — outgoing emails (login codes, notifications) are disabled and logged instead.');
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
    console.log(`[Email] (disabled) to=${message.to} subject="${message.subject}"`);
    return;
  }
  await transporter.sendMail(message);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function verifySessionToken(token) {
  return jwt.verify(token, jwtSecret); // { id, role }
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
    req.user = verifySessionToken(token); // { id, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Admin-only middleware. The role is re-read from the database on every request so a
// demoted/deleted admin loses access immediately, not when their token expires.
const requireAdmin = async (req, res, next) => {
  try {
    const [rows] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
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
function optionalUserId(req) {
  const token = req.cookies.token;
  if (!token) return null;
  try {
    return verifySessionToken(token).id;
  } catch (e) {
    return null;
  }
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

// Generic helper function to send any email
const sendEmail = async (email, subject, htmlContent) => {

  try {
    await deliverMail({
      from: `"Learning Platform" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: subject,
      html: htmlContent
    });
  } catch (error) {
    console.error('[ERROR] Failed to send email:', error);
  }
};

// Helper function to send notification email
const sendNotificationEmail = async (email, subject, message) => {

  try {
    await deliverMail({
      from: `"Learning Platform" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px; max-width: 500px;">
          <h2 style="color: #333;">🎓 Learning Platform</h2>
          <p>${message}</p>
          <p style="margin-top: 20px;">
            <a href="${FRONTEND_URL}" style="background: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
              Access Platform
            </a>
          </p>
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

api.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);

    if (users.length === 0) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const user = users[0];

    // Verifică parola
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    // Verifică dacă contul e aprobat
    if (!user.is_approved && user.role !== 'admin') { // Adminii trec direct, de obicei, dar poți schimba
      return res.status(403).json({ error: 'Your account has not been approved by an administrator yet.' });
    }

    // Generează cod 6 cifre (CSPRNG)
    const code = crypto.randomInt(100000, 1000000).toString();

    // Salvează codul în DB (expiră în 10 min)
    await db.query(
      "UPDATE users SET login_code = ?, login_code_expires = NOW() + INTERVAL '10 minutes', login_code_attempts = 0 WHERE id = ?",
      [code, user.id]
    );

    // Trimite email (sau loghează în consolă)
    await sendLoginCode(user.email, code);

    res.json({ message: 'Code sent via email.', step: 'code_required', userId: user.id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// 2. Endpoint: Verificare Cod (Finalizează Login)
api.post('/verify-code', authLimiter, async (req, res) => {
  const { userId, code } = req.body || {};
  if (!Number.isInteger(Number(userId)) || typeof code !== 'string') {
    return res.status(400).json({ error: 'User ID and code are required.' });
  }

  try {
    const [users] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (users.length === 0) return res.status(404).json({ error: 'User not found.' });

    const user = users[0];

    // Verifică expirarea (și că există un cod activ)
    const now = new Date();
    if (!user.login_code || !user.login_code_expires || new Date(user.login_code_expires) < now) {
      return res.status(400).json({ error: 'Code expired. Please try again.' });
    }

    // Verifică codul — max 5 încercări per cod, apoi codul este invalidat (anti brute-force)
    const expected = Buffer.from(String(user.login_code));
    const provided = Buffer.from(code);
    const codeMatches = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
    if (!codeMatches) {
      const attempts = (user.login_code_attempts || 0) + 1;
      if (attempts >= 5) {
        await db.query('UPDATE users SET login_code = NULL, login_code_expires = NULL, login_code_attempts = 0 WHERE id = ?', [userId]);
        return res.status(400).json({ error: 'Too many incorrect attempts. Please log in again.' });
      }
      await db.query('UPDATE users SET login_code_attempts = ? WHERE id = ?', [attempts, userId]);
      return res.status(400).json({ error: 'Incorrect code.' });
    }

    // Login cu succes -> Șterge codul folosit
    await db.query('UPDATE users SET login_code = NULL, login_code_expires = NULL, login_code_attempts = 0 WHERE id = ?', [userId]);

    // Generare Token JWT
    const token = jwt.sign(
      { id: user.id, role: user.role },
      jwtSecret,
      { expiresIn: '24h' }
    );

    // Setare Cookie HTTP-Only
    const isProduction = NODE_ENV === 'production';
    res.cookie('token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'strict' : 'lax',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });

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
    const decoded = verifySessionToken(token);

    const [users] = await db.query('SELECT id, name, email, role, stars, avatar_url FROM users WHERE id = ?', [decoded.id]);
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
    const decoded = verifySessionToken(token);
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

// Helper function to notify all admins
async function notifyAdmins(type, title, message, link = null, metadata = null) {
  try {
    const [admins] = await db.query("SELECT id FROM users WHERE role = 'admin'");
    for (const admin of admins) {
      await createNotification(admin.id, type, title, message, link, metadata);
    }
  } catch (error) {
    console.error('[Notification] Error notifying admins:', error);
  }
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
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'Password must be between 8 and 128 characters.' });
  }

  // The configured bootstrap admin is created approved + admin so the first login works
  // without shell access to the server.
  const isBootstrapAdmin = BOOTSTRAP_ADMIN_EMAIL && email === BOOTSTRAP_ADMIN_EMAIL;

  try {
    const [existingUsers] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      return res.status(409).json({ error: 'This email is already registered.' });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const [result] = await db.query(
      'INSERT INTO users (name, email, password, role, stars, is_approved) VALUES (?, ?, ?, ?, ?, ?)',
      [name, email, hashedPassword, isBootstrapAdmin ? 'admin' : 'student', 0, isBootstrapAdmin]
    );

    if (isBootstrapAdmin) {
      console.log(`[Auth] Bootstrap admin account created for ${email}`);
      return res.status(201).json({ message: 'Admin account created successfully! You can log in now.', userId: result.insertId });
    }

    // Notify all admins about new user registration
    await notifyAdmins(
      'new_user_pending',
      'New User Registered',
      `${name} (${email}) is waiting for approval.`,
      null,
      { userId: result.insertId, email, name }
    );

    // Send email to admins
    const [admins] = await db.query("SELECT email FROM users WHERE role = 'admin'");
    for (const admin of admins) {
      await sendNotificationEmail(
        admin.email,
        'New User Registered',
        `A new user <strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) is waiting for approval on the Learning Platform.`
      );
    }

    res.status(201).json({
      message: 'Account created successfully! Waiting for administrator approval.',
      userId: result.insertId
    });

  } catch (err) {
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

    // Approve user
    await db.query('UPDATE users SET is_approved = TRUE WHERE id = ?', [id]);

    // Update all pending notifications for this user to approved
    await db.query(
      "UPDATE notifications SET status = 'approved', is_read = TRUE WHERE type = 'new_user_pending' AND (metadata->>'userId')::int = ?",
      [id]
    );

    // Notify user
    await createNotification(
      id,
      'account_approved',
      'Account Approved! 🎉',
      'Your account has been approved by an administrator. You can now access the platform.',
      null,
      null
    );

    // Send email to user
    await sendNotificationEmail(
      targetUser[0].email,
      'Account Approved! 🎉',
      `Hello <strong>${escapeHtml(targetUser[0].name)}</strong>!<br><br>Your account on the Learning Platform has been approved by an administrator. You can now log in and start learning!`
    );

    res.json({ message: 'User approved successfully' });
  } catch (error) {
    console.error('[Approve User] Error:', error);
    res.status(500).json({ error: 'Failed to approve user' });
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

    // Notify user before deleting
    await createNotification(
      id,
      'account_rejected',
      'Account Rejected',
      'Your registration request has been rejected by an administrator.',
      null,
      null
    );

    // Send email to user
    await sendNotificationEmail(
      targetUser[0].email,
      'Registration Request Rejected',
      `Hello <strong>${escapeHtml(targetUser[0].name)}</strong>.<br><br>Unfortunately, your registration request on the Learning Platform has been rejected by an administrator.`
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
      updates.push('email = ?');
      values.push(email);
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
    await createNotification(
      parseInt(id),
      'stars_received',
      `⭐ +${starsToAdd} Stars Received!`,
      `You've received ${starsToAdd} star${starsToAdd > 1 ? 's' : ''} from the administrator! Keep up the great work!`,
      null,
      { starsAdded: starsToAdd, newTotal: updatedUser[0].stars }
    );

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
api.get('/paths', async (req, res) => {
  const userId = optionalUserId(req);
  let userRole = 'student';

  try {
    const [paths] = await db.query('SELECT * FROM paths ORDER BY stars_required ASC, id ASC');

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
        requiredScore: path.stars_required
      };
    });

    res.json(pathsWithStatus);
  } catch (error) {
    console.error('[/paths] Error:', error);
    res.status(500).json({ error: 'Failed to fetch paths' });
  }
});

// Create new path (admin only)
api.post('/paths', authenticateToken, async (req, res) => {
  try {
    const { name, description, stars_required } = req.body;

    // Check if user is admin
    const [userRows] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    if (userRows.length === 0 || userRows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const [result] = await db.query(
      'INSERT INTO paths (name, description, stars_required) VALUES (?, ?, ?)',
      [name, description || '', stars_required || 0]
    );

    res.json({
      id: result.insertId,
      name,
      description,
      stars_required: stars_required || 0
    });
  } catch (error) {
    console.error('[POST /paths] Error:', error);
    res.status(500).json({ error: 'Failed to create path' });
  }
});

// Update path (admin only)
api.put('/paths/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, stars_required } = req.body;

    // Check if user is admin
    const [userRows] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    if (userRows.length === 0 || userRows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await db.query(
      'UPDATE paths SET name = ?, description = ?, stars_required = ? WHERE id = ?',
      [name, description || '', stars_required || 0, id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('[PUT /paths/:id] Error:', error);
    res.status(500).json({ error: 'Failed to update path' });
  }
});

// Delete path (admin only)
api.delete('/paths/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user is admin
    const [userRows] = await db.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    if (userRows.length === 0 || userRows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await db.query('DELETE FROM paths WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('[DELETE /paths/:id] Error:', error);
    res.status(500).json({ error: 'Failed to delete path' });
  }
});

// Unlock path for current user
api.post('/paths/:id/unlock', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Check if path exists and get required stars
    const [pathRows] = await db.query('SELECT stars_required FROM paths WHERE id = ?', [id]);
    if (pathRows.length === 0) {
      return res.status(404).json({ error: 'Path not found' });
    }

    const path = pathRows[0];

    // Check if user has enough stars
    const [userRows] = await db.query('SELECT stars FROM users WHERE id = ?', [userId]);
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userRows[0];
    if (user.stars < path.stars_required) {
      return res.status(403).json({ error: 'Not enough stars to unlock this path' });
    }

    // Check if already unlocked
    const [existingUnlock] = await db.query('SELECT * FROM user_paths WHERE user_id = ? AND path_id = ?', [userId, id]);
    if (existingUnlock.length > 0) {
      return res.json({ message: 'Path already unlocked' });
    }

    // Unlock the path (don't deduct stars, just grant access)
    await db.query('INSERT INTO user_paths (user_id, path_id) VALUES (?, ?)', [userId, id]);

    res.json({ success: true, message: 'Path unlocked successfully' });
  } catch (error) {
    console.error('[POST /paths/:id/unlock] Error:', error);
    res.status(500).json({ error: 'Failed to unlock path' });
  }
});

// --- PATH & LESSONS API ---

// Get Lessons for a Path (including tasks and status for current user)
api.get('/paths/:pathId/details', async (req, res) => {
  const { pathId } = req.params;
  const userId = optionalUserId(req);

  try {
    // 1. Get Lessons
    const [lessons] = await db.query('SELECT * FROM lessons WHERE path_id = ? ORDER BY order_index ASC', [pathId]);

    // 2. Get Tasks for these lessons
    const lessonIds = lessons.map(l => l.id);
    let tasks = [];
    if (lessonIds.length > 0) {
      const [rows] = await db.query(`SELECT * FROM tasks WHERE lesson_id IN (${lessonIds.join(',')})`);
      tasks = rows;

      // Calculate unviewed submissions for admin
      if (userId && tasks.length > 0) {
        const [userRows] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
        if (userRows.length > 0 && userRows[0].role === 'admin') {
          const [unviewedCounts] = await db.query(`
             SELECT task_id, COUNT(*) as count 
             FROM task_submissions 
             WHERE task_id IN (${tasks.map(t => t.id).join(',')}) 
             AND status != 'rejected'
             AND (is_viewed = FALSE OR is_viewed IS NULL)
             GROUP BY task_id
           `);

          unviewedCounts.forEach(c => {
            const t = tasks.find(task => task.id === c.task_id);
            if (t) t.unviewed_count = c.count;
          });
        } else if (userRows.length > 0 && userRows[0].role === 'student') {
          // For students, check which tasks are NEW (not viewed yet)
          const [taskViews] = await db.query(`
            SELECT task_id, viewed_at
            FROM user_task_views
            WHERE user_id = ? AND task_id IN (${tasks.map(t => t.id).join(',')})
          `, [userId]);

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

// Update Lesson (Admin only)
api.put('/lessons/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, description } = req.body;

  try {
    await db.query(
      'UPDATE lessons SET title = ?, description = ? WHERE id = ?',
      [title, description || '', id]
    );
    res.json({ message: 'Lesson updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update lesson' });
  }
});

// Delete Lesson (Admin only)
api.delete('/lessons/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    // Get lesson info before deleting for Socket.IO event
    const [lessons] = await db.query('SELECT path_id FROM lessons WHERE id = ?', [id]);
    const pathId = lessons.length > 0 ? lessons[0].path_id : null;

    // Tasks will be deleted automatically due to CASCADE
    await db.query('DELETE FROM lessons WHERE id = ?', [id]);

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
        INNER JOIN user_paths up ON u.id = up.user_id
        WHERE up.path_id = ? AND u.role = 'student' AND u.is_approved = TRUE
      `, [lesson.path_id]);

      for (const student of students) {
        // Create in-app notification
        await createNotification(
          student.id,
          'new_task',
          'New Task Available! 📝',
          `Task: "${title}" (${taskType})\nPath: ${lesson.path_name}\nLesson: ${lesson.lesson_title}`,
          null,
          { taskId: result.insertId, lessonId, pathId: lesson.path_id, type, deadline: deadlineTs }
        );

        // Send email notification
        await sendNotificationEmail(
          student.email,
          'New Task Available! 📝',
          `Hello <strong>${escapeHtml(student.name)}</strong>!<br><br>
          A new task has been added to your learning path:<br><br>
          <strong>Task:</strong> ${escapeHtml(title)}<br>
          <strong>Type:</strong> <span style="color: ${type === 'mandatory' ? '#dc2626' : '#16a34a'};">${taskType}</span><br>
          <strong>Path:</strong> ${escapeHtml(lesson.path_name)}<br>
          <strong>Lesson:</strong> ${escapeHtml(lesson.lesson_title)}<br>
          ${deadline ? `<strong>Deadline:</strong> ${new Date(deadline).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}<br>` : ''}
          <br>
          Log in to the platform to view the task details and start working on it!`
        );
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
  const { title, type, xp, deadline, description } = req.body;


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

    const result = await db.query(
      'UPDATE tasks SET title = ?, type = ?, xp_reward = ?, deadline = ?, description = ? WHERE id = ?',
      [title, type, xp || 0, deadlineTs, description || '', id]
    );

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
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

// Upload Task Submission
api.post('/tasks/:id/submit', authenticateToken, upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id; // always the authenticated user — never trust the body

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const [result] = await db.query(
      'INSERT INTO task_submissions (task_id, user_id, file_name, file_path, file_size) VALUES (?, ?, ?, ?, ?)',
      [id, userId, req.file.originalname, req.file.filename, req.file.size]
    );

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
      const notificationMessage = `${users[0].name} has uploaded a submission for task "${task.title}" (${task.type.charAt(0).toUpperCase() + task.type.slice(1)}) in lesson "${lessonTitle}" from path "${pathName}".`;

      // Notify all admins about the submission
      await notifyAdmins(
        'task_submission',
        'New Task Submission! 📤',
        notificationMessage,
        null, // Remove link
        {
          taskId: id,
          userId,
          submissionId: result.insertId,
          fileName: req.file.originalname,
          taskTitle: task.title,
          taskType: task.type,
          lessonTitle,
          pathName
        }
      );

      // Emit live event for Admin graph update
      io.emit('task:submission_uploaded', { taskId: id });

      // Send email to admins with detailed info
      const [admins] = await db.query('SELECT email FROM users WHERE role = ?', ['admin']);
      for (const admin of admins) {
        const emailHtml = `
          <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px; max-width: 500px;">
            <h2 style="color: #333;">New Task Submission! 📤</h2>
            <p>Hello,</p>
            <p>A student has submitted a task:</p>
            <p><strong>Student:</strong> ${escapeHtml(users[0].name)}</p>
            <p><strong>Task:</strong> ${escapeHtml(task.title)}</p>
            <p><strong>Type:</strong> ${task.type.charAt(0).toUpperCase() + task.type.slice(1)}</p>
            <p><strong>Lesson:</strong> ${escapeHtml(lessonTitle)}</p>
            <p><strong>Path:</strong> ${escapeHtml(pathName)}</p>
            <p><strong>File:</strong> ${escapeHtml(req.file.originalname)}</p>
            <p style="color: #999; font-size: 12px; margin-top: 20px;">Please review the submission in the platform.</p>
          </div>
        `;
        await sendEmail(admin.email, 'New Task Submission! 📤', emailHtml);
      }
    }

    res.status(201).json({
      id: result.insertId,
      message: 'Submission uploaded successfully',
      fileName: req.file.originalname
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

    await createNotification(
      submission.user_id,
      'submission_approved',
      'Submission Approved! ✅',
      `Your submission for "${taskTitle}" has been approved! The next step is now unlocked.`,
      null,
      { taskId: submission.task_id, submissionId: id }
    );

    // Send Email
    const [student] = await db.query('SELECT email, name FROM users WHERE id = ?', [submission.user_id]);
    if (student.length > 0) {
      await sendNotificationEmail(
        student[0].email,
        'Submission Approved! ✅',
        `Hello <strong>${escapeHtml(student[0].name)}</strong>!<br><br>
            Great news! Your submission for task <strong>"${escapeHtml(taskTitle)}"</strong> has been approved by an administrator.<br>
            You can now proceed to the next task in your learning path.`
      );
    }

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
    await createNotification(
      studentId,
      'submission_approved',
      'Task Approved! ✅',
      `Your submissions for "${taskTitle}" have been approved! ${isMandatory ? 'The next step is now unlocked.' : 'XP has been granted.'}`,
      null,
      { taskId }
    );

    // Send Email
    const [student] = await db.query('SELECT email, name FROM users WHERE id = ?', [studentId]);
    if (student.length > 0) {
      await sendNotificationEmail(
        student[0].email,
        'Task Approved! ✅',
        `Hello <strong>${escapeHtml(student[0].name)}</strong>!<br><br>
            Great news! Your submissions for task <strong>"${escapeHtml(taskTitle)}"</strong> have been approved by an administrator.<br>
            You can now proceed to the next task in your learning path.`
      );
    }

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
    await createNotification(
      studentId,
      'submission_rejected',
      'Task Rejected ❌',
      `Your submissions for "${taskTitle}" were rejected. Reason: ${comment.trim()}`,
      null,
      { taskId, comment: comment.trim() }
    );

    // Send Email with detailed rejection reason
    const [student] = await db.query('SELECT email, name FROM users WHERE id = ?', [studentId]);
    if (student.length > 0) {
      await sendNotificationEmail(
        student[0].email,
        'Task Rejected ❌',
        `Hello <strong>${escapeHtml(student[0].name)}</strong>!<br><br>
            Your submissions for task <strong>"${escapeHtml(taskTitle)}"</strong> have been reviewed and rejected by an administrator.<br><br>
            <strong>Reason:</strong><br>
            <div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin-top: 10px; border-left: 4px solid #ef4444;">
              ${escapeHtml(comment.trim()).replace(/\n/g, '<br>')}
            </div><br>
            Please review the feedback and resubmit your work when ready.`
      );
    }

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
// }
const LAYOUT = { firstX: 80, centerY: 250, lessonSpacingX: 250, taskSpacingY: 120, taskSpacingX: 150 };
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
  if (creatingPath) {
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 255) errors.push('name is required (max 255 chars)');
    if (b.stars_required !== undefined && (!Number.isInteger(b.stars_required) || b.stars_required < 0)) errors.push('stars_required must be a non-negative integer');
  } else if (!Number.isInteger(Number(b.pathId))) {
    errors.push('pathId must be an integer');
  }
  if (!Array.isArray(b.lessons)) errors.push('lessons must be an array');
  else if (b.lessons.length > 200) errors.push('at most 200 lessons per request');
  else b.lessons.forEach((l, i) => {
    if (!l || typeof l.title !== 'string' || !l.title.trim() || l.title.length > 255) errors.push(`lessons[${i}].title is required (max 255 chars)`);
    if (l && l.tasks !== undefined) {
      if (!Array.isArray(l.tasks)) errors.push(`lessons[${i}].tasks must be an array`);
      else if (l.tasks.length > 50) errors.push(`lessons[${i}]: at most 50 tasks`);
      else l.tasks.forEach((t, j) => {
        if (!t || typeof t.title !== 'string' || !t.title.trim() || t.title.length > 255) errors.push(`lessons[${i}].tasks[${j}].title is required (max 255 chars)`);
        if (t && t.type !== undefined && !TASK_TYPES.has(t.type)) errors.push(`lessons[${i}].tasks[${j}].type must be "mandatory" or "optional"`);
        if (t && t.xp !== undefined && (!Number.isInteger(t.xp) || t.xp < 0)) errors.push(`lessons[${i}].tasks[${j}].xp must be a non-negative integer`);
        try { if (t) parseDeadline(t.deadline); } catch (e) { errors.push(`lessons[${i}].tasks[${j}]: ${e.message}`); }
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
        const [result] = await tx.query(
          'INSERT INTO paths (name, description, stars_required) VALUES (?, ?, ?)',
          [body.name.trim(), body.description || '', body.stars_required || 0]
        );
        pathId = result.insertId;
        pathName = body.name.trim();
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
        let taskX = x + LAYOUT.taskSpacingY;
        const taskY = y + LAYOUT.taskSpacingY * direction;
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

        lessons.push({ id: lessonId, title: lesson.title.trim(), order_index: order, tasks: createdTasks });
        parentId = lessonId;
        x += LAYOUT.lessonSpacingX;
        order += 1;
      }

      return { pathId, pathName, lessons };
    });

    // Let open admin/student views refresh
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
        tasks: created.lessons.reduce((n, l) => n + l.tasks.length, 0)
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
io.use((socket, next) => {
  try {
    const cookies = cookie.parse(socket.handshake.headers.cookie || '');
    if (!cookies.token) return next(new Error('unauthorized'));
    const decoded = verifySessionToken(cookies.token);
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
