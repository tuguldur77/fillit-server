const admin = require('firebase-admin');
const searchPlacesService = require('./searchPlaces.service');

const FEEDBACK_SUBCOLLECTION = process.env.RECOMMENDATION_FEEDBACK_SUBCOLLECTION || 'recommendationFeedback';
const ROUTES_MATRIX_ENDPOINT = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
const TRANSPORT_SPEED_MPS = {
  walk: 1.2,
  car: 10.5,
};
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

  const normalized = categories
    .map((raw) => {
      if (!raw || typeof raw !== 'string') return undefined;
      const trimmed = raw.trim();
      if (!trimmed) return undefined;

      const mapped = searchPlacesService.resolvePlaceType(trimmed);
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
  const date = new Date(slotStart);
  if (Number.isNaN(date.getTime())) {
    return 'AFTERNOON';
  }

  const hour = date.getHours();
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

const isOpenNow = (openingHours) => {
  if (!openingHours || typeof openingHours !== 'object') {
    return false;
  }
  if (openingHours.open_now !== undefined) {
    return Boolean(openingHours.open_now);
  }
  if (openingHours.openNow !== undefined) {
    return Boolean(openingHours.openNow);
  }
  return false;
};

const filterPlaces = (places, slotDurationSec, options = {}) => {
  const { ignoreOpenNow = false } = options;
  return places.filter((place) => {
    if (!ignoreOpenNow && !isOpenNow(place.openingHours)) {
      return false;
    }
    if (typeof place.travelTimeSec !== 'number') {
      return false;
    }
    if (place.travelTimeSec > slotDurationSec) {
      return false;
    }
    return true;
  });
};

function buildRecommendationReasons(place, context) {
  const reasons = [];
  const travelTimeSec = Number(place?.travelTimeSec);
  const rating = Number(place?.rating);
  const keywordBoost = Number(context?.keywordBoost || 0);
  const timePreferenceBoost = Number(context?.timePreferenceBoost || 0);

  if (Number.isFinite(travelTimeSec) && travelTimeSec <= 600) {
    reasons.push('도보 10분 이내');
  } else if (Number.isFinite(travelTimeSec) && travelTimeSec <= 1200) {
    reasons.push('가까운 이동거리');
  }

  if (Number.isFinite(rating) && rating >= 4.3) {
    reasons.push('평점이 높음');
  }

  if (keywordBoost > 0) {
    reasons.push('취향 키워드 반영');
  }

  if (timePreferenceBoost > 0) {
    reasons.push('시간대 선호 반영');
  }

  if (place?.openNow === true) {
    reasons.push('현재 영업 중');
  }

  return reasons.slice(0, 3);
}

const rankPlaces = (places, keywordProfile = {}, timeProfile = {}, slotStart, slotEnd) => {
  const ranked = places
    .map((place) => {
      const baseScore = Number(computeBaselineScore(place).toFixed(3));
      const { keywordBoost, matchedKeywords, rawKeywordBoost, cappedKeywordBoost, topMatchedKeywordsCount } =
        computeKeywordBoostDetails(place, keywordProfile);
      const timePreferenceBoost = computeTimePreferenceBoost(place, timeProfile, slotStart, slotEnd);
      const finalScore = Number((baseScore + keywordBoost + timePreferenceBoost).toFixed(3));

      return {
        ...place,
        score: finalScore,
        _keywordDebug: {
          baseScore,
          keywordBoost,
          rawKeywordBoost,
          cappedKeywordBoost,
          topMatchedKeywordsCount,
          timePreferenceBoost,
          finalScore,
          matchedKeywords,
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
    console.log('[recommendation][keyword-rank]', {
      name: p.name,
      baseScore: p._keywordDebug.baseScore,
      keywordBoost: p._keywordDebug.keywordBoost,
      rawKeywordBoost: p._keywordDebug.rawKeywordBoost,
      cappedKeywordBoost: p._keywordDebug.cappedKeywordBoost,
      topMatchedKeywordsCount: p._keywordDebug.topMatchedKeywordsCount,
      finalScore: p._keywordDebug.finalScore,
    });
    console.log('[recommendation][time-rank]', {
      name: p.name,
      baseScore: p._keywordDebug.baseScore,
      keywordBoost: p._keywordDebug.keywordBoost,
      timePreferenceBoost: p._keywordDebug.timePreferenceBoost,
      finalScore: p._keywordDebug.finalScore,
    });
  });
  ranked.slice(0, 3).forEach((p) => {
    console.log('[recommendation][keyword-contrib]', {
      name: p.name,
      matchedKeywords: p._keywordDebug.matchedKeywords,
      keywordBoost: p._keywordDebug.keywordBoost,
    });
  });
  console.log(
    '[recommendation][keyword-final-check]',
    ranked.slice(0, 5).map((p) => ({
      name: p.name,
      baseScore: p._keywordDebug.baseScore,
      rawKeywordBoost: p._keywordDebug.rawKeywordBoost,
      cappedKeywordBoost: p._keywordDebug.cappedKeywordBoost,
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

  console.log(
    '[recommendation][reason-tags-top3]',
    ranked.slice(0, 3).map((p) => ({
      name: p.name,
      reasonTags: buildRecommendationReasons(p, p._keywordDebug),
    }))
  );

  return ranked.map(({ _keywordDebug, ...place }) => ({
    ...place,
    reasonTags: buildRecommendationReasons(place, _keywordDebug),
  }));
};

const runRecommendationPipeline = async ({
  places,
  originLatLng,
  transport,
  slotStart,
  slotEnd,
  keywordProfile,
  timeProfile,
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

  let filtered = filterPlaces(enriched, slotDurationSec);
  if (filtered.length === 0) {
    filtered = filterPlaces(enriched, slotDurationSec, { ignoreOpenNow: true });
  }
  console.log('filtered:', filtered.length);

  console.log('[recommendation][origin-consistency-check]', {
    searchNearbyLocation: originLatLng,
    enrichLocation: originLatLng,
  });

  return rankPlaces(filtered, keywordProfile, timeProfile, slotStart, slotEnd);
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
    places: nearby.results || [],
    originLatLng,
    transport: 'walk',
    slotStart: startIso,
    slotEnd: endIso,
  });

  return rankedPlaces.slice(0, 5);
};

const fetchRecommendationsForSlot = async ({
  uid,
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

  let keywordProfile = {};
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
    keywordProfile = buildUserKeywordProfile(wantedSnapshot.docs || []);
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
    places: nearby.results || [],
    originLatLng: slotOriginLatLng,
    transport: normalizedTransport,
    slotStart: startIso,
    slotEnd: endIso,
    keywordProfile,
    timeProfile,
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
};
