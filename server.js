const express = require('express');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai"); // This matches the package you just installed
const fs = require('fs');
const WebSocket = require('ws');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

process.on('unhandledRejection', (reason) => {
    console.error('UnhandledPromiseRejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('UncaughtException:', err && err.stack ? err.stack : err);
    // Exit so the host restarts the process and the error is visible in logs.
    process.exit(1);
});

// ... existing middleware and routes ...

// Initialize the AI with your key
const app = express();
app.set('trust proxy', 1);
const STARTED_AT = new Date().toISOString();
let APP_VERSION = 'unknown';
try {
    const pkgPath = path.join(__dirname, 'package.json');
    if (fs.existsSync(pkgPath)) {
        APP_VERSION = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || APP_VERSION;
    }
} catch {}
const APP_BUILD =
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.RENDER_GIT_COMMIT ||
    '';
let Database = null;
try {
    // Native dependency; may fail to install/build on some hosts if toolchain is missing.
    Database = require('better-sqlite3');
} catch (err) {
    console.error('better-sqlite3 unavailable; running in limited mode:', err.message);
}

// --- Persistence paths (for deployments with a mounted volume) ---
// Set DATA_DIR to a persistent directory (examples: "/data" on Fly.io, "/var/data" on a VPS)
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
console.log('Boot:', {
    node: process.version,
    env: process.env.NODE_ENV || 'undefined',
    port: process.env.PORT || 'unset',
    dataDir: DATA_DIR
});
try {
    if (DATA_DIR && DATA_DIR !== __dirname && !fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(UPLOADS_DIR)) {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
} catch (err) {
    console.error('Failed to ensure DATA_DIR exists:', err.message);
}

// WebSocket server setup
const wss = new WebSocket.Server({ noServer: true });
const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('WebSocket client connected');

    ws.on('close', () => {
        clients.delete(ws);
        console.log('WebSocket client disconnected');
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        clients.delete(ws);
    });
});

// Function to broadcast data to all connected clients
function broadcast(type, data) {
    const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// MIDDLEWARE: This allows the backend to read JSON data sent from the frontend
app.use(express.json());

// Response headers to help verify you’re hitting the latest deployment (useful on Railway).
app.use((req, res, next) => {
    res.setHeader('X-SentinelX-Version', APP_VERSION);
    res.setHeader('X-SentinelX-Started-At', STARTED_AT);
    if (APP_BUILD) res.setHeader('X-SentinelX-Build', APP_BUILD);
    next();
});

// Optional global protections for public deployments:
// - BASIC_AUTH_USER / BASIC_AUTH_PASS: require basic auth for all routes except /healthz
// - ALLOWLIST_IPS: comma-separated list of allowed client IPs (exact match), others 403
function constantTimeEqual(a, b) {
    const aa = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    if (aa.length !== bb.length) return false;
    return crypto.timingSafeEqual(aa, bb);
}

function parseBasicAuth(header) {
    const h = String(header || '');
    if (!h.startsWith('Basic ')) return null;
    try {
        const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        if (idx < 0) return null;
        return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
    } catch {
        return null;
    }
}

function requireGlobalAccess(req, res, next) {
    if (req.path === '/healthz') return next();

    const allowlist = process.env.ALLOWLIST_IPS ? String(process.env.ALLOWLIST_IPS) : '';
    if (allowlist.trim()) {
        const allowed = allowlist
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        const ip = getRequestIp(req);
        if (!ip || !allowed.includes(ip)) return res.status(403).send('Forbidden');
    }

    const u = process.env.BASIC_AUTH_USER ? String(process.env.BASIC_AUTH_USER) : '';
    const p = process.env.BASIC_AUTH_PASS ? String(process.env.BASIC_AUTH_PASS) : '';
    if (u && p) {
        const creds = parseBasicAuth(req.get('authorization'));
        if (!creds || !constantTimeEqual(creds.user, u) || !constantTimeEqual(creds.pass, p)) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Sentinel-X"');
            return res.status(401).send('Authentication required');
        }
    }

    next();
}
app.use(requireGlobalAccess);

// Rate limiting (memory-based; good enough for a small demo)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 50,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});
const analyzeLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 80,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});

// Disable caching for frontend assets during development (prevents stale script.js in browser cache)
app.use((req, res, next) => {
    if (
        req.method === 'GET' &&
        (req.path === '/' ||
            req.path.endsWith('.html') ||
            req.path.endsWith('.js') ||
            req.path.endsWith('.css'))
    ) {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
    }
    next();
});

// ROUTE: Serves the main dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Simple health endpoint for Railway / uptime checks
app.get('/healthz', (req, res) => {
    res.json({
        ok: true,
        time: new Date().toISOString(),
        startedAt: STARTED_AT,
        version: APP_VERSION,
        build: APP_BUILD || null,
        db: !!db,
        dataDir: DATA_DIR
    });
});

