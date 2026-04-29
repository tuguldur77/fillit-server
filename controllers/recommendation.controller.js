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
    console.log('[demo-slot] body keys:', Object.keys(body));
    console.log('[demo-slot] body:', JSON.stringify(body));

    const {
      slotStart,
      slotEnd,
      origin,
      requestOrigin,
      categories,
      calendarContext,
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

    const normalizedOrigin = origin || requestOrigin ||
      (latitude !== undefined && longitude !== undefined
        ? { lat: Number(latitude), lng: Number(longitude) }
        : undefined);
    const normalizedCategories = Array.isArray(categories) ? categories : selectedCategories;
    const normalizedTransport =
      transport || (Array.isArray(selectedTransports) ? selectedTransports[0] : selectedTransports);

    console.log('[recommendation][for-slot-request]', {
      requestOrigin: origin,
      slotStart,
      slotEnd,
      categories,
      transport,
      hasCalendarContext: Boolean(calendarContext),
    });

    if (!origin && latitude !== undefined && longitude !== undefined) {
      console.warn('[recommendation][for-slot-origin-warning]', {
        message: 'origin not provided; using latitude/longitude compatibility fallback from request body',
        latitude,
        longitude,
      });
    }

    if (!origin && (latitude === undefined || longitude === undefined)) {
      console.warn('[recommendation][for-slot-origin-warning]', {
        message: 'origin missing and no fallback coordinates found; request will fail in service validation',
      });
    }

    const result = await recommendationService.fetchRecommendationsForSlot({
      uid,
      slotStart,
      slotEnd,
      origin: normalizedOrigin,
      categories: normalizedCategories,
      calendarContext,
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

exports.demoSlot = async (req, res, next) => {
  try {
    /*
    curl -X POST http://localhost:3000/api/recommendation/demo-slot \
      -H "Content-Type: application/json" \
      -d '{
        "slotStart":"2026-04-29T10:30:00+09:00",
        "slotEnd":"2026-04-29T12:00:00+09:00",
        "origin":{"lat":37.5665,"lng":126.9780},
        "categories":["cafe"],
        "transport":"walk",
        "testPersona":"quiet"
      }'
    */
    console.log('API HIT: demoSlot');
    console.log('[demo-slot] auth bypassed for demo');
    const body = req.body || {};
    const {
      slotStart,
      slotEnd,
      origin,
      categories,
      calendarContext,
      selectedPrices,
      transport,
      selectedCategories,
      selectedTransports,
      language,
      region,
      maxResults,
      latitude,
      longitude,
      testPersona,
    } = body;

    const uid = testPersona ? 'demo-user' : req.user?.uid || 'demo-user';
    console.log('[recommendation][auth-uid]', uid || null);

    if (testPersona && !['quiet', 'social'].includes(testPersona)) {
      return res.status(400).json({ error: 'unsupported testPersona. Use: quiet | social' });
    }

    const normalizedOrigin = origin ||
      (latitude !== undefined && longitude !== undefined
        ? { lat: Number(latitude), lng: Number(longitude) }
        : undefined);
    const normalizedCategories = Array.isArray(categories) ? categories : selectedCategories;
    const normalizedTransport =
      transport || (Array.isArray(selectedTransports) ? selectedTransports[0] : selectedTransports);

    console.log('[recommendation][demo-slot-request]', {
      requestOrigin: origin,
      slotStart,
      slotEnd,
      categories,
      transport,
      testPersona,
      hasCalendarContext: Boolean(calendarContext),
    });

    if (!origin && latitude !== undefined && longitude !== undefined) {
      console.warn('[recommendation][demo-slot-origin-warning]', {
        message: 'origin not provided; using latitude/longitude compatibility fallback from request body',
        latitude,
        longitude,
      });
    }

    if (!origin && (latitude === undefined || longitude === undefined)) {
      console.warn('[recommendation][demo-slot-origin-warning]', {
        message: 'origin missing and no fallback coordinates found; request will fail in service validation',
      });
    }

    const result = await recommendationService.fetchRecommendationsForSlot({
      uid,
      slotStart,
      slotEnd,
      origin: normalizedOrigin,
      categories: normalizedCategories,
      calendarContext,
      selectedPrices,
      transport: normalizedTransport,
      language,
      region,
      maxResults,
      testPersona,
    });

    res.status(200).json({
      message: '슬롯 기반 데모 추천 조회 성공',
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
