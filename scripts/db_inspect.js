const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const projectRoot = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : projectRoot;
const dbPath = path.join(dataDir, 'data.db');

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

const st = statSafe(dbPath);
console.log('Project root:', projectRoot);
console.log('DATA_DIR:', dataDir);
console.log('DB path:', dbPath);
console.log('DB exists:', !!st);
if (st) {
  console.log('DB size:', st.size, 'bytes');
  console.log('DB mtime:', st.mtime.toISOString());
}

if (!st) process.exit(2);

const db = new Database(dbPath, { fileMustExist: true });
console.log('SQLite version:', db.pragma('compile_options', { simple: false }) ? '(ok)' : '(ok)');

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);
const indexes = db
  .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' ORDER BY name")
  .all();

console.log('\nTables:');
console.log(tables.length ? tables.join(', ') : '(none)');
console.log('\nIndexes:');
console.table(indexes);