// --- API ROUTES (must come BEFORE static middleware) ---
let db;
let insertLoginEventStmt;
let insertUploadedFileStmt;
try {
    const DB_PATH = path.join(DATA_DIR, 'data.db');
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    
    // Users table for authentication
    db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            created_at TEXT
        )
    `).run();

    // Login events table (tracks successful and failed login attempts)
    db.prepare(`
        CREATE TABLE IF NOT EXISTS login_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            username TEXT,
            success INTEGER NOT NULL,
            ip TEXT,
            user_agent TEXT,
            reason TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_login_events_user_created ON login_events(user_id, created_at)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_login_events_username_created ON login_events(username, created_at)`).run();
    insertLoginEventStmt = db.prepare(`
        INSERT INTO login_events (user_id, username, success, ip, user_agent, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Uploaded files table (tracks files uploaded from this device or other devices)
    db.prepare(`
        CREATE TABLE IF NOT EXISTS uploaded_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sha256 TEXT NOT NULL,
            original_name TEXT NOT NULL,
            stored_name TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            size INTEGER,
            mime_type TEXT,
            device_id TEXT,
            ip TEXT,
            user_agent TEXT,
            created_at TEXT NOT NULL
        )
    `).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_uploaded_files_created ON uploaded_files(created_at)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_uploaded_files_sha256 ON uploaded_files(sha256)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_uploaded_files_device ON uploaded_files(device_id, created_at)`).run();
    insertUploadedFileStmt = db.prepare(`
        INSERT INTO uploaded_files (sha256, original_name, stored_name, relative_path, size, mime_type, device_id, ip, user_agent, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    // Initialize default admin user if it doesn't exist
    const adminExists = db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get();
    if (!adminExists) {
        const hashedPassword = bcrypt.hashSync('sentinel123', 10);
        db.prepare(`
            INSERT INTO users (username, password, created_at)
            VALUES (?, ?, ?)
        `).run('admin', hashedPassword, new Date().toISOString());
        console.log('Default admin user created: admin / sentinel123');
    }
    
    db.prepare(`
        CREATE TABLE IF NOT EXISTS analyses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fileName TEXT,
            hash TEXT,
            status TEXT,
            score INTEGER,
            timestamp TEXT
        )
    `).run();

    // Lightweight migration: add metadata columns if missing (safe to run on every boot)
    try {
        const existingCols = new Set(
            db.prepare(`PRAGMA table_info(analyses)`).all().map((r) => String(r.name))
        );
        const addCol = (name, type) => {
            if (!existingCols.has(name)) {
                db.prepare(`ALTER TABLE analyses ADD COLUMN ${name} ${type}`).run();
                existingCols.add(name);
            }
        };
        addCol('analysis_kind', 'TEXT'); // 'static' | 'behavior'
        addCol('username', 'TEXT');
        addCol('device_id', 'TEXT');
        addCol('ip', 'TEXT');
        addCol('user_agent', 'TEXT');
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_analyses_timestamp ON analyses(timestamp)`).run();
    } catch (err) {
        console.error('Analyses schema migration failed:', err.message);
    }

    db.prepare(`
        CREATE TABLE IF NOT EXISTS behavior_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hash TEXT,
            behavior_type TEXT,
            severity TEXT,
            description TEXT,
            timestamp TEXT
        )
    `).run();
    console.log('SQLite:', DB_PATH, 'opened and tables ensured');
} catch (err) {
    console.error('SQLite connection failed:', err.message);
    db = null;
    insertLoginEventStmt = null;
    insertUploadedFileStmt = null;
}

const axios = require('axios');

// --- Config persistence ---
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
let appConfig = {
    metricsInterval: 5,
    virusTotalApiKey: process.env.VIRUSTOTAL_API_KEY || '',
    geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    geminiModel: 'gemini-1.5-flash'
};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            appConfig = Object.assign(appConfig, parsed);
        } else {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(appConfig, null, 2));
        }
        console.log('Config loaded:', CONFIG_PATH);
    } catch (err) {
        console.error('Failed to load config:', err.message);
    }
}

function saveConfig(newConfig) {
    appConfig = Object.assign(appConfig, newConfig);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(appConfig, null, 2));
}

loadConfig();

function getVirusTotalApiKey() {
    return String(appConfig.virusTotalApiKey || process.env.VIRUSTOTAL_API_KEY || '').trim();
}

function getGeminiApiKey() {
    return String(
        appConfig.geminiApiKey ||
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        ''
    ).trim();
}

function getGeminiModel() {
    const m = String(appConfig.geminiModel || '').trim();
    return m || 'gemini-1.5-flash';
}

let cachedGeminiKey = null;
let cachedGeminiClient = null;
function getGeminiClient() {
    const key = getGeminiApiKey();
    if (!key) return null;
    if (cachedGeminiClient && cachedGeminiKey === key) return cachedGeminiClient;

    cachedGeminiKey = key;
    cachedGeminiClient = new GoogleGenerativeAI(key);
    return cachedGeminiClient;
}

function getRequestIp(req) {
    const forwardedFor = req.headers['x-forwarded-for'];
    return (
        (typeof forwardedFor === 'string' && forwardedFor.trim()
            ? forwardedFor.split(',')[0].trim()
            : null) ||
        req.socket?.remoteAddress ||
        req.ip ||
        null
    );
}

function getClientMeta(req) {
    return {
        username: req.get('x-username') ? String(req.get('x-username')).slice(0, 64) : null,
        deviceId: req.get('x-device-id') ? String(req.get('x-device-id')).slice(0, 128) : null,
        ip: getRequestIp(req),
        userAgent: req.get('user-agent') ? String(req.get('user-agent')).slice(0, 256) : null
    };
}

function getProvidedAdminToken(req) {
    const h = req.get('x-admin-token');
    if (h) return String(h);
    const auth = String(req.get('authorization') || '');
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7);
    return '';
}

function requireAdminToken(req, res, next) {
    const expected = process.env.ADMIN_TOKEN ? String(process.env.ADMIN_TOKEN) : '';
    if (!expected) return res.status(503).json({ error: 'ADMIN_TOKEN not configured' });
    const provided = getProvidedAdminToken(req);
    if (!provided || !constantTimeEqual(provided, expected)) return res.status(403).json({ error: 'Forbidden' });
    next();
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (d) => hash.update(d));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOADS_DIR),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname || '').slice(0, 16);
            const name = `tmp-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
            cb(null, name);
        }
    }),
    limits: {
        fileSize: 200 * 1024 * 1024 // 200MB
    }
});

