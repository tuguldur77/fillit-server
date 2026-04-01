const admin = require('firebase-admin');

// Google Places API (New) v1 endpoints
const PLACES_API_BASE = 'https://places.googleapis.com/v1';
const TEXT_SEARCH_ENDPOINT = `${PLACES_API_BASE}/places:searchText`;
const NEARBY_SEARCH_ENDPOINT = `${PLACES_API_BASE}/places:searchNearby`;
const AUTOCOMPLETE_ENDPOINT = `${PLACES_API_BASE}/places:autocomplete`;
// Details uses GET: `${PLACES_API_BASE}/places/{placeId}`

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

const FAVORITES_ROOT_COLLECTION = process.env.FAVORITES_ROOT_COLLECTION || 'users';
const FAVORITES_SUBCOLLECTION = process.env.FAVORITES_SUBCOLLECTION || 'favorites';

// Avoid accessing Firestore before Firebase Admin is initialized in server.js
const getFirestore = () => {
	if (!admin.apps || admin.apps.length === 0) {
		const error = new Error('Firebase Admin SDK가 아직 초기화되지 않았습니다. server.js에서 initializeApp 이후에 Firestore를 사용하세요.');
		error.status = 500;
		throw error;
	}
	return admin.firestore();
};

const fetchFn = global.fetch
	? (...args) => global.fetch(...args)
	: async (...args) => {
		const { default: fetch } = await import('node-fetch');
		return fetch(...args);
	};

// Map user-facing chip labels or simple aliases to Google Places types (v1 primary types)
// Extend this map as you add more chips in the app UI.
const TYPE_ALIASES = {
	// Korean labels → Google type
	'카페': 'cafe',
	'전시': 'museum',
	'체험': 'tourist_attraction',
	'관광지': 'tourist_attraction',
	'맛집': 'restaurant',
	'쇼핑': 'shopping_mall'
};

const resolvePlaceType = (chipOrType) => {
	if (!chipOrType || typeof chipOrType !== 'string') return undefined;
	// exact match (for Korean) or lowercase match (for english)
	if (TYPE_ALIASES[chipOrType]) return TYPE_ALIASES[chipOrType];
	const key = chipOrType.trim().toLowerCase();
	return TYPE_ALIASES[key] || undefined;
};

const PRICE_LEVELS = {
	'무료': [0],
	'₩ 저가': [1],
	'₩₩ 보통': [2],
	'₩₩₩ 고가': [3, 4],
};

const PRICE_ENUM_TO_LEVEL = {
	PRICE_LEVEL_FREE: 0,
	PRICE_LEVEL_INEXPENSIVE: 1,
	PRICE_LEVEL_MODERATE: 2,
	PRICE_LEVEL_EXPENSIVE: 3,
	PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

const PRICE_BAND_BY_LEVEL = {
	0: '무료',
	1: '₩ 저가',
	2: '₩₩ 보통',
	3: '₩₩₩ 고가',
	4: '₩₩₩ 고가',
};

const normalizePriceLevel = (rawValue) => {
	if (rawValue === undefined || rawValue === null) {
		return { normalizedLevel: undefined, raw: rawValue, priceBand: undefined };
	}

	if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
		const level = Math.max(0, Math.min(4, rawValue));
		return {
			normalizedLevel: level,
			raw: rawValue,
			priceBand: PRICE_BAND_BY_LEVEL[level],
		};
	}

	if (typeof rawValue === 'string') {
		const trimmed = rawValue.trim();
		if (PRICE_ENUM_TO_LEVEL[trimmed] !== undefined) {
			const level = PRICE_ENUM_TO_LEVEL[trimmed];
			return {
				normalizedLevel: level,
				raw: trimmed,
				priceBand: PRICE_BAND_BY_LEVEL[level],
			};
		}

		const asNumber = Number(trimmed);
		if (!Number.isNaN(asNumber)) {
			const level = Math.max(0, Math.min(4, asNumber));
			return {
				normalizedLevel: level,
				raw: trimmed,
				priceBand: PRICE_BAND_BY_LEVEL[level],
			};
		}
	}

	return {
		normalizedLevel: undefined,
		raw: rawValue,
		priceBand: undefined,
	};
};

