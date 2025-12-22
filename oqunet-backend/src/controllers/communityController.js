// src/controllers/communityController.js
const db = require('../models');

exports.addCommunity = async (req, res) => {
  const { name, description, access_code } = req.body;
  try {
    if (!access_code) {
      return res.status(400).json({ success: false, message: 'Кіру коды міндетті' });
    }

    // Check if access code already exists
    const existingCommunity = await db.Community.findOne({ where: { access_code: access_code.toUpperCase() } });
    if (existingCommunity) {
      return res.status(400).json({ success: false, message: 'Бұл кіру коды басқа қоғамдастықта бар' });
    }

    const community = await db.Community.create({ 
      name, 
      description,
      access_code: access_code.toUpperCase()
    });
    
    console.log('✅ Community created:', community.toJSON());
    
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
    const communities = await db.Community.findAll({
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

// PUBLIC endpoint - auth керек емес
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