const pool = require('../config/db');
const { localDate } = require('../services/dateService');
const fs = require('fs');
const path = require('path');
const certificateService = require('../services/certificateService');
const { logAction } = require('../services/auditService');
const { sendMail } = require('../services/mailService');
const { notifyAdmins } = require('../services/adminNotificationService');

// Base of the /verify link in certificate emails. PUBLIC_BASE_URL wins,
// since a localhost link can't be opened from the employee's phone.
function publicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

const wantsEmail = (body) => body.send_email !== false && body.send_email !== 'false';

// POST /api/certificates/generate { employee_id, event_title, event_id?, award_date?, venue?, send_email? }
async function generateCertificate(req, res, next) {
  try {
    const { employee_id, event_title, event_id } = req.body;
    const awardDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.award_date || '')) ? req.body.award_date : null;
    let venue = String(req.body.venue || '').trim().slice(0, 150);
    if (!employee_id || !event_title) {
      return res.status(400).json({ success: false, message: 'employee_id and event_title are required.' });
    }

    const [empRows] = await pool.query('SELECT full_name FROM employees WHERE id = ?', [employee_id]);
    if (!empRows[0]) return res.status(404).json({ success: false, message: 'Employee not found.' });

    if (!venue && event_id) {
      const [eventRows] = await pool.query('SELECT venue FROM events WHERE id = ?', [event_id]);
      venue = eventRows[0]?.venue || '';
    }

    const template = await loadTemplate();
    const certificateNumber = `CERT-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
    const verificationCode = certificateService.newVerificationCode();
    const issuedDate = localDate();

    const { pdfPath, sha256 } = await certificateService.generateCertificatePdf({
      fileName: certificateNumber,
      page: { employeeName: empRows[0].full_name, certificateNumber, verificationCode },
      eventTitle: event_title,
      issuedDate,
      awardDate,
      venue,
      template
    });

    const relativePath = `/uploads/certificates/${path.basename(pdfPath)}`;

    const [result] = await pool.query(
      `INSERT INTO certificates (employee_id, event_id, certificate_number, event_title, issued_date, pdf_path, verification_code, file_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [employee_id, event_id || null, certificateNumber, event_title, issuedDate, relativePath, verificationCode, sha256]
    );

    await logAction({ adminId: req.admin.id, action: 'generate', module: 'certificates', details: { certificateNumber }, ip: req.ip });

    const email = wantsEmail(req.body) ? await emailCertificate(result.insertId, publicBaseUrl(req)) : null;

    res.status(201).json({
      success: true,
      message: 'Certificate generated successfully.',
      data: { id: result.insertId, certificateNumber, verificationCode, downloadUrl: relativePath, email }
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/certificates/generate-bulk
// { scope: 'all' | 'department', department_id?, event_title, event_id?, award_date?, venue?, preview?, send_email? }
// One PDF per employee plus a combined PDF for printing; emails are sent in the background.
async function generateBulkCertificates(req, res, next) {
  try {
    const { scope, department_id, event_title, event_id } = req.body;
    const awardDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.award_date || '')) ? req.body.award_date : null;
    let venue = String(req.body.venue || '').trim().slice(0, 150);
    if (!event_title && !req.body.preview) return res.status(400).json({ success: false, message: 'event_title is required.' });
    if (scope !== 'all' && !(scope === 'department' && department_id)) {
      return res.status(400).json({ success: false, message: 'Choose all employees or a department.' });
    }

    const params = [];
    let where = "is_approved = 1 AND status <> 'Inactive'";
    if (scope === 'department') { where += ' AND department_id = ?'; params.push(department_id); }
    const [emps] = await pool.query(`SELECT id, full_name FROM employees WHERE ${where} ORDER BY full_name`, params);
    if (req.body.preview) {
      res.locals.noBroadcast = true; // read-only: don't make every dashboard refresh
      return res.json({ success: true, data: { count: emps.length } });
    }
    if (!emps.length) return res.status(404).json({ success: false, message: 'No active employees found for that selection.' });

    if (!venue && event_id) {
      const [eventRows] = await pool.query('SELECT venue FROM events WHERE id = ?', [event_id]);
      venue = eventRows[0]?.venue || '';
    }

    const template = await loadTemplate();
    const batch = `CERT-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
    const issuedDate = localDate();
    const pad = String(emps.length).length;
    const verifyBaseUrl = publicBaseUrl(req);
    const common = { eventTitle: event_title, issuedDate, awardDate, venue, template };

    const pages = emps.map((e, i) => ({
      employeeName: e.full_name,
      certificateNumber: `${batch}-${String(i + 1).padStart(pad, '0')}`,
      verificationCode: certificateService.newVerificationCode()
    }));

    const rows = [];
    for (let i = 0; i < emps.length; i++) {
      const { pdfPath, sha256 } = await certificateService.generateCertificatePdf({
        fileName: pages[i].certificateNumber, page: pages[i], ...common
      });
      rows.push([
        emps[i].id, event_id || null, pages[i].certificateNumber, event_title, issuedDate,
        `/uploads/certificates/${path.basename(pdfPath)}`, pages[i].verificationCode, sha256
      ]);
    }
    const { pdfPath } = await certificateService.generateCertificatesPdf({ fileName: `${batch}-BATCH`, pages, ...common });
    const relativePath = `/uploads/certificates/${path.basename(pdfPath)}`;

    await pool.query(
      `INSERT INTO certificates (employee_id, event_id, certificate_number, event_title, issued_date, pdf_path, verification_code, file_hash) VALUES ?`,
      [rows]
    );

    await logAction({
      adminId: req.admin.id, action: 'generate_bulk', module: 'certificates',
      details: { batch, scope, departmentId: department_id || null, count: emps.length }, ip: req.ip
    });

    const sendEmail = wantsEmail(req.body);
    res.status(201).json({
      success: true,
      message: `${emps.length} certificate(s) generated.`,
      data: { count: emps.length, batch, downloadUrl: relativePath, emailing: sendEmail }
    });

    if (sendEmail) {
      const [created] = await pool.query(
        'SELECT id FROM certificates WHERE certificate_number IN (?) ORDER BY id', [pages.map((p) => p.certificateNumber)]
      );
      emailBatchInBackground(created.map((c) => c.id), verifyBaseUrl, { batch, eventTitle: event_title });
    }
  } catch (err) {
    next(err);
  }
}

const escapeHtml = (v) => String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// Emails a certificate PDF and records the result. Never throws on delivery failure.
async function emailCertificate(certificateId, verifyBaseUrl) {
  const [rows] = await pool.query(
    `SELECT c.id, c.certificate_number, c.event_title, c.pdf_path, c.verification_code, e.full_name, e.email
     FROM certificates c JOIN employees e ON e.id = c.employee_id WHERE c.id = ?`,
    [certificateId]
  );
  const cert = rows[0];
  if (!cert) return { status: 'not_found', message: 'Certificate not found.' };

  // error null = delivered.
  const record = (error) => pool.query(
    'UPDATE certificates SET emailed_at = IF(? IS NULL, NOW(), emailed_at), email_error = ? WHERE id = ?',
    [error, error, cert.id]
  );

  if (!cert.email) {
    await record('Employee has no email address.');
    return { status: 'no_email', message: `${cert.full_name} has no email address on file.` };
  }

  let content;
  try {
    content = await fs.promises.readFile(path.join(__dirname, '..', cert.pdf_path));
  } catch (err) {
    await record('Certificate PDF is missing on the server.');
    return { status: 'missing_file', message: 'The certificate PDF is missing on the server. Generate it again.' };
  }

  const verifyUrl = cert.verification_code ? `${verifyBaseUrl}/verify/${cert.verification_code}` : null;
  try {
    const result = await sendMail({
      to: cert.email,
      subject: `Certificate of Attendance: ${cert.event_title}`,
      text: [
        `Hello ${cert.full_name},`,
        '',
        `Attached is your Certificate of Attendance for "${cert.event_title}" (Certificate No. ${cert.certificate_number}).`,
        verifyUrl ? `Anyone can confirm it is genuine at ${verifyUrl}. An edited copy will not match our records.` : '',
        '',
        'CSPC HRMDU - GeoAttend'
      ].join('\n'),
      html: `<p>Hello ${escapeHtml(cert.full_name)},</p>
        <p>Attached is your <b>Certificate of Attendance</b> for <b>${escapeHtml(cert.event_title)}</b>
        (Certificate No. ${escapeHtml(cert.certificate_number)}).</p>
        ${verifyUrl ? `<p>Anyone can confirm it is genuine at <a href="${escapeHtml(verifyUrl)}">${escapeHtml(verifyUrl)}</a>. An edited copy will not match our records.</p>` : ''}
        <p style="color:#6B7280">CSPC HRMDU &middot; GeoAttend</p>`,
      attachments: [{ filename: `${cert.certificate_number}.pdf`, content, contentType: 'application/pdf' }]
    });
    if (result && result.printed) {
      await record('No email sender configured on the server.');
      return { status: 'printed', message: 'No email sender is configured, so the email was only printed in the server log.' };
    }
    await record(null);
    return { status: 'sent' };
  } catch (err) {
    await record(String(err.message || err).slice(0, 255));
    return { status: 'failed', message: err.message };
  }
}

// One at a time so mail providers' rate limits aren't hit; ends with an
// admin notification summarising the batch.
function emailBatchInBackground(ids, verifyBaseUrl, { batch, eventTitle }) {
  (async () => {
    const counts = { sent: 0, no_email: 0, failed: 0 };
    for (const id of ids) {
      const { status } = await emailCertificate(id, verifyBaseUrl);
      if (status === 'sent') counts.sent++;
      else if (status === 'no_email') counts.no_email++;
      else counts.failed++;
    }
    await notifyAdmins({
      type: 'certificates_emailed',
      severity: counts.no_email + counts.failed ? 'warning' : 'info',
      title: `Certificates emailed: ${eventTitle}`,
      message: `${counts.sent} of ${ids.length} certificate(s) in ${batch} were emailed.`
        + (counts.no_email ? ` ${counts.no_email} employee(s) have no email address.` : '')
        + (counts.failed ? ` ${counts.failed} could not be sent; check the email settings and resend.` : ''),
      targetView: 'settings',
      dedupe: false
    });
  })().catch((err) => console.error('[certificates] Background emailing failed:', err.message));
}

// POST /api/certificates/preview — one-page PDF, nothing saved or emailed.
async function previewCertificate(req, res, next) {
  try {
    res.locals.noBroadcast = true;
    const awardDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.award_date || '')) ? req.body.award_date : null;
    let venue = String(req.body.venue || '').trim().slice(0, 150);
    let employeeName = 'JUAN DELA CRUZ';
    if (req.body.employee_id) {
      const [empRows] = await pool.query('SELECT full_name FROM employees WHERE id = ?', [req.body.employee_id]);
      if (empRows[0]) employeeName = empRows[0].full_name;
    }
    if (!venue && req.body.event_id) {
      const [eventRows] = await pool.query('SELECT venue FROM events WHERE id = ?', [req.body.event_id]);
      venue = eventRows[0]?.venue || '';
    }
    const pdf = await certificateService.renderCertificatesPdf({
      pages: [{ employeeName }],
      eventTitle: String(req.body.event_title || '').trim() || 'Professional Development Workshop',
      issuedDate: localDate(),
      awardDate,
      venue,
      template: await loadTemplate()
    });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="certificate-preview.pdf"', 'Cache-Control': 'no-store' });
    res.send(pdf);
  } catch (err) {
    next(err);
  }
}

// GET /api/certificates
async function getCertificates(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, e.full_name, e.email FROM certificates c JOIN employees e ON c.employee_id = e.id
       ORDER BY c.created_at DESC, c.id`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// Only keys in certificateService.DEFAULT_TEMPLATE are kept.
const TEMPLATE_SETTING_KEY = 'certificate_template';

async function loadTemplate() {
  const [rows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = ?', [TEMPLATE_SETTING_KEY]);
  try {
    return certificateService.resolveTemplate(JSON.parse(rows[0]?.setting_value || '{}'));
  } catch (e) {
    return certificateService.resolveTemplate();
  }
}

// GET /api/certificates/template
async function getTemplate(req, res, next) {
  try {
    res.json({ success: true, data: await loadTemplate(), defaults: certificateService.DEFAULT_TEMPLATE });
  } catch (err) {
    next(err);
  }
}

// PUT /api/certificates/template { schoolName, accreditation, ... }
// A blank field resets to the default wording.
async function saveTemplate(req, res, next) {
  try {
    const clean = {};
    Object.keys(certificateService.DEFAULT_TEMPLATE).forEach((k) => {
      const v = req.body[k];
      if (typeof v === 'string' && v.trim()) clean[k] = v.trim().slice(0, 200);
    });
    await pool.query(
      `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [TEMPLATE_SETTING_KEY, JSON.stringify(clean)]
    );
    await logAction({ adminId: req.admin.id, action: 'update_template', module: 'certificates', details: clean, ip: req.ip });
    res.json({ success: true, message: 'Certificate template saved.', data: certificateService.resolveTemplate(clean) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  generateCertificate,
  generateBulkCertificates,
  previewCertificate,
  getCertificates,
  getTemplate,
  saveTemplate
};
