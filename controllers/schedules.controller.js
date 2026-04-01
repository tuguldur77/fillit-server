const schedulesService = require('../services/schedules.service');

const toError = (error, defaultStatus = 500) => {
	if (!error.status) {
		error.status = defaultStatus;
	}
	return error;
};

exports.listSchedules = async (req, res, next) => {
	try {
		const uid = req.user.uid;
		const schedules = await schedulesService.listSchedules({
			uid,
			from: req.query.from,
			to: req.query.to,
		});
		res.status(200).json({ data: schedules, count: schedules.length });
	} catch (error) {
		next(toError(error));
	}
};

exports.createSchedule = async (req, res, next) => {
	try {
		const uid = req.user.uid;
		const created = await schedulesService.createSchedule({ uid, payload: req.body || {} });
		res.status(201).json({ message: '일정 생성 성공', data: created });
	} catch (error) {
		next(toError(error));
	}
};

exports.updateSchedule = async (req, res, next) => {
	try {
		const uid = req.user.uid;
		const updated = await schedulesService.updateSchedule({
			uid,
			scheduleId: req.params.id,
			payload: req.body || {},
		});
		res.status(200).json({ message: '일정 수정 성공', data: updated });
	} catch (error) {
		next(toError(error));
	}
};

exports.deleteSchedule = async (req, res, next) => {
	try {
		const uid = req.user.uid;
		const result = await schedulesService.deleteSchedule({ uid, scheduleId: req.params.id });
		res.status(200).json({ message: '일정 삭제 성공', data: result });
	} catch (error) {
		next(toError(error));
	}
};
