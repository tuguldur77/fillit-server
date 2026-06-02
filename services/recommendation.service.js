const admin = require('firebase-admin');
const searchPlacesService = require('./searchPlaces.service');

const FEEDBACK_SUBCOLLECTION = process.env.RECOMMENDATION_FEEDBACK_SUBCOLLECTION || 'recommendationFeedback';
const ROUTES_MATRIX_ENDPOINT = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const REASON_SENTENCE_MODEL = 'gemini-2.5-flash';
const REASON_SENTENCE_MODEL_FALLBACKS = ['gemini-2.5-flash-lite', 'gemini-2.0-flash-001'];
const REASON_SENTENCE_TIMEOUT_MS = 12000;
const REASON_SENTENCE_MAX_CHARS = 40;
const TRANSPORT_SPEED_MPS = {
  walk: 1.2,
  car: 10.5,
};
const MASTER_KEYWORDS = [
  '조용',
  '감성',
  '편안',
  '작업하기좋은',
  '대화하기좋은',
  '좌석많은',
  '채광좋은',
  '인테리어좋은',
  '데이트',
  '모임적합',
  '시끄러운',
  '혼잡한',
  '주차편리',
  '반려동물가능',
  '루프탑',
];
const COSINE_SCORE_WEIGHT = 0.2;
const CALENDAR_SUGGESTED_MATCH_WEIGHT = 0.02;
const CALENDAR_SUGGESTED_MAX = 0.05;
const CALENDAR_AVOID_MATCH_PENALTY = 0.03;
const GEMINI_MAX_PLACES_PER_REQUEST = 10;
const TFIDF_MIN_WEIGHT = 0.02;
const KEYWORD_BOOST_MAX = 0.1;
const KEYWORD_TEXT_MATCH_WEIGHT = 0.006;
const KEYWORD_TYPE_HINT_MATCH_WEIGHT = 0.002;
const KEYWORD_TYPE_HINT_TOP_K = 3;
const BROAD_KEYWORDS = new Set(['조용', '감성', '편안']);
const TIME_PREFERENCE_COLLECTION = 'timePreferences';
const WANTED_COLLECTION = 'wanted';
const TIME_PREFERENCE_BOOST_MAX = 0.2;
const TIME_PREFERENCE_COUNT_WEIGHT = 0.03;
const KEYWORD_BLACKLIST = new Set([
  '카페',
  '커피',
  '맛집',
  '사진',
  '음식',
  '장소',
  'shopping',
  'restaurant',
  'cafe',
  'point_of_interest',
  'establishment',
]);
const GENERIC_TYPE_KEYWORDS = new Set([
  'restaurant',
  'cafe',
  'store',
  'food',
  'point_of_interest',
  'establishment',
  'shopping_mall',
  'tourist_attraction',
  'park',
  'museum',
  'library',
]);
const KEYWORD_TYPE_HINTS = {
  작업하기좋은: ['cafe', 'library'],
  대화하기좋은: ['cafe', 'restaurant'],
  데이트: ['cafe', 'shopping_mall', 'restaurant', 'tourist_attraction'],
  모임적합: ['restaurant', 'cafe'],
  shopping: ['shopping_mall', 'store'],
  채광좋은: ['cafe'],
  인테리어좋은: ['cafe', 'restaurant', 'art_gallery'],
  조용: ['cafe', 'library', 'museum'],
  감성: ['cafe', 'art_gallery'],
  편안: ['cafe', 'park'],
};
const MASTER_KEYWORD_SET = new Set(
  MASTER_KEYWORDS.map((keyword) => (typeof keyword === 'string' ? keyword.trim().toLowerCase() : '')).filter(
    Boolean
  )
);
const TYPE_KEYWORD_MAP = {
  cafe: ['감성', '편안'],
  coffee_shop: ['조용', '작업하기좋은'],
  bakery: ['감성', '편안'],
  restaurant: ['대화하기좋은', '모임적합'],
  bar: ['모임적합', '대화하기좋은'],
};

const fetchFn = global.fetch
  ? (...args) => global.fetch(...args)
  : async (...args) => {
      const { default: fetch } = await import('node-fetch');
      return fetch(...args);
    };

const getFirestore = () => {
  if (!admin.apps || admin.apps.length === 0) {
    const error = new Error('Firebase Admin SDK가 초기화되지 않았습니다.');
    error.status = 500;
    throw error;
  }
  return admin.firestore();
};

const withTimeout = (promise, timeoutMs, label = 'operation') => {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
};

