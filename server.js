const { createApp } = require('./src/app');
const PORT = process.env.PORT || 3000;
createApp().server.listen(PORT, () => console.log(`TaskFlow running on http://localhost:${PORT}`));
