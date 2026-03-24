const path = require('path');
const Database = require('better-sqlite3');

const projectRoot = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : projectRoot;
const dbPath = path.join(dataDir, 'data.db');

const limit = Number(process.env.LIMIT || 50);
const db = new Database(dbPath, { fileMustExist: true });

const rows = db
  .prepare(
    `
    SELECT id, original_name, stored_name, sha256, device_id, size, mime_type, created_at, ip
    FROM uploaded_files
    ORDER BY created_at DESC
    LIMIT ?
  `.trim()
  )
  .all(limit);

console.table(rows);
