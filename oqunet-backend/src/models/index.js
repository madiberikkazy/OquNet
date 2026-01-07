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
db.User = require('./users')(sequelize, DataTypes);
db.Book = require('./books')(sequelize, DataTypes);
db.Community = require('./communities')(sequelize, DataTypes);
db.BookHistory = require('./bookHistory')(sequelize, DataTypes);
db.Message = require('./messages')(sequelize, DataTypes);

// Define relationships
// Book -> User (holder)
db.Book.belongsTo(db.User, { as: 'holder', foreignKey: 'current_holder_id' });
db.User.hasMany(db.Book, { as: 'borrowedBooks', foreignKey: 'current_holder_id' });

// Book -> User (initial holder)
db.Book.belongsTo(db.User, { as: 'initialHolder', foreignKey: 'initial_holder_id' });
db.User.hasMany(db.Book, { as: 'initiallyHeldBooks', foreignKey: 'initial_holder_id' });

// Book -> User (pending transfer)
db.Book.belongsTo(db.User, { as: 'pendingUser', foreignKey: 'pending_user_id' });

// Book -> Community
db.Book.belongsTo(db.Community, { foreignKey: 'community_id' });
db.Community.hasMany(db.Book, { foreignKey: 'community_id' });

// User -> Community
db.User.belongsTo(db.Community, { as: 'community', foreignKey: 'community_id' });
db.Community.hasMany(db.User, { as: 'members', foreignKey: 'community_id' });

// Community -> User (owner)
db.Community.belongsTo(db.User, { as: 'owner', foreignKey: 'owner_id' });
db.User.hasMany(db.Community, { as: 'ownedCommunities', foreignKey: 'owner_id' });

// BookHistory relationships
db.BookHistory.belongsTo(db.Book, { foreignKey: 'book_id', onDelete: 'CASCADE' });
db.BookHistory.belongsTo(db.User, { as: 'borrower', foreignKey: 'user_id', onDelete: 'CASCADE' });
db.Book.hasMany(db.BookHistory, { as: 'history', foreignKey: 'book_id', onDelete: 'CASCADE' });
db.User.hasMany(db.BookHistory, { as: 'borrowHistory', foreignKey: 'user_id', onDelete: 'CASCADE' });

// Message relationships
db.Message.belongsTo(db.User, { as: 'fromUser', foreignKey: 'from_user_id' });
db.Message.belongsTo(db.User, { as: 'toUser', foreignKey: 'to_user_id' });
db.Message.belongsTo(db.Book, { foreignKey: 'book_id' });
db.User.hasMany(db.Message, { as: 'sentMessages', foreignKey: 'from_user_id' });
db.User.hasMany(db.Message, { as: 'receivedMessages', foreignKey: 'to_user_id' });
db.Book.hasMany(db.Message, { foreignKey: 'book_id' });

module.exports = db;