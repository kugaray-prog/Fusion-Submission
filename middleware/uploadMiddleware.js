const multer = require('multer');
const path = require('path');
const fs = require('fs');

function makeStorage(subfolder) {
  const dest = path.join(__dirname, '..', 'uploads', subfolder);
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, dest),
    filename: (req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${unique}${path.extname(file.originalname)}`);
    }
  });
}

const imageFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  const ok = allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype);
  if (ok) return cb(null, true);
  cb(new Error('Only image files (jpg, jpeg, png, webp) are allowed.'));
};

const uploadOcr = multer({
  storage: makeStorage('ocr'),
  fileFilter: imageFilter,
  limits: { fileSize: 8 * 1024 * 1024 } // 8MB
});

const uploadPhoto = multer({
  storage: makeStorage('photos'),
  fileFilter: imageFilter,
  limits: { fileSize: 4 * 1024 * 1024 }
});

const uploadFace = multer({
  storage: makeStorage('faces'),
  fileFilter: imageFilter,
  limits: { fileSize: 6 * 1024 * 1024 }
});

// Registration and face re-verification upload a photo and a video in one
// request, each to its own folder.
const REGISTRATION_FOLDERS = { image: 'faces', selfie: 'selfies', video: 'face_videos' };
Object.values(REGISTRATION_FOLDERS).forEach((sub) => {
  const dest = path.join(__dirname, '..', 'uploads', sub);
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
});

const registrationStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'uploads', REGISTRATION_FOLDERS[file.fieldname] || 'faces')),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  }
});

const registrationFileFilter = (req, file, cb) => {
  if (file.fieldname === 'video') {
    const allowed = /mp4|mov|m4v|quicktime/;
    const ok = allowed.test(path.extname(file.originalname).toLowerCase()) || allowed.test(file.mimetype);
    return ok ? cb(null, true) : cb(new Error('The liveness video must be an mp4 or mov file.'));
  }
  return imageFilter(req, file, cb);
};

const uploadRegistration = multer({
  storage: registrationStorage,
  fileFilter: registrationFileFilter,
  limits: { fileSize: 30 * 1024 * 1024 } // 30MB
});

// Import files stay in memory; they are parsed once and discarded.
const importFileFilter = (req, file, cb) => {
  const allowed = /csv|xlsx|xls/;
  const ok = allowed.test(path.extname(file.originalname).toLowerCase());
  if (ok) return cb(null, true);
  cb(new Error('Only .csv, .xlsx, or .xls files are allowed.'));
};

const uploadImportFile = multer({
  storage: multer.memoryStorage(),
  fileFilter: importFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Also store each upload in the database (services/uploadStore.js), since the
// host disk may not survive restarts.
function withDurableCopy(uploader) {
  const { persistRequestUploads } = require('../services/uploadStore');
  const wrapped = Object.create(uploader);
  for (const method of ['single', 'fields', 'array']) {
    wrapped[method] = (...args) => [uploader[method](...args), persistRequestUploads];
  }
  return wrapped;
}

module.exports = {
  uploadOcr: withDurableCopy(uploadOcr),
  uploadPhoto: withDurableCopy(uploadPhoto),
  uploadFace: withDurableCopy(uploadFace),
  uploadRegistration: withDurableCopy(uploadRegistration),
  uploadImportFile
};
