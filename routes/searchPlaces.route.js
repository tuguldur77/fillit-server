const express = require('express');

const router = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const searchPlacesController = require('../controllers/searchPlaces.controller');

router.get('/photoProxy', searchPlacesController.photoProxy);

router.use(authenticateToken);

router.post('/keyword', searchPlacesController.searchByKeyword);
router.get('/details/:placeId', searchPlacesController.getPlaceDetails);
router.post('/autocomplete', searchPlacesController.autocomplete);
router.post('/nearby', searchPlacesController.searchNearby);
router.get('/photo-url', searchPlacesController.getPhotoUrl);

module.exports = router;