// ============================================
// LOGIN ENDPOINT
// ============================================
app.post('/login', authLimiter, (req, res) => {
    const { username, password } = req.body;
    const userAgent = req.get('user-agent') || null;
    const ip = getRequestIp(req);
    
    if (!username || !password) {
        try {
            insertLoginEventStmt?.run(null, username || null, 0, ip, userAgent, 'missing_credentials', new Date().toISOString());
        } catch {}
        return res.status(400).json({ 
            success: false, 
            message: 'Username and password required' 
        });
    }

    // If SQLite isn't available (for example: native module couldn't build on the host),
    // allow demo login so the UI still functions.
    if (!db) {
        const ok = username === 'admin' && password === 'sentinel123';
        if (!ok) {
            return res.status(401).json({
                success: false,
                message: 'Invalid username or password'
            });
        }

        const token = crypto.randomBytes(32).toString('hex');
        return res.json({
            success: true,
            token: token,
            message: 'Login successful (demo mode)'
        });
    }
    
    try {
        const user = db.prepare(`SELECT id, username, password FROM users WHERE username = ?`).get(username);
        
        if (!user) {
            try {
                insertLoginEventStmt?.run(null, username, 0, ip, userAgent, 'user_not_found', new Date().toISOString());
            } catch {}
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid username or password' 
            });
        }
        
        // Support both old sha256 hashes and new bcrypt hashes.
        const stored = String(user.password || '');
        const isBcrypt = stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$');
        const ok = isBcrypt
            ? bcrypt.compareSync(String(password), stored)
            : crypto.createHash('sha256').update(String(password)).digest('hex') === stored;

        if (!ok) {
            try {
                insertLoginEventStmt?.run(user.id, user.username, 0, ip, userAgent, 'bad_password', new Date().toISOString());
            } catch {}
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid username or password' 
            });
        }

        // Upgrade legacy sha256 hashes to bcrypt after a successful login.
        if (!isBcrypt) {
            try {
                const upgraded = bcrypt.hashSync(String(password), 10);
                db.prepare(`UPDATE users SET password = ? WHERE id = ?`).run(upgraded, user.id);
            } catch {}
        }
        
        // Generate a simple token (in production, use JWT)
        const token = crypto.randomBytes(32).toString('hex');

        try {
            insertLoginEventStmt?.run(user.id, user.username, 1, ip, userAgent, null, new Date().toISOString());
        } catch {}
        
        res.json({
            success: true,
            token: token,
            message: 'Login successful'
        });
    } catch (error) {
        console.error('Login error:', error);
        try {
            insertLoginEventStmt?.run(null, username || null, 0, ip, userAgent, 'server_error', new Date().toISOString());
        } catch {}
        res.status(500).json({ 
            success: false, 
            message: 'Server error' 
        });
    }
});

