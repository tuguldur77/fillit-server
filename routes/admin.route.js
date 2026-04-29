const express = require('express');

const router = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const adminController = require('../controllers/admin.controller');

router.post('/clearGenericKeywords', authenticateToken, adminController.clearGenericKeywords);

module.exports = router;