const asIso = (value, fieldName) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${fieldName}는 유효한 datetime 이어야 합니다.`);
    error.status = 400;
    throw error;
  }
  return parsed.toISOString();
};

const validateLatLng = (value, fieldName) => {
  const lat = Number(value?.lat);
  const lng = Number(value?.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    const error = new Error(`${fieldName}.lat/lng는 숫자여야 합니다.`);
    error.status = 400;
    throw error;
  }
  return { lat, lng };
};

const normalizeTransport = (transport = 'walk') => {
  const rawValue = Array.isArray(transport) ? transport[0] : transport;
  const raw = String(rawValue || 'walk').toLowerCase();
  if (['walk', 'walking', '도보'].includes(raw)) return 'walk';
  if (['car', 'drive', 'driving', '자동차'].includes(raw)) return 'car';
  return 'walk';
};

const haversineDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
};

const estimateTravelTimeSec = (distanceM, transport) => {
  const normalized = normalizeTransport(transport);
  const speed = TRANSPORT_SPEED_MPS[normalized] || TRANSPORT_SPEED_MPS.walk;
  return Math.round(distanceM / speed);
};

const toRoutesTravelMode = (transport) => (normalizeTransport(transport) === 'car' ? 'DRIVE' : 'WALK');

const ensureMapsApiKey = () => {
  if (!GOOGLE_MAPS_API_KEY) {
    const error = new Error('GOOGLE_MAPS_API_KEY 또는 GOOGLE_PLACES_API_KEY 환경 변수가 필요합니다.');
    error.status = 500;
    throw error;
  }
};

const resolveOrigin = async ({ origin, language, region, selectedPrices, transport }) => {
  if (!origin) {
    const error = new Error('origin(lat,lng 또는 query)은 필수입니다.');
    error.status = 400;
    throw error;
  }

  if (origin.lat !== undefined || origin.lng !== undefined) {
    return validateLatLng(origin, 'origin');
  }

  if (origin.query && typeof origin.query === 'string') {
    const query = origin.query.trim();
    if (!query) {
      const error = new Error('origin.query는 비어 있을 수 없습니다.');
      error.status = 400;
      throw error;
    }

    const geocodeResult = await searchPlacesService.searchPlacesByKeyword({
      keyword: query,
      language,
      region,
      maxResults: 1,
      selectedPrices,
      selectedTransports: [normalizeTransport(transport)],
    });

    const first = geocodeResult.results?.[0];
    if (!first?.location) {
      const error = new Error('origin.query로 위치를 찾지 못했습니다.');
      error.status = 400;
      throw error;
    }

    return {
      lat: Number(first.location.latitude),
      lng: Number(first.location.longitude),
    };
  }

  const error = new Error('origin은 {lat,lng} 또는 {query} 형식이어야 합니다.');
  error.status = 400;
  throw error;
};

const normalizeCategoriesForPlaces = (categories) => {
  if (!Array.isArray(categories) || categories.length === 0) {
    return [];
  }

  const categoryMap = {
    cafe: '카페',
    restaurant: '맛집',
    카페: '카페',
    맛집: '맛집',
  };

  const normalized = categories
    .map((raw) => {
      if (!raw || typeof raw !== 'string') return undefined;
      const trimmed = raw.trim();
      if (!trimmed) return undefined;

      const mappedLabel = categoryMap[trimmed] || trimmed;
      const mapped = searchPlacesService.resolvePlaceType(mappedLabel);
      const candidate = (mapped || trimmed).toLowerCase();
      return /^[a-z_]+$/.test(candidate) ? candidate : undefined;
    })
    .filter(Boolean);

  return [...new Set(normalized)];
};

const computeBaselineScore = (place) => {
  const distanceScore = Math.exp(-Number(place.distanceM || 0) / 3000);
  const travelTimeScore = Math.exp(-Number(place.travelTimeSec || 0) / 1800);
  const ratingScore = Number(place.rating || 0) / 5;

  return 0.4 * distanceScore + 0.4 * travelTimeScore + 0.2 * ratingScore;
};

function getTimeBucket(slotStart) {
  const slotDate = new Date(slotStart);
  if (Number.isNaN(slotDate.getTime())) {
    return 'AFTERNOON';
  }

  const KST_OFFSET = 9 * 60 * 60 * 1000;
  const slotKST = new Date(slotDate.getTime() + KST_OFFSET);
  const hour = slotKST.getUTCHours();
  if (hour >= 6 && hour <= 10) return 'MORNING';
  if (hour >= 11 && hour <= 16) return 'AFTERNOON';
  if (hour >= 17 && hour <= 20) return 'EVENING';
  return 'NIGHT';
}

function getDurationBucket(slotStart, slotEnd) {
  const start = new Date(slotStart);
  const end = new Date(slotEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return 'MEDIUM';
  }

  const durationMinutes = (end.getTime() - start.getTime()) / (60 * 1000);
  if (durationMinutes <= 60) return 'SHORT';
  if (durationMinutes <= 120) return 'MEDIUM';
  return 'LONG';
}

const buildTimePreferenceDocId = (bucket, durationBucket) => `${bucket}_${durationBucket}`;

const resolvePlaceCategory = (place) => {
  if (!place || typeof place !== 'object') {
    return null;
  }

  const primaryType = normalizeKeyword(place.primaryType || place.type || place.placePrimaryType);
  if (primaryType) {
    return primaryType;
  }

  const types = Array.isArray(place.types)
    ? place.types
    : Array.isArray(place.placeTypes)
    ? place.placeTypes
    : [];
  const firstType = normalizeKeyword(types[0]);
  return firstType || null;
};

const normalizeKeyword = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const shouldIgnoreKeyword = (keyword, wantedData = {}) => {
  if (!keyword || keyword.length < 2) {
    return true;
  }
  if (KEYWORD_BLACKLIST.has(keyword)) {
    return true;
  }

  const wantedName = normalizeKeyword(wantedData.name);
  if (wantedName && keyword === wantedName) {
    return true;
  }

  const wantedPrimaryType = normalizeKeyword(wantedData.primaryType);
  if (wantedPrimaryType && keyword === wantedPrimaryType && GENERIC_TYPE_KEYWORDS.has(keyword)) {
    return true;
  }

  const wantedTypes = Array.isArray(wantedData.types)
    ? wantedData.types.map((type) => normalizeKeyword(type)).filter(Boolean)
    : [];
  if (wantedTypes.includes(keyword) && GENERIC_TYPE_KEYWORDS.has(keyword)) {
    return true;
  }

  return false;
};

function buildUserKeywordProfile(wantedDocs) {
  if (!Array.isArray(wantedDocs) || wantedDocs.length === 0) {
    return {};
  }

  return wantedDocs.reduce((profile, wantedDoc) => {
    const data = typeof wantedDoc?.data === 'function' ? wantedDoc.data() : wantedDoc;
    const docId = wantedDoc?.id || data?.placeId || 'unknown-doc';
    const signals = Array.isArray(data?.keywordSignals) ? data.keywordSignals : [];

    if (signals.length > 0) {
      signals.forEach((signal) => {
        const keyword = normalizeKeyword(signal?.keyword);
        const weight = Number(signal?.weight);
        if (!keyword) {
          return;
        }
        if (signal?.weight === undefined || signal?.weight === null || Number.isNaN(weight)) {
          return;
        }
        if (weight <= 0) {
          return;
        }
        if (shouldIgnoreKeyword(keyword, data)) {
          return;
        }
        profile[keyword] = (profile[keyword] || 0) + weight;
      });
      return profile;
    }

    const rawKeywords = data?.keywords;
    const fallbackKeywords = Array.isArray(rawKeywords)
      ? rawKeywords
      : typeof rawKeywords === 'string'
      ? rawKeywords.split(',')
      : [];

    if (fallbackKeywords.length > 0) {
      console.log('[recommendation][keyword-profile-fallback]', {
        docId,
        reason: 'keywordSignals-empty-or-missing',
        keywordsCount: fallbackKeywords.length,
      });
    }

    fallbackKeywords.forEach((keyword) => {
      const normalized = normalizeKeyword(keyword);
      if (shouldIgnoreKeyword(normalized, data)) {
        console.log('[recommendation][keyword-profile-fallback]', {
          docId,
          keyword: normalized,
          status: 'skipped',
          reason: 'excluded-by-filter',
        });
        return;
      }
      profile[normalized] = (profile[normalized] || 0) + 1;
      console.log('[recommendation][keyword-profile-fallback]', {
        docId,
        keyword: normalized,
        status: 'accepted',
        totalWeight: profile[normalized],
      });
    });

    return profile;
  }, {});
}

function extractKeywordsFromWantedData(data = {}) {
  const fromSignals = Array.isArray(data.keywordSignals)
    ? data.keywordSignals
        .map((signal) => normalizeKeyword(signal?.keyword))
        .filter((keyword) => keyword && !shouldIgnoreKeyword(keyword, data))
    : [];

  if (fromSignals.length > 0) {
    return fromSignals;
  }

  const rawKeywords = data?.keywords;
  const fallbackKeywords = Array.isArray(rawKeywords)
    ? rawKeywords
    : typeof rawKeywords === 'string'
    ? rawKeywords.split(',')
    : [];

  return fallbackKeywords
    .map((keyword) => normalizeKeyword(keyword))
    .filter((keyword) => keyword && !shouldIgnoreKeyword(keyword, data));
}

function extractPlaceKeywords(place = {}) {
  const directKeywords = Array.isArray(place?.keywords)
    ? place.keywords
    : typeof place?.keywords === 'string'
    ? place.keywords.split(',')
    : [];

  const signalKeywords = Array.isArray(place?.keywordSignals)
    ? place.keywordSignals.map((signal) => signal?.keyword)
    : [];

  const normalized = [...directKeywords, ...signalKeywords]
    .map((keyword) => normalizeKeyword(keyword))
    .filter(Boolean);

  return [...new Set(normalized)];
}

function mapTypesToKeywords(types = []) {
  const keywords = new Set();
  (Array.isArray(types) ? types : []).forEach((type) => {
    const normalizedType = normalizeKeyword(type);
    (TYPE_KEYWORD_MAP[normalizedType] || []).forEach((keyword) => {
      const normalizedKeyword = normalizeKeyword(keyword);
      if (MASTER_KEYWORD_SET.has(normalizedKeyword)) {
        keywords.add(normalizedKeyword);
      }
    });
  });
  return [...keywords];
}

function parseGeminiKeywordResponse(rawText) {
  const cleaned = String(rawText || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) {
      return [];
    }
    try {
      const parsed = JSON.parse(match[0]);
      return Array.isArray(parsed) ? parsed : [];
    } catch (parseError) {
      return [];
    }
  }
}

function getFallback(place = {}, userContext = {}) {
  if (userContext?.calendarContext) {
    return '일정 사이 잠깐 들르기 좋은 곳이에요';
  }

  if (Number(userContext?.timePreferenceBoost || 0) > 0) {
    return '이 시간대 자주 찾는 분위기예요';
  }

  if (Array.isArray(place?.matchedKeywords) && place.matchedKeywords.length > 0) {
    return '취향에 딱 맞는 곳이에요';
  }

  const distance = Number(place?.distance ?? place?.distanceM ?? Infinity);
  if (distance < 500) {
    return '가깝고 분위기 좋은 곳이에요';
  }

  return '지금 이 시간에 어울리는 곳이에요';
}

function sanitizeReasonSentence(sentence = '') {
  const cleaned = String(sentence || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^\s*["'`]+\s*/, '')
    .replace(/\s*["'`]+\s*$/, '')
    .trim();
  return cleaned;
}

function buildReasonSentencePrompt(place = {}, userContext = {}) {
  const matchedKeywords = Array.isArray(place?.matchedKeywords) ? place.matchedKeywords.filter(Boolean) : [];
  const matchedKeywordsText = matchedKeywords.length > 0 ? matchedKeywords.join(', ') : '(취향 데이터 학습 중)';
  const distanceMeters = Number(place?.distance ?? place?.distanceM ?? 0);
  const walkMinutes = Number(
    place?.walkMinutes ??
      (Number.isFinite(Number(place?.travelTimeSec)) ? Math.max(1, Math.round(Number(place.travelTimeSec) / 60)) : 0)
  );
  const timePreferenceBoost = Number(userContext?.timePreferenceBoost || 0);
  const calendarText = userContext?.calendarContext
    ? `직전 일정: "${String(userContext.calendarContext.previousEventTitle || '')}"
직후 일정: "${String(userContext.calendarContext.nextEventTitle || '')}"
분위기: "${String(userContext.calendarContext.mood || '')}"`
    : '캘린더 정보 없음';
  const timeText =
    userContext?.timeBucket === 'MORNING' ? '오전' : userContext?.timeBucket === 'AFTERNOON' ? '오후' : '저녁';

  return `You are a friendly Korean place recommendation assistant.
Write ONE short Korean sentence explaining why this place fits
this user right now.

Place type: "${String(place?.primaryType || '')}"
Matched taste keywords: ${matchedKeywordsText}
Distance: "도보 ${walkMinutes}분 (${distanceMeters}m)"
Rating: ${String(place?.rating ?? '')}
Time of day: ${timeText}
Gap duration: ${String(userContext?.gapDurationMinutes ?? '')}분
Time preference boost: ${timePreferenceBoost > 0 ? '이 시간대 자주 방문함' : '없음'}
${calendarText}

RULES:
- Write ONLY one sentence in Korean
- Maximum 25 characters
- Warm and natural tone
- Use endings: 예요, 이에요, 좋아요, 곳이에요
- Do NOT mention place name
- Do NOT use formal endings (습니다, 합니다)
- Focus on the STRONGEST signal:
  * If calendarContext exists -> mention schedule
  * If timePreferenceBoost > 0 -> mention time pattern
  * If matchedKeywords has items -> mention taste
  * If distance < 500m -> mention closeness

Good examples:
"오전 미팅 후 조용히 쉬기 딱 좋아요"
"이 시간대 자주 찾는 분위기예요"
"취향에 딱 맞는 감성 카페예요"
"가깝고 평점 높은 곳이에요"
"친구 만나기 전 잠깐 들르기 좋아요"

Return ONLY the sentence. No quotes. No explanation.`;
}

async function callGeminiReasonSentence(prompt, modelName) {
  const response = await fetchFn(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(
      GEMINI_API_KEY
    )}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          topP: 0.9,
        },
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini 호출 실패: ${response.status} ${response.statusText} ${text}`);
  }

  const data = await response.json();
  const text = (data?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text)
    .filter(Boolean)
    .join(' ');

  return {
    text,
    finishReason: data?.candidates?.[0]?.finishReason || null,
    candidateCount: Array.isArray(data?.candidates) ? data.candidates.length : 0,
    modelName,
  };
}

async function generateReasonSentence(place = {}, userContext = {}) {
  const placeName = place?.name || null;
  const hasCalendarContext = Boolean(userContext?.calendarContext);
  const timePreferenceBoost = Number(userContext?.timePreferenceBoost || 0);
  const matchedKeywords = Array.isArray(place?.matchedKeywords)
    ? place.matchedKeywords.filter(Boolean)
    : [];
  const hasApiKey = Boolean(GEMINI_API_KEY);
  const configuredModel = process.env.REASON_SENTENCE_MODEL || REASON_SENTENCE_MODEL;
  const modelCandidates = [...new Set([configuredModel, ...REASON_SENTENCE_MODEL_FALLBACKS])];

  console.log('[reason-sentence][debug-entry]', {
    name: placeName,
    matchedKeywords,
    hasApiKey,
  });

  console.log('[reason-sentence][model-check]', {
    hasModel: hasApiKey,
    modelType: 'rest',
    hasGenerateContent: true,
    configuredModel,
    modelCandidates,
  });

  console.log('[reason-sentence][generating]', {
    name: placeName,
    matchedKeywords,
    hasCalendarContext,
    timePreferenceBoost,
  });

  const fallback = getFallback(place, userContext);
  if (!GEMINI_API_KEY) {
    console.warn('[reason-sentence][fallback-reason]', {
      name: placeName,
      reason: 'missing-gemini-api-key',
    });
    console.log('[reason-sentence][result]', {
      name: placeName,
      sentence: fallback,
      length: [...fallback].length,
      source: 'fallback',
    });
    return fallback;
  }

  const prompt = buildReasonSentencePrompt(place, userContext);
  console.log('[reason-sentence][prompt-preview]', {
    name: placeName,
    promptLength: prompt.length,
    promptStart: prompt.substring(0, 100),
  });

  try {
    let lastError = null;

    for (const modelName of modelCandidates) {
      try {
        const geminiResult = await Promise.race([
          callGeminiReasonSentence(prompt, modelName),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('TIMEOUT')), REASON_SENTENCE_TIMEOUT_MS);
          }),
        ]);

        console.log('[reason-sentence][gemini-raw]', {
          name: placeName,
          modelName,
          result: geminiResult?.text,
          finishReason: geminiResult?.finishReason,
          candidateCount: geminiResult?.candidateCount,
        });

        const sentence = sanitizeReasonSentence(geminiResult?.text || '');
        const sentenceLength = [...sentence].length;
        if (!sentence || sentenceLength > REASON_SENTENCE_MAX_CHARS) {
          console.warn('[reason-sentence][model-attempt-invalid]', {
            name: placeName,
            modelName,
            sentenceLength,
            maxAllowed: REASON_SENTENCE_MAX_CHARS,
          });
          continue;
        }

        console.log('[reason-sentence][gemini-success]', {
          name: placeName,
          modelName,
          text: sentence,
        });

        console.log('[reason-sentence][result]', {
          name: placeName,
          sentence,
          length: sentenceLength,
          source: 'gemini',
          modelName,
        });

        return sentence;
      } catch (attemptError) {
        lastError = attemptError;
        console.warn('[reason-sentence][model-attempt-failed]', {
          name: placeName,
          modelName,
          error: attemptError?.message || String(attemptError),
        });
      }
    }

    throw lastError || new Error('NO_VALID_REASON_SENTENCE');
  } catch (e) {
    console.error('[reason-sentence][gemini-error]', {
      name: placeName,
      error: e?.message || String(e),
      stack: typeof e?.stack === 'string' ? e.stack.split('\n')[0] : undefined,
      attemptedModels: modelCandidates,
    });
    console.warn('[reason-sentence][error]', {
      name: placeName,
      error: e?.message || String(e),
    });
    console.warn('[reason-sentence][fallback-reason]', {
      name: placeName,
      reason: 'all-model-attempts-failed-or-invalid',
    });
    console.log('[reason-sentence][result]', {
      name: placeName,
      sentence: fallback,
      length: [...fallback].length,
      source: 'fallback',
    });
    return fallback;
  }
}

function buildReasonSentenceUserContext({ keywordProfile = {}, calendarContext = null, timeBucket, durationBucket, slotStart, slotEnd }) {
  const start = new Date(slotStart);
  const end = new Date(slotEnd);
  const gapDurationMinutes =
    Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())
      ? 0
      : Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));

  return {
    keywordProfile,
    topUserKeywords: Object.entries(keywordProfile || {})
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 4)
      .map(([keyword]) => keyword),
    calendarContext: calendarContext || null,
    timeBucket,
    durationBucket,
    gapDurationMinutes,
    timePreferenceBoost: 0,
  };
}

async function generateKeywordsWithGemini(place = {}, options = {}) {
  const { returnMeta = false } = options;
  const placeId = place?.placeId || place?.id || null;
  const normalizedTypes = Array.isArray(place?.types)
    ? place.types.map((type) => normalizeKeyword(type)).filter(Boolean)
    : [];
  const typeFallbackKeywords = mapTypesToKeywords(normalizedTypes);
  const db = getFirestore();
  const buildReturnValue = (keywords, source) => (returnMeta ? { keywords, source } : keywords);

  const persistKeywords = async (keywords) => {
    if (!placeId || !Array.isArray(keywords)) {
      return;
    }
    try {
      await db
        .collection('places')
        .doc(placeId)
        .set(
          {
            name: place?.name || null,
            keywords,
            primaryType: place?.primaryType || null,
            types: Array.isArray(place?.types) ? place.types : [],
            rating: place?.rating ?? null,
            updatedAt: Date.now(),
          },
          { merge: true }
        );
    } catch (error) {
      console.warn('[recommendation][gemini-keywords-cache-failed]', {
        placeId,
        message: error?.message || String(error),
      });
    }
  };

  if (!GEMINI_API_KEY) {
    await persistKeywords(typeFallbackKeywords);
    return buildReturnValue(typeFallbackKeywords, 'type-fallback');
  }

  const prompt = `You are a Korean cafe and restaurant keyword tagger
for a personalized place recommendation app.

Analyze this specific place and assign DISTINCTIVE keywords
that describe what makes THIS place unique.

Place name: "${String(place?.name || '')}"
Types: "${normalizedTypes.join(', ')}"
Rating: ${String(place?.rating ?? '')} out of 5
Address: "${String(place?.formattedAddress || place?.address || '')}"

ASSIGNMENT GUIDELINES - think about each carefully:
- Specialty coffee focus + good rating -> 조용, 작업하기좋은
- Large space, many seats -> 좌석많은
- Trendy interior, aesthetic photos -> 인테리어좋은, 감성
- Natural lighting, windows -> 채광좋은
- Romantic atmosphere -> 데이트, 감성
- Good for groups/meetings -> 모임적합, 대화하기좋은
- Quiet residential area -> 조용, 편안
- Busy commercial area -> 시끄러운, 혼잡한
- Rooftop terrace -> 루프탑
- Cozy and comfortable -> 편안
- Bakery or dessert focus -> 감성, 편안
- Gallery or art space -> 감성, 인테리어좋은

Restaurant type guidelines:
- BBQ (barbecue_restaurant) -> 대화하기좋은, 모임적합, 좌석많은
- Seafood (seafood_restaurant) -> 대화하기좋은, 모임적합
- Fine dining -> 인테리어좋은, 데이트, 감성
- Casual Korean (korean_restaurant) -> 편안, 대화하기좋은
- Trendy popular -> 인테리어좋은, 감성, 혼잡한
- Quiet local -> 조용, 편안
- Large group space -> 좌석많은, 모임적합

MASTER KEYWORD LIST - ONLY use these exact strings:
["조용", "감성", "편안", "작업하기좋은", "대화하기좋은",
 "좌석많은", "채광좋은", "인테리어좋은", "데이트", "모임적합",
 "시끄러운", "혼잡한", "주차편리", "반려동물가능", "루프탑"]

STRICT RULES:
- Return ONLY keywords from the master list
- Do NOT include brand names or location names
- Return 3 to 6 keywords
- Make keywords SPECIFIC to this place type and characteristics
- Do NOT assign "감성" and "편안" to every single cafe
  -> only assign them if genuinely fitting for THIS place
- Even for restaurants, always consider:
  - Loud vs quiet atmosphere -> 시끄러운 or 조용
  - Romantic vs casual -> 데이트 or 편안
  - Good lighting -> 채광좋은
  - Instagram worthy -> 감성, 인테리어좋은
- Do NOT assign identical keywords to every restaurant.
  Differentiate based on place name, rating, and type.

Return ONLY a JSON array. No explanation. No markdown. No backticks.
Example: ["조용", "작업하기좋은", "채광좋은"]`;

  try {
    const response = await fetchFn(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        GEMINI_MODEL
      )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            topP: 0.9,
          },
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gemini 호출 실패: ${response.status} ${response.statusText} ${text}`);
    }

    const data = await response.json();
    const rawText = (data?.candidates || [])
      .flatMap((candidate) => candidate?.content?.parts || [])
      .map((part) => part?.text)
      .filter(Boolean)
      .join('\n');

    const parsedKeywords = parseGeminiKeywordResponse(rawText)
      .map((keyword) => normalizeKeyword(keyword))
      .filter((keyword) => MASTER_KEYWORD_SET.has(keyword));
    const geminiKeywords = [...new Set(parsedKeywords)].slice(0, 6);

    if (geminiKeywords.length > 0) {
      await persistKeywords(geminiKeywords);
      return buildReturnValue(geminiKeywords, 'gemini');
    }

    await persistKeywords(typeFallbackKeywords);
    return buildReturnValue(typeFallbackKeywords, 'type-fallback');
  } catch (error) {
    console.warn('[recommendation][gemini-keywords-failed]', {
      placeId,
      name: place?.name || null,
      message: error?.message || String(error),
    });

    await persistKeywords(typeFallbackKeywords);
    return buildReturnValue(typeFallbackKeywords, 'type-fallback');
  }
}

