-- Run these in MySQL or phpMyAdmin
CREATE DATABASE IF NOT EXISTS buybuzz_datahub;
USE buybuzz_datahub;

CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    phone VARCHAR(20) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    status ENUM('active', 'suspended') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE wallets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNIQUE,
    balance DECIMAL(10,2) DEFAULT 0.00,
    level ENUM('Bronze', 'Silver', 'Gold') DEFAULT 'Bronze',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);