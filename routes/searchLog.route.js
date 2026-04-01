const express = require('express');

const router = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const searchLogController = require('../controllers/searchLog.controller');

router.use(authenticateToken);

router.post('/log', searchLogController.createSearchLog);

module.exports = router;
