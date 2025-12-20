const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const dbFile = process.env.DB_PATH || path.join(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbFile);

// 初始化数据库表结构
db.serialize(() => {
    // 用户表
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT,
        is_admin INTEGER DEFAULT 0
    )`);

    // 数据表
    db.run(`CREATE TABLE IF NOT EXISTS data (
        username TEXT PRIMARY KEY,
        json_data TEXT,
        version INTEGER
    )`);

    // 设置表
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);
    
    // 自动迁移：检查 is_admin 字段
    db.all("PRAGMA table_info(users)", (err, rows) => {
        if (!rows.some(r => r.name === 'is_admin')) {
            console.log(">> DB Migration: Adding is_admin column...");
            db.run("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0");
        }
    });
});

module.exports = db;
