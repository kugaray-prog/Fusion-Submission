-- GeoAttend schema (MySQL 8+)

CREATE DATABASE IF NOT EXISTS geoattend
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE geoattend;

CREATE TABLE admin_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('super_admin','admin','staff') DEFAULT 'admin',
  is_active TINYINT(1) DEFAULT 1,
  last_login DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL UNIQUE,
  office VARCHAR(150) NULL,
  description TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_code VARCHAR(20) NOT NULL UNIQUE,
  full_name VARCHAR(150) NOT NULL,
  surname VARCHAR(80) NULL,
  given_name VARCHAR(80) NULL,
  middle_name VARCHAR(80) NULL,
  suffix VARCHAR(10) NULL,
  department_id INT NOT NULL,
  office VARCHAR(150) NULL,
  position VARCHAR(120) NULL,
  gender VARCHAR(40) NULL,
  photo_path VARCHAR(255) NULL,
  email VARCHAR(150) UNIQUE NULL,
  phone VARCHAR(30) NULL,
  password_hash VARCHAR(255) NULL,
  status ENUM('Full-time','Part-time','COS','Inactive') DEFAULT 'Full-time',
  remark ENUM('Active','On Leave') DEFAULT 'Active',
  classification VARCHAR(50) DEFAULT 'Permanent Administrative',
  attendance_score DECIMAL(5,2) DEFAULT 100.00,
  rating_points DECIMAL(6,2) DEFAULT 0,
  -- DoubleSafe lockout for new-device registration
  face_failed_attempts INT NOT NULL DEFAULT 0,
  face_locked_until DATETIME NULL,
  face_lock_reason VARCHAR(255) NULL,
  -- 0 = registered themselves in the app, not yet accepted by an admin;
  -- hidden from the Employees list until their device is approved.
  is_approved TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(id)
) ENGINE=InnoDB;

