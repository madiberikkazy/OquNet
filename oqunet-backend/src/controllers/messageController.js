// src/controllers/messageController.js
const db = require('../models');

// Get user's messages
exports.getMyMessages = async (req, res) => {
  try {
    const userId = req.user.id;

    const messages = await db.Message.findAll({
      where: {
        to_user_id: userId
      },
      include: [
        { model: db.User, as: 'fromUser', attributes: ['id', 'name'] },
        { model: db.Book, attributes: ['id', 'title'] }
      ],
      order: [['createdAt', 'DESC']]
    });

    res.json({ 
      success: true,
      messages: messages.map(m => m.toJSON())
    });
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// Mark message as read
exports.markAsRead = async (req, res) => {
  try {
    const { message_id } = req.params;
    const userId = req.user.id;

    const message = await db.Message.findByPk(message_id);

    if (!message) {
      return res.status(404).json({ message: 'Хабарлама табылмады' });
    }

    if (message.to_user_id !== userId) {
      return res.status(403).json({ message: 'Рұқсат жоқ' });
    }

    message.is_read = true;
    await message.save();

    res.json({ 
      success: true,
      message: 'Хабарлама оқылды деп белгіленді' 
    });
  } catch (err) {
    console.error('Mark as read error:', err);
    res.status(500).json({ message: err.message });
  }
};

// Get unread count
exports.getUnreadCount = async (req, res) => {
  try {
    const userId = req.user.id;

    const count = await db.Message.count({
      where: {
        to_user_id: userId,
        is_read: false
      }
    });

    res.json({ 
      success: true,
      count 
    });
  } catch (err) {
    console.error('Get unread count error:', err);
    res.status(500).json({ success: false, count: 0 });
  }
};