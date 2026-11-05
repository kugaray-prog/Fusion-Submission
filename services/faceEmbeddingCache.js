const pool = require('../config/db');
const config = require('../config/config');
const { cosineSimilarity } = require('./faceService');

// In-memory copy of employee_faces embeddings for the registration duplicate
// check. Rows are append-only (faces are only removed with their employee), so
// each lookup fetches just the rows added since the last one instead of
// re-reading and re-parsing every embedding per request.
const faces = new Map(); // employee_faces.id -> { employeeId, embedding }
let lastFaceId = 0;
let refreshing = null;

function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const [rows] = await pool.query(
      'SELECT id, employee_id, embedding FROM employee_faces WHERE id > ? ORDER BY id',
      [lastFaceId]
    );
    for (const r of rows) {
      faces.set(r.id, { employeeId: r.employee_id, embedding: Float32Array.from(JSON.parse(r.embedding)) });
      lastFaceId = Math.max(lastFaceId, r.id);
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// Registrations between the duplicate check and the face insert, so two
// simultaneous sign-ups with the same face can't both get through.
const pending = new Set();

/**
 * Best match among faces enrolled to other employees who still have a device
 * (same rule the duplicate check always used), or null. Cached rows are
 * confirmed against the database, so deleted employees never match.
 */
async function findOtherOwner(embedding, excludeEmployeeId) {
  await refresh();
  const hits = [];
  for (const [faceId, face] of faces) {
    if (String(face.employeeId) === String(excludeEmployeeId)) continue;
    const similarity = cosineSimilarity(embedding, face.embedding);
    if (similarity >= config.face.matchThreshold) hits.push({ faceId, employeeId: face.employeeId, similarity });
  }
  if (!hits.length) return null;

  const [rows] = await pool.query(
    `SELECT ef.id, EXISTS (SELECT 1 FROM mobile_devices md WHERE md.employee_id = ef.employee_id) AS has_device
     FROM employee_faces ef WHERE ef.id IN (?)`,
    [hits.map((h) => h.faceId)]
  );
  const live = new Set(rows.filter((r) => r.has_device).map((r) => r.id));
  // Forget rows whose employee was deleted.
  const stillThere = new Set(rows.map((r) => r.id));
  for (const h of hits) if (!stillThere.has(h.faceId)) faces.delete(h.faceId);

  const owners = hits.filter((h) => live.has(h.faceId)).sort((a, b) => b.similarity - a.similarity);
  return owners.length ? { employeeId: owners[0].employeeId, similarity: owners[0].similarity } : null;
}

/** Holds `embedding` as in-progress; returns a release function, or null if a matching registration is already in progress. */
function reserve(embedding) {
  for (const other of pending) {
    if (cosineSimilarity(embedding, other) >= config.face.matchThreshold) return null;
  }
  pending.add(embedding);
  return () => pending.delete(embedding);
}

module.exports = { findOtherOwner, reserve, refresh };