CREATE TABLE mobile_devices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  device_uid VARCHAR(150) NOT NULL UNIQUE, -- Android ID / IMEI-derived unique id
  model VARCHAR(120) NULL,
  brand VARCHAR(120) NULL,
  os VARCHAR(60) NULL,
  status ENUM('pending','approved','rejected','blacklisted') DEFAULT 'pending',
  push_token VARCHAR(255) NULL, -- Expo push token (services/pushService.js)
  registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  venue VARCHAR(200) NULL,
  start_datetime DATETIME NOT NULL,
  end_datetime DATETIME NOT NULL,
  department_id INT NULL,
  is_active TINYINT(1) DEFAULT 1,
  recurrence_type ENUM('none','weekly','dates') NOT NULL DEFAULT 'none',
  recurrence_days VARCHAR(20) NULL,
  recurrence_end_date DATE NULL,
  is_recurring_parent TINYINT(1) NOT NULL DEFAULT 0,
  parent_event_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(id),
  FOREIGN KEY (parent_event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Event audience. No rows in either table = everyone is expected.
CREATE TABLE event_attendee_departments (
  event_id INT NOT NULL,
  department_id INT NOT NULL,
  PRIMARY KEY (event_id, department_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE event_attendee_employees (
  event_id INT NOT NULL,
  employee_id INT NOT NULL,
  PRIMARY KEY (event_id, employee_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE geofences (
  id INT AUTO_INCREMENT PRIMARY KEY,
  event_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  venue VARCHAR(200) NULL,
  shape_type ENUM('circle','polygon','rectangle') DEFAULT 'circle',
  center_lat DECIMAL(10,7) NULL,
  center_lng DECIMAL(10,7) NULL,
  radius_meters INT NULL,
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Polygon vertices
CREATE TABLE geofence_points (
  id INT AUTO_INCREMENT PRIMARY KEY,
  geofence_id INT NOT NULL,
  point_order INT NOT NULL,
  lat DECIMAL(10,7) NOT NULL,
  lng DECIMAL(10,7) NOT NULL,
  FOREIGN KEY (geofence_id) REFERENCES geofences(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE ocr_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NULL,
  image_path VARCHAR(255) NOT NULL,
  extracted_text TEXT NULL,
  extracted_employee_code VARCHAR(20) NULL,
  result ENUM('matched','no_match','wrong_employee','wrong_id','unreadable','duplicate','expired','low_confidence') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE employee_faces (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  image_path VARCHAR(255) NOT NULL,
  video_path VARCHAR(255) NULL, -- optional guided liveness clip (blink/nod/turn-head) recorded during mobile registration
  embedding LONGTEXT NOT NULL, -- JSON array of floats produced by the ONNX face-recognition model
  model_name VARCHAR(100) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE face_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NULL,
  image_path VARCHAR(255) NOT NULL,
  similarity DECIMAL(5,2) NULL,
  result ENUM('matched','no_match','no_face_detected','expired','duplicate') NOT NULL,
  liveness_verified TINYINT(1) NOT NULL DEFAULT 0,
  liveness_actions VARCHAR(120) NULL,
  -- 'kiosk' (admin Verification page) or 'mobile_anomaly' (employee's own
  -- re-verification after an anomaly flag, in the mobile app)
  source VARCHAR(20) NOT NULL DEFAULT 'kiosk',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- DoubleSafe face checks during new-device registration
CREATE TABLE device_verification_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  device_uid VARCHAR(255) NULL,
  image_path VARCHAR(255) NULL,
  similarity DECIMAL(5,2) NULL,
  result ENUM('matched','no_match','locked') NOT NULL,
  liveness_verified TINYINT(1) NOT NULL DEFAULT 0,
  liveness_actions VARCHAR(120) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One row per employee/event/day
CREATE TABLE attendance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  event_id INT NULL,
  geofence_id INT NULL,
  device_id INT NULL,
  ocr_record_id INT NULL,
  verification_method ENUM('mobile_gps','ocr','face') NOT NULL DEFAULT 'mobile_gps',
  face_record_id INT NULL,
  verified_by_admin_id INT NULL,
  attendance_date DATE NOT NULL,
  time_in DATETIME NULL,
  time_out DATETIME NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  accuracy_meters DECIMAL(6,2) NULL,
  attendance_status ENUM('Present','Late','Absent','Excused') DEFAULT 'Present',
  verification_status ENUM('Verified','Pending','Rejected') DEFAULT 'Pending',
  late_minutes INT DEFAULT 0,
  work_hours DECIMAL(5,2) DEFAULT 0,
  total_duration_seconds INT NOT NULL DEFAULT 0, -- accumulated across every time-in/time-out session for the day
  last_lat DECIMAL(10,7) NULL,
  last_lng DECIMAL(10,7) NULL,
  last_ping_at DATETIME NULL,
  outside_streak INT DEFAULT 0,
  auto_ended TINYINT(1) DEFAULT 0,
  -- 1 once the event has ended and the final status (80% presence rule)
  -- has been settled, or an admin set the status by hand.
  status_finalized TINYINT(1) NOT NULL DEFAULT 0,
  selfie_path VARCHAR(255) NULL,
  selfie_lat DECIMAL(10,7) NULL,
  selfie_lng DECIMAL(10,7) NULL,
  requires_face_verification TINYINT(1) DEFAULT 0,
  face_verified_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL,
  FOREIGN KEY (geofence_id) REFERENCES geofences(id) ON DELETE SET NULL,
  FOREIGN KEY (device_id) REFERENCES mobile_devices(id) ON DELETE SET NULL,
  FOREIGN KEY (ocr_record_id) REFERENCES ocr_records(id) ON DELETE SET NULL,
  FOREIGN KEY (face_record_id) REFERENCES face_records(id) ON DELETE SET NULL,
  FOREIGN KEY (verified_by_admin_id) REFERENCES admin_accounts(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_emp_date_event (employee_id, attendance_date, event_id)
) ENGINE=InnoDB;

-- One row per time-in/time-out; totals roll up into attendance.total_duration_seconds
CREATE TABLE attendance_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attendance_id INT NOT NULL,
  employee_id INT NOT NULL,
  time_in DATETIME NOT NULL,
  time_out DATETIME NULL,
  duration_seconds INT NULL,
  in_latitude DECIMAL(10,7) NULL,
  in_longitude DECIMAL(10,7) NULL,
  out_latitude DECIMAL(10,7) NULL,
  out_longitude DECIMAL(10,7) NULL,
  auto_ended TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (attendance_id) REFERENCES attendance(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE attendance_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attendance_id INT NULL,
  employee_id INT NOT NULL,
  action VARCHAR(60) NOT NULL, -- e.g. geofence_entered, geofence_exited, attendance_submitted, attendance_rejected
  details TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (attendance_id) REFERENCES attendance(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NULL,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(60) DEFAULT 'general',
  is_read TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE admin_notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(60) NOT NULL,
  severity ENUM('info','success','warning','danger') NOT NULL DEFAULT 'info',
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  target_view VARCHAR(40) NULL,
  employee_id INT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_notifications_read (is_read, created_at),
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Verifies a new admin's email before the account is created
CREATE TABLE admin_email_otps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(150) NOT NULL,
  code_hash VARCHAR(255) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_email_otps_email (email)
) ENGINE=InnoDB;

CREATE TABLE certificates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  event_id INT NULL,
  certificate_number VARCHAR(60) NOT NULL UNIQUE,
  event_title VARCHAR(200) NOT NULL,
  issued_date DATE NOT NULL,
  pdf_path VARCHAR(255) NULL,
  -- Printed on the certificate (QR + text); looked up by the public /verify page.
  verification_code VARCHAR(20) NULL UNIQUE,
  -- SHA-256 of the employee's own PDF, to spot an edited copy.
  file_hash CHAR(64) NULL,
  emailed_at DATETIME NULL,
  email_error VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- One row per employee per event: 5 = present, 1 = absent
CREATE TABLE employee_ratings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  event_id INT NULL,
  rating_date DATE NOT NULL,
  rating TINYINT NOT NULL DEFAULT 1,
  is_manual TINYINT(1) DEFAULT 0,
  notes VARCHAR(255) NULL,
  updated_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES admin_accounts(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_emp_rating_event (employee_id, event_id),
  CONSTRAINT chk_rating_range CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB;

CREATE TABLE geo_anomalies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attendance_id INT NULL,
  employee_id INT NOT NULL,
  event_id INT NULL,
  device_uid VARCHAR(150) NULL,
  anomaly_type ENUM('duplicate_geolocation','device_mismatch','impossible_travel','other') DEFAULT 'duplicate_geolocation',
  details TEXT NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  resolved TINYINT(1) DEFAULT 0,
  resolved_by INT NULL,
  resolved_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (attendance_id) REFERENCES attendance(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL,
  FOREIGN KEY (resolved_by) REFERENCES admin_accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admin_id INT NULL,
  action VARCHAR(100) NOT NULL,
  module VARCHAR(60) NOT NULL,
  details TEXT NULL,
  ip_address VARCHAR(60) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES admin_accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(100) NOT NULL UNIQUE,
  setting_value TEXT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Durable copies of uploaded files (see services/uploadStore.js)
CREATE TABLE stored_uploads (
  path VARCHAR(255) NOT NULL PRIMARY KEY,
  mime_type VARCHAR(50) NOT NULL,
  data MEDIUMBLOB NOT NULL,
  size_bytes INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Indexes
CREATE INDEX idx_attendance_date ON attendance(attendance_date);
CREATE INDEX idx_attendance_sessions_open ON attendance_sessions(attendance_id, time_out);
CREATE INDEX idx_employees_dept ON employees(department_id);
CREATE INDEX idx_geofence_event ON geofences(event_id);
CREATE INDEX idx_employee_ratings_date ON employee_ratings(rating_date);
CREATE INDEX idx_employee_ratings_event ON employee_ratings(event_id);
CREATE INDEX idx_geo_anomalies_resolved ON geo_anomalies(resolved);
CREATE INDEX idx_employees_classification ON employees(classification);
CREATE INDEX idx_events_parent ON events(parent_event_id);

-- Default data (same as `npm run seed`, without sample employees)

-- Default admin: admin@my.cspc.edu.ph / password -- change the password
-- right after the first sign-in.
INSERT IGNORE INTO admin_accounts (full_name, email, password_hash, role) VALUES
  ('Super Admin', 'admin@my.cspc.edu.ph', '$2b$12$MruGa3uv4qMcs8qFOsHWmO3ouIibDNe1pXN756mdt7hqlXvxEWjBS', 'super_admin');

-- CSPC departments / offices (keep in sync with services/cspcOffices.js)
INSERT IGNORE INTO departments (name, office) VALUES
  ('Office of the President', 'Office of the President'),
  ('Office of the Vice President for Academic Affairs', 'Office of the Vice President for Academic Affairs'),
  ('Office of the Vice President for Administration and Finance', 'Office of the Vice President for Administration and Finance'),
  ('Office of the Vice President for Research, Innovation and Collaboration', 'Office of the Vice President for Research, Innovation and Collaboration'),
  ('Graduate School', 'Graduate School'),
  ('College of Arts and Sciences', 'College of Arts and Sciences'),
  ('College of Computer Studies', 'College of Computer Studies'),
  ('College of Engineering and Architecture', 'College of Engineering and Architecture'),
  ('College of Health Sciences', 'College of Health Sciences'),
  ('College of Technological and Developmental Education', 'College of Technological and Developmental Education'),
  ('College of Tourism, Hospitality and Business Management', 'College of Tourism, Hospitality and Business Management'),
  ('Human Resource Management and Development Unit', 'Human Resource Management and Development Unit'),
  ('Accounting Unit', 'Accounting Unit'),
  ('Budget Unit', 'Budget Unit'),
  ('Cash Unit', 'Cash Unit'),
  ('Procurement Unit', 'Procurement Unit'),
  ('Records and Freedom of Information Unit', 'Records and Freedom of Information Unit'),
  ('General Services Unit', 'General Services Unit'),
  ('Supply and Property Management Unit', 'Supply and Property Management Unit'),
  ('Information and Communications Technology Unit', 'Information and Communications Technology Unit'),
  ('Project Management Unit', 'Project Management Unit'),
  ('Internal Audit Unit', 'Internal Audit Unit'),
  ('Legal Affairs Office', 'Legal Affairs Office'),
  ('Institutional Planning and Development Unit', 'Institutional Planning and Development Unit'),
  ('Center for International Relations and Linkages', 'Center for International Relations and Linkages'),
  ('Student Registration and Records', 'Student Registration and Records'),
  ('Student Testing and Admission', 'Student Testing and Admission'),
  ('Student Affairs Services', 'Student Affairs Services'),
  ('Guidance and Counseling Office', 'Guidance and Counseling Office'),
  ('Learning Resources and Development', 'Learning Resources and Development'),
  ('Center for Quality Assurance', 'Center for Quality Assurance'),
  ('Center for Gender and Development', 'Center for Gender and Development'),
  ('Center for Human Rights Education', 'Center for Human Rights Education'),
  ('Research and Development Services Office', 'Research and Development Services Office'),
  ('Extension and Community Services Office', 'Extension and Community Services Office'),
  ('Production and Auxiliary Services', 'Production and Auxiliary Services'),
  ('Technology Transfer Office', 'Technology Transfer Office'),
  ('National Service Training Program', 'National Service Training Program'),
  ('Information and Alumni Affairs Unit', 'Information and Alumni Affairs Unit'),
  ('Buhi Campus Administration', 'Buhi Campus Administration'),
  ('Other Offices / Units', 'Other Offices / Units');

-- System settings
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
  ('late_grace_minutes', '15'),
  ('default_geofence_radius', '150'),
  ('ocr_min_confidence', '70'),
  ('school_name', 'GeoAttend Institution'),
  ('cspc_latitude', '13.4059'),
  ('cspc_longitude', '123.3758'),
  ('cspc_label', 'CSPC - Camarines Sur Polytechnic Colleges, Nabua, Camarines Sur');
