// src/routes/communityRoutes.js
const express = require('express');
const router = express.Router();
const communityController = require('../controllers/communityController');
const { authenticateToken, isAdmin } = require('../middleware/authMiddleware');

// Public route - auth not required
router.get('/public', communityController.getPublicCommunities);

// Protected routes
router.get('/', authenticateToken, communityController.getAllCommunities);
router.post('/add', authenticateToken, isAdmin, communityController.addCommunity);
router.delete('/delete/:id', authenticateToken, isAdmin, communityController.deleteCommunity);

module.exports = router;