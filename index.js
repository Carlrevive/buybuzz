// backend/index.js - COMPLETE SERVER WITH PAYSTACK & DATA BUNDLE API
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const axios = require('axios');
const crypto = require('crypto');
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
    database: process.env.DB_NAME || 'buybuzz_datahub',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Initialize database
async function initializeDB() {
    try {
        // Users table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                full_name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                phone VARCHAR(20) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                status ENUM('active', 'suspended') DEFAULT 'active',
                role ENUM('user', 'admin', 'super_admin') DEFAULT 'user',
                last_login TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Wallets table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS wallets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT UNIQUE,
                balance DECIMAL(10,2) DEFAULT 0.00,
                level ENUM('Bronze', 'Silver', 'Gold', 'Platinum') DEFAULT 'Bronze',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Wallet transactions table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS wallet_transactions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                transaction_id VARCHAR(50) UNIQUE NOT NULL,
                reference VARCHAR(100),
                type ENUM('credit', 'debit', 'transfer_in', 'transfer_out', 'purchase', 'refund') NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                status ENUM('pending', 'completed', 'failed', 'cancelled') DEFAULT 'pending',
                description TEXT,
                metadata JSON,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Orders table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id INT AUTO_INCREMENT PRIMARY KEY,
                order_id VARCHAR(50) UNIQUE NOT NULL,
                user_id INT NOT NULL,
                order_type ENUM('data_bundle', 'results_checker', 'afa_bundle', 'top_up', 'flyer_generation') NOT NULL,
                network ENUM('MTN', 'Telecel', 'AirtelTigo', 'other') DEFAULT 'other',
                bundle_size VARCHAR(50),
                product_name VARCHAR(100),
                amount DECIMAL(10,2) NOT NULL,
                beneficiary_number VARCHAR(20),
                payment_reference VARCHAR(100),
                status ENUM('pending_payment', 'processing', 'completed', 'failed', 'refunded') DEFAULT 'pending_payment',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Order sequence table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS order_sequence (
                id INT AUTO_INCREMENT PRIMARY KEY,
                last_number INT DEFAULT 4000
            )
        `);

        // Data bundle products table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS data_bundle_products (
                id INT AUTO_INCREMENT PRIMARY KEY,
                network ENUM('MTN', 'Telecel', 'AirtelTigo') NOT NULL,
                bundle_size VARCHAR(20) NOT NULL,
                price DECIMAL(10,2) NOT NULL,
                validity_days INT DEFAULT 30,
                status ENUM('active', 'inactive') DEFAULT 'active',
                UNIQUE KEY unique_network_size (network, bundle_size)
            )
        `);

        // Initialize order sequence
        const [seqCheck] = await pool.query('SELECT * FROM order_sequence');
        if (seqCheck.length === 0) {
            await pool.query('INSERT INTO order_sequence (last_number) VALUES (4000)');
        }

        // Insert default bundle products if not exist
        const [productCheck] = await pool.query('SELECT * FROM data_bundle_products');
        if (productCheck.length === 0) {
            await pool.query(`
                INSERT INTO data_bundle_products (network, bundle_size, price) VALUES
                ('MTN', '1GB', 10), ('MTN', '2GB', 18), ('MTN', '5GB', 40), ('MTN', '10GB', 75),
                ('Telecel', '1GB', 9), ('Telecel', '2GB', 17), ('Telecel', '5GB', 38), ('Telecel', '10GB', 72),
                ('AirtelTigo', '1GB', 8), ('AirtelTigo', '2GB', 15), ('AirtelTigo', '5GB', 35), ('AirtelTigo', '10GB', 68)
            `);
        }

        // Create default admin user (password: admin123)
        const [adminCheck] = await pool.query('SELECT * FROM users WHERE email = ?', ['admin@buybuzz.com']);
        if (adminCheck.length === 0) {
            const adminHash = await bcrypt.hash('admin123', 10);
            await pool.query(
                'INSERT INTO users (full_name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)',
                ['System Admin', 'admin@buybuzz.com', '+233501234567', adminHash, 'super_admin']
            );
        }

        console.log('✅ Database initialized successfully');

    } catch (error) {
        console.error('❌ Database initialization failed:', error);
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
        
        if (!full_name || !email || !phone || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        
        if (password !== confirm_password) {
            return res.status(400).json({ error: 'Passwords do not match' });
        }
        
        const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(409).json({ error: 'Email already registered' });
        }
        
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        
        const [result] = await pool.query(
            'INSERT INTO users (full_name, email, phone, password_hash) VALUES (?, ?, ?, ?)',
            [full_name, email, phone, password_hash]
        );
        
        await pool.query(
            'INSERT INTO wallets (user_id, balance, level) VALUES (?, 0.00, "Bronze")',
            [result.insertId]
        );
        
        const token = jwt.sign(
            { id: result.insertId, email },
            process.env.JWT_SECRET || 'your-secret-key',
            { expiresIn: '24h' }
        );
        
        res.status(201).json({
            success: true,
            message: 'Account created successfully',
            token,
            user: { id: result.insertId, full_name, email, phone }
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
        
        const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = users[0];
        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        await pool.query(
            'UPDATE users SET last_login = NOW() WHERE id = ?',
            [user.id]
        );
        
        const [wallets] = await pool.query('SELECT * FROM wallets WHERE user_id = ?', [user.id]);
        const wallet = wallets[0] || { balance: 0, level: 'Bronze' };
        
        const token = jwt.sign(
            { id: user.id, email: user.email },
            process.env.JWT_SECRET || 'your-secret-key',
            { expiresIn: '24h' }
        );
        
        res.json({
            success: true,
            token,
            user: { id: user.id, full_name: user.full_name, email: user.email, phone: user.phone },
            wallet
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// 3. GET USER PROFILE
app.get('/api/profile', authenticateToken, async (req, res) => {
    try {
        const [users] = await pool.query(
            'SELECT id, full_name, email, phone, created_at FROM users WHERE id = ?',
            [req.user.id]
        );
        
        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({ success: true, user: users[0] });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// 4. GET WALLET BALANCE
app.get('/api/wallet', authenticateToken, async (req, res) => {
    try {
        const [wallets] = await pool.query(
            'SELECT * FROM wallets WHERE user_id = ?',
            [req.user.id]
        );
        
        const wallet = wallets[0] || { balance: 0, level: 'Bronze' };
        
        const [transactions] = await pool.query(
            'SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
            [req.user.id]
        );
        
        res.json({ success: true, wallet, transactions: transactions || [] });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// 5. DASHBOARD DATA
app.get('/api/dashboard', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const [users] = await pool.query(
            'SELECT full_name FROM users WHERE id = ?',
            [userId]
        );
        
        const [wallets] = await pool.query(
            'SELECT balance, level FROM wallets WHERE user_id = ?',
            [userId]
        );
        
        const [ordersResult] = await pool.query(
            'SELECT COUNT(*) as total_orders FROM orders WHERE user_id = ?',
            [userId]
        );
        
        const [completedOrders] = await pool.query(
            'SELECT COUNT(*) as completed FROM orders WHERE user_id = ? AND status = "completed"',
            [userId]
        );
        
        const [pendingOrders] = await pool.query(
            'SELECT COUNT(*) as pending FROM orders WHERE user_id = ? AND status IN ("pending_payment", "processing")',
            [userId]
        );
        
        const [recentActivity] = await pool.query(`
            (SELECT 'wallet_transaction' as type, description as action, amount, created_at 
             FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5)
            UNION
            (SELECT 'order' as type, CONCAT('Order #', order_id) as action, amount, created_at 
             FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 5)
            ORDER BY created_at DESC LIMIT 10
        `, [userId, userId]);
        
        res.json({
            success: true,
            data: {
                user: users[0],
                wallet: wallets[0] || { balance: 0, level: 'Bronze' },
                stats: {
                    total_orders: ordersResult[0]?.total_orders || 0,
                    completed_orders: completedOrders[0]?.completed || 0,
                    pending_orders: pendingOrders[0]?.pending || 0,
                    total_sales: 1250.50
                },
                recent_activity: recentActivity.map(act => ({
                    action: act.action,
                    amount: act.amount ? `GHS ${act.amount}` : null,
                    time: new Date(act.created_at).toLocaleDateString()
                }))
            }
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ========== PAYSTACK PAYMENT INTEGRATION ==========

// 6. INITIATE PAYSTACK PAYMENT (Wallet Top-up)
app.post('/api/wallet/topup/initialize', authenticateToken, async (req, res) => {
    try {
        const { amount, email } = req.body;
        
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Valid amount is required' });
        }
        
        const amountInKobo = Math.round(amount * 100);
        
        const response = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email || req.user.email,
                amount: amountInKobo,
                currency: 'GHS',
                callback_url: `${process.env.FRONTEND_URL || 'http://localhost:8080'}/wallet/topup/callback`
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        const reference = response.data.data.reference;
        const transactionId = `PAY-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        await pool.query(
            'INSERT INTO wallet_transactions (user_id, transaction_id, reference, type, amount, status, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                req.user.id,
                transactionId,
                reference,
                'credit',
                amount,
                'pending',
                `Wallet top-up via Paystack`
            ]
        );
        
        res.json({
            success: true,
            authorization_url: response.data.data.authorization_url,
            reference: reference,
            access_code: response.data.data.access_code
        });
        
    } catch (error) {
        console.error('Paystack init error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Payment initialization failed' });
    }
});

// 7. PAYSTACK WEBHOOK FOR PAYMENT VERIFICATION
app.post('/api/webhook/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const hash = crypto.createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET || '')
                          .update(req.body)
                          .digest('hex');
        
        if (hash !== req.headers['x-paystack-signature']) {
            return res.status(401).send('Invalid signature');
        }
        
        const event = JSON.parse(req.body.toString());
        
        if (event.event === 'charge.success') {
            const { reference, amount, customer } = event.data;
            
            const [transactions] = await pool.query(
                'SELECT * FROM wallet_transactions WHERE reference = ? AND status = "pending"',
                [reference]
            );
            
            if (transactions.length > 0) {
                const transaction = transactions[0];
                const amountInGHS = amount / 100;
                
                await pool.query('START TRANSACTION');
                
                try {
                    await pool.query(
                        'UPDATE wallet_transactions SET status = "completed", amount = ? WHERE reference = ?',
                        [amountInGHS, reference]
                    );
                    
                    await pool.query(
                        'UPDATE wallets SET balance = balance + ? WHERE user_id = ?',
                        [amountInGHS, transaction.user_id]
                    );
                    
                    await pool.query('COMMIT');
                    console.log(`✅ Payment ${reference} processed for user ${transaction.user_id}`);
                } catch (err) {
                    await pool.query('ROLLBACK');
                    console.error('Transaction rollback:', err);
                }
            }
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).send('Webhook processing failed');
    }
});

// 8. MANUAL PAYMENT VERIFICATION
app.get('/api/wallet/topup/verify/:reference', authenticateToken, async (req, res) => {
    try {
        const response = await axios.get(
            `https://api.paystack.co/transaction/verify/${req.params.reference}`,
            {
                headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
            }
        );
        
        if (response.data.data.status === 'success') {
            const amount = response.data.data.amount / 100;
            
            await pool.query('START TRANSACTION');
            
            try {
                await pool.query(
                    'UPDATE wallet_transactions SET status = "completed" WHERE reference = ? AND user_id = ?',
                    [req.params.reference, req.user.id]
                );
                
                await pool.query(
                    'UPDATE wallets SET balance = balance + ? WHERE user_id = ?',
                    [amount, req.user.id]
                );
                
                await pool.query('COMMIT');
                
                const [wallets] = await pool.query(
                    'SELECT * FROM wallets WHERE user_id = ?',
                    [req.user.id]
                );
                
                res.json({
                    success: true,
                    message: 'Payment verified and wallet credited',
                    wallet: wallets[0]
                });
            } catch (err) {
                await pool.query('ROLLBACK');
                throw err;
            }
        } else {
            res.json({ success: false, message: 'Payment not successful' });
        }
    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// ========== DATA BUNDLE API ==========

// 9. GET AVAILABLE DATA BUNDLES
app.get('/api/data/bundles', async (req, res) => {
    try {
        const [products] = await pool.query(
            'SELECT * FROM data_bundle_products WHERE status = "active" ORDER BY network, price'
        );
        
        const bundles = {};
        products.forEach(product => {
            if (!bundles[product.network]) {
                bundles[product.network] = [];
            }
            bundles[product.network].push({
                size: product.bundle_size,
                price: product.price,
                validity: `${product.validity_days} days`
            });
        });
        
        res.json({ success: true, bundles });
    } catch (error) {
        console.error('Bundles error:', error);
        res.status(500).json({ error: 'Failed to fetch bundles' });
    }
});

// 10. BUY DATA BUNDLE
app.post('/api/data/buy', authenticateToken, async (req, res) => {
    try {
        const { network, bundle_size, beneficiary_number } = req.body;
        
        if (!['MTN', 'Telecel', 'AirtelTigo'].includes(network)) {
            return res.status(400).json({ error: 'Invalid network' });
        }
        
        if (!bundle_size || !beneficiary_number) {
            return res.status(400).json({ error: 'Bundle size and beneficiary number are required' });
        }
        
        const [product] = await pool.query(
            'SELECT * FROM data_bundle_products WHERE network = ? AND bundle_size = ? AND status = "active"',
            [network, bundle_size]
        );
        
        if (product.length === 0) {
            return res.status(400).json({ error: 'Invalid bundle selection' });
        }
        
        const price = product[0].price;
        
        const [wallets] = await pool.query(
            'SELECT balance FROM wallets WHERE user_id = ?',
            [req.user.id]
        );
        
        if (wallets[0].balance < price) {
            return res.status(400).json({ error: 'Insufficient wallet balance' });
        }
        
        const [seq] = await pool.query('SELECT last_number FROM order_sequence');
        const orderId = `BUZZ-${seq[0].last_number + 1}`;
        
        await pool.query('START TRANSACTION');
        
        try {
            await pool.query(
                'UPDATE wallets SET balance = balance - ? WHERE user_id = ?',
                [price, req.user.id]
            );
            
            const transactionId = `DATA-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            await pool.query(
                'INSERT INTO wallet_transactions (user_id, transaction_id, type, amount, description, status) VALUES (?, ?, ?, ?, ?, ?)',
                [
                    req.user.id,
                    transactionId,
                    'debit',
                    price,
                    `${network} ${bundle_size} data bundle`,
                    'completed'
                ]
            );
            
            await pool.query(
                `INSERT INTO orders (order_id, user_id, order_type, product_name, network, bundle_size, amount, beneficiary_number, status) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    orderId,
                    req.user.id,
                    'data_bundle',
                    `${network} ${bundle_size}`,
                    network,
                    bundle_size,
                    price,
                    beneficiary_number,
                    'processing'
                ]
            );
            
            await pool.query(
                'UPDATE order_sequence SET last_number = last_number + 1'
            );
            
            await pool.query('COMMIT');
            
            // SIMULATE DATA DELIVERY (Replace with actual vendor API call)
            setTimeout(async () => {
                try {
                    await pool.query(
                        'UPDATE orders SET status = "completed", delivered_at = NOW() WHERE order_id = ?',
                        [orderId]
                    );
                    console.log(`✅ Data bundle delivered: ${orderId}`);
                } catch (err) {
                    console.error('Delivery update error:', err);
                }
            }, 3000);
            
            res.json({
                success: true,
                message: 'Data bundle purchase initiated',
                order_id: orderId,
                amount: price,
                status: 'processing',
                beneficiary: beneficiary_number
            });
            
        } catch (error) {
            await pool.query('ROLLBACK');
            throw error;
        }
        
    } catch (error) {
        console.error('Data purchase error:', error);
        res.status(500).json({ error: 'Data purchase failed' });
    }
});

// 11. CHECK ORDER STATUS
app.get('/api/orders/:orderId', authenticateToken, async (req, res) => {
    try {
        const [orders] = await pool.query(
            'SELECT * FROM orders WHERE order_id = ? AND user_id = ?',
            [req.params.orderId, req.user.id]
        );
        
        if (orders.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        res.json({ success: true, order: orders[0] });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// 12. GET USER ORDERS
app.get('/api/orders', authenticateToken, async (req, res) => {
    try {
        const { status, limit = 20, offset = 0 } = req.query;
        
        let query = 'SELECT * FROM orders WHERE user_id = ?';
        const params = [req.user.id];
        
        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }
        
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));
        
        const [orders] = await pool.query(query, params);
        
        const [total] = await pool.query(
            'SELECT COUNT(*) as count FROM orders WHERE user_id = ?',
            [req.user.id]
        );
        
        res.json({
            success: true,
            orders,
            pagination: {
                total: total[0].count,
                limit: parseInt(limit),
                offset: parseInt(offset)
            }
        });
    } catch (error) {
        console.error('Orders error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ========== ADMIN ENDPOINTS ==========

// 13. GET ALL USERS (Admin only)
app.get('/api/admin/users', authenticateToken, async (req, res) => {
    try {
        const [user] = await pool.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
        if (user[0].role !== 'admin' && user[0].role !== 'super_admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        
        const [users] = await pool.query(`
            SELECT u.*, w.balance, w.level 
            FROM users u 
            LEFT JOIN wallets w ON u.id = w.user_id 
            ORDER BY u.created_at DESC
        `);
        
        res.json({ success: true, users });
    } catch (error) {
        console.error('Admin users error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// 14. GET SYSTEM STATS (Admin only)
app.get('/api/admin/stats', authenticateToken, async (req, res) => {
    try {
        const [user] = await pool.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
        if (user[0].role !== 'admin' && user[0].role !== 'super_admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        
        const [userCount] = await pool.query('SELECT COUNT(*) as count FROM users');
        const [orderCount] = await pool.query('SELECT COUNT(*) as count FROM orders');
        const [todayOrders] = await pool.query(
            'SELECT COUNT(*) as count FROM orders WHERE DATE(created_at) = CURDATE()'
        );
        const [totalRevenue] = await pool.query(
            'SELECT SUM(amount) as total FROM orders WHERE status = "completed"'
        );
        const [walletTotal] = await pool.query('SELECT SUM(balance) as total FROM wallets');
        
        res.json({
            success: true,
            stats: {
                total_users: userCount[0].count,
                total_orders: orderCount[0].count,
                today_orders: todayOrders[0].count,
                total_revenue: totalRevenue[0].total || 0,
                total_wallet_balance: walletTotal[0].total || 0
            }
        });
    } catch (error) {
        console.error('Admin stats error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ========== UTILITY ENDPOINTS ==========

// 15. HEALTH CHECK
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        service: 'BuyBuzz DataHub API',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        features: ['auth', 'wallet', 'paystack', 'data-bundles', 'orders']
    });
});

// 16. UPDATE BUNDLE PRICES (Admin)
app.put('/api/admin/bundle/:id', authenticateToken, async (req, res) => {
    try {
        const [user] = await pool.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
        if (user[0].role !== 'admin' && user[0].role !== 'super_admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        
        const { price, status } = req.body;
        
        if (price !== undefined && (isNaN(price) || price <= 0)) {
            return res.status(400).json({ error: 'Invalid price' });
        }
        
        const updates = [];
        const params = [];
        
        if (price !== undefined) {
            updates.push('price = ?');
            params.push(price);
        }
        
        if (status !== undefined && ['active', 'inactive'].includes(status)) {
            updates.push('status = ?');
            params.push(status);
        }
        
        if (updates.length === 0) {
            return res.status(400).json({ error: 'No updates provided' });
        }
        
        params.push(req.params.id);
        
        await pool.query(
            `UPDATE data_bundle_products SET ${updates.join(', ')} WHERE id = ?`,
            params
        );
        
        res.json({ success: true, message: 'Bundle updated successfully' });
    } catch (error) {
        console.error('Update bundle error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// 17. WALLET-TO-WALLET TRANSFER
app.post('/api/wallet/transfer', authenticateToken, async (req, res) => {
    try {
        const { recipient_email, amount, note } = req.body;
        
        if (!recipient_email || !amount || amount <= 0) {
            return res.status(400).json({ error: 'Valid recipient email and amount required' });
        }
        
        if (recipient_email === req.user.email) {
            return res.status(400).json({ error: 'Cannot transfer to yourself' });
        }
        
        const [recipient] = await pool.query('SELECT id FROM users WHERE email = ?', [recipient_email]);
        if (recipient.length === 0) {
            return res.status(404).json({ error: 'Recipient not found' });
        }
        
        const [senderWallet] = await pool.query(
            'SELECT balance FROM wallets WHERE user_id = ?',
            [req.user.id]
        );
        
        if (senderWallet[0].balance < amount) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        await pool.query('START TRANSACTION');
        
        try {
            // Deduct from sender
            await pool.query(
                'UPDATE wallets SET balance = balance - ? WHERE user_id = ?',
                [amount, req.user.id]
            );
            
            const senderTxId = `TRANSFER-OUT-${Date.now()}`;
            await pool.query(
                'INSERT INTO wallet_transactions (user_id, transaction_id, type, amount, description, status) VALUES (?, ?, ?, ?, ?, ?)',
                [
                    req.user.id,
                    senderTxId,
                    'transfer_out',
                    amount,
                    `Transfer to ${recipient_email}${note ? ': ' + note : ''}`,
                    'completed'
                ]
            );
            
            // Add to recipient
            await pool.query(
                'UPDATE wallets SET balance = balance + ? WHERE user_id = ?',
                [amount, recipient[0].id]
            );
            
            const recipientTxId = `TRANSFER-IN-${Date.now()}`;
            await pool.query(
                'INSERT INTO wallet_transactions (user_id, transaction_id, type, amount, description, status) VALUES (?, ?, ?, ?, ?, ?)',
                [
                    recipient[0].id,
                    recipientTxId,
                    'transfer_in',
                    amount,
                    `Transfer from ${req.user.email}${note ? ': ' + note : ''}`,
                    'completed'
                ]
            );
            
            await pool.query('COMMIT');
            
            const [updatedWallet] = await pool.query(
                'SELECT balance FROM wallets WHERE user_id = ?',
                [req.user.id]
            );
            
            res.json({
                success: true,
                message: 'Transfer completed successfully',
                new_balance: updatedWallet[0].balance
            });
            
        } catch (error) {
            await pool.query('ROLLBACK');
            throw error;
        }
        
    } catch (error) {
        console.error('Transfer error:', error);
        res.status(500).json({ error: 'Transfer failed' });
    }
});

// ========== ERROR HANDLING ==========

// 404 Handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: { message: 'Endpoint not found', code: 'NOT_FOUND' }
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    
    res.status(500).json({
        success: false,
        error: {
            message: 'Internal server error',
            code: 'SERVER_ERROR',
            ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
        }
    });
});

// ========== START SERVER ==========

async function startServer() {
    await initializeDB();
    
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`📁 API Endpoints:`);
        console.log(`   POST /api/signup                - User registration`);
        console.log(`   POST /api/login                 - User login`);
        console.log(`   GET  /api/profile              - Get user profile`);
        console.log(`   GET  /api/wallet               - Get wallet balance`);
        console.log(`   GET  /api/dashboard            - Get dashboard data`);
        console.log(`   POST /api/wallet/topup/initialize - Paystack wallet top-up`);
        console.log(`   POST /api/webhook/paystack     - Paystack webhook`);
        console.log(`   GET  /api/data/bundles         - Get available data bundles`);
        console.log(`   POST /api/data/buy             - Buy data bundle`);
        console.log(`   GET  /api/orders               - Get user orders`);
        console.log(`   POST /api/wallet/transfer      - Wallet-to-wallet transfer`);
        console.log(`   GET  /api/admin/users          - Admin: Get all users`);
        console.log(`   GET  /api/admin/stats          - Admin: Get system stats`);
        console.log(`   GET  /health                   - Health check`);
        console.log(`\n🔑 Environment variables needed:`);
        console.log(`   PAYSTACK_SECRET_KEY           - Your Paystack secret key`);
        console.log(`   PAYSTACK_WEBHOOK_SECRET       - Paystack webhook secret`);
        console.log(`   JWT_SECRET                    - JWT signing secret`);
        console.log(`   DB_*                          - Database credentials`);
    });
}

startServer();
