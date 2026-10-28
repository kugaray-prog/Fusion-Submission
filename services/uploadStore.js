const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pool = require('../config/db');

// Durable copies of uploaded photos in MySQL, keyed by public path
// ("/uploads/selfies/123.jpg"), for hosts whose disk is wiped on restart.
// Stored as JPEGs (longest side 800px). Videos are not stored.

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const MAX_SIDE = 800;
const JPEG_QUALITY = 78;

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(
      `CREATE TABLE IF NOT EXISTS stored_uploads (
         path VARCHAR(255) NOT NULL PRIMARY KEY,
         mime_type VARCHAR(50) NOT NULL,
         data MEDIUMBLOB NOT NULL,
         size_bytes INT NOT NULL,
         created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ).catch((err) => {
      tableReady = null; // retry on the next call
      throw err;
    });
  }
  return tableReady;
}

function publicPathFor(absPath) {
  const rel = path.relative(UPLOADS_DIR, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return `/uploads/${rel.split(path.sep).join('/')}`;
}

async function compress(input) {
  return sharp(input)
    .rotate() // apply EXIF orientation before it's stripped
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

// Stores `input` (path or Buffer) under `publicPath`, replacing any copy.
async function saveUpload(publicPath, input) {
  await ensureTable();
  const data = await compress(input);
  await pool.query(
    `INSERT INTO stored_uploads (path, mime_type, data, size_bytes) VALUES (?, 'image/jpeg', ?, ?)
     ON DUPLICATE KEY UPDATE mime_type = VALUES(mime_type), data = VALUES(data), size_bytes = VALUES(size_bytes)`,
    [publicPath, data, data.length]
  );
  return data.length;
}

// Middleware after multer: stores every uploaded image. Failures are only logged.
async function persistRequestUploads(req, res, next) {
  const files = [];
  if (req.file) files.push(req.file);
  if (req.files) files.push(...(Array.isArray(req.files) ? req.files : Object.values(req.files).flat()));
  for (const file of files) {
    if (!file.path || !/^image\//.test(file.mimetype || '')) continue;
    const publicPath = publicPathFor(file.path);
    if (!publicPath) continue;
    try {
      await saveUpload(publicPath, file.path);
    } catch (err) {
      console.error(`[uploadStore] Could not store ${publicPath}:`, err.message);
    }
  }
  next();
}

// Fallback for GET /uploads/*: serves the stored copy and restores it to disk.
async function serveStoredUpload(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let publicPath;
  try {
    publicPath = `/uploads${decodeURIComponent(req.path)}`;
  } catch (e) {
    return next();
  }
  if (publicPath.includes('..')) return next();
  try {
    await ensureTable();
    const [rows] = await pool.query('SELECT mime_type, data FROM stored_uploads WHERE path = ?', [publicPath]);
    if (!rows[0]) return next();
    const { mime_type: mimeType, data } = rows[0];
    if (!wasDeletedLocally(publicPath)) {
      const diskPath = diskPathFor(publicPath);
      fs.promises.mkdir(path.dirname(diskPath), { recursive: true })
        .then(() => fs.promises.writeFile(diskPath, data))
        .then(() => { loadKnownPaths().add(publicPath); return saveKnownPaths(); })
        .catch(() => {});
    }
    res.set('Content-Type', mimeType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(data);
  } catch (err) {
    next(err);
  }
}

// Deletes both the stored copy and the file on disk.
async function removeUpload(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/') || publicPath.includes('..')) return;
  await ensureTable();
  await pool.query('DELETE FROM stored_uploads WHERE path = ?', [publicPath]);
  await fs.promises.unlink(diskPathFor(publicPath)).catch(() => {});
}

function diskPathFor(publicPath) {
  return path.join(UPLOADS_DIR, ...publicPath.slice('/uploads/'.length).split('/'));
}

// Paths this machine has had on disk. A known path now missing was deleted on
// purpose and is not restored.
const STATE_FILE = path.join(UPLOADS_DIR, '.sync-state.json');
let knownPaths = null;
let hadStateFile = false;
function loadKnownPaths() {
  if (!knownPaths) {
    try {
      knownPaths = new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
      hadStateFile = true;
    } catch (e) {
      knownPaths = new Set();
    }
  }
  return knownPaths;
}
function hasAnyPhotoOnDisk() {
  try {
    return fs.readdirSync(UPLOADS_DIR, { withFileTypes: true }).some((dir) =>
      dir.isDirectory() &&
      fs.readdirSync(path.join(UPLOADS_DIR, dir.name)).some((name) => !name.startsWith('.')));
  } catch (e) {
    return false;
  }
}
async function saveKnownPaths() {
  await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.promises.writeFile(STATE_FILE, JSON.stringify([...loadKnownPaths()]));
}
function wasDeletedLocally(publicPath) {
  return loadKnownPaths().has(publicPath) && !fs.existsSync(diskPathFor(publicPath));
}

// Restores stored photos missing from uploads/; returns the count written.
let syncing = false;
let syncedUpTo = null; // newest created_at seen, as the DB returned it
async function syncToDisk({ full = false } = {}) {
  if (syncing) return 0;
  syncing = true;
  let written = 0;
  const known = loadKnownPaths();
  const knownBefore = known.size;
  // No state file yet but photos on disk: the folder wasn't wiped, so treat
  // missing files as deleted. An empty folder is restored in full.
  const adoptMissing = full && !hadStateFile && knownBefore === 0 && hasAnyPhotoOnDisk();
  try {
    await ensureTable();
    const since = full ? null : syncedUpTo;
    const [rows] = since
      // Overlap catches rows committed slightly after their created_at.
      ? await pool.query('SELECT path, created_at FROM stored_uploads WHERE created_at >= ? - INTERVAL 1 MINUTE ORDER BY created_at', [since])
      : await pool.query('SELECT path, created_at FROM stored_uploads ORDER BY created_at');
    for (const { path: publicPath, created_at: createdAt } of rows) {
      syncedUpTo = createdAt;
      if (!publicPath.startsWith('/uploads/') || publicPath.includes('..')) continue;
      const diskPath = diskPathFor(publicPath);
      if (fs.existsSync(diskPath)) {
        known.add(publicPath);
        continue;
      }
      if (adoptMissing) known.add(publicPath);
      if (known.has(publicPath)) continue; // deleted on purpose -- leave it
      const [[row]] = await pool.query('SELECT data FROM stored_uploads WHERE path = ?', [publicPath]);
      if (!row) continue;
      await fs.promises.mkdir(path.dirname(diskPath), { recursive: true });
      await fs.promises.writeFile(diskPath, row.data);
      known.add(publicPath);
      written++;
    }
    if (known.size !== knownBefore) await saveKnownPaths();
  } finally {
    syncing = false;
  }
  return written;
}

function startDiskSync(intervalMs = Number(process.env.UPLOAD_SYNC_INTERVAL_MS) || 5000) {
  const tick = (full) => syncToDisk({ full })
    .then((n) => { if (n) console.log(`[uploadStore] Saved ${n} photo(s) into uploads/.`); })
    .catch((err) => console.error('[uploadStore] Sync to uploads/ failed:', err.message));
  tick(true);
  return setInterval(() => tick(false), intervalMs);
}

module.exports = { removeUpload, persistRequestUploads, serveStoredUpload, startDiskSync };