const filterByPrices = (places, selectedPrices) => {
	if (!selectedPrices || selectedPrices.length === 0) return places;

	const allowedLevels = new Set();
	selectedPrices.forEach((priceLabel) => {
		const levels = PRICE_LEVELS[priceLabel];
		if (levels) levels.forEach((level) => allowedLevels.add(level));
	});

	return places.filter((place) => {
		const priceLevel = place.priceLevel;
		return priceLevel === undefined || allowedLevels.has(priceLevel);
	});
};

const ensureApiKey = () => {
	if (!GOOGLE_PLACES_API_KEY) {
		const error = new Error('GOOGLE_PLACES_API_KEY 환경 변수가 설정되지 않았습니다.');
		error.status = 500;
		throw error;
	}
};

const defaultFieldMask = [
	'places.id',
	'places.displayName',
	'places.formattedAddress',
	'places.location',
	'places.types',
	'places.rating',
	'places.userRatingCount',
	'places.priceLevel',
	'places.primaryType',
	'places.businessStatus',
	'places.currentOpeningHours',
	'places.photos',
];

const mapV1PlaceSummary = (place) => ({
	...(() => {
		const normalizedPrice = normalizePriceLevel(place.priceLevel);
		return {
			priceLevel: normalizedPrice.normalizedLevel,
			priceLevelRaw: normalizedPrice.raw,
			priceBand: normalizedPrice.priceBand,
		};
	})(),
	placeId: place.id,
	name: place.displayName?.text || place.displayName || undefined,
	types: place.types,
	primaryType: place.primaryType,
	rating: place.rating,
	userRatingsTotal: place.userRatingCount,
	formattedAddress: place.formattedAddress,
	openingHours: place.currentOpeningHours,
	businessStatus: place.businessStatus,
	location: place.location,
	photos: place.photos?.map((p) => ({
		name: p.name, // resource name, e.g., places/XXX/photos/YYY
		widthPx: p.widthPx,
		heightPx: p.heightPx,
		authorAttributions: p.authorAttributions,
	})),
});

// Text Search (New)
const searchPlacesByKeyword = async ({
	keyword,
	location,
	radius,
	type,
	language,
	maxResults,
	pageToken,
	region,
	selectedPrices,
	selectedTransports,
}) => {
	ensureApiKey();

	const headers = {
		'Content-Type': 'application/json',
		'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
		'X-Goog-FieldMask': defaultFieldMask.join(','),
	};

	const body = {
		textQuery: keyword,
	};

	if (language) body.languageCode = language;
	if (region) body.regionCode = region;
	if (typeof maxResults === 'number') body.maxResultCount = maxResults;
	if (pageToken) body.pageToken = pageToken;

	if (location && radius) {
		body.locationBias = {
			circle: {
				center: { latitude: location.lat, longitude: location.lng },
				radius: radius,
			},
		};
	}

	// New API doesn't support 'type' directly in text search; it's inferred from query.
	// If needed, include it in the keyword on the client side.

	const response = await fetchFn(TEXT_SEARCH_ENDPOINT, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const text = await response.text();
		const error = new Error(`Places Text Search(v1) 호출 실패: ${response.status} ${response.statusText}`);
		error.details = text;
		error.status = response.status;
		throw error;
	}

	const data = await response.json();
	let results = (data.places || []).map(mapV1PlaceSummary);

	// Filter by selected prices
	results = filterByPrices(results, selectedPrices);

	if (selectedTransports && selectedTransports.length) {
		console.log('Selected transports:', selectedTransports);
	}

	if (selectedPrices && selectedPrices.length) {
		console.log('Selected prices:', selectedPrices);
	}

	return {
		query: { keyword, location, radius, language, region, selectedPrices, selectedTransports },
		results,
		nextPageToken: data.nextPageToken || null,
		status: 'OK',
	};
};

