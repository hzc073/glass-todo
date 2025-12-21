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

    db.run(`CREATE TABLE IF NOT EXISTS user_settings (
        username TEXT PRIMARY KEY,
        settings_json TEXT,
        updated_at INTEGER NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        username TEXT,
        p256dh TEXT,
        auth TEXT,
        expiration_time INTEGER,
        created_at INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pomodoro_settings (
        username TEXT PRIMARY KEY,
        work_min INTEGER NOT NULL,
        short_break_min INTEGER NOT NULL,
        long_break_min INTEGER NOT NULL,
        long_break_every INTEGER NOT NULL,
        auto_start_next INTEGER NOT NULL DEFAULT 0,
        auto_start_break INTEGER NOT NULL DEFAULT 0,
        auto_start_work INTEGER NOT NULL DEFAULT 0,
        auto_finish_task INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pomodoro_state (
        username TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        remaining_ms INTEGER NOT NULL,
        is_running INTEGER NOT NULL,
        target_end INTEGER,
        cycle_count INTEGER NOT NULL DEFAULT 0,
        current_task_id INTEGER,
        updated_at INTEGER NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pomodoro_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        task_id INTEGER,
        task_title TEXT,
        started_at INTEGER,
        ended_at INTEGER NOT NULL,
        duration_min INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    )`);

    db.run("CREATE INDEX IF NOT EXISTS idx_pomodoro_sessions_user_time ON pomodoro_sessions(username, ended_at)");

    db.run(`CREATE TABLE IF NOT EXISTS pomodoro_daily_stats (
        username TEXT NOT NULL,
        date_key TEXT NOT NULL,
        work_sessions INTEGER NOT NULL DEFAULT 0,
        work_minutes INTEGER NOT NULL DEFAULT 0,
        break_minutes INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (username, date_key)
    )`);

    db.run("CREATE INDEX IF NOT EXISTS idx_pomodoro_daily_user_date ON pomodoro_daily_stats(username, date_key)");

    db.run(`CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        task_id INTEGER NOT NULL,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        storage_driver TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )`);

    db.run("CREATE INDEX IF NOT EXISTS idx_attachments_owner_task ON attachments(owner_user_id, task_id)");
    
    // 自动迁移：检查 is_admin 字段
    db.all("PRAGMA table_info(users)", (err, rows) => {
        if (!rows.some(r => r.name === 'is_admin')) {
            console.log(">> DB Migration: Adding is_admin column...");
            db.run("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0");
        }
    });

    db.all("PRAGMA table_info(pomodoro_settings)", (err, rows) => {
        if (!rows) return;
        if (!rows.some(r => r.name === 'auto_start_break')) {
            console.log(">> DB Migration: Adding pomodoro_settings.auto_start_break column...");
            db.run("ALTER TABLE pomodoro_settings ADD COLUMN auto_start_break INTEGER NOT NULL DEFAULT 0");
        }
        if (!rows.some(r => r.name === 'auto_start_work')) {
            console.log(">> DB Migration: Adding pomodoro_settings.auto_start_work column...");
            db.run("ALTER TABLE pomodoro_settings ADD COLUMN auto_start_work INTEGER NOT NULL DEFAULT 0");
        }
        if (!rows.some(r => r.name === 'auto_finish_task')) {
            console.log(">> DB Migration: Adding pomodoro_settings.auto_finish_task column...");
            db.run("ALTER TABLE pomodoro_settings ADD COLUMN auto_finish_task INTEGER NOT NULL DEFAULT 0");
        }
    });
});

module.exports = db;