async function fetchPlaceKeywords({ uid, places = [], wantedDocs = [] }) {
  const db = getFirestore();
  const targetPlaces = Array.isArray(places) ? places : [];
  const targetPlaceIdSet = new Set(
    targetPlaces
      .map((place) => place?.placeId || place?.id)
      .filter((placeId) => typeof placeId === 'string' && placeId.length > 0)
  );
  const keywordMap = {};
  const sourceMap = {};
  let resolvedWantedDocs = Array.isArray(wantedDocs) ? wantedDocs : [];

  try {
    if (resolvedWantedDocs.length === 0) {
      const wantedSnapshot = await db.collection('users').doc(uid).collection(WANTED_COLLECTION).get();
      resolvedWantedDocs = wantedSnapshot.docs || [];
    }

    resolvedWantedDocs.forEach((wantedDoc) => {
      const data = typeof wantedDoc?.data === 'function' ? wantedDoc.data() : wantedDoc;
      const wantedPlaceId = data?.placeId || wantedDoc?.id;
      if (!wantedPlaceId) {
        return;
      }

      const keywords = extractKeywordsFromWantedData(data);
      keywordMap[wantedPlaceId] = keywords;
      if (targetPlaceIdSet.has(wantedPlaceId) && keywords.length > 0) {
        sourceMap[wantedPlaceId] = 'wanted';
      }
    });
  } catch (error) {
    console.warn('[recommendation][keyword-map-wanted-read-failed]', {
      uid,
      message: error?.message || String(error),
    });
  }

  const placesMissingKeywords = targetPlaces.filter((place) => {
    const placeId = place?.placeId || place?.id;
    if (!placeId) {
      return false;
    }
    return !Array.isArray(keywordMap[placeId]) || keywordMap[placeId].length === 0;
  });

  try {
    const placeDocResults = await Promise.all(
      placesMissingKeywords.map(async (place) => {
        const placeId = place?.placeId || place?.id;
        if (!placeId) {
          return { placeId: null, keywords: [] };
        }

        try {
          const placeDoc = await db.collection('places').doc(placeId).get();
          if (!placeDoc.exists) {
            return { placeId, keywords: [] };
          }
          const data = placeDoc.data() || {};
          const keywords = extractPlaceKeywords(data);
          return { placeId, keywords };
        } catch (innerError) {
          console.warn('[recommendation][keyword-map-place-read-failed]', {
            placeId,
            message: innerError?.message || String(innerError),
          });
          return { placeId, keywords: [] };
        }
      })
    );

    placeDocResults.forEach(({ placeId, keywords }) => {
      if (!placeId) {
        return;
      }
      const finalKeywords = Array.isArray(keywords) ? keywords : [];
      keywordMap[placeId] = finalKeywords;
      if (finalKeywords.length > 0) {
        sourceMap[placeId] = 'places';
      }

      const matchedPlace = targetPlaces.find((place) => (place?.placeId || place?.id) === placeId);
      if (finalKeywords.length > 0) {
        console.log('[keyword-map][from-places]', {
          name: matchedPlace?.name || null,
          keywords: finalKeywords,
          keywordCount: finalKeywords.length,
        });
      }
    });
  } catch (error) {
    console.warn('[recommendation][keyword-map-places-read-failed]', {
      message: error?.message || String(error),
    });
  }

  const stillMissing = placesMissingKeywords.filter((place) => {
    const placeId = place?.placeId || place?.id;
    if (!placeId) {
      return false;
    }
    return !Array.isArray(keywordMap[placeId]) || keywordMap[placeId].length === 0;
  });
  const geminiTargets = stillMissing.slice(0, GEMINI_MAX_PLACES_PER_REQUEST);

  try {
    await Promise.all(
      geminiTargets.map(async (place) => {
        const placeId = place?.placeId || place?.id || null;
        const fallbackKeywords = mapTypesToKeywords(place?.types || []);

        if (!placeId) {
          return;
        }

        try {
          const generatedResult = await generateKeywordsWithGemini(place, { returnMeta: true });
          const finalKeywords = Array.isArray(generatedResult?.keywords) ? generatedResult.keywords : [];
          const source = generatedResult?.source === 'gemini' ? 'gemini' : 'type-fallback';

          keywordMap[placeId] = finalKeywords;
          sourceMap[placeId] = source;

          console.log('[keyword-map][generated]', {
            name: place?.name || null,
            keywords: finalKeywords,
            source,
          });
        } catch (innerError) {
          keywordMap[placeId] = fallbackKeywords;
          sourceMap[placeId] = 'type-fallback';

          console.log('[keyword-map][generated]', {
            name: place?.name || null,
            keywords: fallbackKeywords,
            source: 'type-fallback',
          });
        }
      })
    );
  } catch (error) {
    console.warn('[recommendation][keyword-map-gemini-failed]', {
      message: error?.message || String(error),
    });
  }

  const placesWithKeywords = targetPlaces.map((place) => {
    const placeId = place?.placeId || place?.id;
    const keywords = placeId && Array.isArray(keywordMap[placeId]) ? keywordMap[placeId] : [];
    return {
      ...place,
      keywords,
    };
  });

  const placesWithKeywordCount = placesWithKeywords.filter(
    (place) => Array.isArray(place.keywords) && place.keywords.length > 0
  ).length;

  console.log('[recommendation][keyword-map-debug]', {
    totalPlaces: placesWithKeywords.length,
    placesWithKeywords: placesWithKeywordCount,
    placesWithoutKeywords: placesWithKeywords.length - placesWithKeywordCount,
    sample: placesWithKeywords.slice(0, 3).map((place) => ({
      name: place?.name || null,
      keywordCount: Array.isArray(place?.keywords) ? place.keywords.length : 0,
    })),
  });

  const fromWanted = targetPlaces.filter((place) => sourceMap[place?.placeId || place?.id] === 'wanted').length;
  const fromPlaces = targetPlaces.filter((place) => sourceMap[place?.placeId || place?.id] === 'places').length;
  const fromGemini = targetPlaces.filter((place) => sourceMap[place?.placeId || place?.id] === 'gemini').length;
  const fromFallback = targetPlaces.filter(
    (place) => sourceMap[place?.placeId || place?.id] === 'type-fallback'
  ).length;
  const stillEmpty = placesWithKeywords.filter(
    (place) => !Array.isArray(place.keywords) || place.keywords.length === 0
  ).length;

  console.log('[keyword-map][final-summary]', {
    totalPlaces: placesWithKeywords.length,
    fromWanted,
    fromPlaces,
    fromGemini,
    fromFallback,
    stillEmpty,
  });

  return placesWithKeywords;
}

