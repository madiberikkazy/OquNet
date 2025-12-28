// src/routes/searchRoutes.js
const express = require('express');
const router = express.Router();
const { authenticateToken, isAdmin } = require('../middleware/authMiddleware');
const searchController = require('../controllers/searchController');

router.get('/books', authenticateToken, searchController.searchBooks);
router.get('/users', authenticateToken, isAdmin, searchController.searchUsers);
router.get('/genres', authenticateToken, searchController.getGenres);

module.exports = router;