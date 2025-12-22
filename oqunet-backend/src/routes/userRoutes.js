// src/routes/userRoutes.js
const express = require('express');
const router = express.Router();
const { User } = require('../models');
const bcrypt = require('bcrypt');
const userController = require('../controllers/userController');
const { authenticateToken, isAdmin } = require('../middleware/authMiddleware');

// Public routes
router.post('/register', async (req, res) => {
  const { name, email, phone, password, community_id } = req.body;

  console.log('Register request:', { email, name, hasPassword: !!password, phone: !!req.body.phone, communityProvided: !!community_id });

  try {
    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) return res.status(400).json({ message: 'Пайдаланушы бар' });

    const hashedPassword = bcrypt.hashSync(password, 10);

    const userData = {
      name,
      email,
      phone: phone || '',
      password: hashedPassword,
      role: 'user'
    };

    if (community_id) {
      userData.community_id = community_id;
    }

    const user = await User.create(userData);

    res.status(201).json({ message: 'Пайдаланушы тіркелді', user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/login', userController.login);

// Protected routes (authenticated users only)
router.get('/', authenticateToken, userController.getAllUsers);

// Profile update - any authenticated user can update their own profile
router.put('/profile', authenticateToken, userController.updateProfile);

// Join community - authenticated users
router.post('/join-community', authenticateToken, userController.joinCommunity);

// Leave community - authenticated users
router.post('/leave-community', authenticateToken, userController.leaveCommunity);

// Admin only routes
router.post('/add', authenticateToken, isAdmin, userController.addUser);

// User can delete their own account, admin can delete anyone (except admin)
router.delete('/delete/:id', authenticateToken, userController.deleteUser);

module.exports = router;