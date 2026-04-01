const recommendationService = require('../services/recommendation.service');

const toError = (error, defaultStatus = 500) => {
  if (!error.status) {
    error.status = defaultStatus;
  }
  return error;
};

exports.getRecommendations = async (req, res) => {
  try {
    // 1. 클라이언트가 보낸 요청 본문(body)에서 필요 정보 추출
    const { latitude, longitude, startTime, endTime } = req.body;
    const uid = req.user.uid;

    // 2. 필수 값이 있는지 간단히 확인
    if (!latitude || !longitude || !startTime || !endTime) {
      return res.status(400).json({ message: '필수 입력값이 누락되었습니다.' });
    }

    // 3. 서비스 레이어에 로직 처리를 위임
    // 기획서의 P1(규칙 기반), P2(학습 기반) 로직이 서비스에서 처리됩니다. [cite: 23, 24]
    const recommendations = await recommendationService.fetchAndFilterPlaces({
      uid,
      latitude,
      longitude,
      startTime,
      endTime
    });

    // 4. 처리 결과를 클라이언트에 성공 응답으로 전송
    res.status(200).json({
      message: '추천 컨텐츠 조회 성공',
      count: recommendations.length,
      data: recommendations
    });

  } catch (error) {
    // 5. 서비스 처리 중 에러 발생 시
    console.error('추천 컨트롤러 에러:', error);
    res.status(500).json({ message: '서버 내부 오류가 발생했습니다.', error: error.message });
  }
};

exports.recommendForSlot = async (req, res, next) => {
  try {
    console.log('API HIT: recommendForSlot');
    const uid = req.user.uid;
    console.log('[recommendation][auth-uid]', req.user?.uid);
    const {
      slotStart,
      slotEnd,
      origin,
      categories,
      selectedPrices,
      transport,
      selectedCategories,
      selectedTransports,
      language,
      region,
      maxResults,
      latitude,
      longitude,
    } = req.body || {};

    const normalizedOrigin = origin ||
      (latitude !== undefined && longitude !== undefined
        ? { lat: Number(latitude), lng: Number(longitude) }
        : undefined);
    const normalizedCategories = Array.isArray(categories) ? categories : selectedCategories;
    const normalizedTransport =
      transport || (Array.isArray(selectedTransports) ? selectedTransports[0] : selectedTransports);

    const result = await recommendationService.fetchRecommendationsForSlot({
      uid,
      slotStart,
      slotEnd,
      origin: normalizedOrigin,
      categories: normalizedCategories,
      selectedPrices,
      transport: normalizedTransport,
      language,
      region,
      maxResults,
    });

    res.status(200).json({
      message: '슬롯 기반 추천 조회 성공',
      data: result,
    });
  } catch (error) {
    next(toError(error));
  }
};

exports.submitFeedback = async (req, res, next) => {
  try {
    console.log('[recommendation][feedback-request]', {
      method: req.method,
      url: req.originalUrl,
      hasAuthHeader: Boolean(req.headers?.authorization),
      uid: req.user?.uid || null,
      body: req.body || {},
    });

    const uid = req.user.uid;
    const { placeId, action, context, scheduleId } = req.body || {};
    const saved = await recommendationService.saveRecommendationFeedback({
      uid,
      placeId,
      action,
      context,
      scheduleId,
    });

    res.status(201).json({ message: '추천 피드백 저장 성공', data: saved });
  } catch (error) {
    console.error('[recommendation][feedback-failed]', {
      status: error.status || 500,
      message: error.message,
      details: error.details || null,
      body: req.body || {},
      uid: req.user?.uid || null,
    });
    next(toError(error));
  }
};
