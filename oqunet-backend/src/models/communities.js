// src/models/communities.js
module.exports = (sequelize, DataTypes) => {
  const Community = sequelize.define('Community', {
    id: { 
      type: DataTypes.INTEGER, 
      primaryKey: true, 
      autoIncrement: true 
    },
    name: { 
      type: DataTypes.STRING, 
      allowNull: false 
    },
    description: { 
      type: DataTypes.STRING, 
      allowNull: true 
    },
    access_code: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true
    },
    owner_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Users',
        key: 'id'
      }
    }
  }, {
    tableName: 'Communities',
    timestamps: true
  });

  return Community;
};