const express = require('express');

const router = express.Router();

const authenticateToken = require('../middleware/auth.middleware'); 
const recommendationController = require('../controllers/recommendation.controller'); 

// Basic GET route example
router.get('/', authenticateToken, (req, res) => {

    res.json({ message: 'Recommendation router is working' });
});

router.post('/', authenticateToken, recommendationController.getRecommendations);
router.post('/for-slot', authenticateToken, recommendationController.recommendForSlot);
router.post('/feedback', authenticateToken, recommendationController.submitFeedback);

module.exports = router;