function buildMasterKeywordList(tfidfProfile = {}, places = []) {
  const set = new Set(MASTER_KEYWORDS.map((keyword) => normalizeKeyword(keyword)).filter(Boolean));

  Object.keys(tfidfProfile || {}).forEach((keyword) => {
    const normalized = normalizeKeyword(keyword);
    if (normalized) {
      set.add(normalized);
    }
  });

  (Array.isArray(places) ? places : []).forEach((place) => {
    extractPlaceKeywords(place).forEach((keyword) => {
      set.add(keyword);
    });
  });

  return [...set];
}

function normalizeKeywordProfileOverride(keywordProfile) {
  if (!keywordProfile) {
    return {};
  }
  if (keywordProfile instanceof Map) {
    return [...keywordProfile.entries()].reduce((acc, [keyword, freq]) => {
      const normalized = normalizeKeyword(keyword);
      const weight = Number(freq);
      if (!normalized || !Number.isFinite(weight) || weight <= 0) {
        return acc;
      }
      acc[normalized] = weight;
      return acc;
    }, {});
  }
  if (typeof keywordProfile === 'object') {
    return Object.entries(keywordProfile).reduce((acc, [keyword, freq]) => {
      const normalized = normalizeKeyword(keyword);
      const weight = Number(freq);
      if (!normalized || !Number.isFinite(weight) || weight <= 0) {
        return acc;
      }
      acc[normalized] = weight;
      return acc;
    }, {});
  }
  return {};
}

function buildTfidfKeywordProfileFromProfile(keywordProfile, totalFrequency, allCandidatePlaces = []) {
  const normalizedProfile = normalizeKeywordProfileOverride(keywordProfile);
  const termCounts = Object.entries(normalizedProfile).reduce((acc, [keyword, freq]) => {
    acc[keyword] = Number(freq) || 0;
    return acc;
  }, {});

  const hasOverrideTotal = Number.isFinite(Number(totalFrequency)) && Number(totalFrequency) > 0;
  let totalTerms = hasOverrideTotal ? Number(totalFrequency) : 0;
  if (!hasOverrideTotal) {
    totalTerms = Object.values(termCounts).reduce((sum, value) => sum + Number(value || 0), 0);
  }

  if (totalTerms <= 0 || Object.keys(termCounts).length === 0) {
    return {};
  }

  const candidatePlaces = Array.isArray(allCandidatePlaces) ? allCandidatePlaces : [];
  const totalPlaces = Math.max(1, candidatePlaces.length);
  const placesContainingKeyword = {};

  candidatePlaces.forEach((place) => {
    const keywordSet = new Set(extractPlaceKeywords(place));
    keywordSet.forEach((keyword) => {
      placesContainingKeyword[keyword] = (placesContainingKeyword[keyword] || 0) + 1;
    });
  });

  return Object.entries(termCounts).reduce((acc, [keyword, freq]) => {
    const keywordWeight = Number(freq) || 0;
    const containingCount = Number(placesContainingKeyword[keyword] || 0);
    const idfScore = Math.log(totalPlaces / (1 + containingCount));
    const normalizedIdfScore = Math.max(0, Math.min(1, idfScore));
    const userFreqWeight = Math.max(0, Math.min(1, keywordWeight / totalTerms));
    const hybridWeight = Math.max(0, Math.min(1, normalizedIdfScore * 0.5 + userFreqWeight * 0.5));
    const finalWeight = Math.max(hybridWeight, TFIDF_MIN_WEIGHT);

    console.log('[recommendation][tfidf-hybrid]', {
      keyword,
      idfScore: Number(idfScore.toFixed(3)),
      userFreqWeight: Number(userFreqWeight.toFixed(3)),
      hybridWeight: Number(hybridWeight.toFixed(3)),
      finalWeight: Number(finalWeight.toFixed(3)),
    });

    acc[keyword] = Number(finalWeight.toFixed(6));
    return acc;
  }, {});
}

function buildTfidfKeywordProfile(wantedDocs = [], allCandidatePlaces = []) {
  if (!Array.isArray(wantedDocs) || wantedDocs.length === 0) {
    return {};
  }

  const termCounts = {};
  let totalTerms = 0;

  wantedDocs.forEach((wantedDoc) => {
    const data = typeof wantedDoc?.data === 'function' ? wantedDoc.data() : wantedDoc;
    const keywords = extractKeywordsFromWantedData(data);

    keywords.forEach((keyword) => {
      termCounts[keyword] = (termCounts[keyword] || 0) + 1;
      totalTerms += 1;
    });
  });

  if (totalTerms === 0) {
    return {};
  }

  const candidatePlaces = Array.isArray(allCandidatePlaces) ? allCandidatePlaces : [];
  const totalPlaces = Math.max(1, candidatePlaces.length);
  const placesContainingKeyword = {};

  candidatePlaces.forEach((place) => {
    const keywordSet = new Set(extractPlaceKeywords(place));
    keywordSet.forEach((keyword) => {
      placesContainingKeyword[keyword] = (placesContainingKeyword[keyword] || 0) + 1;
    });
  });

  return Object.entries(termCounts).reduce((acc, [keyword, freq]) => {
    const keywordWeight = Number(freq) || 0;
    const totalFrequency = totalTerms;
    const containingCount = Number(placesContainingKeyword[keyword] || 0);
    const idfScore = Math.log(totalPlaces / (1 + containingCount));
    const normalizedIdfScore = Math.max(0, Math.min(1, idfScore));
    const userFreqWeight = Math.max(0, Math.min(1, keywordWeight / totalFrequency));
    const hybridWeight = Math.max(0, Math.min(1, normalizedIdfScore * 0.5 + userFreqWeight * 0.5));
    const finalWeight = Math.max(hybridWeight, TFIDF_MIN_WEIGHT);

    console.log('[recommendation][tfidf-hybrid]', {
      keyword,
      idfScore: Number(idfScore.toFixed(3)),
      userFreqWeight: Number(userFreqWeight.toFixed(3)),
      hybridWeight: Number(hybridWeight.toFixed(3)),
      finalWeight: Number(finalWeight.toFixed(3)),
    });

    acc[keyword] = Number(finalWeight.toFixed(6));
    return acc;
  }, {});
}

function computeCosineSimilarity(place, tfidfProfile, masterKeywordList) {
  if (!place || !tfidfProfile || !Array.isArray(masterKeywordList) || masterKeywordList.length === 0) {
    return 0;
  }

  const placeKeywordSet = new Set(extractPlaceKeywords(place));
  if (placeKeywordSet.size === 0) {
    return 0;
  }

  let dotProduct = 0;
  let userMagnitudeSq = 0;
  let placeMagnitudeSq = 0;

  masterKeywordList.forEach((keyword) => {
    const userWeight = Number(tfidfProfile[keyword] || 0);
    const placeValue = placeKeywordSet.has(keyword) ? 1 : 0;

    dotProduct += userWeight * placeValue;
    userMagnitudeSq += userWeight * userWeight;
    placeMagnitudeSq += placeValue * placeValue;
  });

  if (userMagnitudeSq <= 0 || placeMagnitudeSq <= 0) {
    return 0;
  }

  const cosineSimilarity = dotProduct / (Math.sqrt(userMagnitudeSq) * Math.sqrt(placeMagnitudeSq));
  if (!Number.isFinite(cosineSimilarity)) {
    return 0;
  }

  return Math.max(0, Math.min(1, cosineSimilarity));
}

