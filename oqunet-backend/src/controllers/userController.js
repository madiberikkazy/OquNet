// src/controllers/userController.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../models');

exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await db.User.findOne({ 
      where: { email },
      include: [{ model: db.Community, as: 'community', attributes: ['id', 'name'] }]
    });
    
    if (!user) return res.status(400).json({ message: 'User табылмады' });

    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) return res.status(400).json({ message: 'Пароль қате' });

    const token = jwt.sign({ id: user.id }, 'your_jwt_secret', { expiresIn: '24h' });
    
    res.json({ 
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        community_id: user.community_id,
        community: user.community
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: err.message });
  }
};

exports.addUser = async (req, res) => {
  const { name, email, phone, password, role, community_id } = req.body;

  const hashedPassword = bcrypt.hashSync(password, 10);
  try {
    const user = await db.User.create({ 
      name, 
      email,
      phone: phone || '',
      password: hashedPassword, 
      role: role || 'user',
      community_id: role === 'admin' ? null : community_id
    });
    res.json(user);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.deleteUser = async (req, res) => {
  const id = req.params.id;
  
  try {
    const user = await db.User.findByPk(id);
    if (!user) return res.status(404).json({ message: 'User табылмады' });

    // Check if user is admin - can't delete admin
    if (user.role === 'admin') {
      return res.status(403).json({ message: 'Админ аккаунтын өшіруге болмайды' });
    }

    // Check if requesting user has permission
    // Admin can delete anyone, user can only delete themselves
    if (req.user.role !== 'admin' && req.user.id !== user.id) {
      return res.status(403).json({ message: 'Рұқсат жоқ' });
    }

    await user.destroy();
    res.json({ message: 'User өшірілді' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ message: err.message });
  }
};

exports.getAllUsers = async (req, res) => {
  try {
    const users = await db.User.findAll({
      attributes: ['id', 'name', 'email', 'phone', 'role', 'community_id'],
      include: [{ model: db.Community, as: 'community', attributes: ['name'] }]
    });
    res.json({ users });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Update user profile
exports.updateProfile = async (req, res) => {
  const userId = req.user.id;
  const { name, email, phone } = req.body;

  console.log('Update profile request:', { userId, name, email, phone });

  try {
    const user = await db.User.findByPk(userId);
    if (!user) {
      console.error('User not found:', userId);
      return res.status(404).json({ message: 'User табылмады' });
    }

    // Check if email is being changed and if it's already taken
    if (email && email !== user.email) {
      const existingUser = await db.User.findOne({ where: { email } });
      if (existingUser) {
        console.warn('Email already exists:', email);
        return res.status(400).json({ message: 'Бұл email басқа қолданушыда бар' });
      }
    }

    // Update fields
    if (name) user.name = name;
    if (email) user.email = email;
    if (phone) user.phone = phone;

    await user.save();
    console.log('User updated successfully:', userId);

    // Return updated user with community
    const updatedUser = await db.User.findByPk(userId, {
      attributes: ['id', 'name', 'email', 'phone', 'role', 'community_id'],
      include: [{ model: db.Community, as: 'community', attributes: ['id', 'name'] }]
    });

    console.log('Returning updated user:', updatedUser.toJSON());

    res.json({ 
      message: 'Профиль жаңартылды',
      user: updatedUser.toJSON()
    });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ message: err.message });
  }
};

// Join community with access code
exports.joinCommunity = async (req, res) => {
  const userId = req.user.id;
  const { access_code } = req.body;

  try {
    const user = await db.User.findByPk(userId);
    if (!user) return res.status(404).json({ message: 'User табылмады' });

    if (user.community_id) {
      return res.status(400).json({ message: 'Сіз қазірдің өзінде қоғамдастыққа қосылғансыз' });
    }

    // Find community by access code
    const community = await db.Community.findOne({ where: { access_code: access_code.toUpperCase() } });
    if (!community) {
      return res.status(404).json({ message: 'Қате код. Қоғамдастық табылмады' });
    }

    user.community_id = community.id;
    await user.save();

    // Return updated user with community
    const updatedUser = await db.User.findByPk(userId, {
      attributes: ['id', 'name', 'email', 'phone', 'role', 'community_id'],
      include: [{ model: db.Community, as: 'community', attributes: ['id', 'name', 'access_code'] }]
    });

    res.json({ 
      message: `${community.name} қоғамдастығына қосылдыңыз!`,
      user: updatedUser.toJSON()
    });
  } catch (err) {
    console.error('Join community error:', err);
    res.status(500).json({ message: err.message });
  }
};

// Leave community
exports.leaveCommunity = async (req, res) => {
  const userId = req.user.id;

  try {
    const user = await db.User.findByPk(userId, {
      include: [{ model: db.Community, as: 'community' }]
    });
    
    if (!user) return res.status(404).json({ message: 'User табылмады' });

    if (!user.community_id) {
      return res.status(400).json({ message: 'Сіз ешбір қоғамдастыққа қосылмағансыз' });
    }

    // Check if user has borrowed books
    const borrowedBook = await db.Book.findOne({ where: { current_holder_id: userId } });
    if (borrowedBook) {
      return res.status(400).json({ 
        message: `Алдымен кітапты қайтарыңыз: "${borrowedBook.title}"`
      });
    }

    const communityName = user.community.name;
    user.community_id = null;
    await user.save();

    // Return updated user
    const updatedUser = await db.User.findByPk(userId, {
      attributes: ['id', 'name', 'email', 'phone', 'role', 'community_id']
    });

    res.json({ 
      message: `${communityName} қоғамдастығынан шықтыңыз`,
      user: updatedUser.toJSON()
    });
  } catch (err) {
    console.error('Leave community error:', err);
    res.status(500).json({ message: err.message });
  }
};