const express = require('express');
const router = express.Router();
const employeeController = require('../controllers/employeeController');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const { uploadPhoto, uploadImportFile } = require('../middleware/uploadMiddleware');

router.use(requireAuth, requireRole('super_admin'));

router.get('/export/csv', employeeController.exportCsv);
router.get('/export/excel', employeeController.exportExcel);
router.post('/import/preview', uploadImportFile.single('file'), employeeController.importPreview);
router.post('/import/commit', employeeController.importCommit);
router.get('/', employeeController.getEmployees);
router.get('/:id', employeeController.getEmployeeById);
router.post('/', uploadPhoto.single('photo'), employeeController.createEmployee);
router.put('/:id', uploadPhoto.single('photo'), employeeController.updateEmployee);
router.patch('/:id/remark', employeeController.updateRemark);
router.patch('/:id/unlock-face', employeeController.unlockFace);
router.delete('/:id', employeeController.deleteEmployee);

module.exports = router;
