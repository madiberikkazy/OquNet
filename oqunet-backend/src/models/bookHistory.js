// src/models/bookHistory.js
module.exports = (sequelize, DataTypes) => {
  const BookHistory = sequelize.define('BookHistory', {
    id: { 
      type: DataTypes.INTEGER, 
      primaryKey: true, 
      autoIncrement: true 
    },
    book_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'Books',
        key: 'id'
      }
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'Users',
        key: 'id'
      }
    },
    borrowed_at: {
      type: DataTypes.DATE,
      allowNull: false
    },
    returned_at: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    tableName: 'BookHistories',
    timestamps: false
  });

  return BookHistory;
};