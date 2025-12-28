// src/middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const db = require('../models');

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ message: 'Token жоқ' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token жоқ' });

  try {
    const decoded = jwt.verify(token, 'your_jwt_secret');
    req.user = await db.User.findByPk(decoded.id);
    if (!req.user) return res.status(401).json({ message: 'User жоқ' });
    next();
  } catch (err) {
    return res.status(403).json({ message: 'Token жарамсыз' });
  }
};

const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin ғана рұқсат алады' });
  }
  next();
};

// Check if user is owner of a community
const isCommunityOwner = async (req, res, next) => {
  try {
    const communityId = req.params.communityId || req.params.id || req.body.community_id;
    
    if (!communityId) {
      return res.status(400).json({ message: 'Community ID керек' });
    }

    const community = await db.Community.findByPk(communityId);
    
    if (!community) {
      return res.status(404).json({ message: 'Қоғамдастық табылмады' });
    }

    // Admin can access any community, or user must be the owner
    if (req.user.role === 'admin' || community.owner_id === req.user.id) {
      req.community = community;
      next();
    } else {
      return res.status(403).json({ message: 'Сіз бұл қоғамдастықтың иесі емессіз' });
    }
  } catch (err) {
    console.error('isCommunityOwner error:', err);
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { authenticateToken, isAdmin, isCommunityOwner };