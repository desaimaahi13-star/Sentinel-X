const express = require('express');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai"); // This matches the package you just installed
const fs = require('fs');
const WebSocket = require('ws');
const crypto = require('crypto');

// ... existing middleware and routes ...

// Initialize the AI with your key
const app = express();
const Database = require('better-sqlite3');

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

// ROUTE: Serves the main dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- API ROUTES (must come BEFORE static middleware) ---
let db;
try {
    db = new Database(path.join(__dirname, 'data.db'));
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
    
    // Initialize default admin user if it doesn't exist
    const adminExists = db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get();
    if (!adminExists) {
        const hashedPassword = crypto.createHash('sha256').update('sentinel123').digest('hex');
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
    console.log('SQLite: data.db opened and table ensured');
} catch (err) {
    console.error('SQLite connection failed:', err.message);
    db = null;
}

const axios = require('axios');
const API_KEY = process.env.VIRUSTOTAL_API_KEY || '';

// --- Config persistence ---
const CONFIG_PATH = path.join(__dirname, 'config.json');
let appConfig = {
    metricsInterval: 5,
    virusTotalApiKey: process.env.VIRUSTOTAL_API_KEY || ''
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

// ============================================
// LOGIN ENDPOINT
// ============================================
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ 
            success: false, 
            message: 'Username and password required' 
        });
    }
    
    try {
        const user = db.prepare(`SELECT id, username, password FROM users WHERE username = ?`).get(username);
        
        if (!user) {
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid username or password' 
            });
        }
        
        // Hash the provided password and compare
        const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
        
        if (user.password !== hashedPassword) {
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid username or password' 
            });
        }
        
        // Generate a simple token (in production, use JWT)
        const token = crypto.randomBytes(32).toString('hex');
        
        res.json({
            success: true,
            token: token,
            message: 'Login successful'
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error' 
        });
    }
});

app.post('/analyze', async (req, res) => {
    const { fileName, hash } = req.body; // Received from script.js

    // If API key is not configured, return UNKNOWN (200) so frontend continues with dynamic analysis
    if (!API_KEY || API_KEY === 'YOUR_VIRUSTOTAL_API_KEY') {
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
            headers: { 'x-apikey': API_KEY }
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
        db.prepare(`
            INSERT INTO analyses (fileName, hash, status, score, timestamp)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            fileName,
            hash,
            result.status,
            result.score,
            result.timestamp
        );

        res.json(result);

        // Broadcast stats update
        try {
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

app.post('/analyze-behavior', async (req, res) => {
    const { fileName, hash } = req.body;
    
    try {
        const behaviors = detectBehaviors(hash, fileName);
        const behaviorScore = calculateBehaviorScore(behaviors);
        
        // Store detected behaviors in database
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
        
        // Determine final status based on behavior analysis
        let finalStatus = 'CLEAN';
        if (behaviorScore > 70) finalStatus = 'MALICIOUS';
        else if (behaviorScore > 40) finalStatus = 'SUSPICIOUS';
        else if (behaviorScore > 0) finalStatus = 'UNKNOWN';
        
        // Store the analysis result in database
        db.prepare(`
            INSERT INTO analyses (fileName, hash, status, score, timestamp)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            fileName,
            hash,
            finalStatus,
            behaviorScore,
            new Date().toISOString()
        );
        
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
            virusTotalConfigured: !!(appConfig.virusTotalApiKey || API_KEY)
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
            virusTotalApiKey: typeof newC.virusTotalApiKey === 'string' ? newC.virusTotalApiKey : appConfig.virusTotalApiKey
        };

        saveConfig(allowed);
        res.json({ config: appConfig });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// --- Stats endpoint for dashboard charts ---
app.get('/stats', (req, res) => {
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

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`  SENTINEL-X SOC BACKEND IS ONLINE       `);
    console.log(`  URL: http://localhost:${PORT}          `);
    console.log(`=========================================`);
});

// Handle WebSocket upgrades
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});