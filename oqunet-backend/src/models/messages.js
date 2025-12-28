// src/models/messages.js
module.exports = (sequelize, DataTypes) => {
  const Message = sequelize.define('Message', {
    id: { 
      type: DataTypes.INTEGER, 
      primaryKey: true, 
      autoIncrement: true 
    },
    from_user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'Users',
        key: 'id'
      }
    },
    to_user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'Users',
        key: 'id'
      }
    },
    book_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'Books',
        key: 'id'
      }
    },
    message_type: {
      type: DataTypes.ENUM('transfer_request', 'transfer_code', 'chat'),
      allowNull: false
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    is_read: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    transfer_code: {
      type: DataTypes.STRING(6),
      allowNull: true
    }
  }, {
    tableName: 'Messages',
    timestamps: true
  });

  return Message;
};