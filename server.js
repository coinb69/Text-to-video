const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from both root and public directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Smart HTML route resolver
app.get('*', (req, res) => {
    const publicIndexPath = path.join(__dirname, 'public', 'index.html');
    const rootIndexPath = path.join(__dirname, 'index.html');

    if (fs.existsSync(publicIndexPath)) {
        res.sendFile(publicIndexPath);
    } else if (fs.existsSync(rootIndexPath)) {
        res.sendFile(rootIndexPath);
    } else {
        res.status(404).send('index.html file not found in root or public folder.');
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
