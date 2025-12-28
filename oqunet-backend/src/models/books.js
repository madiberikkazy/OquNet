// oqunet-backend/src/models/books.js
module.exports = (sequelize, DataTypes) => {
  const Book = sequelize.define('Book', {
    id: { 
      type: DataTypes.INTEGER, 
      primaryKey: true, 
      autoIncrement: true 
    },
    title: { 
      type: DataTypes.STRING, 
      allowNull: false 
    },
    author: { 
      type: DataTypes.STRING, 
      allowNull: true
    },
    image_url: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    community_id: { 
      type: DataTypes.INTEGER, 
      allowNull: false,
      references: {
        model: 'Communities',
        key: 'id'
      }
    },
    current_holder_id: { 
      type: DataTypes.INTEGER, 
      allowNull: true,
      references: {
        model: 'Users',
        key: 'id'
      }
    },
    borrowed_at: { 
      type: DataTypes.DATE, 
      allowNull: true 
    },
    borrow_days: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 14
    }
  }, {
    tableName: 'Books',
    timestamps: true
  });

  return Book;
};