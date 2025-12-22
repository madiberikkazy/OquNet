// src/routes/bookRoutes.js
const express = require('express');
const router = express.Router();
const { authenticateToken, isAdmin } = require('../middleware/authMiddleware');
const bookController = require('../controllers/bookController');

// User routes - can borrow and return books
router.get('/', authenticateToken, bookController.getAllBooks);
router.get('/community/:communityId', authenticateToken, bookController.getBooksByCommunity);
router.post('/borrow', authenticateToken, bookController.borrowBook);
router.post('/return-my-book', authenticateToken, bookController.returnMyBook);

// Admin routes - can manage all books
router.post('/add', authenticateToken, isAdmin, bookController.addBook);
router.post('/assign', authenticateToken, isAdmin, bookController.assignBook);
router.post('/return', authenticateToken, isAdmin, bookController.returnBook);
router.delete('/delete/:id', authenticateToken, isAdmin, bookController.deleteBook);

module.exports = router;