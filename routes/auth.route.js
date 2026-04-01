// routes/auth.route.js (수정본)

const express = require('express');
const router = express.Router();

const authenticateToken = require('../middleware/auth.middleware'); 
const authController = require('../controllers/auth.controller'); 


/**
 * 🛡️ 보호된 라우트: ID 토큰 검증 및 정상 작동 여부 확인
 * POST /api/auth/verify
 * (기존의 '/verify-token' 대신 더 간결하게 '/verify'로 변경)
 */
router.post('/verify', 
    authenticateToken, 
    authController.verifyToken // ✅ auth.controller.js에 정의된 함수와 일치
); 


module.exports = router;