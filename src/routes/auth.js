const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { User, College } = require('../models');
const router = express.Router();

router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        // Check if user exists
        let user = await User.findOne({
            where: { email },
            include: [College]
        });

        // For demo purposes: if no users exist at all, create an admin user
        const userCount = await User.count();
        if (userCount === 0 && email === 'admin@example.com' && password === 'admin123') {
            const demoCollege = await College.create({ name: 'Default College' });
            const hashedPassword = await bcrypt.hash('admin123', 10);
            user = await User.create({
                firstName: 'System',
                lastName: 'Administrator',
                email: 'admin@example.com',
                password: hashedPassword,
                mobileNo: '1234567890',
                role: 'ADMIN',
                collegeId: demoCollege.id
            });
            user = await User.findOne({ where: { id: user.id }, include: [College] });
        }

        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Verify password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            process.env.JWT_SECRET || 'cctv_secret',
            { expiresIn: '24h' }
        );

        return res.json({
            token,
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                fullName: user.fullName,
                email: user.email,
                mobileNo: user.mobileNo,
                role: user.role,
                college: user.College ? user.College.name : null
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error during login' });
    }
});

module.exports = router;
