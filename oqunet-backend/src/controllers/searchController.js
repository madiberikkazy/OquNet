// src/controllers/searchController.js
const { Op } = require('sequelize');
const db = require('../models');

// Predefined genres list
const GENRES = [
  'Роман',
  'Әңгіме',
  'Поэзия',
  'Фантастика',
  'Фэнтези',
  'Детектив',
  'Триллер',
  'Махаббат романы',
  'Тарихи шығарма',
  'Ғылыми-көпшілік',
  'Өмірбаян',
  'Психология',
  'Балалар әдебиеті',
  'Өзін-өзі дамыту',
  'Діни әдебиет'
];

// Normalize phone number - remove all non-digits
function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}

// Search books
exports.searchBooks = async (req, res) => {
  try {
    const { query, genre } = req.query;
    const userId = req.user.id;
    const userRole = req.user.role;
    
    const whereConditions = {};
    
    // Filter by community (non-admin users)
    if (userRole !== 'admin') {
      whereConditions.community_id = req.user.community_id;
    }
    
    // Search by title or author
    if (query && query.trim()) {
      whereConditions[Op.or] = [
        { title: { [Op.iLike]: `%${query}%` } },
        { author: { [Op.iLike]: `%${query}%` } }
      ];
    }
    
    // Filter by genre
    if (genre && genre !== 'all') {
      whereConditions.genre = genre;
    }
    
    const books = await db.Book.findAll({
      where: whereConditions,
      include: [
        { model: db.User, as: 'holder', attributes: ['id', 'name', 'email', 'phone'] },
        { model: db.User, as: 'pendingUser', attributes: ['id', 'name'] },
        { model: db.Community, attributes: ['id', 'name'] }
      ],
      order: [['title', 'ASC']]
    });
    
    res.json({ 
      success: true,
      books: books.map(b => b.toJSON()),
      count: books.length
    });
  } catch (err) {
    console.error('Search books error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// Search users (admin only)
exports.searchUsers = async (req, res) => {
  try {
    // Only admin can search users
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Тек админ іздей алады' });
    }
    
    const { phone } = req.query;
    
    if (!phone || phone.trim().length < 3) {
      return res.status(400).json({ 
        message: 'Телефон нөмірінің кем дегенде 3 таңбасын енгізіңіз' 
      });
    }
    
    // Normalize the search phone number
    const normalizedSearchPhone = normalizePhone(phone);
    
    // Get all users and filter by normalized phone
    const allUsers = await db.User.findAll({
      attributes: ['id', 'name', 'email', 'phone', 'role', 'community_id'],
      include: [{ model: db.Community, as: 'community', attributes: ['name'] }]
    });
    
    // Filter users whose normalized phone contains the search digits
    const matchedUsers = allUsers.filter(user => {
      const userNormalizedPhone = normalizePhone(user.phone);
      return userNormalizedPhone.includes(normalizedSearchPhone);
    });
    
    res.json({ 
      success: true,
      users: matchedUsers.map(u => u.toJSON()),
      count: matchedUsers.length
    });
  } catch (err) {
    console.error('Search users error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// Get all unique genres
exports.getGenres = async (req, res) => {
  try {
    // Return predefined genres list
    res.json({ 
      success: true,
      genres: GENRES
    });
  } catch (err) {
    console.error('Get genres error:', err);
    res.status(500).json({ success: false, genres: [] });
  }
};