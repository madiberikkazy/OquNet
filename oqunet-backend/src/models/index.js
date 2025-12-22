// src/models/index.js
const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize('oqunet', 'madiberikkazy004', '', {
  host: 'localhost',
  dialect: 'postgres',
  logging: false
});

const db = {};
db.Sequelize = Sequelize;
db.sequelize = sequelize;

// Import models
// Note: filenames in /src/models are plural for most models
db.User = require('./users')(sequelize, DataTypes);
db.Book = require('./books')(sequelize, DataTypes);
db.Community = require('./communities')(sequelize, DataTypes);
db.BookHistory = require('./bookHistory')(sequelize, DataTypes);

// Define relationships
// Book -> User (holder)
db.Book.belongsTo(db.User, { as: 'holder', foreignKey: 'current_holder_id' });
db.User.hasMany(db.Book, { as: 'borrowedBooks', foreignKey: 'current_holder_id' });

// Book -> Community
db.Book.belongsTo(db.Community, { foreignKey: 'community_id' });
db.Community.hasMany(db.Book, { foreignKey: 'community_id' });

// User -> Community
db.User.belongsTo(db.Community, { as: 'community', foreignKey: 'community_id' });
db.Community.hasMany(db.User, { as: 'members', foreignKey: 'community_id' });

// BookHistory relationships
// Use cascading deletes so histories are cleaned up when a Book or User is removed
db.BookHistory.belongsTo(db.Book, { foreignKey: 'book_id', onDelete: 'CASCADE' });
db.BookHistory.belongsTo(db.User, { as: 'borrower', foreignKey: 'user_id', onDelete: 'CASCADE' });
db.Book.hasMany(db.BookHistory, { as: 'history', foreignKey: 'book_id', onDelete: 'CASCADE' });
db.User.hasMany(db.BookHistory, { as: 'borrowHistory', foreignKey: 'user_id', onDelete: 'CASCADE' });

module.exports = db;