// Seeds the default admin, departments and sample employees. Run: npm run seed
require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../config/db');
const config = require('../config/config');
const cspcOffices = require('../services/cspcOffices');

async function seed() {
  const conn = await pool.getConnection();
  try {
    console.log('Seeding GeoAttend database...');

    // Rename accounts still on the old email domain.
    const { domain, legacyDomain } = config.email;
    for (const table of ['admin_accounts', 'employees']) {
      const [renamed] = await conn.query(
        `UPDATE ${table} t
         LEFT JOIN ${table} dup ON dup.email = CONCAT(SUBSTRING_INDEX(t.email, '@', 1), '@', ?)
         SET t.email = CONCAT(SUBSTRING_INDEX(t.email, '@', 1), '@', ?)
         WHERE t.email LIKE ? AND dup.id IS NULL`,
        [domain, domain, `%@${legacyDomain}`]
      );
      if (renamed.affectedRows) {
        console.log(`Moved ${renamed.affectedRows} ${table} email(s) from @${legacyDomain} to @${domain}.`);
      }
    }

    // 1. Default admin account (admin@my.cspc.edu.ph unless DEFAULT_ADMIN_EMAIL says otherwise)
    const adminEmail = config.email.defaultAdmin;
    const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'password';
    const [existingAdmin] = await conn.query('SELECT id FROM admin_accounts WHERE email = ?', [adminEmail]);

    if (existingAdmin.length === 0) {
      const hash = await bcrypt.hash(adminPassword, 12);
      await conn.query(
        `INSERT INTO admin_accounts (full_name, email, password_hash, role) VALUES (?, ?, ?, 'super_admin')`,
        ['Super Admin', adminEmail, hash]
      );
      console.log(`Created admin account: ${adminEmail} / ${adminPassword}`);
    } else {
      console.log('Admin account already exists, skipping.');
    }

    // 2. Departments (CSPC's departments/offices)
    for (const name of cspcOffices) {
      const [rows] = await conn.query('SELECT id FROM departments WHERE name = ?', [name]);
      if (rows.length === 0) {
        await conn.query('INSERT INTO departments (name, office) VALUES (?, ?)', [name, name]);
      }
    }
    const [deptRows] = await conn.query('SELECT id, name FROM departments');
    const deptMap = Object.fromEntries(deptRows.map(d => [d.name, d.id]));

    // 3. Sample employees
    const employees = [
      { code: 'E001', name: 'Dr. Sarah Jenkins', dept: 'College of Engineering and Architecture', position: 'Senior Professor', status: 'Full-time', email: 'sarah.jenkins@my.cspc.edu.ph' },
      { code: 'E002', name: 'Prof. Michael Chen', dept: 'College of Computer Studies', position: 'IT Instructor', status: 'Part-time', email: 'michael.chen@my.cspc.edu.ph' },
      { code: 'E003', name: 'Dr. Emily Watson', dept: 'College of Health Sciences', position: 'Department Dean', status: 'Full-time', email: 'emily.watson@my.cspc.edu.ph' },
      { code: '2025020147', name: 'Jessemri A. Tabayag', dept: 'Human Resource Management and Development Unit', position: 'Administrative Aide II', status: 'Full-time', email: 'jessemri.tabayag@my.cspc.edu.ph' }
    ];
    const empPassHash = await bcrypt.hash('employee123', 12);
    for (const e of employees) {
      const [rows] = await conn.query('SELECT id FROM employees WHERE employee_code = ?', [e.code]);
      if (rows.length === 0) {
        await conn.query(
          `INSERT INTO employees (employee_code, full_name, department_id, office, position, email, password_hash, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [e.code, e.name, deptMap[e.dept], e.dept, e.position, e.email, empPassHash, e.status]
        );
      }
    }

    // 4. Default settings
    const defaults = [
      ['late_grace_minutes', '15'],
      ['default_geofence_radius', '150'],
      ['ocr_min_confidence', '70'],
      ['school_name', 'GeoAttend Institution'],
      ['cspc_latitude', '13.4059'],
      ['cspc_longitude', '123.3758'],
      ['cspc_label', 'CSPC - Camarines Sur Polytechnic Colleges, Nabua, Camarines Sur']
    ];
    for (const [key, value] of defaults) {
      await conn.query(
        `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = setting_value`,
        [key, value]
      );
    }

    console.log('Seeding complete.');
  } catch (err) {
    console.error('Seeding failed:', err);
  } finally {
    conn.release();
    process.exit(0);
  }
}

seed();
