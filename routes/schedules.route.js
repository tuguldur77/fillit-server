const express = require('express');

const router = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const schedulesController = require('../controllers/schedules.controller');

router.use(authenticateToken);

router.post('/', schedulesController.createSchedule);
router.patch('/:id', schedulesController.updateSchedule);
router.delete('/:id', schedulesController.deleteSchedule);
router.get('/', schedulesController.listSchedules);

module.exports = router;
