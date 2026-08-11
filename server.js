const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static frontend assets from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Fallback Route to load index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Express Server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
