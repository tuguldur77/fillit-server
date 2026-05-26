
// 1. 환경 변수 로드 (가장 먼저 실행)
require('dotenv').config(); 

// 2. 필수 모듈 임포트
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin'); // Firebase Admin SDK

// 3. 라우터 파일 임포트는 Firebase 초기화 이후에 수행 (의존성 순서 보장)

// ...
// 4. 서버 설정
const app = express();
const PORT = process.env.PORT || 3000;

// 5. Firebase Admin SDK 초기화 (인증 검증을 위해 필수)
try {
    let firebaseConfig;

    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        // Railway: use environment variable
        firebaseConfig = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } else {
        // Local: use file
        firebaseConfig = require('./serviceAccountKey.json');
    }

    admin.initializeApp({
        credential: admin.credential.cert(firebaseConfig)
    });
    console.log('✅ Firebase Admin SDK 초기화 성공');
} catch (error) {
    console.error(`❌ Firebase Admin SDK 초기화 실패: ${error.message}`);
    console.error('=> FIREBASE_SERVICE_ACCOUNT_JSON 환경 변수 또는 serviceAccountKey.json 파일을 확인하세요.');
    process.exit(1); // 초기화 실패 시 서버 종료
}


// --- 전역 미들웨어 설정 ---

// 6. CORS 설정: 모바일 앱과의 통신 허용
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'] // Authorization 헤더 허용 (ID 토큰 전송 위함)
}));

// 7. 요청 본문(Body) 파서 설정: JSON 형태로 받은 데이터를 req.body로 파싱
app.use(express.json());


// --- 기본 라우트 및 API 라우터 연결 ---

// Firebase 초기화가 끝난 뒤 라우터를 로드하여, 라우트 내부에서 Firestore를 사용할 때 초기화 문제가 없도록 함
const authRoutes = require('./routes/auth.route'); 
const searchPlaceRoutes = require('./routes/searchPlaces.route');
const recommendationRoutes = require('./routes/recommendation.route');
const adminRoutes = require('./routes/admin.route');
const schedulesRoutes = require('./routes/schedules.route');
const searchLogRoutes = require('./routes/searchLog.route');

console.log('Auth Router Loaded:', typeof authRoutes.stack !== 'undefined');
console.log('SearchPlace Router Loaded:', typeof searchPlaceRoutes.stack !== 'undefined');
console.log('Recommendation Router Loaded:', typeof recommendationRoutes.stack !== 'undefined');
console.log('Admin Router Loaded:', typeof adminRoutes.stack !== 'undefined');
console.log('Schedules Router Loaded:', typeof schedulesRoutes.stack !== 'undefined');
console.log('SearchLog Router Loaded:', typeof searchLogRoutes.stack !== 'undefined');

// 8. 테스트용 루트 라우트
app.get('/', (req, res) => {
    res.status(200).send('🔥 서버가 정상적으로 실행 중입니다. API 엔드포인트를 확인하세요.');
});

// 9. 기능별 라우터 연결 (URL 접두사 설정)
app.use('/api/auth', authRoutes); // 예: /api/auth/login
app.use('/api/searchPlace', searchPlaceRoutes); // 장소 검색 라우터
app.use('/api/recommendation', recommendationRoutes); // 추천 라우터
app.use('/api/admin', adminRoutes); // 관리자 유틸 라우터
app.use('/api/schedules', schedulesRoutes); // 일정 CRUD/조회
app.use('/api/search', searchLogRoutes); // 검색 로그



// --- 에러 핸들링 미들웨어 (마지막에 위치) ---

// 10. 존재하지 않는 라우트에 대한 404 처리
app.use((req, res, next) => {
    res.status(404).json({ message: `요청하신 경로 [${req.url}]는 존재하지 않습니다.` });
});

// 11. 최종 에러 핸들러 (모든 서버 내부 오류 처리)
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(err.status || 500).json({ 
        message: err.message || '서버 내부 오류가 발생했습니다.',
        error: process.env.NODE_ENV === 'development' ? err : {} // 개발 환경에서만 에러 상세 정보 제공
    });
});


// --- 서버 구동 ---

app.listen(PORT, () => {
    console.log(`🚀 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
    // Redis 연결은 보통 services/ 또는 config/redis.js 파일에서 별도로 진행됩니다.
});