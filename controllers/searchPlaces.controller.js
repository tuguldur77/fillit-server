const searchPlacesService = require('../services/searchPlaces.service');

const ensureHttpError = (error, statusCode = 500) => {
	if (!error.status) {
		error.status = statusCode;
	}
	return error;
};

exports.searchByKeyword = async (req, res, next) => {
	try {
		const {
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
		} = req.body || {};

		if (!keyword && !pageToken) {
			return res.status(400).json({
				message: 'keyword 또는 pageToken 중 하나는 반드시 포함되어야 합니다.',
			});
		}

		let normalizedLocation;
		if (location !== undefined) {
			const lat = Number(location.lat);
			const lng = Number(location.lng);

			if (Number.isNaN(lat) || Number.isNaN(lng)) {
				return res.status(400).json({
					message: 'location.lat 및 location.lng는 숫자여야 합니다.',
				});
			}

			normalizedLocation = { lat, lng };
		}

		const parsedRadius = radius === undefined ? undefined : Number(radius);
		if (parsedRadius !== undefined && (Number.isNaN(parsedRadius) || parsedRadius <= 0)) {
			return res.status(400).json({ message: 'radius는 양수 숫자여야 합니다.' });
		}

		const parsedMaxResults = maxResults === undefined ? undefined : Number(maxResults);
		if (parsedMaxResults !== undefined && (Number.isNaN(parsedMaxResults) || parsedMaxResults <= 0)) {
			return res.status(400).json({ message: 'maxResults는 양수 숫자여야 합니다.' });
		}

		const result = await searchPlacesService.searchPlacesByKeyword({
			keyword,
			location: normalizedLocation,
			radius: parsedRadius,
			type,
			language,
			maxResults: parsedMaxResults,
			pageToken,
			region,
			selectedPrices,
			selectedTransports,
		});

		res.status(200).json(result);
	} catch (error) {
		next(ensureHttpError(error));
	}
};

exports.autocomplete = async (req, res, next) => {
	try {
		const { input, language, region, location, radius, sessionToken } = req.body || {};
		let { includedPrimaryTypes, chip, type, uiType } = req.body || {};
		if (!input || typeof input !== 'string') {
			return res.status(400).json({ message: 'input 문자열이 필요합니다.' });
		}

		let normalizedLocation;
		if (location) {
			const lat = Number(location.lat);
			const lng = Number(location.lng);
			if (Number.isNaN(lat) || Number.isNaN(lng)) {
				return res.status(400).json({ message: 'location.lat 및 location.lng는 숫자여야 합니다.' });
			}
			normalizedLocation = { lat, lng };
		}

		const parsedRadius = radius === undefined ? undefined : Number(radius);
		if (parsedRadius !== undefined && (Number.isNaN(parsedRadius) || parsedRadius <= 0)) {
			return res.status(400).json({ message: 'radius는 양수 숫자여야 합니다.' });
		}

		// If client passed a chip/label instead of Google type, resolve it
		const chipCandidate = chip || uiType || type;
		if ((!includedPrimaryTypes || includedPrimaryTypes.length === 0) && chipCandidate) {
			const resolved = searchPlacesService.resolvePlaceType(chipCandidate);
			if (resolved) {
				includedPrimaryTypes = [resolved];
			}
		}

		const result = await searchPlacesService.autocomplete({
			input,
			language,
			region,
			location: normalizedLocation,
			radius: parsedRadius,
			sessionToken,
			includedPrimaryTypes,
		});

		res.status(200).json(result);
	} catch (error) {
		next(ensureHttpError(error));
	}
};

