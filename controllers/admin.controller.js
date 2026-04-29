const recommendationService = require('../services/recommendation.service');

const toError = (error, defaultStatus = 500) => {
  if (!error.status) {
    error.status = defaultStatus;
  }
  return error;
};

exports.clearGenericKeywords = async (req, res, next) => {
  try {
    const result = await recommendationService.clearGenericKeywords();
    res.status(200).json({
      message: 'generic keyword cleanup completed',
      data: result,
    });
  } catch (error) {
    next(toError(error));
  }
};
