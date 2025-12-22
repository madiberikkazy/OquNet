const bcrypt = require('bcrypt');
const db = require('./src/models');

async function seedAdmin() {
  await db.sequelize.sync({ alter: true });

  const hashedPassword = bcrypt.hashSync('admin123', 10);

  const [admin, created] = await db.User.findOrCreate({
    where: { email: 'admin@mail.com' },
    defaults: {
      name: 'Admin',
      password: hashedPassword,
      role: 'admin'
    }
  });

  if (created) {
    console.log('Admin user қосылды');
  } else {
    console.log('Admin user бұрыннан бар');
  }

  process.exit();
}

seedAdmin();