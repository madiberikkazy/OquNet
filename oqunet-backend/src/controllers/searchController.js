// src/controllers/searchController.js - FIXED ASSOCIATIONS
const { Op } = require('sequelize');
const db = require('../models');

const GENRES = [
  'Роман', 'Әңгіме', 'Поэзия', 'Фантастика', 'Фэнтези',
  'Детектив', 'Триллер', 'Махаббат романы', 'Тарихи шығарма',
  'Ғылыми-көпшілік', 'Өмірбаян', 'Психология', 'Балалар әдебиеті',
  'Өзін-өзі дамыту', 'Діни әдебиет'
];

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}

exports.searchBooks = async (req, res) => {
  try {
    const { query, genre } = req.query;
    const userId = req.user.id;
    const userRole = req.user.role;
    
    const whereConditions = {};
    
    if (userRole !== 'admin') {
      whereConditions.community_id = req.user.community_id;
    }
    
    if (query && query.trim()) {
      whereConditions[Op.or] = [
        { title: { [Op.iLike]: `%${query}%` } },
        { author: { [Op.iLike]: `%${query}%` } }
      ];
    }
    
    if (genre && genre !== 'all') {
      whereConditions.genre = genre;
    }
    
    const books = await db.Book.findAll({
      where: whereConditions,
      include: [
        { 
          model: db.User, 
          as: 'holder', 
          attributes: ['id', 'name', 'email', 'phone'],
          required: false
        },
        { 
          model: db.User, 
          as: 'initialHolder', 
          attributes: ['id', 'name', 'email', 'phone'],
          required: false
        },
        { 
          model: db.User, 
          as: 'pendingUser', 
          attributes: ['id', 'name'],
          required: false
        },
        { 
          model: db.Community, 
          attributes: ['id', 'name'],
          required: false
        }
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

exports.searchUsers = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Тек админ іздей алады' });
    }
    
    const { phone } = req.query;
    
    if (!phone || phone.trim().length < 3) {
      return res.status(400).json({ 
        message: 'Телефон нөмірінің кем дегенде 3 таңбасын енгізіңіз' 
      });
    }
    
    const normalizedSearchPhone = normalizePhone(phone);
    
    const allUsers = await db.User.findAll({
      attributes: ['id', 'name', 'email', 'phone', 'role', 'community_id'],
      include: [
        { 
          model: db.Community, 
          as: 'community', 
          attributes: ['name'],
          required: false
        }
      ]
    });
    
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

exports.getGenres = async (req, res) => {
  try {
    res.json({ 
      success: true,
      genres: GENRES
    });
  } catch (err) {
    console.error('Get genres error:', err);
    res.status(500).json({ success: false, genres: [] });
  }
};