// Place Details (New)
const getPlaceDetails = async ({ placeId, language, region, fields }) => {
	ensureApiKey();

	const fieldMask = Array.isArray(fields) && fields.length > 0
		? fields.join(',')
		: [
			'id',
			'displayName',
			'formattedAddress',
			'location',
			'types',
			'rating',
			'userRatingCount',
			'priceLevel',
			'currentOpeningHours',
			'internationalPhoneNumber',
			'websiteUri',
			'photos',
		].join(',');

	const query = new URLSearchParams();
	if (language) query.set('languageCode', language);
	if (region) query.set('regionCode', region);

	const url = `${PLACES_API_BASE}/places/${encodeURIComponent(placeId)}${query.toString() ? `?${query.toString()}` : ''}`;

	const response = await fetchFn(url, {
		method: 'GET',
		headers: {
			'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
			'X-Goog-FieldMask': fieldMask,
		},
	});

	if (!response.ok) {
		const text = await response.text();
		const error = new Error(`Places Details(v1) 호출 실패: ${response.status} ${response.statusText}`);
		error.details = text;
		error.status = response.status;
		throw error;
	}

	const data = await response.json();
	return { placeId, result: data, status: 'OK' };
};

// Autocomplete (New)
const autocomplete = async ({ input, language, region, location, radius, sessionToken, includedPrimaryTypes }) => {
	ensureApiKey();

	const headers = {
		'Content-Type': 'application/json',
		'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
		'X-Goog-FieldMask': [
			'suggestions.placePrediction.placeId',
			'suggestions.placePrediction.text',
			'suggestions.placePrediction.types',
			'suggestions.placePrediction.distanceMeters',
		].join(','),
	};

	const body = { input };
	if (language) body.languageCode = language;
	if (region) body.regionCode = region;
	if (Array.isArray(includedPrimaryTypes) && includedPrimaryTypes.length > 0) body.includedPrimaryTypes = includedPrimaryTypes;
	if (sessionToken) body.sessionToken = sessionToken; // improves billing grouping

	if (location && radius) {
		body.locationBias = {
			circle: {
				center: { latitude: location.lat, longitude: location.lng },
				radius: radius,
			},
		};
	}

	const response = await fetchFn(AUTOCOMPLETE_ENDPOINT, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const text = await response.text();
		const error = new Error(`Places Autocomplete(v1) 호출 실패: ${response.status} ${response.statusText}`);
		error.details = text;
		error.status = response.status;
		throw error;
	}

	const data = await response.json();
	return { suggestions: data.suggestions || [] };
};

