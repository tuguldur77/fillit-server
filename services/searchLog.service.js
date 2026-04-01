const admin = require('firebase-admin');

const SEARCH_LOG_SUBCOLLECTION = process.env.SEARCH_LOG_SUBCOLLECTION || 'searchLogs';

const getFirestore = () => {
	if (!admin.apps || admin.apps.length === 0) {
		const error = new Error('Firebase Admin SDK가 초기화되지 않았습니다.');
		error.status = 500;
		throw error;
	}
	return admin.firestore();
};

const createSearchLog = async ({ uid, query, filters, clickedPlaceId }) => {
	if (!query || typeof query !== 'string') {
		const error = new Error('query는 필수 문자열입니다.');
		error.status = 400;
		throw error;
	}

	const payload = {
		query: query.trim(),
		filters: filters || {},
		clickedPlaceId: clickedPlaceId || null,
		createdAt: new Date().toISOString(),
	};

	const db = getFirestore();
	const ref = await db.collection('users').doc(uid).collection(SEARCH_LOG_SUBCOLLECTION).add(payload);
	return { id: ref.id, ...payload };
};

module.exports = {
	createSearchLog,
};
