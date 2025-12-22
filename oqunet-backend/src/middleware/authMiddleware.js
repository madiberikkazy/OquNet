// src/middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const db = require('../models');

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ message: 'Token жоқ' });

  const token = authHeader.split(' ')[1]; // Bearer <token>
  if (!token) return res.status(401).json({ message: 'Token жоқ' });

  try {
    const decoded = jwt.verify(token, 'your_jwt_secret'); // .env қолдануға болады
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

module.exports = { authenticateToken, isAdmin };