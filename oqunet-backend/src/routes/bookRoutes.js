// src/routes/bookRoutes.js - FIXED VERSION
const express = require('express');
const router = express.Router();
const { authenticateToken, isAdmin } = require('../middleware/authMiddleware');
const bookController = require('../controllers/bookController');

// User routes - can borrow and return books
router.get('/', authenticateToken, bookController.getAllBooks);
router.get('/community/:communityId', authenticateToken, bookController.getBooksByCommunity);
router.post('/borrow', authenticateToken, bookController.borrowBook);
router.post('/return-my-book', authenticateToken, bookController.returnMyBook);

// Routes for BOTH admin AND community owners
router.post('/add', authenticateToken, bookController.addBook);  // Changed: removed isAdmin
router.delete('/delete/:id', authenticateToken, bookController.deleteBook);  // Changed: removed isAdmin

// Admin-only routes (for backwards compatibility)
router.post('/assign', authenticateToken, isAdmin, bookController.assignBook);
router.post('/return', authenticateToken, isAdmin, bookController.returnBook);

module.exports = router;