// ============================================
// REGISTER (PUBLIC SIGNUP) ENDPOINT
// ============================================
app.post('/register', authLimiter, (req, res) => {
    if (String(process.env.DISABLE_PUBLIC_SIGNUP || '').toLowerCase() === 'true') {
        return res.status(403).json({ success: false, message: 'Public signup disabled' });
    }
    if (!db) return res.status(503).json({ success: false, message: 'Database not available' });

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
        return res.status(400).json({ success: false, message: 'Username must be 3-32 chars (letters/numbers/_)' });
    }
    if (password.length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    try {
        const exists = db.prepare(`SELECT id FROM users WHERE username = ?`).get(username);
        if (exists) return res.status(409).json({ success: false, message: 'Username already exists' });

        const hashedPassword = bcrypt.hashSync(password, 10);
        db.prepare(`INSERT INTO users (username, password, created_at) VALUES (?, ?, ?)`).run(
            username,
            hashedPassword,
            new Date().toISOString()
        );

        res.json({ success: true, message: 'Account created' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to create account' });
    }
});

// ============================================
// FILE UPLOAD + LISTING (shared across devices)
// ============================================
app.post('/api/upload', analyzeLimiter, upload.single('file'), async (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not available' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });
    if (!insertUploadedFileStmt) return res.status(500).json({ error: 'Upload DB not initialized (restart server)' });

    const deviceId = req.get('x-device-id') || null;
    const userAgent = req.get('user-agent') || null;
    const ip = getRequestIp(req);

    const tempPath = req.file.path;
    const originalName = req.file.originalname || 'unknown';
    const mimeType = req.file.mimetype || null;
    const size = req.file.size || null;

    try {
        const sha256 = await sha256File(tempPath);
        const ext = path.extname(originalName || '').slice(0, 16);
        const storedName = `${sha256}${ext}`;
        const finalPath = path.join(UPLOADS_DIR, storedName);

        if (fs.existsSync(finalPath)) {
            try { fs.unlinkSync(tempPath); } catch {}
        } else {
            fs.renameSync(tempPath, finalPath);
        }

        const relativePath = path.join('uploads', storedName).replace(/\\/g, '/');
        const createdAt = new Date().toISOString();
        const info = insertUploadedFileStmt.run(
            sha256,
            originalName,
            storedName,
            relativePath,
            size,
            mimeType,
            deviceId,
            ip,
            userAgent,
            createdAt
        );

        res.json({
            success: true,
            id: info?.lastInsertRowid ?? null,
            sha256,
            originalName,
            storedName,
            relativePath,
            createdAt
        });
    } catch (err) {
        try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {}
        res.status(500).json({ error: 'Upload failed', reason: err.message });
    }
});

app.get('/api/uploads', (req, res) => {
    if (!db) return res.json({ uploads: [] });

    const limitRaw = Number(req.query.limit || 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 50;
    const deviceId = req.query.device_id ? String(req.query.device_id) : null;
    const q = req.query.q ? String(req.query.q) : null;

    try {
        const where = [];
        const params = [];
        if (deviceId) {
            where.push('device_id = ?');
            params.push(deviceId);
        }
        if (q) {
            where.push('original_name LIKE ?');
            params.push(`%${q}%`);
        }

        const sql = `
            SELECT id, sha256, original_name, size, mime_type, device_id, ip, created_at, relative_path
            FROM uploaded_files
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY created_at DESC
            LIMIT ?
        `;
        params.push(limit);

        const rows = db.prepare(sql).all(...params);
        res.json({ uploads: rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list uploads', reason: err.message });
    }
});

app.post('/analyze', analyzeLimiter, async (req, res) => {
    const { fileName, hash } = req.body; // Received from script.js
    const meta = getClientMeta(req);

    // If API key is not configured, return UNKNOWN (200) so frontend continues with dynamic analysis
    const virusTotalKey = getVirusTotalApiKey();
    if (!virusTotalKey || virusTotalKey === 'YOUR_VIRUSTOTAL_API_KEY') {
        if (db) {
            try {
                db.prepare(`
                    INSERT INTO analyses (fileName, hash, status, score, timestamp, analysis_kind, username, device_id, ip, user_agent)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    fileName,
                    hash,
                    'UNKNOWN',
                    0,
                    new Date().toISOString(),
                    'static',
                    meta.username,
                    meta.deviceId,
                    meta.ip,
                    meta.userAgent
                );
                broadcast('analysis', { fileName, status: 'UNKNOWN', score: 0, analysis_kind: 'static', username: meta.username, device_id: meta.deviceId, timestamp: new Date().toISOString() });
            } catch {}
        }
        return res.json({
            status: "UNKNOWN",
            score: 0,
            reasoning: "VirusTotal API key not configured. Static lookup skipped.",
            timestamp: new Date().toISOString()
        });
    }

    try {
        // Query VirusTotal API v3 for the file hash
        const response = await axios.get(`https://www.virustotal.com/api/v3/files/${hash}`, {
            headers: { 'x-apikey': virusTotalKey }
        });

        const attributes = response.data.data.attributes;
        const stats = attributes.last_analysis_stats;

        // Map real data to your UI format
        const result = {
            status: stats.malicious > 0 ? "MALICIOUS" : "CLEAN",
            score: Math.round((stats.malicious / (stats.malicious + stats.undetected)) * 100),
            reasoning: `Flagged by ${stats.malicious} vendors. Engine: ${attributes.type_description}`,
            timestamp: new Date().toISOString()
        };

        // Store the analysis result in database
        if (db) {
            db.prepare(`
                INSERT INTO analyses (fileName, hash, status, score, timestamp, analysis_kind, username, device_id, ip, user_agent)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                fileName,
                hash,
                result.status,
                result.score,
                result.timestamp,
                'static',
                meta.username,
                meta.deviceId,
                meta.ip,
                meta.userAgent
            );
            broadcast('analysis', { fileName, status: result.status, score: result.score, analysis_kind: 'static', username: meta.username, device_id: meta.deviceId, timestamp: result.timestamp });
        }

        res.json(result);

        // Broadcast stats update
        try {
            if (!db) return;
            const analyses = db.prepare(`SELECT COUNT(*) as total, status FROM analyses GROUP BY status`).all();
            const statuses = {};
            let totalAnalyses = 0;
            analyses.forEach(row => {
                statuses[row.status] = row.total;
                totalAnalyses += row.total;
            });

            const behaviors_stats = db.prepare(`
                SELECT behavior_type, COUNT(*) as count FROM behavior_logs GROUP BY behavior_type ORDER BY count DESC LIMIT 10
            `).all();

            const severities = db.prepare(`
                SELECT severity, COUNT(*) as count FROM behavior_logs GROUP BY severity
            `).all();
            const severityMap = {};
            severities.forEach(row => {
                severityMap[row.severity] = row.count;
            });

            const scoreStats = db.prepare(`
                SELECT AVG(score) as avg_score, MAX(score) as max_score, MIN(score) as min_score FROM analyses
            `).get();

            const stats = {
                totalAnalyses,
                statuses,
                topBehaviors: behaviors_stats,
                severities: severityMap,
                scoreStats
            };
            
            broadcast('stats', stats);
        } catch (broadcastErr) {
            console.error('Failed to broadcast stats update:', broadcastErr);
        }

    } catch (error) {
        console.error('VirusTotal lookup failed:', error.message);
        // Return UNKNOWN with 200 so frontend still proceeds to behavior analysis
        res.json({
            status: "UNKNOWN",
            score: 0,
            reasoning: "VirusTotal lookup failed or hash not found. Dynamic analysis recommended.",
            timestamp: new Date().toISOString()
        });
    }
});

// ===== BEHAVIOR DETECTION ENGINE =====
const BEHAVIOR_SIGNATURES = {
    'registry_modification': {
        patterns: ['HKLM\\Software\\Microsoft\\Windows\\Run', 'SetValueEx', 'RegCreateKey'],
        severity: 'HIGH',
        description: 'Persistence via registry modification'
    },
    'process_injection': {
        patterns: ['CreateRemoteThread', 'WriteProcessMemory', 'VirtualAllocEx'],
        severity: 'CRITICAL',
        description: 'Code injection into other processes'
    },
    'file_encryption': {
        patterns: ['CryptEncrypt', 'EVP_Encrypt', 'AES_encrypt'],
        severity: 'HIGH',
        description: 'File encryption detected (ransomware indicator)'
    },
    'command_execution': {
        patterns: ['cmd.exe', 'powershell.exe', 'system()', 'exec()'],
        severity: 'MEDIUM',
        description: 'Suspicious command execution'
    },
    'network_beaconing': {
        patterns: ['WinINet', 'URLDownloadToFile', 'InternetConnect'],
        severity: 'HIGH',
        description: 'Network communication to external server'
    },
    'anti_analysis': {
        patterns: ['IsDebuggerPresent', 'CheckRemoteDebuggerPresent', 'GetTickCount'],
        severity: 'MEDIUM',
        description: 'Anti-debugging/anti-analysis techniques'
    },
    'privilege_escalation': {
        patterns: ['AdjustTokenPrivileges', 'EnablePrivilege', 'SeDebugPrivilege'],
        severity: 'CRITICAL',
        description: 'Privilege escalation attempt'
    }
};

function analyzeFileSize(size) {
    const behaviors = [];
    if (size > 50 * 1024 * 1024) {
        behaviors.push({
            type: 'suspicious_size',
            severity: 'LOW',
            description: 'Unusually large file size (>50MB)'
        });
    }
    return behaviors;
}

function analyzeFileExtension(fileName) {
    const behaviors = [];
    const suspiciousExts = ['.exe', '.dll', '.scr', '.vbs', '.js', '.bat', '.cmd', '.com'];
    const ext = path.extname(fileName).toLowerCase();
    
    if (suspiciousExts.includes(ext)) {
        behaviors.push({
            type: 'executable_detected',
            severity: 'MEDIUM',
            description: `Executable file detected: ${ext}`
        });
    }
    return behaviors;
}

function detectBehaviors(fileHash, fileName) {
    const detectedBehaviors = [];
    
    // Simulate behavior detection based on heuristics
    const behavior_chance = Math.random();
    
    // Add detected behaviors based on probability
    if (behavior_chance < 0.3) {
        detectedBehaviors.push({
            type: 'network_beaconing',
            severity: 'HIGH',
            description: 'Outbound connection attempt to 185.220.101.45:8080'
        });
    }
    if (behavior_chance < 0.5) {
        detectedBehaviors.push({
            type: 'registry_modification',
            severity: 'HIGH',
            description: 'Attempts to modify HKLM\\Software\\Microsoft\\Windows\\Run'
        });
    }
    if (behavior_chance < 0.4) {
        detectedBehaviors.push({
            type: 'process_injection',
            severity: 'CRITICAL',
            description: 'WriteProcessMemory call to svchost.exe (PID: 1024)'
        });
    }
    if (behavior_chance < 0.2) {
        detectedBehaviors.push({
            type: 'anti_analysis',
            severity: 'MEDIUM',
            description: 'IsDebuggerPresent API call detected'
        });
    }
    
    // Add file-based detection
    detectedBehaviors.push(...analyzeFileSize(Math.random() * 100 * 1024 * 1024));
    detectedBehaviors.push(...analyzeFileExtension(fileName));
    
    return detectedBehaviors;
}

function calculateBehaviorScore(behaviors) {
    let score = 0;
    behaviors.forEach(b => {
        if (b.severity === 'CRITICAL') score += 40;
        else if (b.severity === 'HIGH') score += 20;
        else if (b.severity === 'MEDIUM') score += 10;
        else score += 5;
    });
    return Math.min(score, 100);
}

app.post('/analyze-behavior', analyzeLimiter, async (req, res) => {
    const { fileName, hash } = req.body;
    const meta = getClientMeta(req);
    
    try {
        const behaviors = detectBehaviors(hash, fileName);
        const behaviorScore = calculateBehaviorScore(behaviors);
        
        // Store detected behaviors in database
        if (db) {
            behaviors.forEach(behavior => {
                db.prepare(`
                    INSERT INTO behavior_logs (hash, behavior_type, severity, description, timestamp)
                    VALUES (?, ?, ?, ?, ?)
                `).run(
                    hash,
                    behavior.type,
                    behavior.severity,
                    behavior.description,
                    new Date().toISOString()
                );
            });
        }
        
        // Determine final status based on behavior analysis
        let finalStatus = 'CLEAN';
        if (behaviorScore > 70) finalStatus = 'MALICIOUS';
        else if (behaviorScore > 40) finalStatus = 'SUSPICIOUS';
        else if (behaviorScore > 0) finalStatus = 'UNKNOWN';
        
        // Store the analysis result in database
        if (db) {
            db.prepare(`
                INSERT INTO analyses (fileName, hash, status, score, timestamp, analysis_kind, username, device_id, ip, user_agent)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                fileName,
                hash,
                finalStatus,
                behaviorScore,
                new Date().toISOString(),
                'behavior',
                meta.username,
                meta.deviceId,
                meta.ip,
                meta.userAgent
            );
            broadcast('analysis', { fileName, status: finalStatus, score: behaviorScore, analysis_kind: 'behavior', username: meta.username, device_id: meta.deviceId, timestamp: new Date().toISOString() });
        }
        
        const result = {
            behaviors: behaviors,
            behavior_score: behaviorScore,
            threat_level: behaviorScore > 70 ? 'CRITICAL' : behaviorScore > 40 ? 'HIGH' : 'MEDIUM',
            timestamp: new Date().toISOString()
        };
        
        res.json(result);
        
        // Broadcast real-time updates
        // Fetch updated stats and broadcast
        try {
            if (!db) return;
            const analyses = db.prepare(`SELECT COUNT(*) as total, status FROM analyses GROUP BY status`).all();
            const statuses = {};
            let totalAnalyses = 0;
            analyses.forEach(row => {
                statuses[row.status] = row.total;
                totalAnalyses += row.total;
            });

            const behaviors_stats = db.prepare(`
                SELECT behavior_type, COUNT(*) as count FROM behavior_logs GROUP BY behavior_type ORDER BY count DESC LIMIT 10
            `).all();

            const severities = db.prepare(`
                SELECT severity, COUNT(*) as count FROM behavior_logs GROUP BY severity
            `).all();
            const severityMap = {};
            severities.forEach(row => {
                severityMap[row.severity] = row.count;
            });

            const scoreStats = db.prepare(`
                SELECT AVG(score) as avg_score, MAX(score) as max_score, MIN(score) as min_score FROM analyses
            `).get();

            const stats = {
                totalAnalyses,
                statuses,
                topBehaviors: behaviors_stats,
                severities: severityMap,
                scoreStats
            };
            
            broadcast('stats', stats);
        } catch (broadcastErr) {
            console.error('Failed to broadcast stats update:', broadcastErr);
        }
        
    } catch (error) {
        res.status(500).json({
            error: 'Behavior analysis failed',
            reason: error.message
        });
    }
});

// Get behavior history for a specific file hash
app.get('/behavior-history/:hash', (req, res) => {
    const { hash } = req.params;
    try {
        const behaviors = db.prepare(`
            SELECT * FROM behavior_logs WHERE hash = ? ORDER BY timestamp DESC
        `).all(hash);
        
        res.json({ behaviors });
    } catch (error) {
        res.status(500).json({ error: 'Failed to retrieve behavior history' });
    }
});

// --- Additional APIs for frontend/clients ---
app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        timestamp: new Date().toISOString()
    });
});

// List recent analyses (for dashboards, tables, etc.)
app.get('/api/analyses', (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not available' });

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    try {
        const rows = db.prepare(`
            SELECT id, fileName, hash, status, score, timestamp
            FROM analyses
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(limit);
        res.json({ analyses: rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list analyses', reason: err.message });
    }
});

// Generate an AI incident report for a given file hash using Gemini.
app.post('/api/ai/report', async (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not available' });

    const { hash } = req.body || {};
    if (!hash) return res.status(400).json({ error: 'hash is required' });

    const client = getGeminiClient();
    if (!client) {
        return res.status(400).json({
            error: 'Gemini API key not configured',
            hint: 'Set GEMINI_API_KEY env var or POST /config with { geminiApiKey: \"...\" }'
        });
    }

    try {
        const analysis = db.prepare(`
            SELECT id, fileName, hash, status, score, timestamp
            FROM analyses
            WHERE hash = ?
            ORDER BY timestamp DESC
            LIMIT 1
        `).get(hash);

        const behaviors = db.prepare(`
            SELECT behavior_type, severity, description, timestamp
            FROM behavior_logs
            WHERE hash = ?
            ORDER BY timestamp DESC
            LIMIT 50
        `).all(hash);

        const model = client.getGenerativeModel({ model: getGeminiModel() });

        const prompt = [
            "You are a SOC analyst. Generate a concise incident report for the file sample below.",
            "Return plain text with these sections: Summary, Observations, Risk Assessment, Recommended Actions.",
            "Do not invent details beyond what is provided. If data is missing, say what is missing.",
            "",
            "Sample:",
            JSON.stringify({ analysis, behaviors }, null, 2)
        ].join("\n");

        const result = await model.generateContent(prompt);
        const reportText = result?.response?.text ? result.response.text() : String(result);

        res.json({
            hash,
            model: getGeminiModel(),
            report: reportText,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate AI report', reason: err.message });
    }
});

// Simulated metrics endpoint for Node Health (local simulated API)
app.get('/metrics', (req, res) => {
    // Create some semi-random but stable-looking metrics
    const activeNodes = 8;
    const healthy = 7;
    const degraded = activeNodes - healthy;
    const avgUptimeDays = 72;

    const metrics = {
        cluster: {
            activeNodes,
            healthy,
            degraded,
            avgUptimeDays
        },
        nodes: Array.from({ length: activeNodes }).map((_, i) => ({
            id: `node-${i + 1}`,
            status: i < healthy ? 'healthy' : 'degraded',
            uptimeDays: avgUptimeDays - (i % 5)
        })),
        timestamp: new Date().toISOString(),
        config: {
            metricsInterval: appConfig.metricsInterval,
            virusTotalConfigured: !!getVirusTotalApiKey(),
            geminiConfigured: !!getGeminiApiKey()
        }
    };

    res.json(metrics);
    // Broadcast metrics update to all connected WebSocket clients
    broadcast('metrics', metrics);
});    

// --- Config endpoints ---
app.get('/test-config', (req, res) => {
    res.json({ message: 'test config works' });
});

app.get('/config', (req, res) => {
    try {
        res.json({ config: appConfig });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read config' });
    }
});

app.post('/config', (req, res) => {
    try {
        const newC = req.body || {};
        // Only allow certain keys
        const allowed = {
            metricsInterval: Number(newC.metricsInterval) || appConfig.metricsInterval,
            virusTotalApiKey: typeof newC.virusTotalApiKey === 'string' ? newC.virusTotalApiKey : appConfig.virusTotalApiKey,
            geminiApiKey: typeof newC.geminiApiKey === 'string' ? newC.geminiApiKey : appConfig.geminiApiKey,
            geminiModel: typeof newC.geminiModel === 'string' ? newC.geminiModel : appConfig.geminiModel
        };

        saveConfig(allowed);
        res.json({ config: appConfig });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// --- Stats endpoint for dashboard charts ---
app.get('/stats', (req, res) => {
    if (!db) {
        return res.json({
            totalAnalyses: 0,
            statuses: {},
            topBehaviors: [],
            severities: {},
            scoreStats: { avg_score: null, max_score: null, min_score: null }
        });
    }
    try {
        // Get analysis counts by status
        const analyses = db.prepare(`SELECT COUNT(*) as total, status FROM analyses GROUP BY status`).all();
        const statuses = {};
        let totalAnalyses = 0;
        analyses.forEach(row => {
            statuses[row.status] = row.total;
            totalAnalyses += row.total;
        });

        // Get behavior frequency
        const behaviors = db.prepare(`
            SELECT behavior_type, COUNT(*) as count FROM behavior_logs GROUP BY behavior_type ORDER BY count DESC LIMIT 10
        `).all();

        // Get severity distribution
        const severities = db.prepare(`
            SELECT severity, COUNT(*) as count FROM behavior_logs GROUP BY severity
        `).all();
        const severityMap = {};
        severities.forEach(row => {
            severityMap[row.severity] = row.count;
        });

        // Get average scores
        const scoreStats = db.prepare(`
            SELECT AVG(score) as avg_score, MAX(score) as max_score, MIN(score) as min_score FROM analyses
        `).get();

        const stats = {
            totalAnalyses,
            statuses,
            topBehaviors: behaviors,
            severities: severityMap,
            scoreStats
        };

        res.json(stats);
        // Broadcast stats update to all connected WebSocket clients
        broadcast('stats', stats);
    } catch (err) {
        res.status(500).json({ error: 'Failed to retrieve stats', reason: err.message });
    }
});

// HOSTING: Serve static files LAST (after all API routes)
app.use(express.static(__dirname));

// Many PaaS providers (Fly/Render/Railway) set PORT; default to 3000 when unset.
const DEFAULT_PORT = 3000;
const PORT = process.env.PORT || DEFAULT_PORT;
const server = app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`  SENTINEL-X SOC BACKEND IS ONLINE       `);
    console.log(`  URL: http://localhost:${PORT}          `);
    console.log(`=========================================`);
});

// Recent analysis events (across all users/devices). Set ADMIN_TOKEN to restrict access.
app.get('/api/analyses', (req, res) => {
    if (!db) return res.json({ analyses: [] });

    const adminToken = process.env.ADMIN_TOKEN ? String(process.env.ADMIN_TOKEN) : '';
    if (adminToken) {
        const provided = getProvidedAdminToken(req);
        if (!provided || !constantTimeEqual(provided, adminToken)) return res.status(403).json({ error: 'Forbidden' });
    }

    const limitRaw = Number(req.query.limit || 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 50;

    try {
        const rows = db.prepare(`
            SELECT id, fileName, hash, status, score, timestamp, analysis_kind, username, device_id
            FROM analyses
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(limit);

        res.json({ analyses: rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list analyses', reason: err.message });
    }
});

// Admin: list/create users (requires ADMIN_TOKEN)
app.get('/admin/users', adminLimiter, requireAdminToken, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    try {
        const rows = db.prepare(`SELECT id, username, created_at FROM users ORDER BY created_at DESC LIMIT 500`).all();
        res.json({ users: rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list users' });
    }
});

app.post('/admin/users', adminLimiter, requireAdminToken, (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
        return res.status(400).json({ error: 'Username must be 3-32 chars (letters/numbers/_)' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    try {
        const exists = db.prepare(`SELECT id FROM users WHERE username = ?`).get(username);
        if (exists) return res.status(409).json({ error: 'Username already exists' });
        const hashedPassword = bcrypt.hashSync(password, 10);
        db.prepare(`INSERT INTO users (username, password, created_at) VALUES (?, ?, ?)`).run(
            username,
            hashedPassword,
            new Date().toISOString()
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create user' });
    }
});

// Handle WebSocket upgrades
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});
