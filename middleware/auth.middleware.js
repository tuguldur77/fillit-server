// middleware/auth.middleware.js

const admin = require('firebase-admin');

/**
 * @function authenticateToken
 * @description HTTP 요청 헤더의 Firebase ID 토큰을 검증하는 미들웨어 함수.
 * 검증 성공 시 req.user에 사용자 정보를 추가하고 다음(next) 라우트로 진행.
 * 검증 실패 시 401 또는 403 응답을 즉시 반환.
 */
const authenticateToken = async (req, res, next) => {
    // 1. Authorization 헤더 확인 (Bearer <ID_TOKEN> 형식)
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.warn('인증 실패: Authorization 헤더 누락 또는 형식 오류');
        // 토큰이 없거나 형식이 틀린 경우 401 Unauthorized 반환
        return res.status(401).json({ 
            message: '접근 권한이 필요합니다. 유효한 ID 토큰을 Bearer 형식으로 제공하세요.'
        });
    }

    // 2. 순수한 ID 토큰 추출
    const idToken = authHeader.split('Bearer ')[1];

    try {
        // 3. Firebase Admin SDK를 사용한 토큰 검증 (가장 중요한 보안 로직)
        // verifyIdToken()은 토큰의 서명, 만료 시간, 발급자 등을 모두 Firebase 서버와 통신하여 검증합니다.
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        
        // 4. 검증 성공: 디코드된 사용자 정보를 req 객체에 추가
        // 이 정보(UID, 이메일 등)는 Controller와 Service에서 사용자 식별에 사용됩니다.
        req.user = decodedToken;
        
        // 5. 다음 미들웨어 또는 최종 라우트 핸들러로 요청 전달
        next(); 
        
    } catch (error) {
        // 6. 검증 실패 (토큰 만료, 위변조, 네트워크 오류 등)
        console.error('인증 실패 - ID 토큰 검증 오류:', error.code, error.message);
        
        // 403 Forbidden 반환 (토큰은 존재하지만 유효하지 않거나 권한이 없는 경우)
        return res.status(403).json({ 
            message: '제공된 ID 토큰이 유효하지 않거나 만료되었습니다.',
            errorCode: error.code || 'TOKEN_INVALID'
        });
    }
};

module.exports = authenticateToken;