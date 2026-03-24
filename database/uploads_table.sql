-- Sentinel-X: uploaded files table (SQLite)
-- Usage (PowerShell): `sqlite3 data.db ".read database/uploads_table.sql"`

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
);

CREATE INDEX IF NOT EXISTS idx_uploaded_files_created ON uploaded_files(created_at);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_sha256 ON uploaded_files(sha256);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_device ON uploaded_files(device_id, created_at);
