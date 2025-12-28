// src/routes/communityRoutes.js
const express = require('express');
const router = express.Router();
const communityController = require('../controllers/communityController');
const { authenticateToken, isAdmin, isCommunityOwner } = require('../middleware/authMiddleware');

// Public route
router.get('/public', communityController.getPublicCommunities);

// Protected routes - any authenticated user
router.get('/', authenticateToken, communityController.getAllCommunities);
router.post('/create', authenticateToken, communityController.createCommunity);

// Admin only routes
router.post('/add', authenticateToken, isAdmin, communityController.addCommunity);

// Owner or admin routes
router.delete('/delete/:id', authenticateToken, communityController.deleteCommunity);
router.get('/:communityId/members', authenticateToken, communityController.getCommunityMembers);
router.delete('/:communityId/members/:userId', authenticateToken, communityController.removeMember);

module.exports = router;