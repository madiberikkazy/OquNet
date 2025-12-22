const path = require('path');
const app = require('./src/app');

console.log('server.js cwd:', process.cwd());
console.log('__dirname:', __dirname);
console.log('main module filename:', require.main && require.main.filename);

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});