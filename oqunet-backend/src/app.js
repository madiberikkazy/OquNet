//src/app.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const db = require('./models');

const userRoutes = require('./routes/userRoutes');
const bookRoutes = require('./routes/bookRoutes');
const communityRoutes = require('./routes/communityRoutes');
const messageRoutes = require('./routes/messageRoutes');
const searchRoutes = require('./routes/searchRoutes');

const app = express();

app.use(cors());
app.use(bodyParser.json());

// Simple request logger for debugging (mask sensitive fields)
app.use((req, res, next) => {
  try {
    const safeBody = { ...req.body };
    if (safeBody.password) safeBody.password = '***';
    console.log('>>', req.method, req.path, 'body:', safeBody);
  } catch (e) {
    console.warn('Request logger error:', e);
  }
  next();
});

// Test route
app.get('/', (req, res) => {
  res.json({ message: 'OquNet API is working' });
});

// Debug route to check active server instance
app.get('/api/debug', (req, res) => {
  res.json({ message: 'OquNet debug OK', timestamp: Date.now() });
});

// API routes
app.use('/api/users', userRoutes);
app.use('/api/books', bookRoutes);
app.use('/api/communities', communityRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/search', searchRoutes);

// Sync DB (auto-alter to keep schema in sync with models)
db.sequelize.sync({ alter: true }).then(() => {
  console.log('Database synced');
});

// Temporary health-check route for debugging
app.get('/__health', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = app;