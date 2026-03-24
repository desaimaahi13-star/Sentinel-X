-- Sentinel-X: login-related tables (SQLite)
-- Usage (PowerShell): `sqlite3 data.db ".read database/login_tables.sql"`

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    created_at TEXT
);

-- Tracks successful + failed login attempts
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
);

CREATE INDEX IF NOT EXISTS idx_login_events_user_created ON login_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_login_events_username_created ON login_events(username, created_at);
