// backend/index.js - COMPLETE SERVER
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'buybuzz',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Initialize database
async function initializeDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                full_name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                phone VARCHAR(20) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                status ENUM('active', 'suspended') DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS wallets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT UNIQUE,
                balance DECIMAL(10,2) DEFAULT 0.00,
                level ENUM('Bronze', 'Silver', 'Gold') DEFAULT 'Bronze',
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Database initialization failed:', error);
    }
}

// Auth middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ error: 'Access token required' });
    
    jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
};

// 1. USER SIGNUP ENDPOINT
app.post('/api/signup', async (req, res) => {
    try {
        const { full_name, email, phone, password, confirm_password } = req.body;
        
        // Validation
        if (!full_name || !email || !phone || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        
        if (password !== confirm_password) {
            return res.status(400).json({ error: 'Passwords do not match' });
        }
        
        // Check if email exists
        const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(409).json({ error: 'Email already registered' });
        }
        
        // Hash password
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        
        // Create user
        const [result] = await pool.query(
            'INSERT INTO users (full_name, email, phone, password_hash) VALUES (?, ?, ?, ?)',
            [full_name, email, phone, password_hash]
        );
        
        // Create wallet for user
        await pool.query(
            'INSERT INTO wallets (user_id, balance, level) VALUES (?, 0.00, "Bronze")',
            [result.insertId]
        );
        
        // Generate JWT token
        const token = jwt.sign(
            { id: result.insertId, email },
            process.env.JWT_SECRET || 'your-secret-key',
            { expiresIn: '24h' }
        );
        
        res.status(201).json({
            success: true,
            message: 'Account created successfully',
            token,
            user: {
                id: result.insertId,
                full_name,
                email,
                phone
            }
        });
        
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// 2. USER LOGIN ENDPOINT
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Find user
        const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = users[0];
        
        // Verify password
        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Get wallet info
        const [wallets] = await pool.query('SELECT * FROM wallets WHERE user_id = ?', [user.id]);
        const wallet = wallets[0] || { balance: 0, level: 'Bronze' };
        
        // Generate token
        const token = jwt.sign(
            { id: user.id, email: user.email },
            process.env.JWT_SECRET || 'your-secret-key',
            { expiresIn: '24h' }
        );
        
        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                full_name: user.full_name,
                email: user.email,
                phone: user.phone
            },
            wallet
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// 3. GET USER PROFILE (PROTECTED)
app.get('/api/profile', authenticateToken, async (req, res) => {
    try {
        const [users] = await pool.query(
            'SELECT id, full_name, email, phone, created_at FROM users WHERE id = ?',
            [req.user.id]
        );
        
        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({
            success: true,
            user: users[0]
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// 4. GET WALLET BALANCE (PROTECTED)
app.get('/api/wallet', authenticateToken, async (req, res) => {
    try {
        const [wallets] = await pool.query(
            'SELECT * FROM wallets WHERE user_id = ?',
            [req.user.id]
        );
        
        const wallet = wallets[0] || { balance: 0, level: 'Bronze' };
        
        // Get transactions (if you have a transactions table)
        const [transactions] = await pool.query(
            'SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
            [req.user.id]
        );
        
        res.json({
            success: true,
            wallet,
            transactions: transactions || []
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// 5. DASHBOARD DATA (PROTECTED)
app.get('/api/dashboard', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Get user info
        const [users] = await pool.query(
            'SELECT full_name FROM users WHERE id = ?',
            [userId]
        );
        
        // Get wallet
        const [wallets] = await pool.query(
            'SELECT balance, level FROM wallets WHERE user_id = ?',
            [userId]
        );
        
        // Get orders count (example)
        const [ordersResult] = await pool.query(
            'SELECT COUNT(*) as total_orders FROM orders WHERE user_id = ?',
            [userId]
        );
        
        // Mock sales data (replace with actual query)
        const weeklySales = [
            { day: 'Mon', amount: 150 },
            { day: 'Tue', amount: 230 },
            { day: 'Wed', amount: 180 },
            { day: 'Thu', amount: 290 },
            { day: 'Fri', amount: 320 },
            { day: 'Sat', amount: 280 },
            { day: 'Sun', amount: 190 }
        ];
        
        res.json({
            success: true,
            data: {
                user: users[0],
                wallet: wallets[0] || { balance: 0, level: 'Bronze' },
                stats: {
                    total_orders: ordersResult[0]?.total_orders || 0,
                    completed_orders: 0, // Add actual query
                    pending_orders: 0,   // Add actual query
                    total_sales: 1250.50
                },
                weekly_sales: weeklySales,
                recent_activity: [
                    { action: 'Logged in', time: '2 hours ago' },
                    { action: 'Topped up wallet', amount: 'GHS 100', time: '1 day ago' },
                    { action: 'Purchased MTN 5GB', amount: 'GHS 25', time: '2 days ago' }
                ]
            }
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        service: 'BuyBuzz DataHub API',
        timestamp: new Date().toISOString()
    });
});

// Start server
async function startServer() {
    await initializeDB();
    
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`📁 API Endpoints:`);
        console.log(`   POST /api/signup      - User registration`);
        console.log(`   POST /api/login       - User login`);
        console.log(`   GET  /api/profile     - Get user profile (requires auth)`);
        console.log(`   GET  /api/wallet      - Get wallet balance (requires auth)`);
        console.log(`   GET  /api/dashboard   - Get dashboard data (requires auth)`);
        console.log(`   GET  /health          - Health check`);
    });
}

startServer();