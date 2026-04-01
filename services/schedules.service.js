const admin = require('firebase-admin');
const recommendationService = require('./recommendation.service');

const SCHEDULES_COLLECTION = process.env.SCHEDULES_SUBCOLLECTION || 'schedules';

const getFirestore = () => {
	if (!admin.apps || admin.apps.length === 0) {
		const error = new Error('Firebase Admin SDK가 초기화되지 않았습니다.');
		error.status = 500;
		throw error;
	}
	return admin.firestore();
};

const toIso = (value, fieldName) => {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		const error = new Error(`${fieldName}는 유효한 ISO datetime 이어야 합니다.`);
		error.status = 400;
		throw error;
	}
	return date.toISOString();
};

const validateLocation = (scheduleLocation) => {
	if (scheduleLocation === undefined || scheduleLocation === null) {
		return undefined;
	}

	const lat = Number(scheduleLocation.lat);
	const lng = Number(scheduleLocation.lng);
	if (Number.isNaN(lat) || Number.isNaN(lng)) {
		const error = new Error('scheduleLocation.lat/lng는 숫자여야 합니다.');
		error.status = 400;
		throw error;
	}

	return { lat, lng };
};

const normalizeSchedulePayload = (payload, { partial = false } = {}) => {
	const result = {};

	if (!partial || payload.title !== undefined) {
		if (!payload.title || typeof payload.title !== 'string') {
			const error = new Error('title은 필수 문자열입니다.');
			error.status = 400;
			throw error;
		}
		result.title = payload.title.trim();
	}

	if (payload.description !== undefined) {
		result.description = String(payload.description || '').trim();
	}

	if (!partial || payload.slotStart !== undefined) {
		if (!payload.slotStart) {
			const error = new Error('slotStart는 필수입니다.');
			error.status = 400;
			throw error;
		}
		result.slotStart = toIso(payload.slotStart, 'slotStart');
	}

	if (!partial || payload.slotEnd !== undefined) {
		if (!payload.slotEnd) {
			const error = new Error('slotEnd는 필수입니다.');
			error.status = 400;
			throw error;
		}
		result.slotEnd = toIso(payload.slotEnd, 'slotEnd');
	}

	if (result.slotStart && result.slotEnd && result.slotStart >= result.slotEnd) {
		const error = new Error('slotEnd는 slotStart보다 이후 시각이어야 합니다.');
		error.status = 400;
		throw error;
	}

	if (payload.scheduleLocationText !== undefined) {
		result.scheduleLocationText = String(payload.scheduleLocationText || '').trim();
	}

	if (payload.scheduleLocation !== undefined) {
		result.scheduleLocation = validateLocation(payload.scheduleLocation);
	}

	if (payload.selectedPlace !== undefined) {
		result.selectedPlace = payload.selectedPlace;
	}

	if (payload.tags !== undefined) {
		result.tags = Array.isArray(payload.tags) ? payload.tags.slice(0, 20) : [];
	}

	return result;
};

const listSchedules = async ({ uid, from, to }) => {
	const fromIso = from ? toIso(from, 'from') : undefined;
	const toIsoValue = to ? toIso(to, 'to') : undefined;
	if (fromIso && toIsoValue && fromIso > toIsoValue) {
		const error = new Error('from은 to보다 이전이어야 합니다.');
		error.status = 400;
		throw error;
	}

	const db = getFirestore();
	const snapshot = await db.collection('users').doc(uid).collection(SCHEDULES_COLLECTION).get();
	const schedules = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

	const filtered = schedules.filter((item) => {
		if (fromIso && item.slotEnd < fromIso) return false;
		if (toIsoValue && item.slotStart > toIsoValue) return false;
		return true;
	});

	filtered.sort((a, b) => (a.slotStart < b.slotStart ? -1 : 1));
	return filtered;
};

const createSchedule = async ({ uid, payload }) => {
	const normalized = normalizeSchedulePayload(payload, { partial: false });
	const now = new Date().toISOString();
	const data = {
		...normalized,
		createdAt: now,
		updatedAt: now,
	};

	const db = getFirestore();
	const ref = await db.collection('users').doc(uid).collection(SCHEDULES_COLLECTION).add(data);
	if (data.selectedPlace) {
		console.log('[schedules][time-preference-trigger]', {
			selectedPlace: data.selectedPlace,
			selectedPlacePrimaryType: data.selectedPlace?.primaryType || null,
			selectedPlaceTypes: Array.isArray(data.selectedPlace?.types) ? data.selectedPlace.types : [],
			startTime: data.slotStart,
			endTime: data.slotEnd,
		});
		await recommendationService.saveTimePreferenceFromSelection({
			uid,
			slotStart: data.slotStart,
			slotEnd: data.slotEnd,
			selectedPlace: data.selectedPlace,
		});
	}
	return { id: ref.id, ...data };
};

const updateSchedule = async ({ uid, scheduleId, payload }) => {
	if (!scheduleId) {
		const error = new Error('scheduleId가 필요합니다.');
		error.status = 400;
		throw error;
	}

	const normalized = normalizeSchedulePayload(payload, { partial: true });
	if (Object.keys(normalized).length === 0) {
		const error = new Error('수정할 필드가 없습니다.');
		error.status = 400;
		throw error;
	}

	const db = getFirestore();
	const docRef = db.collection('users').doc(uid).collection(SCHEDULES_COLLECTION).doc(scheduleId);
	const existing = await docRef.get();
	if (!existing.exists) {
		const error = new Error('일정을 찾을 수 없습니다.');
		error.status = 404;
		throw error;
	}

	const merged = { ...existing.data(), ...normalized };
	if (merged.slotStart >= merged.slotEnd) {
		const error = new Error('slotEnd는 slotStart보다 이후 시각이어야 합니다.');
		error.status = 400;
		throw error;
	}

	merged.updatedAt = new Date().toISOString();
	await docRef.set(merged, { merge: true });
	if (merged.selectedPlace) {
		console.log('[schedules][time-preference-trigger]', {
			selectedPlace: merged.selectedPlace,
			selectedPlacePrimaryType: merged.selectedPlace?.primaryType || null,
			selectedPlaceTypes: Array.isArray(merged.selectedPlace?.types) ? merged.selectedPlace.types : [],
			startTime: merged.slotStart,
			endTime: merged.slotEnd,
		});
		await recommendationService.saveTimePreferenceFromSelection({
			uid,
			slotStart: merged.slotStart,
			slotEnd: merged.slotEnd,
			selectedPlace: merged.selectedPlace,
		});
	}
	return { id: scheduleId, ...merged };
};

const deleteSchedule = async ({ uid, scheduleId }) => {
	if (!scheduleId) {
		const error = new Error('scheduleId가 필요합니다.');
		error.status = 400;
		throw error;
	}

	const db = getFirestore();
	const docRef = db.collection('users').doc(uid).collection(SCHEDULES_COLLECTION).doc(scheduleId);
	const existing = await docRef.get();
	if (!existing.exists) {
		const error = new Error('일정을 찾을 수 없습니다.');
		error.status = 404;
		throw error;
	}

	await docRef.delete();
	return { id: scheduleId, deleted: true };
};

module.exports = {
	listSchedules,
	createSchedule,
	updateSchedule,
	deleteSchedule,
};