exports.searchNearby = async (req, res, next) => {
	try {
		let { location, radius, language, region, includedTypes, excludedTypes, maxResults, rankPreference, keyword, chip, type, uiType, selectedPrices, selectedTransports } = req.body || {};
		if (!location || radius === undefined) {
			// Set default to South Korea if not provided
			location = { lat: 37.5665, lng: 126.9780 };
			radius = 200000;
		}

		const lat = Number(location.lat);
		const lng = Number(location.lng);
		const r = Number(radius);
		if (Number.isNaN(lat) || Number.isNaN(lng) || Number.isNaN(r) || r <= 0) {
			return res.status(400).json({ message: '올바른 location(lat,lng)과 양수 radius를 제공해야 합니다.' });
		}

		const mr = maxResults === undefined ? undefined : Number(maxResults);
		if (mr !== undefined && (Number.isNaN(mr) || mr <= 0)) {
			return res.status(400).json({ message: 'maxResults는 양수 숫자여야 합니다.' });
		}

		// If client passed a chip/label instead of Google type, resolve includedTypes when absent
		if ((!includedTypes || includedTypes.length === 0) && (chip || type || uiType)) {
			const resolved = searchPlacesService.resolvePlaceType(chip || uiType || type);
			if (resolved) {
				includedTypes = [resolved];
			}
		}

		const result = await searchPlacesService.searchNearby({
			location: { lat, lng },
			radius: r,
			language,
			region,
			includedTypes,
			excludedTypes,
			maxResults: mr,
			rankPreference,
			keyword,
			selectedPrices,
			selectedTransports,
		});

		res.status(200).json(result);
	} catch (error) {
		next(ensureHttpError(error));
	}
};

exports.getPhotoUrl = async (req, res, next) => {
	try {
		const { name, maxWidthPx, maxHeightPx } = req.query || {};
		if (!name) {
			return res.status(400).json({ message: '사진 리소스 name 쿼리 파라미터가 필요합니다.' });
		}

		const result = searchPlacesService.getPhotoUrl({
			name,
			maxWidthPx: maxWidthPx ? Number(maxWidthPx) : undefined,
			maxHeightPx: maxHeightPx ? Number(maxHeightPx) : undefined,
		});

		res.status(200).json(result);
	} catch (error) {
		next(ensureHttpError(error));
	}
};

exports.photoProxy = async (req, res, next) => {
	try {
		const { name, maxWidthPx, maxHeightPx } = req.query || {};
		if (!name || typeof name !== 'string' || !name.startsWith('places/')) {
			return res.status(400).json({ message: 'name은 places/로 시작하는 사진 리소스여야 합니다.' });
		}

		const parsedMaxWidthPx = maxWidthPx === undefined ? undefined : Number(maxWidthPx);
		const parsedMaxHeightPx = maxHeightPx === undefined ? undefined : Number(maxHeightPx);

		if (parsedMaxWidthPx !== undefined && (!Number.isFinite(parsedMaxWidthPx) || parsedMaxWidthPx <= 0)) {
			return res.status(400).json({ message: 'maxWidthPx는 양수 숫자여야 합니다.' });
		}

		if (parsedMaxHeightPx !== undefined && (!Number.isFinite(parsedMaxHeightPx) || parsedMaxHeightPx <= 0)) {
			return res.status(400).json({ message: 'maxHeightPx는 양수 숫자여야 합니다.' });
		}

		const effectiveMaxWidthPx = parsedMaxWidthPx === undefined && parsedMaxHeightPx === undefined
			? 800
			: parsedMaxWidthPx;
		const effectiveMaxHeightPx = parsedMaxHeightPx;

		const result = await searchPlacesService.fetchPhotoMedia({
			name,
			maxWidthPx: effectiveMaxWidthPx,
			maxHeightPx: effectiveMaxHeightPx,
		});

		res.setHeader('Content-Type', result.contentType || 'image/jpeg');
		res.setHeader('Cache-Control', result.cacheControl || 'public, max-age=3600');
		return res.status(200).send(result.buffer);
	} catch (error) {
		if (error.upstream) {
			return res.status(502).json({ message: 'Google photo proxy failed' });
		}
		next(ensureHttpError(error));
	}
};

exports.getPlaceDetails = async (req, res, next) => {
	try {
		const { placeId } = req.params;
		if (!placeId) {
			return res.status(400).json({ message: 'placeId 파라미터가 필요합니다.' });
		}

		const fields = typeof req.query.fields === 'string'
			? req.query.fields.split(',').map((field) => field.trim()).filter(Boolean)
			: undefined;

		const details = await searchPlacesService.getPlaceDetails({
			placeId,
			language: req.query.language,
			region: req.query.region,
			fields,
		});

		res.status(200).json(details);
	} catch (error) {
		next(ensureHttpError(error));
	}
};
