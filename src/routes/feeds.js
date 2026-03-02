const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const authMiddleware = require('../middleware/auth');

const FEEDS_FILE = path.join(__dirname, '../data/feeds.json');

// Get all feeds
router.get('/', (req, res) => {
    try {
        const data = fs.readFileSync(FEEDS_FILE, 'utf8');
        const feeds = JSON.parse(data);
        res.json(feeds);
    } catch (error) {
        console.error('Error reading feeds file:', error);
        res.status(500).json({ message: 'Error fetching feeds' });
    }
});

// Get single feed by ID
router.get('/:id', (req, res) => {
    try {
        const data = fs.readFileSync(FEEDS_FILE, 'utf8');
        const feeds = JSON.parse(data);
        const feed = feeds.find(f => f.id === req.params.id);

        if (!feed) {
            return res.status(404).json({ message: 'Feed not found' });
        }

        res.json(feed);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching feed' });
    }
});

module.exports = router;
