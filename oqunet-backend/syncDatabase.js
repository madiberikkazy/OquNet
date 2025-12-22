// syncDatabase.js
const db = require('./src/models');

async function syncDatabase() {
  try {
    console.log('🔄 Starting database synchronization...');
    
    // Force sync - this will DROP all tables and recreate them
    // WARNING: This will delete all data!
    await db.sequelize.sync({ force: true });
    
    console.log('✅ Database synchronized successfully!');
    console.log('📋 Tables created:');
    console.log('   - Users');
    console.log('   - Communities');
    console.log('   - Books');
    
    console.log('\n⚠️  All data has been cleared!');
    console.log('💡 Run: node seedAdmin.js to create admin user again');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error syncing database:', error);
    process.exit(1);
  }
}

syncDatabase();