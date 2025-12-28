// src/routes/messageRoutes.js
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const messageController = require('../controllers/messageController');

router.get('/', authenticateToken, messageController.getMyMessages);
router.get('/unread-count', authenticateToken, messageController.getUnreadCount);
router.put('/:message_id/read', authenticateToken, messageController.markAsRead);

module.exports = router;