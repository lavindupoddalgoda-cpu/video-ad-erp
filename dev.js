// Local development only. Vercel ignores this file and uses api/index.js.
const path = require('path');
const express = require('express');
const app = require('./api/index.js');
app.use(express.static(path.join(__dirname, 'public')));
app.listen(3000, () => console.log('Mini-ERP running at http://localhost:3000'));
