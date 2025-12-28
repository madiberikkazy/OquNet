// src/controllers/communityController.js
const db = require('../models');

// User can create their own community
exports.createCommunity = async (req, res) => {
  const { name, description, access_code } = req.body;
  const userId = req.user.id;
  
  try {
    if (!name || !access_code) {
      return res.status(400).json({ message: 'Атауы және кіру коды міндетті' });
    }

    if (access_code.length < 4) {
      return res.status(400).json({ message: 'Кіру коды кем дегенде 4 таңба болуы керек' });
    }

    // Check if access code already exists
    const existingCommunity = await db.Community.findOne({ 
      where: { access_code: access_code.toUpperCase() } 
    });
    
    if (existingCommunity) {
      return res.status(400).json({ message: 'Бұл кіру коды басқа қоғамдастықта бар' });
    }

    // Create community with owner
    const community = await db.Community.create({ 
      name, 
      description: description || '',
      access_code: access_code.toUpperCase(),
      owner_id: userId
    });

    // Automatically join the user to their community
    const user = await db.User.findByPk(userId);
    user.community_id = community.id;
    await user.save();

    // Reload with owner info
    await community.reload({
      include: [{ model: db.User, as: 'owner', attributes: ['id', 'name', 'email'] }]
    });

    // Get updated user with community
    const updatedUser = await db.User.findByPk(userId, {
      include: [{ model: db.Community, as: 'community', attributes: ['id', 'name', 'access_code'] }]
    });
    
    console.log('✅ Community created by user:', community.toJSON());
    
    res.json({ 
      success: true,
      message: 'Қоғамдастық құрылды және сіз автоматты түрде қосылдыңыз!',
      community: community.toJSON(),
      user: updatedUser.toJSON()
    });
  } catch (err) {
    console.error('❌ Error creating community:', err);
    res.status(400).json({ success: false, message: err.message });
  }
};

// Admin: Add community (legacy)
exports.addCommunity = async (req, res) => {
  const { name, description, access_code } = req.body;
  try {
    if (!access_code) {
      return res.status(400).json({ success: false, message: 'Кіру коды міндетті' });
    }

    const existingCommunity = await db.Community.findOne({ 
      where: { access_code: access_code.toUpperCase() } 
    });
    
    if (existingCommunity) {
      return res.status(400).json({ success: false, message: 'Бұл кіру коды басқа қоғамдастықта бар' });
    }

    const community = await db.Community.create({ 
      name, 
      description,
      access_code: access_code.toUpperCase(),
      owner_id: null // Admin communities have no owner
    });
    
    console.log('✅ Admin community created:', community.toJSON());
    
    res.json({ 
      success: true,
      message: 'Community қосылды',
      community: community.toJSON() 
    });
  } catch (err) {
    console.error('❌ Error creating community:', err);
    res.status(400).json({ success: false, message: err.message });
  }
};

exports.deleteCommunity = async (req, res) => {
  try {
    const id = req.params.id;
    const community = await db.Community.findByPk(id);
    
    if (!community) {
      return res.status(404).json({ success: false, message: 'Community табылмады' });
    }

    // Check if user has permission to delete
    if (req.user.role !== 'admin' && community.owner_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Сіз бұл қоғамдастықты өшіре алмайсыз' });
    }

    await community.destroy();
    console.log('✅ Community deleted:', id);
    res.json({ success: true, message: 'Community өшірілді' });
  } catch (err) {
    console.error('❌ Error deleting community:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getAllCommunities = async (req, res) => {
  try {
    const where = {};
    
    // If user is not admin, show only their owned communities
    if (req.user.role !== 'admin') {
      where.owner_id = req.user.id;
    }

    const communities = await db.Community.findAll({
      where,
      include: [
        { 
          model: db.User, 
          as: 'owner', 
          attributes: ['id', 'name', 'email'] 
        }
      ],
      order: [['id', 'ASC']]
    });
    
    const plainCommunities = communities.map(c => c.toJSON());
    
    console.log('✅ Communities fetched:', plainCommunities.length);
    
    res.json({ 
      success: true,
      communities: plainCommunities 
    });
  } catch (err) {
    console.error('❌ Error fetching communities:', err);
    res.status(500).json({ success: false, message: err.message, communities: [] });
  }
};

exports.getPublicCommunities = async (req, res) => {
  try {
    const communities = await db.Community.findAll({
      attributes: ['id', 'name', 'description'],
      order: [['name', 'ASC']]
    });
    
    res.json({ 
      success: true,
      communities: communities.map(c => c.toJSON())
    });
  } catch (err) {
    console.error('❌ Error fetching public communities:', err);
    res.status(500).json({ success: false, message: err.message, communities: [] });
  }
};

// Get community members (for owners)
exports.getCommunityMembers = async (req, res) => {
  try {
    const communityId = req.params.communityId;
    const community = await db.Community.findByPk(communityId);
    
    if (!community) {
      return res.status(404).json({ message: 'Қоғамдастық табылмады' });
    }

    // Check permission
    if (req.user.role !== 'admin' && community.owner_id !== req.user.id) {
      return res.status(403).json({ message: 'Рұқсат жоқ' });
    }

    const members = await db.User.findAll({
      where: { community_id: communityId },
      attributes: ['id', 'name', 'email', 'phone', 'createdAt']
    });

    res.json({ 
      success: true, 
      members: members.map(m => m.toJSON()) 
    });
  } catch (err) {
    console.error('Error fetching community members:', err);
    res.status(500).json({ message: err.message });
  }
};

// Remove member from community (owner only)
exports.removeMember = async (req, res) => {
  try {
    const { communityId, userId } = req.params;
    const community = await db.Community.findByPk(communityId);
    
    if (!community) {
      return res.status(404).json({ message: 'Қоғамдастық табылмады' });
    }

    // Check permission
    if (req.user.role !== 'admin' && community.owner_id !== req.user.id) {
      return res.status(403).json({ message: 'Рұқсат жоқ' });
    }

    const user = await db.User.findByPk(userId);
    
    if (!user) {
      return res.status(404).json({ message: 'Қолданушы табылмады' });
    }

    if (user.community_id !== parseInt(communityId)) {
      return res.status(400).json({ message: 'Бұл қолданушы қоғамдастықта емес' });
    }

    // Can't remove owner
    if (user.id === community.owner_id) {
      return res.status(400).json({ message: 'Иені өшіруге болмайды' });
    }

    // Check if user has borrowed books
    const borrowedBook = await db.Book.findOne({ where: { current_holder_id: userId } });
    if (borrowedBook) {
      return res.status(400).json({ 
        message: `Қолданушының кітабы бар: "${borrowedBook.title}". Алдымен кітапты қайтару керек.` 
      });
    }

    user.community_id = null;
    await user.save();

    res.json({ 
      success: true, 
      message: `${user.name} қоғамдастықтан шығарылды` 
    });
  } catch (err) {
    console.error('Error removing member:', err);
    res.status(500).json({ message: err.message });
  }
};