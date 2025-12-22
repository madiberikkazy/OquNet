// src/models/user.js (or users.js)
module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define('User', {
    id: { 
      type: DataTypes.INTEGER, 
      primaryKey: true, 
      autoIncrement: true 
    },
    name: { 
      type: DataTypes.STRING, 
      allowNull: false 
    },
    email: { 
      type: DataTypes.STRING, 
      unique: true, 
      allowNull: false 
    },
    phone: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: ''
    },
    password: { 
      type: DataTypes.STRING, 
      allowNull: false 
    },
    role: { 
      type: DataTypes.STRING, 
      defaultValue: 'user' 
    },
    community_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Communities',
        key: 'id'
      }
    }
  }, {
    tableName: 'Users',
    timestamps: true
  });

  return User;
};