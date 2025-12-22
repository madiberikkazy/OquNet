// src/models/community.js (or communities.js)
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
    }
  }, {
    tableName: 'Communities',
    timestamps: true
  });

  return Community;
};