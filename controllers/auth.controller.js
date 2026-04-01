// controllers/auth.controller.js


/**
 * @function verifyToken
 * @description 미들웨어를 통과한 요청에 대해 최종적으로 성공 응답을 반환합니다.
 * 이 함수가 실행되었다는 것은 곧 미들웨어의 정상 작동을 의미합니다.
 */
exports.verifyToken = (req, res) => {
    // req.user 객체가 존재한다는 것은 인증 미들웨어가 성공적으로 실행되었음을 의미합니다.
    res.status(200).json({
        message: '인증 미들웨어 정상 작동 확인. ID 토큰이 유효합니다.',
        isVerified: true,
        user_uid: req.user.uid, // 미들웨어에서 넣어준 UID를 반환하여 확인
    });
};