const pool = require('../config/db');
const { sha256 } = require('../services/certificateService');

// Public page opened by the certificate QR code: /verify/<code>.

const normalizeCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(?=.)/g, '$1-');

async function findCertificate(code) {
  if (!code) return null;
  const [rows] = await pool.query(
    `SELECT c.certificate_number, c.event_title, c.issued_date, c.pdf_path, c.verification_code, c.file_hash, e.full_name
     FROM certificates c JOIN employees e ON e.id = c.employee_id WHERE c.verification_code = ?`,
    [code]
  );
  return rows[0] || null;
}

// GET /verify and /verify/:code (also /verify?code=... from the form).
async function showVerifyPage(req, res, next) {
  try {
    const code = normalizeCode(req.params.code || req.query.code);
    const cert = await findCertificate(code);
    res.status(code && !cert ? 404 : 200).render('verify-certificate', { code, cert });
  } catch (err) {
    next(err);
  }
}

// POST /api/verify/:code/check (raw PDF body) -> { match }: whether the file
// is byte-for-byte the certificate that was issued.
async function checkCertificateFile(req, res, next) {
  try {
    res.locals.noBroadcast = true;
    const cert = await findCertificate(normalizeCode(req.params.code));
    if (!cert) return res.status(404).json({ success: false, message: 'No certificate has this verification code.' });
    if (!cert.file_hash) return res.status(422).json({ success: false, message: 'This certificate has no file fingerprint on record.' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ success: false, message: 'Choose the certificate PDF to check.' });
    }
    res.json({ success: true, data: { match: sha256(req.body) === cert.file_hash } });
  } catch (err) {
    next(err);
  }
}

module.exports = { showVerifyPage, checkCertificateFile };