// Nearby Search (New)
const searchNearby = async ({ location, radius, language, region, includedTypes, excludedTypes, maxResults, rankPreference, keyword, selectedPrices, selectedTransports }) => {
	ensureApiKey();

	const headers = {
		'Content-Type': 'application/json',
		'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
		'X-Goog-FieldMask': defaultFieldMask.join(','),
	};

	const body = {
		locationRestriction: {
			circle: {
				center: { latitude: location.lat, longitude: location.lng },
				radius: radius,
			},
		},
	};

	if (language) body.languageCode = language;
	if (region) body.regionCode = region;
	if (Array.isArray(includedTypes) && includedTypes.length > 0) body.includedTypes = includedTypes;
	if (Array.isArray(excludedTypes) && excludedTypes.length > 0) body.excludedTypes = excludedTypes;
	if (typeof maxResults === 'number') body.maxResultCount = maxResults;
	if (rankPreference) body.rankPreference = rankPreference; // 'DISTANCE' or 'RELEVANCE'
	if (keyword) body.keyword = keyword;

	const response = await fetchFn(NEARBY_SEARCH_ENDPOINT, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const text = await response.text();
		const error = new Error(`Places Nearby(v1) 호출 실패: ${response.status} ${response.statusText}`);
		error.details = text;
		error.status = response.status;
		throw error;
	}

	const data = await response.json();

	// DEBUG: raw google places sample (first 2)
	const rawSample = (data.places || []).slice(0, 2).map((p) => ({
		id: p?.id,
		displayName: p?.displayName?.text || p?.displayName,
		formattedAddress: p?.formattedAddress,
		hasPhotos: Array.isArray(p?.photos) && p.photos.length > 0,
		photoName: p?.photos?.[0]?.name || null,
		photoUrl: p?.photos?.[0]?.url || null,
	}));
	console.log('[searchNearby][raw-sample]', rawSample);

	let results = (data.places || []).map(mapV1PlaceSummary);

	// DEBUG: mapped nearby sample (first 2)
	const mappedSample = results.slice(0, 2).map((p) => ({
		placeId: p?.placeId,
		formattedAddress: p?.formattedAddress,
		hasPhotos: Array.isArray(p?.photos) && p.photos.length > 0,
		photoName: p?.photos?.[0]?.name || null,
		photoUrl: p?.photos?.[0]?.url || null,
	}));
	console.log('[searchNearby][mapped-sample]', mappedSample);

	console.log(`Before filtering: ${results.length} places`);
	console.log('Price levels:', results.map(p => p.priceLevel));

	results = filterByPrices(results, selectedPrices);

	console.log(`After price filtering: ${results.length} places`);

	if (selectedTransports && selectedTransports.length) {
		console.log('Selected transports:', selectedTransports);
	}

	if (selectedPrices && selectedPrices.length) {
		console.log('Selected prices:', selectedPrices);
	}

	return { results, nextPageToken: data.nextPageToken || null, status: 'OK' };
};

// Photo URL for clients should point to backend proxy (not direct Google media URL).
const getPhotoUrl = ({ name, maxWidthPx, maxHeightPx }) => {
	ensureApiKey();
	if (!name) {
		const error = new Error('photo resource name이 필요합니다. (예: places/PLACE_ID/photos/PHOTO_ID)');
		error.status = 400;
		throw error;
	}
	if (!String(name).startsWith('places/')) {
		const error = new Error('photo resource name은 places/로 시작해야 합니다.');
		error.status = 400;
		throw error;
	}

	const params = new URLSearchParams();
	params.set('name', String(name));
	if (maxWidthPx) params.set('maxWidthPx', String(maxWidthPx));
	if (maxHeightPx) params.set('maxHeightPx', String(maxHeightPx));

	const url = `/api/searchPlace/photoProxy?${params.toString()}`;
	return { url };
};

