const searchLogService = require('../services/searchLog.service');

const toError = (error, defaultStatus = 500) => {
	if (!error.status) {
		error.status = defaultStatus;
	}
	return error;
};

exports.createSearchLog = async (req, res, next) => {
	try {
		const uid = req.user.uid;
		const { query, filters, clickedPlaceId } = req.body || {};
		const saved = await searchLogService.createSearchLog({
			uid,
			query,
			filters,
			clickedPlaceId,
		});
		res.status(201).json({ message: '검색 로그 저장 성공', data: saved });
	} catch (error) {
		next(toError(error));
	}
};
