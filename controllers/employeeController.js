const bcrypt = require('bcrypt');
const pool = require('../config/db');
const { logAction } = require('../services/auditService');

const VALID_SUFFIXES = ['', 'Jr.', 'Sr.', 'II', 'III', 'IV', 'V'];

// "Given [Middle] Surname [Suffix]"
function composeFullName({ given_name, middle_name, surname, suffix }) {
  return [given_name, middle_name, surname, suffix]
    .map(part => (part || '').trim())
    .filter(Boolean)
    .join(' ');
}

// Free text (the mobile form has an "Others" option), so only presence and
// length are checked.
function isValidClassification(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 50;
}

// GET /api/employees?search=&department=&status=&classification=&page=&limit=
async function getEmployees(req, res, next) {
  try {
    const { search = '', department = 'all', status = 'all', classification = 'all', page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    // Self-registered employees stay hidden until their device is approved.
    let where = 'WHERE e.is_approved = 1';
    const params = [];

    // Every word must match, in any order ("cruz juan" finds "Juan Dela Cruz").
    const searchWords = String(search).split(/[\s,]+/).filter(Boolean).slice(0, 10);
    for (const word of searchWords) {
      where += ' AND (e.full_name LIKE ? OR e.employee_code LIKE ? OR e.email LIKE ?)';
      params.push(`%${word}%`, `%${word}%`, `%${word}%`);
    }
    if (department !== 'all') {
      where += ' AND d.name = ?';
      params.push(department);
    }
    if (status !== 'all') {
      where += ' AND e.status = ?';
      params.push(status);
    }
    if (classification !== 'all') {
      where += ' AND e.classification = ?';
      params.push(classification);
    }

    const [rows] = await pool.query(
      `SELECT e.id, e.employee_code, e.full_name, e.surname, e.given_name, e.middle_name, e.suffix,
              e.office, e.position, e.email, e.phone,
              e.photo_path, e.status, e.remark, e.classification, e.gender, e.attendance_score, e.rating_points,
              e.face_failed_attempts, e.face_locked_until, e.face_lock_reason,
              d.id AS department_id, d.name AS department_name
       FROM employees e
       JOIN departments d ON e.department_id = d.id
       ${where}
       ORDER BY e.full_name ASC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM employees e JOIN departments d ON e.department_id = d.id ${where}`,
      params
    );

    res.json({
      success: true,
      data: rows,
      pagination: { page: Number(page), limit: Number(limit), total: countRows[0].total }
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/employees/:id
async function getEmployeeById(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT e.*, d.name AS department_name FROM employees e
       JOIN departments d ON e.department_id = d.id WHERE e.id = ?`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Employee not found.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
}

// POST /api/employees
async function createEmployee(req, res, next) {
  try {
    const {
      department, office, position, gender, email, phone, status, remark, classification, password, employee_code,
      surname, given_name, middle_name, suffix
    } = req.body;

    const employeeCode = employee_code && employee_code.trim();
    if (!employeeCode) {
      return res.status(400).json({ success: false, message: 'Employee ID is required.' });
    }
    if (!surname || !surname.trim() || !given_name || !given_name.trim()) {
      return res.status(400).json({ success: false, message: 'Surname and Given Name are required.' });
    }
    if (!department) {
      return res.status(400).json({ success: false, message: 'Department is required.' });
    }
    if (suffix && !VALID_SUFFIXES.includes(suffix)) {
      return res.status(400).json({ success: false, message: 'Invalid suffix value.' });
    }
    if (classification && !isValidClassification(classification)) {
      return res.status(400).json({ success: false, message: 'Classification must be 1-50 characters.' });
    }
    if (gender && gender.trim().length > 40) {
      return res.status(400).json({ success: false, message: 'Gender must be 40 characters or fewer.' });
    }

    const [deptRows] = await pool.query('SELECT id FROM departments WHERE name = ?', [department]);
    if (!deptRows[0]) return res.status(400).json({ success: false, message: 'Unknown department.' });

    const [dupRows] = await pool.query('SELECT id FROM employees WHERE employee_code = ?', [employeeCode]);
    if (dupRows[0]) return res.status(409).json({ success: false, message: `Employee ID "${employeeCode}" is already in use.` });

    const surnameVal = surname.trim();
    const givenNameVal = given_name.trim();
    const middleNameVal = middle_name ? middle_name.trim() : null;
    const suffixVal = suffix ? suffix.trim() : null;
    const fullName = composeFullName({ given_name: givenNameVal, middle_name: middleNameVal, surname: surnameVal, suffix: suffixVal });

    const passwordHash = await bcrypt.hash(password || 'changeme123', 12);
    const photoPath = req.file ? `/uploads/photos/${req.file.filename}` : null;

    const [result] = await pool.query(
      `INSERT INTO employees (employee_code, full_name, surname, given_name, middle_name, suffix, department_id, office, position, gender, photo_path, email, phone, password_hash, status, remark, classification)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [employeeCode, fullName, surnameVal, givenNameVal, middleNameVal, suffixVal, deptRows[0].id, office || department, position || null, (gender && gender.trim()) || null, photoPath, email || null, phone || null, passwordHash, status || 'Full-time', remark || 'Active', classification || 'Permanent Administrative']
    );

    await logAction({ adminId: req.admin.id, action: 'create', module: 'employees', details: { employeeCode }, ip: req.ip });

    res.status(201).json({ success: true, message: 'Employee registered successfully.', data: { id: result.insertId, employee_code: employeeCode } });
  } catch (err) {
    next(err);
  }
}

// PUT /api/employees/:id
async function updateEmployee(req, res, next) {
  try {
    const { id } = req.params;
    const {
      department, office, position, gender, email, phone, status, remark, classification, employee_code,
      surname, given_name, middle_name, suffix
    } = req.body;

    const [existing] = await pool.query('SELECT * FROM employees WHERE id = ?', [id]);
    if (!existing[0]) return res.status(404).json({ success: false, message: 'Employee not found.' });

    const employeeCode = employee_code && employee_code.trim();
    if (!employeeCode) {
      return res.status(400).json({ success: false, message: 'Employee ID is required.' });
    }
    if (employeeCode !== existing[0].employee_code) {
      const [dupRows] = await pool.query('SELECT id FROM employees WHERE employee_code = ? AND id != ?', [employeeCode, id]);
      if (dupRows[0]) return res.status(409).json({ success: false, message: `Employee ID "${employeeCode}" is already in use.` });
    }

    const surnameVal = (surname && surname.trim()) || existing[0].surname;
    const givenNameVal = (given_name && given_name.trim()) || existing[0].given_name;
    if (!surnameVal || !givenNameVal) {
      return res.status(400).json({ success: false, message: 'Surname and Given Name are required.' });
    }
    if (suffix && !VALID_SUFFIXES.includes(suffix)) {
      return res.status(400).json({ success: false, message: 'Invalid suffix value.' });
    }
    if (classification && !isValidClassification(classification)) {
      return res.status(400).json({ success: false, message: 'Classification must be 1-50 characters.' });
    }
    if (gender && gender.trim().length > 40) {
      return res.status(400).json({ success: false, message: 'Gender must be 40 characters or fewer.' });
    }
    const middleNameVal = middle_name !== undefined ? (middle_name ? middle_name.trim() : null) : existing[0].middle_name;
    const suffixVal = suffix !== undefined ? (suffix ? suffix.trim() : null) : existing[0].suffix;
    const fullName = composeFullName({ given_name: givenNameVal, middle_name: middleNameVal, surname: surnameVal, suffix: suffixVal });

    let departmentId = existing[0].department_id;
    if (department) {
      const [deptRows] = await pool.query('SELECT id FROM departments WHERE name = ?', [department]);
      if (!deptRows[0]) return res.status(400).json({ success: false, message: 'Unknown department.' });
      departmentId = deptRows[0].id;
    }

    const photoPath = req.file ? `/uploads/photos/${req.file.filename}` : existing[0].photo_path;

    await pool.query(
      `UPDATE employees SET employee_code = ?, full_name = ?, surname = ?, given_name = ?, middle_name = ?, suffix = ?, department_id = ?, office = ?, position = ?, gender = ?, email = ?, phone = ?, status = ?, remark = ?, classification = ?, photo_path = ?
       WHERE id = ?`,
      [
        employeeCode,
        fullName,
        surnameVal,
        givenNameVal,
        middleNameVal,
        suffixVal,
        departmentId,
        office || existing[0].office,
        position || existing[0].position,
        (gender && gender.trim()) || existing[0].gender,
        email || existing[0].email,
        phone || existing[0].phone,
        status || existing[0].status,
        remark || existing[0].remark,
        classification || existing[0].classification || 'Permanent Administrative',
        photoPath,
        id
      ]
    );

    await logAction({ adminId: req.admin.id, action: 'update', module: 'employees', details: { id }, ip: req.ip });

    res.json({ success: true, message: 'Employee updated successfully.' });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/employees/:id/remark
async function updateRemark(req, res, next) {
  try {
    const { id } = req.params;
    const { remark } = req.body;
    if (!['Active', 'On Leave'].includes(remark)) {
      return res.status(400).json({ success: false, message: 'Remark must be Active or On Leave.' });
    }
    const [result] = await pool.query('UPDATE employees SET remark = ? WHERE id = ?', [remark, id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Employee not found.' });

    await logAction({ adminId: req.admin.id, action: 'update_remark', module: 'employees', details: { id, remark }, ip: req.ip });
    res.json({ success: true, message: `Remark set to ${remark}.` });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/employees/:id/unlock-face
// Clears a face re-verification lockout early (see employeeAuthController.linkDevice).
async function unlockFace(req, res, next) {
  try {
    const { id } = req.params;
    const [result] = await pool.query(
      'UPDATE employees SET face_failed_attempts = 0, face_locked_until = NULL, face_lock_reason = NULL WHERE id = ?',
      [id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Employee not found.' });

    await logAction({ adminId: req.admin.id, action: 'unlock_face', module: 'employees', details: { id }, ip: req.ip });
    res.json({ success: true, message: 'Face verification lock cleared. The employee can register a new device again.' });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/employees/:id
async function deleteEmployee(req, res, next) {
  try {
    const [result] = await pool.query('DELETE FROM employees WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Employee not found.' });

    await logAction({ adminId: req.admin.id, action: 'delete', module: 'employees', details: { id: req.params.id }, ip: req.ip });

    res.json({ success: true, message: 'Employee deleted successfully.' });
  } catch (err) {
    next(err);
  }
}

// GET /api/employees/export/csv
async function exportCsv(req, res, next) {
  try {
    const { Parser } = require('json2csv');
    const [rows] = await pool.query(
      `SELECT e.employee_code, e.full_name, d.name AS department, e.office, e.position, e.email, e.phone, e.status
       FROM employees e JOIN departments d ON e.department_id = d.id WHERE e.is_approved = 1 ORDER BY e.full_name`
    );
    const parser = new Parser();
    const csv = parser.parse(rows);
    res.header('Content-Type', 'text/csv');
    res.attachment('employees.csv');
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

// GET /api/employees/export/excel
async function exportExcel(req, res, next) {
  try {
    const ExcelJS = require('exceljs');
    const [rows] = await pool.query(
      `SELECT e.employee_code, e.full_name, d.name AS department, e.office, e.position, e.email, e.phone, e.status
       FROM employees e JOIN departments d ON e.department_id = d.id WHERE e.is_approved = 1 ORDER BY e.full_name`
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Employees');
    sheet.columns = [
      { header: 'Employee Code', key: 'employee_code', width: 15 },
      { header: 'Full Name', key: 'full_name', width: 30 },
      { header: 'Department', key: 'department', width: 30 },
      { header: 'Office', key: 'office', width: 25 },
      { header: 'Position', key: 'position', width: 25 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Phone', key: 'phone', width: 18 },
      { header: 'Status', key: 'status', width: 15 }
    ];
    sheet.addRows(rows);
    sheet.getRow(1).font = { bold: true };

    res.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.attachment('employees.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
}

// Parses CSV/Excel into row objects keyed by normalized header
// ("Employee ID" -> employee_id).
async function parseImportBuffer(file) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const ext = require('path').extname(file.originalname).toLowerCase();

  if (ext === '.csv') {
    await workbook.csv.read(require('stream').Readable.from(file.buffer));
  } else {
    await workbook.xlsx.load(file.buffer);
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headerRow = sheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = String(cell.value || '').trim().toLowerCase().replace(/\s+/g, '_');
  });

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const obj = {};
    let hasAnyValue = false;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = headers[colNumber];
      if (!key) return;
      let value = cell.value;
      if (value && typeof value === 'object' && value.text) value = value.text; // hyperlink/rich text cells
      value = value === null || value === undefined ? '' : String(value).trim();
      if (value) hasAnyValue = true;
      obj[key] = value;
    });
    if (hasAnyValue) rows.push({ rowNumber, ...obj });
  });

  return rows;
}

// Maps common header aliases onto the fields createEmployee expects.
function normalizeImportRow(row) {
  const get = (...keys) => {
    for (const k of keys) {
      if (row[k] !== undefined && row[k] !== '') return row[k];
    }
    return '';
  };
  return {
    rowNumber: row.rowNumber,
    employee_code: get('employee_code', 'employee_id', 'id_number', 'employeeid'),
    surname: get('surname', 'last_name', 'lastname'),
    given_name: get('given_name', 'first_name', 'firstname'),
    middle_name: get('middle_name', 'middlename'),
    suffix: get('suffix'),
    department: get('department', 'department_name', 'office'),
    office: get('office', 'department'),
    position: get('position', 'title'),
    email: get('email', 'email_address'),
    phone: get('phone', 'phone_number', 'contact_number'),
    status: get('status', 'employment_type') || 'Full-time',
    classification: get('classification', 'employee_classification') || 'Permanent Administrative'
  };
}

// Checks required fields and departments, and duplicates against the database
// and earlier rows in the same file.
function validateImportRow(row, { existingCodes, existingEmails, seenCodesInFile, departmentNames }) {
  const errors = [];
  if (!row.employee_code) errors.push('Missing Employee ID');
  if (!row.surname) errors.push('Missing Surname');
  if (!row.given_name) errors.push('Missing Given Name');
  if (!row.department) errors.push('Missing Department');
  else if (departmentNames && !departmentNames.has(row.department.toLowerCase())) {
    errors.push(`Unknown department "${row.department}"`);
  }
  if (row.status && !['Full-time', 'Part-time', 'COS', 'Inactive'].includes(row.status)) {
    errors.push(`Invalid status "${row.status}"`);
  }
  if (row.classification && !isValidClassification(row.classification)) {
    errors.push(`Invalid classification "${row.classification}"`);
  }

  let isDuplicate = false;
  if (row.employee_code) {
    if (existingCodes.has(row.employee_code.toLowerCase())) { isDuplicate = true; errors.push('Employee ID already exists'); }
    if (seenCodesInFile.has(row.employee_code.toLowerCase())) { isDuplicate = true; errors.push('Duplicate Employee ID within this file'); }
    seenCodesInFile.add(row.employee_code.toLowerCase());
  }
  if (row.email && existingEmails.has(row.email.toLowerCase())) { isDuplicate = true; errors.push('Email already exists'); }

  return { ...row, errors, isDuplicate, isValid: errors.length === 0 };
}

// POST /api/employees/import/preview (multipart "file")
// Validates without writing anything.
async function importPreview(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'A CSV or Excel file is required.' });

    const rawRows = await parseImportBuffer(req.file);
    if (!rawRows.length) return res.status(400).json({ success: false, message: 'The file has no data rows.' });

    const [existingRows] = await pool.query('SELECT employee_code, email FROM employees');
    const existingCodes = new Set(existingRows.map((r) => (r.employee_code || '').toLowerCase()));
    const existingEmails = new Set(existingRows.filter((r) => r.email).map((r) => r.email.toLowerCase()));
    const [deptRows] = await pool.query('SELECT name FROM departments');
    const departmentNames = new Set(deptRows.map((d) => d.name.toLowerCase()));

    const seenCodesInFile = new Set();
    const validated = rawRows
      .map(normalizeImportRow)
      .map((row) => validateImportRow(row, { existingCodes, existingEmails, seenCodesInFile, departmentNames }));

    const summary = {
      totalRows: validated.length,
      validRows: validated.filter((r) => r.isValid).length,
      duplicateRows: validated.filter((r) => r.isDuplicate).length,
      invalidRows: validated.filter((r) => !r.isValid).length
    };

    res.json({ success: true, summary, rows: validated });
  } catch (err) {
    next(err);
  }
}

// POST /api/employees/import/commit { rows }
// Re-validates server-side; invalid rows are skipped, not fatal.
async function importCommit(req, res, next) {
  const conn = await pool.getConnection();
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ success: false, message: 'No rows to import.' });
    }

    const [existingRows] = await conn.query('SELECT employee_code, email FROM employees');
    const existingCodes = new Set(existingRows.map((r) => (r.employee_code || '').toLowerCase()));
    const existingEmails = new Set(existingRows.filter((r) => r.email).map((r) => r.email.toLowerCase()));
    const [deptRows] = await conn.query('SELECT id, name FROM departments');
    const deptByName = new Map(deptRows.map((d) => [d.name.toLowerCase(), d.id]));
    const departmentNames = new Set(deptRows.map((d) => d.name.toLowerCase()));

    const seenCodesInFile = new Set();
    let imported = 0;
    let duplicates = 0;
    let invalid = 0;
    const errorReport = [];

    await conn.beginTransaction();

    for (const raw of rows) {
      const row = validateImportRow(normalizeImportRow(raw), { existingCodes, existingEmails, seenCodesInFile, departmentNames });
      if (!row.isValid) {
        if (row.isDuplicate) duplicates++; else invalid++;
        errorReport.push({ rowNumber: row.rowNumber, employee_code: row.employee_code, errors: row.errors.join('; ') });
        continue;
      }

      const fullName = composeFullName({ given_name: row.given_name, middle_name: row.middle_name, surname: row.surname, suffix: row.suffix });
      const passwordHash = await bcrypt.hash('changeme123', 12);

      await conn.query(
        `INSERT INTO employees (employee_code, full_name, surname, given_name, middle_name, suffix, department_id, office, position, email, phone, password_hash, status, remark, classification)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?)`,
        [
          row.employee_code, fullName, row.surname, row.given_name, row.middle_name || null, row.suffix || null,
          deptByName.get(row.department.toLowerCase()), row.office || row.department, row.position || null,
          row.email || null, row.phone || null, passwordHash, row.status || 'Full-time', row.classification || 'Permanent Administrative'
        ]
      );
      existingCodes.add(row.employee_code.toLowerCase());
      if (row.email) existingEmails.add(row.email.toLowerCase());
      imported++;
    }

    await conn.commit();
    await logAction({ adminId: req.admin.id, action: 'batch_import', module: 'employees', details: { imported, duplicates, invalid }, ip: req.ip });

    res.json({
      success: true,
      message: `Import complete: ${imported} imported, ${duplicates} duplicates, ${invalid} invalid.`,
      summary: { totalRows: rows.length, imported, duplicates, invalid },
      errorReport
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
}

module.exports = {
  getEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  updateRemark,
  unlockFace,
  deleteEmployee,
  exportCsv,
  exportExcel,
  importPreview,
  importCommit
};