const fetchPhotoMedia = async ({ name, maxWidthPx, maxHeightPx }) => {
	ensureApiKey();
	if (!name) {
		const error = new Error('photo resource name이 필요합니다. (예: places/PLACE_ID/photos/PHOTO_ID)');
		error.status = 400;
		throw error;
	}
	if (!String(name).startsWith('places/')) {
		const error = new Error('photo resource name은 places/로 시작해야 합니다.');
		error.status = 400;
		throw error;
	}

	const effectiveMaxWidthPx = maxWidthPx === undefined && maxHeightPx === undefined ? 800 : maxWidthPx;
	const effectiveMaxHeightPx = maxHeightPx;

	const params = new URLSearchParams();
	params.set('skipHttpRedirect', 'true');
	if (effectiveMaxWidthPx !== undefined) params.set('maxWidthPx', String(effectiveMaxWidthPx));
	if (effectiveMaxHeightPx !== undefined) params.set('maxHeightPx', String(effectiveMaxHeightPx));

	const requestTarget = `${PLACES_API_BASE}/${encodeURI(name)}/media?${params.toString()}`;

	try {
		const response = await fetchFn(requestTarget, {
			method: 'GET',
			headers: {
				'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
			},
		});

		const contentType = response.headers.get('content-type') || '';
		const location = response.headers.get('location');
		const cacheControl = response.headers.get('cache-control');

		if (!response.ok) {
			const text = await response.text();

			const error = new Error(`Places Photo Media(v1) 호출 실패: ${response.status} ${response.statusText}`);
			error.details = text;
			error.status = 502;
			error.upstream = true;
			error.upstreamStatus = response.status;
			error.upstreamStatusText = response.statusText;
			error.requestTarget = requestTarget;
			error.upstreamHeaders = {
				'content-type': contentType || null,
				location: location || null,
				'cache-control': cacheControl || null,
			};
			throw error;
		}

		if (contentType.includes('application/json')) {
			const payload = await response.json();
			const photoUri = payload?.photoUri;

			if (!photoUri || typeof photoUri !== 'string') {
				const error = new Error('Places Photo Media JSON 응답에 photoUri가 없습니다.');
				error.details = JSON.stringify(payload);
				error.status = 502;
				error.upstream = true;
				error.upstreamStatus = response.status;
				error.upstreamStatusText = response.statusText;
				error.requestTarget = requestTarget;
				error.upstreamHeaders = {
					'content-type': contentType || null,
					location: location || null,
					'cache-control': cacheControl || null,
				};
				throw error;
			}

			const secondResponse = await fetchFn(photoUri, { method: 'GET' });
			const secondContentType = secondResponse.headers.get('content-type') || '';
			const secondCacheControl = secondResponse.headers.get('cache-control');

			if (!secondResponse.ok) {
				const secondBody = await secondResponse.text();

				const error = new Error(`Photo URI fetch 실패: ${secondResponse.status} ${secondResponse.statusText}`);
				error.details = secondBody;
				error.status = 502;
				error.upstream = true;
				error.upstreamStatus = secondResponse.status;
				error.upstreamStatusText = secondResponse.statusText;
				error.requestTarget = photoUri;
				error.upstreamHeaders = {
					'content-type': secondContentType || null,
					'cache-control': secondCacheControl || null,
				};
				throw error;
			}

			if (!secondContentType.toLowerCase().startsWith('image/')) {
				const secondBody = await secondResponse.text();

				const error = new Error('Photo URI fetch 응답이 이미지가 아닙니다.');
				error.details = secondBody;
				error.status = 502;
				error.upstream = true;
				error.upstreamStatus = secondResponse.status;
				error.upstreamStatusText = secondResponse.statusText;
				error.requestTarget = photoUri;
				error.upstreamHeaders = {
					'content-type': secondContentType || null,
					'cache-control': secondCacheControl || null,
				};
				throw error;
			}

			const secondArrayBuffer = await secondResponse.arrayBuffer();
			const secondBuffer = Buffer.from(secondArrayBuffer);

			return {
				buffer: secondBuffer,
				contentType: secondContentType || 'image/jpeg',
				cacheControl: secondCacheControl || 'public, max-age=3600',
				location: null,
				requestTarget,
				upstreamStatus: secondResponse.status,
				upstreamStatusText: secondResponse.statusText,
				bodyType: 'binary',
				byteLength: secondBuffer.length,
			};
		}

		const arrayBuffer = await response.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);

		return {
			buffer,
			contentType: contentType || 'image/jpeg',
			cacheControl: cacheControl || 'public, max-age=3600',
			location: location || null,
			requestTarget,
			upstreamStatus: response.status,
			upstreamStatusText: response.statusText,
			bodyType: 'binary',
			byteLength: buffer.length,
		};
	} catch (error) {
		throw error;
	}
};

module.exports = {
	searchPlacesByKeyword,
	getPlaceDetails,
	autocomplete,
	searchNearby,
	getPhotoUrl,
	fetchPhotoMedia,
	resolvePlaceType,
};