function computeCalendarContextScore(place, calendarContext) {
  if (!calendarContext || typeof calendarContext !== 'object') {
    return {
      calendarContextScore: 0,
      suggestedMatches: [],
      avoidMatches: [],
    };
  }

  const placeKeywordSet = new Set(extractPlaceKeywords(place));
  const suggestedKeywords = Array.isArray(calendarContext.suggestedKeywords)
    ? calendarContext.suggestedKeywords.map((keyword) => normalizeKeyword(keyword)).filter(Boolean)
    : [];
  const avoidKeywords = Array.isArray(calendarContext.avoidKeywords)
    ? calendarContext.avoidKeywords.map((keyword) => normalizeKeyword(keyword)).filter(Boolean)
    : [];

  const suggestedMatches = [...new Set(suggestedKeywords.filter((keyword) => placeKeywordSet.has(keyword)))];
  const avoidMatches = [...new Set(avoidKeywords.filter((keyword) => placeKeywordSet.has(keyword)))];

  const calendarBoost = Math.min(
    CALENDAR_SUGGESTED_MAX,
    suggestedMatches.length * CALENDAR_SUGGESTED_MATCH_WEIGHT
  );
  const avoidPenalty = avoidMatches.length * CALENDAR_AVOID_MATCH_PENALTY;
  const calendarContextScore = Number((calendarBoost - avoidPenalty).toFixed(3));

  return {
    calendarContextScore,
    suggestedMatches,
    avoidMatches,
  };
}

function computeKeywordBoostDetails(place, keywordProfile) {
  if (!place || !keywordProfile || typeof keywordProfile !== 'object') {
    return { keywordBoost: 0, matchedKeywords: [] };
  }

  const profileEntries = Object.entries(keywordProfile).filter(([, freq]) => Number(freq) > 0);
  if (profileEntries.length === 0) {
    return { keywordBoost: 0, matchedKeywords: [] };
  }

  const topTypeHintKeywords = new Set(
    [...profileEntries]
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, KEYWORD_TYPE_HINT_TOP_K)
      .map(([keyword]) => keyword)
  );

  const placeTypes = new Set(
    [place.primaryType, ...(Array.isArray(place.types) ? place.types : [])]
      .map((type) => normalizeKeyword(type))
      .filter(Boolean)
  );
  const searchableText = [
    place.name,
    place.address,
    Array.isArray(place.types) ? place.types.join(' ') : place.types,
    place.primaryType,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!searchableText) {
    return { keywordBoost: 0, matchedKeywords: [] };
  }

  const matchedKeywords = [];
  const pushContribution = (keyword, mode, contribution) => {
    if (contribution <= 0) {
      return;
    }
    matchedKeywords.push({
      keyword,
      mode,
      contribution,
    });
  };

  const rawBoost = profileEntries.reduce((sum, [keyword, weight]) => {
    let nextSum = sum;
    const numericWeight = Number(weight);
    if (!Number.isFinite(numericWeight) || numericWeight <= 0) {
      return nextSum;
    }

    const isBroadKeyword = BROAD_KEYWORDS.has(keyword);
    const broadFactor = isBroadKeyword ? 0.35 : 1;
    const hasTextMatch = !isBroadKeyword && searchableText.includes(keyword);

    if (hasTextMatch) {
      const contribution = numericWeight * KEYWORD_TEXT_MATCH_WEIGHT * broadFactor;
      nextSum += contribution;
      pushContribution(keyword, 'text', contribution);
    }

    const canApplyTypeHint = topTypeHintKeywords.has(keyword);
    const hintedTypes = canApplyTypeHint ? KEYWORD_TYPE_HINTS[keyword] || [] : [];
    if (hintedTypes.some((type) => placeTypes.has(normalizeKeyword(type)))) {
      const contribution = numericWeight * KEYWORD_TYPE_HINT_MATCH_WEIGHT * broadFactor;
      nextSum += contribution;
      pushContribution(keyword, 'typeHint', contribution);
    }

    return nextSum;
  }, 0);

  if (rawBoost <= 0) {
    return { keywordBoost: 0, matchedKeywords: [] };
  }

  const boost = Math.min(KEYWORD_BOOST_MAX, rawBoost);
  const scale = rawBoost > KEYWORD_BOOST_MAX ? KEYWORD_BOOST_MAX / rawBoost : 1;
  const scaledMatchedKeywords = matchedKeywords.map((match) => ({
    keyword: match.keyword,
    mode: match.mode,
    contribution: Number((match.contribution * scale).toFixed(3)),
  }));

  return {
    rawKeywordBoost: Number(rawBoost.toFixed(3)),
    cappedKeywordBoost: Number(boost.toFixed(3)),
    topMatchedKeywordsCount: scaledMatchedKeywords.length,
    keywordBoost: Number(boost.toFixed(3)),
    matchedKeywords: scaledMatchedKeywords,
  };
}

function computeKeywordBoost(place, keywordProfile) {
  return computeKeywordBoostDetails(place, keywordProfile).keywordBoost;
}

async function loadTimePreferenceProfile(uid) {
  if (!uid) {
    console.log('[recommendation][time-profile-load]', {
      uid,
      docsLoaded: 0,
      keysLoaded: [],
      sampleCategories: {},
    });
    return {};
  }

  const db = getFirestore();
  const snapshot = await db.collection('users').doc(uid).collection(TIME_PREFERENCE_COLLECTION).get();
  const profile = snapshot.docs.reduce((acc, doc) => {
    const data = doc.data() || {};
    const bucket = data.bucket;
    const durationBucket = data.durationBucket;
    if (!bucket || !durationBucket) {
      return acc;
    }
    const key = buildTimePreferenceDocId(bucket, durationBucket);
    acc[key] = {
      bucket,
      durationBucket,
      categories: data.categories || {},
    };
    return acc;
  }, {});

  const keysLoaded = Object.keys(profile);
  console.log('[recommendation][time-profile-load]', {
    uid,
    docsLoaded: snapshot.size,
    keysLoaded,
    sampleCategories: keysLoaded.length > 0 ? profile[keysLoaded[0]].categories || {} : {},
  });

  return profile;
}

function computeTimePreferenceBoost(place, timeProfile, slotStart, slotEnd, options = {}) {
  const { debug = false } = options;
  const placeName = place?.name || null;
  const bucket = getTimeBucket(slotStart);
  const durationBucket = getDurationBucket(slotStart, slotEnd);
  const category = resolvePlaceCategory(place);

  if (!place || !timeProfile || typeof timeProfile !== 'object') {
    if (debug) {
      console.log('[recommendation][time-preference-boost-debug]', {
        name: placeName,
        resolvedCategory: category,
        bucket,
        durationBucket,
        matchedCount: 0,
        timePreferenceBoost: 0,
        reason: 'invalid-time-profile',
      });
    }
    return 0;
  }

  const profile = timeProfile[buildTimePreferenceDocId(bucket, durationBucket)];
  if (!profile || typeof profile.categories !== 'object') {
    if (debug) {
      console.log('[recommendation][time-preference-boost-debug]', {
        name: placeName,
        resolvedCategory: category,
        bucket,
        durationBucket,
        matchedCount: 0,
        timePreferenceBoost: 0,
        reason: 'no-profile-for-bucket',
      });
    }
    return 0;
  }

  if (!category) {
    if (debug) {
      console.log('[recommendation][time-preference-boost-debug]', {
        name: placeName,
        resolvedCategory: null,
        bucket,
        durationBucket,
        matchedCount: 0,
        timePreferenceBoost: 0,
        reason: 'no-category',
      });
    }
    return 0;
  }

  const count = Number(profile.categories[category] || 0);
  if (!Number.isFinite(count) || count <= 0) {
    if (debug) {
      console.log('[recommendation][time-preference-boost-debug]', {
        name: placeName,
        resolvedCategory: category,
        bucket,
        durationBucket,
        matchedCount: 0,
        timePreferenceBoost: 0,
        reason: 'category-not-found-or-zero',
      });
    }
    return 0;
  }

  const timePreferenceBoost = Number(
    Math.min(TIME_PREFERENCE_BOOST_MAX, count * TIME_PREFERENCE_COUNT_WEIGHT).toFixed(3)
  );

  if (debug) {
    console.log('[recommendation][time-preference-boost-debug]', {
      name: placeName,
      resolvedCategory: category,
      bucket,
      durationBucket,
      matchedCount: count,
      timePreferenceBoost,
    });
  }

  return timePreferenceBoost;
}

async function saveTimePreferenceFromSelection({ uid, slotStart, slotEnd, selectedPlace }) {
  if (!uid || !slotStart || !slotEnd || !selectedPlace) {
    return null;
  }

  const category = resolvePlaceCategory(selectedPlace);
  if (!category) {
    return null;
  }

  const bucket = getTimeBucket(slotStart);
  const durationBucket = getDurationBucket(slotStart, slotEnd);
  const docId = buildTimePreferenceDocId(bucket, durationBucket);
  const targetPath = `users/${uid}/${TIME_PREFERENCE_COLLECTION}/${docId}`;

  console.log('[recommendation][time-preference-save]', {
    uid,
    slotStart,
    slotEnd,
    bucket,
    durationBucket,
    selectedPlaceName: selectedPlace?.name || null,
    selectedPlacePrimaryType: selectedPlace?.primaryType || selectedPlace?.type || selectedPlace?.placePrimaryType || null,
    selectedPlaceTypes: Array.isArray(selectedPlace?.types)
      ? selectedPlace.types
      : Array.isArray(selectedPlace?.placeTypes)
      ? selectedPlace.placeTypes
      : [],
    resolvedCategory: category,
  });

  const db = getFirestore();
  const docRef = db.collection('users').doc(uid).collection(TIME_PREFERENCE_COLLECTION).doc(docId);
  const increment = admin.firestore.FieldValue.increment(1);
  const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();

  await docRef.set(
    {
      bucket,
      durationBucket,
      categories: {
        [category]: increment,
      },
      updatedAt: serverTimestamp,
    },
    { merge: true }
  );

  console.log('[recommendation][time-preference-save-write]', {
    targetPath,
    incrementedCategory: category,
  });

  const writtenDoc = await docRef.get();
  const writtenData = writtenDoc.exists ? writtenDoc.data() || {} : {};
  console.log('[recommendation][time-preference-save-verify]', {
    targetPath,
    exists: writtenDoc.exists,
    categories: writtenData.categories || {},
  });

  return { bucket, durationBucket, category, targetPath };
}

const mapPlaces = (places = []) => {
  return places.map((place) => {
    const firstPhoto = Array.isArray(place.photos) && place.photos.length > 0 ? place.photos[0] : null;
    const photoName =
      place.photoName ||
      place.photoReference ||
      firstPhoto?.name ||
      firstPhoto?.photoName ||
      firstPhoto?.reference ||
      null;

    let photoUrl = place.photoUrl || null;
    if (!photoUrl && photoName) {
      try {
        photoUrl = searchPlacesService.getPhotoUrl({ name: photoName }).url;
      } catch (error) {
        photoUrl = null;
      }
    }

    const openingHours = place.openingHours ?? null;
    const openNow = place.openingHours?.openNow ?? place.openingHours?.open_now ?? null;
    const weekdayDescriptions =
      place.openingHours?.weekdayDescriptions ??
      place.openingHours?.weekdayDescriptionsList ??
      place.regularOpeningHours?.weekdayDescriptions ??
      null;
    const primaryType = place.primaryType ?? null;
    const types = Array.isArray(place.types) ? place.types : [];

    return {
      id: place.placeId || place.id || null,
      placeId: place.placeId || place.id || null,
      name: place.name,
      address: place.address || place.formattedAddress || null,
      formattedAddress: place.formattedAddress || null,
      primaryType,
      rating: place.rating,
      openingHours,
      openNow,
      weekdayDescriptions,
      priceLevel: place.priceLevel,
      priceBand: place.priceBand,
      priceLevelRaw: place.priceLevelRaw,
      location: place.location,
      travelTimeSec: null,
      distanceM: null,
      types,
      photoName,
      photoUrl,
      photos: place.photos ?? null,
    };
  });
};

const parseRoutesMatrixRows = (rawText) => {
  const cleaned = String(rawText || '').replace(/^\)\]\}'\n?/, '').trim();
  if (!cleaned) {
    return [];
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (Array.isArray(parsed.matrixEntries)) {
      return parsed.matrixEntries;
    }
    if (parsed && typeof parsed === 'object' && (parsed.destinationIndex !== undefined || parsed.condition)) {
      return [parsed];
    }
  } catch (error) {
    // Fallback to NDJSON parse below.
  }

  const rows = [];
  const lines = cleaned.split('\n').map((line) => line.trim()).filter(Boolean);
  lines.forEach((line) => {
    const normalized = line.endsWith(',') ? line.slice(0, -1) : line;
    if (!normalized.startsWith('{') || !normalized.endsWith('}')) {
      return;
    }
    try {
      rows.push(JSON.parse(normalized));
    } catch (error) {
      // Ignore malformed line and continue parsing other rows.
    }
  });

  if (rows.length > 0) {
    return rows;
  }

  const parseError = new Error(`Routes Matrix 응답 파싱 실패: ${cleaned.slice(0, 300)}`);
  parseError.status = 502;
  throw parseError;
};

const attachDistanceMatrix = async ({ places, originLatLng, transport }) => {
  if (!Array.isArray(places) || places.length === 0) {
    return [];
  }

  const candidates = places.filter((place) => {
    const lat = Number(place.location?.latitude);
    const lng = Number(place.location?.longitude);
    return !Number.isNaN(lat) && !Number.isNaN(lng);
  });

  if (candidates.length === 0) {
    return [];
  }

  ensureMapsApiKey();

  const buildPayload = (travelMode) => ({
    origins: [
      {
        waypoint: {
          location: {
            latLng: {
              latitude: Number(originLatLng.lat),
              longitude: Number(originLatLng.lng),
            },
          },
        },
      },
    ],
    destinations: candidates.map((place) => ({
      waypoint: {
        location: {
          latLng: {
            latitude: Number(place.location.latitude),
            longitude: Number(place.location.longitude),
          },
        },
      },
    })),
    travelMode,
  });

  const requestRows = async (travelMode) => {
    const response = await fetchFn(ROUTES_MATRIX_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,condition,distanceMeters,duration,status',
      },
      body: JSON.stringify(buildPayload(travelMode)),
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`Routes Matrix 호출 실패: ${response.status} ${response.statusText}`);
      error.details = text;
      error.status = response.status;
      throw error;
    }

    const rawText = await response.text();
    return parseRoutesMatrixRows(rawText);
  };

  const requestedMode = toRoutesTravelMode(transport);
  let rows = await requestRows(requestedMode);

  const conditionCounts = rows.reduce((acc, row) => {
    const key = row.condition || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const statusCounts = rows.reduce((acc, row) => {
    const key = row.status?.code !== undefined ? String(row.status.code) : 'NONE';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  console.log('[routes-matrix] rowCount:', rows.length);
  console.log('[routes-matrix] conditions:', conditionCounts);
  console.log('[routes-matrix] statusCodes:', statusCounts);

  const hasRouteExists = rows.some((row) => row.condition === 'ROUTE_EXISTS');
  if (requestedMode === 'WALK' && !hasRouteExists) {
    console.log('[routes-matrix] WALK produced no routes, retrying with DRIVE fallback');
    rows = await requestRows('DRIVE');
    const fallbackConditionCounts = rows.reduce((acc, row) => {
      const key = row.condition || 'UNKNOWN';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    console.log('[routes-matrix][fallback DRIVE] rowCount:', rows.length);
    console.log('[routes-matrix][fallback DRIVE] conditions:', fallbackConditionCounts);
  }

  const routed = rows.reduce((acc, row) => {
    if (row.condition !== 'ROUTE_EXISTS') {
      return acc;
    }

    const destinationIndex = Number(row.destinationIndex);
    if (Number.isNaN(destinationIndex) || destinationIndex < 0 || destinationIndex >= candidates.length) {
      return acc;
    }

    const place = candidates[destinationIndex];
    const distanceM = Number(row.distanceMeters);
    const travelTimeSec = Number(String(row.duration || '0s').replace('s', ''));
    if (Number.isNaN(distanceM) || Number.isNaN(travelTimeSec)) {
      return acc;
    }

    acc.push({
      ...place,
      travelTimeSec,
      distanceM,
    });
    return acc;
  }, []);

  if (routed.length > 0) {
    return routed;
  }

  console.log('[routes-matrix] no route rows available, using haversine fallback estimation');
  return candidates.map((place) => {
    const distanceM = haversineDistance(
      Number(originLatLng.lat),
      Number(originLatLng.lng),
      Number(place.location.latitude),
      Number(place.location.longitude)
    );
    return {
      ...place,
      distanceM,
      travelTimeSec: estimateTravelTimeSec(distanceM, transport),
    };
  });
};

const isOpenDuringSlot = (place, slotDay, slotHour) => {
  const periods = place?.openingHours?.periods;
  if (!Array.isArray(periods) || periods.length === 0) {
    return null;
  }

  return periods.some((period) => {
    const openDay = period?.open?.day;
    if (openDay === undefined || openDay === null) return false;

    const closeDay = period?.close?.day ?? openDay;
    const openHour = period.open?.hour ?? 0;
    const closeHour =
      closeDay !== openDay
        ? (period.close?.hour ?? 0) + 24
        : (period.close?.hour ?? 23);

    let effectiveSlotHour = slotHour;
    if (slotDay !== openDay) {
      if (closeDay !== openDay && slotDay === closeDay) {
        effectiveSlotHour = slotHour + 24;
      } else {
        return false;
      }
    }

    return effectiveSlotHour >= openHour && effectiveSlotHour < closeHour;
  });
};

const filterPlaces = (places, slotDurationSec) => {
  return places.filter((place) => {
    if (typeof place.travelTimeSec !== 'number') {
      return false;
    }
    if (place.travelTimeSec > slotDurationSec) {
      return false;
    }
    return true;
  });
};

function buildReasonTags(place) {
  const travelTimeSec = Number(place?.travelTimeSec);
  const rating = Number(place?.rating);
  const cosineSimilarity = Number(place?.cosineSimilarity || 0);
  const keywordScore = Number(place?.keywordScore || 0);
  const calendarContextScore = Number(place?.calendarContextScore || 0);
  const timePreferenceBoost = Number(place?.timePreferenceBoost || 0);
  const eligibleTags = [];

  if (cosineSimilarity >= 0.5) {
    eligibleTags.push('취향 저격');
  } else if (cosineSimilarity > 0 || keywordScore > 0) {
    eligibleTags.push('취향 키워드 반영');
  }

  if (calendarContextScore > 0) {
    eligibleTags.push('일정 맥락 반영');
  }

  if (timePreferenceBoost > 0) {
    eligibleTags.push('이 시간대 자주 방문');
  }

  if (Number.isFinite(travelTimeSec) && travelTimeSec <= 600) {
    eligibleTags.push('도보 10분 이내');
  } else if (Number.isFinite(travelTimeSec) && travelTimeSec <= 1200) {
    eligibleTags.push('가까운 이동거리');
  }

  if (Number.isFinite(rating) && rating >= 4.3) {
    eligibleTags.push('평점이 높음');
  }

  if (place?.openNow === true) {
    eligibleTags.push('이 시간대 영업 중');
  }

  const finalTags = eligibleTags.slice(0, 3);
  console.log('[recommendation][reason-tag-debug]', {
    name: place?.name || null,
    cosineSimilarity,
    keywordScore,
    calendarContextScore,
    timePreferenceBoost,
    eligibleTags,
    finalTags,
  });

  return finalTags;
}

const rankPlaces = async (
  places,
  wantedDocs = [],
  timeProfile = {},
  slotStart,
  slotEnd,
  calendarContext = null,
  userContext = null,
  keywordProfileOverride = null,
  keywordProfileTotalFrequency = null
) => {
  const normalizedOverride = normalizeKeywordProfileOverride(keywordProfileOverride);
  const hasKeywordProfileOverride = Object.keys(normalizedOverride).length > 0;
  const tfidfProfile = hasKeywordProfileOverride
    ? buildTfidfKeywordProfileFromProfile(normalizedOverride, keywordProfileTotalFrequency, places)
    : buildTfidfKeywordProfile(wantedDocs, places);
  const masterKeywordList = buildMasterKeywordList(tfidfProfile, places);
  const tfidfTop5 = Object.entries(tfidfProfile)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 5)
    .map(([keyword, weight]) => ({ keyword, weight }));

  const ranked = places
    .map((place) => {
      const baseScore = Number(computeBaselineScore(place).toFixed(3));
      const cosineSimilarity = Number(
        computeCosineSimilarity(place, tfidfProfile, masterKeywordList).toFixed(3)
      );
      const keywordScore = Number((cosineSimilarity * COSINE_SCORE_WEIGHT).toFixed(3));
      const { calendarContextScore, suggestedMatches, avoidMatches } = computeCalendarContextScore(
        place,
        calendarContext
      );
      const timeBoost = computeTimePreferenceBoost(place, timeProfile, slotStart, slotEnd);
      const finalScore = Number((baseScore + keywordScore + calendarContextScore + timeBoost).toFixed(3));

      return {
        ...place,
        score: finalScore,
        cosineSimilarity,
        keywordScore,
        calendarContextScore,
        timePreferenceBoost: timeBoost,
        _keywordDebug: {
          baseScore,
          cosineSimilarity,
          keywordScore,
          calendarContextScore,
          suggestedMatches,
          avoidMatches,
          tfidfTop5,
          timePreferenceBoost: timeBoost,
          finalScore,
        },
      };
    })
    .sort((a, b) => b.score - a.score);

  console.log('=== RANK DEBUG START ===');
  ranked.slice(0, 5).forEach((p, i) => {
    computeTimePreferenceBoost(p, timeProfile, slotStart, slotEnd, { debug: true });
    console.log(
      `${i + 1}. ${p.name} | ${p.distanceM}m | ${Math.round(p.travelTimeSec / 60)}min | rating:${p.rating} | score:${p._keywordDebug.finalScore}`
    );
    console.log('[recommendation][keyword-tfidf]', {
      name: p.name,
      tfidfProfile: p._keywordDebug.tfidfTop5,
    });
    console.log('[recommendation][keyword-cosine]', {
      name: p.name,
      cosineSimilarity: p._keywordDebug.cosineSimilarity,
      keywordScore: p._keywordDebug.keywordScore,
    });
    console.log('[recommendation][calendar-context]', {
      name: p.name,
      suggestedMatches: p._keywordDebug.suggestedMatches,
      avoidMatches: p._keywordDebug.avoidMatches,
      calendarContextScore: p._keywordDebug.calendarContextScore,
    });
    console.log('[recommendation][keyword-rank]', {
      name: p.name,
      baseScore: p._keywordDebug.baseScore,
      cosineSimilarity: p._keywordDebug.cosineSimilarity,
      keywordScore: p._keywordDebug.keywordScore,
      calendarContextScore: p._keywordDebug.calendarContextScore,
      finalScore: p._keywordDebug.finalScore,
    });
    console.log('[recommendation][time-rank]', {
      name: p.name,
      baseScore: p._keywordDebug.baseScore,
      keywordScore: p._keywordDebug.keywordScore,
      timePreferenceBoost: p._keywordDebug.timePreferenceBoost,
      finalScore: p._keywordDebug.finalScore,
    });
  });
  console.log(
    '[recommendation][keyword-final-check]',
    ranked.slice(0, 5).map((p) => ({
      name: p.name,
      baseScore: p._keywordDebug.baseScore,
      cosineSimilarity: p._keywordDebug.cosineSimilarity,
      keywordScore: p._keywordDebug.keywordScore,
      calendarContextScore: p._keywordDebug.calendarContextScore,
      timePreferenceBoost: p._keywordDebug.timePreferenceBoost,
      finalScore: p._keywordDebug.finalScore,
    }))
  );
  console.log(
    '[recommendation][type-check]',
    ranked.slice(0, 3).map((p) => ({
      name: p.name,
      primaryType: p.primaryType,
      types: p.types,
    }))
  );
  console.log('=== RANK DEBUG END ===');

  const rankedWithReasonTags = ranked.map((place) => ({
    ...place,
    reasonTags: buildReasonTags(place),
    reasonSentence: null,
  }));

  const userProfileKeywords = Object.keys(userContext?.keywordProfile || {});
  const userProfileKeywordSet = new Set(userProfileKeywords);
  rankedWithReasonTags.forEach((place) => {
    const placeKeywords = Array.isArray(place?.keywords) ? place.keywords : [];
    place.matchedKeywords = placeKeywords.filter((keyword) => userProfileKeywordSet.has(normalizeKeyword(keyword)));
  });

  console.log(
    '[reason-sentence][matched-debug]',
    rankedWithReasonTags.slice(0, 3).map((p) => ({
      name: p.name,
      placeKeywords: p.keywords,
      matchedKeywords: p.matchedKeywords,
      matchCount: Array.isArray(p.matchedKeywords) ? p.matchedKeywords.length : 0,
    }))
  );

  const rankedPlaces = rankedWithReasonTags;
  const placesToProcess = rankedPlaces.slice(0, Math.min(3, rankedPlaces.length));

  console.log('[reason-sentence][top3-debug]', {
    rankedLength: rankedPlaces.length,
    top3Length: placesToProcess.length,
    names: placesToProcess.map((p) => p.name),
    hasCalendarContext: !!calendarContext,
  });

  if (placesToProcess.length === 0) {
    console.log('[reason-sentence][skip]', {
      reason: 'no-ranked-places',
      rankedLength: rankedPlaces.length,
    });
    return rankedWithReasonTags.map(({ _keywordDebug, ...place }) => place);
  }

  console.log('[reason-sentence][starting]', {
    count: placesToProcess.length,
    names: placesToProcess.map((p) => p.name),
  });

  const reasonSentences = await Promise.all(
    placesToProcess.map((place) =>
      withTimeout(
        generateReasonSentence(place, {
          ...(userContext || {}),
          timePreferenceBoost: Number(place?.timePreferenceBoost || 0),
        }),
        REASON_SENTENCE_TIMEOUT_MS,
        `reason-sentence:${place?.name || 'unknown'}`
      ).catch((error) => {
        console.warn('[reason-sentence][error]', {
          name: place?.name || null,
          error: error?.message || String(error),
        });
        return getFallback(place, userContext || {});
      })
    )
  );

  placesToProcess.forEach((place, index) => {
    place.reasonSentence = reasonSentences[index] || getFallback(place, userContext || {});
  });

  console.log(
    '[recommendation][reason-tags-top3]',
    rankedWithReasonTags.slice(0, 3).map((p) => ({
      name: p.name,
      cosineSimilarity: p.cosineSimilarity,
      keywordScore: p.keywordScore,
      calendarContextScore: p.calendarContextScore,
      timePreferenceBoost: p.timePreferenceBoost,
      reasonTags: p.reasonTags,
    }))
  );

  return rankedWithReasonTags.map(({ _keywordDebug, ...place }) => place);
};

const runRecommendationPipeline = async ({
  uid,
  places,
  originLatLng,
  transport,
  slotStart,
  slotEnd,
  wantedDocs,
  timeProfile,
  calendarContext,
  keywordProfileOverride,
  keywordProfileTotalFrequency,
}) => {
  console.log('=== PIPELINE START ===');
  const slotDurationSec = (new Date(slotEnd) - new Date(slotStart)) / 1000;
  const mappedPlaces = mapPlaces(places);
  console.log('mapped:', mappedPlaces.length);
  if (mappedPlaces.length > 0) {
    const sample = mappedPlaces[0];
    console.log('[recommendation][opening-hours-sample]', {
      name: sample.name,
      openNow: sample.openNow,
      weekdayDescriptionsLength: Array.isArray(sample.weekdayDescriptions)
        ? sample.weekdayDescriptions.length
        : 0,
    });
  }

  const enriched = await attachDistanceMatrix({
    places: mappedPlaces,
    originLatLng,
    transport,
  });
  console.log('enriched:', enriched.length);

  const placesWithKeywords = await fetchPlaceKeywords({
    uid,
    places: enriched,
    wantedDocs,
  });

  const keywordProfile = buildUserKeywordProfile(wantedDocs);
  const normalizedOverride = normalizeKeywordProfileOverride(keywordProfileOverride);
  const hasKeywordProfileOverride = Object.keys(normalizedOverride).length > 0;
  const resolvedKeywordProfile = hasKeywordProfileOverride ? normalizedOverride : keywordProfile;
  const timeBucket = getTimeBucket(slotStart);
  const durationBucket = getDurationBucket(slotStart, slotEnd);
  const userContext = buildReasonSentenceUserContext({
    keywordProfile: resolvedKeywordProfile,
    calendarContext,
    timeBucket,
    durationBucket,
    slotStart,
    slotEnd,
  });

  const slotDate = new Date(slotStart);
  const KST_OFFSET = 9 * 60 * 60 * 1000;
  const slotKST = new Date(slotDate.getTime() + KST_OFFSET);
  const slotHour = slotKST.getUTCHours();
  const slotDay = slotKST.getUTCDay();
  console.log('[slot-time-debug]', {
    utcHour: slotDate.getUTCHours(),
    kstHour: slotHour,
    kstDay: slotDay,
  });
  const placesWithSlotOpenNow = placesWithKeywords.map((place) => ({
    ...place,
    openNow: isOpenDuringSlot(place, slotDay, slotHour),
  }));
  const openDuringSlot = placesWithSlotOpenNow.filter((place) => place.openNow !== false);
  console.log('[slot-open-filter]', {
    slotHour,
    slotDay,
    beforeFilter: placesWithSlotOpenNow.length,
    afterFilter: openDuringSlot.length,
  });

  const filtered = filterPlaces(openDuringSlot, slotDurationSec);
  console.log('filtered:', filtered.length);

  console.log('[recommendation][origin-consistency-check]', {
    searchNearbyLocation: originLatLng,
    enrichLocation: originLatLng,
  });

  return rankPlaces(
    filtered,
    wantedDocs,
    timeProfile,
    slotStart,
    slotEnd,
    calendarContext,
    userContext,
    normalizedOverride,
    keywordProfileTotalFrequency
  );
};

const fetchAndFilterPlaces = async ({ uid, latitude, longitude, startTime, endTime }) => {
  const startIso = asIso(startTime, 'startTime');
  const endIso = asIso(endTime, 'endTime');
  const originLatLng = validateLatLng({ lat: latitude, lng: longitude }, 'origin');

  const db = getFirestore();
  const userDoc = await db.collection('users').doc(uid).get();
  const userPreferences = userDoc.exists ? userDoc.data().preferences : ['cafe', 'book_store'];

  const nearby = await searchPlacesService.searchNearby({
    location: originLatLng,
    radius: 2500,
    includedTypes: userPreferences.slice(0, 5),
    maxResults: 15,
    language: 'ko',
  });

  const rankedPlaces = await runRecommendationPipeline({
    uid,
    places: nearby.results || [],
    originLatLng,
    transport: 'walk',
    slotStart: startIso,
    slotEnd: endIso,
    wantedDocs: [],
    calendarContext: null,
  });

  return rankedPlaces.slice(0, 5);
};

const fetchRecommendationsForSlot = async ({
  uid,
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
  testPersona,
}) => {
  const startIso = asIso(slotStart, 'slotStart');
  const endIso = asIso(slotEnd, 'slotEnd');
  if (startIso >= endIso) {
    const error = new Error('slotEnd는 slotStart보다 이후 시각이어야 합니다.');
    error.status = 400;
    throw error;
  }

  const normalizedCategories = normalizeCategoriesForPlaces(
    Array.isArray(categories) ? categories : selectedCategories
  );
  const normalizedTransport = normalizeTransport(transport || selectedTransports);
  const db = getFirestore();

  let wantedDocs = [];
  let keywordProfileOverride = null;
  let keywordProfileTotalFrequency = null;
  let timeProfile = {};
  try {
    const wantedPath = `users/${uid}/${WANTED_COLLECTION}`;
    const wantedSnapshot = await db.collection('users').doc(uid).collection(WANTED_COLLECTION).get();
    console.log('[recommendation][wanted-debug]', {
      uid,
      wantedPath,
      wantedCount: wantedSnapshot.size,
      sampleDocs: wantedSnapshot.docs.slice(0, 2).map((doc) => {
        const wanted = doc.data() || {};
        const keywordSignals = Array.isArray(wanted.keywordSignals) ? wanted.keywordSignals : [];
        const keywords = Array.isArray(wanted.keywords)
          ? wanted.keywords
          : typeof wanted.keywords === 'string'
          ? wanted.keywords.split(',')
          : [];
        return {
          docId: doc.id,
          name: wanted.name || null,
          hasKeywords: keywords.length > 0,
          hasKeywordSignals: keywordSignals.length > 0,
          keywordSignalsLength: keywordSignals.length,
          rawKeywordSignalsSample: keywordSignals.slice(0, 3),
        };
      }),
    });
    wantedDocs = wantedSnapshot.docs || [];
    const keywordProfile = buildUserKeywordProfile(wantedDocs);
    const sortedKeywords = Object.entries(keywordProfile).sort((a, b) => Number(b[1]) - Number(a[1]));
    console.log('[recommendation][keyword-profile]', {
      profileSize: Object.keys(keywordProfile).length,
      totalFrequency: Object.values(keywordProfile).reduce((sum, value) => sum + Number(value || 0), 0),
    });
    console.log('[recommendation][keyword-profile-debug]', {
      wantedCount: wantedSnapshot.size,
      profileSize: Object.keys(keywordProfile).length,
      totalFrequency: Object.values(keywordProfile).reduce((sum, value) => sum + Number(value || 0), 0),
      topKeywords: sortedKeywords.slice(0, 10).map(([keyword, weight]) => ({
        keyword,
        weight,
      })),
    });
  } catch (error) {
    console.warn('[recommendation][keyword-profile] failed to load wanted keywords:', error?.message || error);
  }

  if (testPersona === 'quiet') {
    keywordProfileOverride = new Map([
      ['조용', 60],
      ['작업하기좋은', 55],
      ['채광좋은', 40],
      ['편안', 35],
      ['혼잡한', 3],
      ['시끄러운', 3],
    ]);
    keywordProfileTotalFrequency = 196;
    console.log('[demo][persona] quiet_worker profile injected');
  }

  if (testPersona === 'social') {
    keywordProfileOverride = new Map([
      ['데이트', 53],
      ['인테리어좋은', 52],
      ['모임적합', 43],
      ['대화하기좋은', 39],
      ['감성', 32],
      ['좌석많은', 30],
      ['혼잡한', 28],
      ['시끄러운', 22],
    ]);
    keywordProfileTotalFrequency = 346;
    console.log('[demo][persona] social_date profile injected');
  }

  try {
    timeProfile = await loadTimePreferenceProfile(uid);
    console.log('[recommendation][time-profile]', {
      profileSize: Object.keys(timeProfile).length,
      bucket: getTimeBucket(startIso),
      durationBucket: getDurationBucket(startIso, endIso),
    });
  } catch (error) {
    console.warn('[recommendation][time-profile] failed to load time preferences:', error?.message || error);
  }

  if (!origin) {
    console.warn('[recommendation][for-slot-origin-warning]', {
      message: 'origin missing; no default/current-location fallback is used in for-slot flow',
      fallbackUsed: false,
    });
  }

  if (
    origin &&
    origin.query === undefined &&
    (origin.lat === undefined || origin.lng === undefined)
  ) {
    console.warn('[recommendation][for-slot-origin-warning]', {
      message: 'origin format invalid; expected {lat,lng} or {query}',
      requestOrigin: origin,
      fallbackUsed: false,
    });
  }

  const originLatLng = await resolveOrigin({
    origin,
    language,
    region,
    selectedPrices,
    transport: normalizedTransport,
  });

  // Keep one immutable origin reference for all free-slot recommendation stages.
  const slotOriginLatLng = originLatLng;
  console.log('[recommendation][origin-debug]', {
    requestOrigin: origin,
    resolvedOrigin: slotOriginLatLng,
    searchNearbyLocation: slotOriginLatLng,
    pipelineOrigin: slotOriginLatLng,
  });
  console.log('[recommendation][slot-origin-check]', {
    requestOrigin: origin,
    resolvedOrigin: slotOriginLatLng,
    searchNearbyLocation: slotOriginLatLng,
    pipelineOrigin: slotOriginLatLng,
  });

  let nearby;
  if (normalizedCategories.length > 0) {
    nearby = await searchPlacesService.searchNearby({
      location: slotOriginLatLng,
      radius: 3000,
      includedTypes: normalizedCategories,
      language,
      region,
      maxResults: maxResults ? Number(maxResults) : 20,
      selectedPrices,
      selectedTransports: [normalizedTransport],
    });
  } else {
    nearby = await searchPlacesService.searchNearby({
      location: slotOriginLatLng,
      radius: 3000,
      language,
      region,
      maxResults: maxResults ? Number(maxResults) : 20,
      selectedPrices,
      selectedTransports: [normalizedTransport],
    });
  }

  const places = await runRecommendationPipeline({
    uid,
    places: nearby.results || [],
    originLatLng: slotOriginLatLng,
    transport: normalizedTransport,
    slotStart: startIso,
    slotEnd: endIso,
    wantedDocs,
    timeProfile,
    calendarContext,
    keywordProfileOverride,
    keywordProfileTotalFrequency,
  });

  await db.collection('users').doc(uid).collection('recommendationSlots').add({
    slotStart: startIso,
    slotEnd: endIso,
    origin,
    resolvedOrigin: slotOriginLatLng,
    categories: normalizedCategories || [],
    selectedPrices: selectedPrices || [],
    transport: normalizedTransport,
    resultCount: places.length,
    createdAt: new Date().toISOString(),
  });

  return {
    places,
    slot: { slotStart: startIso, slotEnd: endIso },
    origin: slotOriginLatLng,
  };
};

const saveWantedAndPlaceKeywordDocs = async ({ uid, placeId, context }) => {
  if (!uid || !placeId) {
    return;
  }

  const db = getFirestore();
  const placeForKeywording = {
    placeId,
    id: placeId,
    name: context?.name || null,
    primaryType: context?.primaryType || null,
    types: Array.isArray(context?.types) ? context.types : [],
    rating: context?.rating ?? null,
    formattedAddress: context?.formattedAddress || context?.address || null,
  };

  let geminiKeywords = Array.isArray(context?.keywords)
    ? context.keywords.map((keyword) => normalizeKeyword(keyword)).filter((keyword) => MASTER_KEYWORD_SET.has(keyword))
    : [];
  geminiKeywords = [...new Set(geminiKeywords)].slice(0, 6);

  if (geminiKeywords.length === 0) {
    try {
      geminiKeywords = await generateKeywordsWithGemini(placeForKeywording);
    } catch (error) {
      geminiKeywords = [];
    }
  }

  const keywordSignals = geminiKeywords.map((keyword) => ({
    keyword,
    weight: 1,
    source: 'gemini+normalize',
  }));

  try {
    await db
      .collection('users')
      .doc(uid)
      .collection(WANTED_COLLECTION)
      .doc(placeId)
      .set(
        {
          placeId,
          name: placeForKeywording.name,
          keywords: geminiKeywords,
          keywordSignals,
          primaryType: placeForKeywording.primaryType,
          types: placeForKeywording.types,
          rating: placeForKeywording.rating,
          updatedAt: Date.now(),
        },
        { merge: true }
      );

    await db
      .collection('places')
      .doc(placeId)
      .set(
        {
          name: placeForKeywording.name,
          keywords: geminiKeywords,
          primaryType: placeForKeywording.primaryType,
          types: placeForKeywording.types,
          rating: placeForKeywording.rating,
          updatedAt: Date.now(),
        },
        { merge: true }
      );

    console.log('[wanted][places-synced]', {
      placeId,
      name: placeForKeywording.name,
      keywordCount: geminiKeywords.length,
    });
  } catch (error) {
    console.warn('[wanted][places-synced-failed]', {
      placeId,
      message: error?.message || String(error),
    });
  }
};

const clearGenericKeywords = async () => {
  const db = getFirestore();
  const snapshot = await db.collection('places').get();
  const genericKeywordGroups = [new Set(['감성', '편안']), new Set(['대화하기좋은', '모임적합'])];
  let deletedCount = 0;
  let batch = db.batch();
  let ops = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    const keywords = Array.isArray(data.keywords)
      ? data.keywords.map((keyword) => String(keyword).trim()).filter(Boolean)
      : [];

    const isTooGeneric = genericKeywordGroups.some(
      (group) => keywords.length > 0 && keywords.length <= 2 && keywords.every((keyword) => group.has(keyword))
    );

    if (!isTooGeneric) {
      continue;
    }

    batch.delete(doc.ref);
    deletedCount += 1;
    ops += 1;

    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  if (ops > 0) {
    await batch.commit();
  }

  console.log('[keyword-cleanup]', {
    deletedCount,
    reason: 'too-generic',
  });

  return {
    deletedCount,
    reason: 'too-generic',
  };
};

const saveRecommendationFeedback = async ({ uid, placeId, action, context, scheduleId }) => {
  const allowed = new Set(['like', 'dislike', 'skip', 'ab_pick']);
  if (!allowed.has(action)) {
    const error = new Error('action은 like|dislike|skip|ab_pick 중 하나여야 합니다.');
    error.status = 400;
    throw error;
  }
  if (!placeId || typeof placeId !== 'string') {
    const error = new Error('placeId는 필수 문자열입니다.');
    error.status = 400;
    throw error;
  }

  const payload = {
    placeId,
    action,
    context: context || {},
    scheduleId: scheduleId || null,
    createdAt: new Date().toISOString(),
  };

  const db = getFirestore();
  const ref = await db.collection('users').doc(uid).collection(FEEDBACK_SUBCOLLECTION).add(payload);

  const slotStart = context?.slotStart;
  const slotEnd = context?.slotEnd;
  const hasPrimaryType = typeof context?.primaryType === 'string' && context.primaryType.trim().length > 0;
  const hasTypes = Array.isArray(context?.types) && context.types.length > 0;

  if (action === 'like') {
    await saveWantedAndPlaceKeywordDocs({
      uid,
      placeId,
      context: context || {},
    });
  }

  if (action === 'like' && slotStart && slotEnd && (hasPrimaryType || hasTypes)) {
    const selectedPlace = {
      placeId,
      primaryType: hasPrimaryType ? context.primaryType : null,
      types: hasTypes ? context.types : [],
    };

    console.log('[recommendation][feedback-timepref-trigger]', {
      uid,
      placeId,
      slotStart,
      slotEnd,
      selectedPlace,
    });

    try {
      const timePreferenceResult = await saveTimePreferenceFromSelection({
        uid,
        slotStart,
        slotEnd,
        selectedPlace,
      });

      console.log('[recommendation][feedback-timepref-done]', {
        uid,
        placeId,
        resolvedCategory: timePreferenceResult?.category || null,
        targetPath: timePreferenceResult?.targetPath || null,
      });
    } catch (error) {
      console.warn('[recommendation][feedback-timepref-failed]', {
        uid,
        placeId,
        message: error?.message || String(error),
      });
    }
  }

  return { id: ref.id, ...payload };
};

module.exports = {
  fetchAndFilterPlaces,
  fetchRecommendationsForSlot,
  getTimeBucket,
  getDurationBucket,
  loadTimePreferenceProfile,
  computeTimePreferenceBoost,
  saveTimePreferenceFromSelection,
  saveRecommendationFeedback,
  clearGenericKeywords,
};
