const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const db = require('./server/db');
const { authenticate, requireAdmin, getOrInitInviteCode, generateInviteCode } = require('./server/auth');
const webpush = require('web-push');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
let VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const PUSH_SCAN_INTERVAL_MS = 60 * 1000;
const PUSH_WINDOW_MS = 60 * 1000;

const isPushConfigured = () => !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
        if (err) return reject(err);
        resolve(this);
    });
});

const loadVapidFromDb = async () => {
    const rows = await dbAll(
        "SELECT key, value FROM settings WHERE key IN ('vapid_public_key','vapid_private_key','vapid_subject')"
    );
    const map = {};
    rows.forEach((row) => { map[row.key] = row.value; });
    return map;
};

const saveVapidToDb = async ({ publicKey, privateKey, subject }) => {
    await dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ['vapid_public_key', publicKey]);
    await dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ['vapid_private_key', privateKey]);
    await dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ['vapid_subject', subject]);
};

const ensureVapidKeys = async () => {
    if (isPushConfigured()) {
        webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
        return;
    }
    try {
        const stored = await loadVapidFromDb();
        if (!VAPID_PUBLIC_KEY && stored.vapid_public_key) VAPID_PUBLIC_KEY = stored.vapid_public_key;
        if (!VAPID_PRIVATE_KEY && stored.vapid_private_key) VAPID_PRIVATE_KEY = stored.vapid_private_key;
        if (!process.env.VAPID_SUBJECT && stored.vapid_subject) VAPID_SUBJECT = stored.vapid_subject;
    } catch (e) {
        console.warn('vapid load failed', e);
    }

    if (!isPushConfigured()) {
        const generated = webpush.generateVAPIDKeys();
        VAPID_PUBLIC_KEY = generated.publicKey;
        VAPID_PRIVATE_KEY = generated.privateKey;
        if (!VAPID_SUBJECT) VAPID_SUBJECT = 'mailto:admin@example.com';
        try {
            await saveVapidToDb({
                publicKey: VAPID_PUBLIC_KEY,
                privateKey: VAPID_PRIVATE_KEY,
                subject: VAPID_SUBJECT
            });
        } catch (e) {
            console.warn('vapid save failed', e);
        }
    }

    if (isPushConfigured()) {
        webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    }
};

app.use(cors());
app.use(bodyParser.json());
app.get('/config.json', (req, res) => {
    res.json({
        apiBaseUrl: process.env.API_BASE_URL || '',
        useLocalStorage: String(process.env.USE_LOCAL_STORAGE || '').toLowerCase() === 'true',
        holidayJsonUrl: process.env.HOLIDAY_JSON_URL || '',
        appTitle: process.env.APP_TITLE || 'Glass Todo'
    });
});
app.use(express.static(path.join(__dirname, 'public')));

const holidaysDir = path.join(__dirname, 'public', 'holidays');
if (!fs.existsSync(holidaysDir)) fs.mkdirSync(holidaysDir, { recursive: true });

const buildPushPayload = (task) => {
    const when = task.date ? `${task.date}${task.start ? ` ${task.start}` : ''}` : '';
    return {
        title: '开始时间提醒',
        body: when ? `${task.title} (${when})` : task.title,
        url: '/',
        tag: `task-${task.id}`
    };
};

const sendPushToUser = async (username, payload) => {
    if (!isPushConfigured()) return false;
    let subs = [];
    try {
        subs = await dbAll("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE username = ?", [username]);
    } catch (e) {
        console.warn('push load subscriptions failed', e);
        return false;
    }
    if (!subs.length) return false;
    const message = JSON.stringify(payload);
    const sendJobs = subs.map(async (sub) => {
        const subscription = {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth }
        };
        try {
            await webpush.sendNotification(subscription, message);
        } catch (err) {
            const code = err?.statusCode;
            if (code === 404 || code === 410) {
                db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", [sub.endpoint]);
            } else {
                console.warn('push send failed', code || err);
            }
        }
    });
    await Promise.allSettled(sendJobs);
    return true;
};

const scanAndSendReminders = async () => {
    if (!isPushConfigured()) return;
    let rows = [];
    try {
        rows = await dbAll("SELECT username, json_data FROM data");
    } catch (e) {
        console.warn('push scan failed', e);
        return;
    }

    const now = Date.now();
    for (const row of rows) {
        let tasks = [];
        try {
            tasks = JSON.parse(row.json_data || '[]');
        } catch (e) {
            continue;
        }
        if (!Array.isArray(tasks) || tasks.length === 0) continue;
        let changed = false;
        for (const task of tasks) {
            if (!task || task.deletedAt || task.status === 'completed') continue;
            const remindAt = task.remindAt;
            if (!remindAt) continue;
            if (task.notifiedAt && task.notifiedAt >= remindAt) continue;
            if (now < remindAt || now >= (remindAt + PUSH_WINDOW_MS)) continue;
            const sent = await sendPushToUser(row.username, buildPushPayload(task));
            if (sent) {
                task.notifiedAt = now;
                changed = true;
            }
        }
        if (changed) {
            const newVersion = Date.now();
            await dbRun(
                "INSERT OR REPLACE INTO data (username, json_data, version) VALUES (?, ?, ?)",
                [row.username, JSON.stringify(tasks), newVersion]
            );
        }
    }
};

let pushScanRunning = false;
setInterval(() => {
    if (!isPushConfigured() || pushScanRunning) return;
    pushScanRunning = true;
    scanAndSendReminders().finally(() => { pushScanRunning = false; });
}, PUSH_SCAN_INTERVAL_MS);

// --- API 路由 ---

// 1. 登录/注册
app.all('/api/login', authenticate, (req, res) => {
    res.json({ 
        success: true, 
        username: req.user.username,
        isAdmin: !!req.user.is_admin 
    });
});

// 2. 数据同步
app.get('/api/data', authenticate, (req, res) => {
    db.get("SELECT json_data, version FROM data WHERE username = ?", [req.user.username], (err, row) => {
        res.json({ data: row ? JSON.parse(row.json_data) : [], version: row ? row.version : 0 });
    });
});

app.post('/api/data', authenticate, (req, res) => {
    const { data, version, force } = req.body;
    db.get("SELECT version FROM data WHERE username = ?", [req.user.username], (err, row) => {
        const serverVersion = row ? row.version : 0;
        if (!force && version < serverVersion) {
            return res.status(409).json({ error: "Conflict", serverVersion, message: "云端数据更新" });
        }
        const newVersion = Date.now();
        db.run(`INSERT OR REPLACE INTO data (username, json_data, version) VALUES (?, ?, ?)`, 
            [req.user.username, JSON.stringify(data), newVersion], 
            () => res.json({ success: true, version: newVersion })
        );
    });
});

// Push notification APIs
app.get('/api/push/public-key', authenticate, (req, res) => {
    if (!isPushConfigured()) return res.status(500).json({ error: "Push not configured" });
    res.json({ key: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', authenticate, (req, res) => {
    if (!isPushConfigured()) return res.status(500).json({ error: "Push not configured" });
    const sub = req.body && req.body.subscription;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        return res.status(400).json({ error: "Invalid subscription" });
    }
    const now = Date.now();
    db.run(
        "INSERT OR REPLACE INTO push_subscriptions (endpoint, username, p256dh, auth, expiration_time, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [sub.endpoint, req.user.username, sub.keys.p256dh, sub.keys.auth, sub.expirationTime || null, now],
        () => res.json({ success: true })
    );
});

app.post('/api/push/unsubscribe', authenticate, (req, res) => {
    const endpoint = req.body && req.body.endpoint;
    if (!endpoint) {
        db.run("DELETE FROM push_subscriptions WHERE username = ?", [req.user.username], () => res.json({ success: true }));
        return;
    }
    db.run(
        "DELETE FROM push_subscriptions WHERE endpoint = ? AND username = ?",
        [endpoint, req.user.username],
        () => res.json({ success: true })
    );
});

app.post('/api/push/test', authenticate, async (req, res) => {
    if (!isPushConfigured()) return res.status(500).json({ error: "Push not configured" });
    try {
        const sent = await sendPushToUser(req.user.username, {
            title: '测试通知',
            body: '这是一条测试通知',
            url: '/',
            tag: `test-${Date.now()}`
        });
        if (!sent) return res.status(404).json({ error: "No subscription" });
        res.json({ success: true });
    } catch (e) {
        console.warn('push test failed', e);
        res.status(500).json({ error: "Push test failed" });
    }
});

// 3. 管理员接口
app.get('/api/admin/invite', authenticate, requireAdmin, (req, res) => {
    getOrInitInviteCode((code) => res.json({ code }));
});

app.post('/api/admin/invite/refresh', authenticate, requireAdmin, (req, res) => {
    const newCode = generateInviteCode();
    db.run("UPDATE settings SET value = ? WHERE key = 'invite_code'", [newCode], () => res.json({ code: newCode }));
});

app.get('/api/admin/users', authenticate, requireAdmin, (req, res) => {
    db.all("SELECT username, is_admin FROM users", (err, rows) => res.json({ users: rows }));
});

app.post('/api/admin/reset-pwd', authenticate, requireAdmin, (req, res) => {
    const { targetUser } = req.body;
    db.run("UPDATE users SET password = '123456' WHERE username = ?", [targetUser], function(err) {
        if (this.changes === 0) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, message: "密码已重置为 123456" });
    });
});

app.post('/api/admin/delete-user', authenticate, requireAdmin, (req, res) => {
    const { targetUser } = req.body;
    if (targetUser === req.user.username) return res.status(400).json({ error: "不能删除自己" });
    db.serialize(() => {
        db.run("DELETE FROM users WHERE username = ?", [targetUser]);
        db.run("DELETE FROM data WHERE username = ?", [targetUser]);
    });
    res.json({ success: true });
});

// 4. 修改密码
app.post('/api/change-pwd', authenticate, (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) return res.status(400).json({ error: "提交参数错误" });
    db.get("SELECT password FROM users WHERE username = ?", [req.user.username], (err, row) => {
        if (err || !row) return res.status(500).json({ error: "DB Error" });
        if (row.password !== oldPassword) return res.status(400).json({ error: "原密码不正确" });
        db.run("UPDATE users SET password = ? WHERE username = ?", [newPassword, req.user.username], function(updateErr) {
            if (updateErr) return res.status(500).json({ error: "DB Error" });
            res.json({ success: true });
        });
    });
});

// 5. 节假日缓存
app.get('/api/holidays/:year', authenticate, (req, res) => {
    const year = String(req.params.year || '').trim();
    if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: 'Invalid year' });
    const filePath = path.join(holidaysDir, `${year}.json`);
    if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
    }

    const base = process.env.HOLIDAY_JSON_URL || 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json';
    const url = base.includes('{year}') ? base.replace('{year}', year) : base;
    https.get(url, (resp) => {
        if (resp.statusCode !== 200) {
            resp.resume();
            return res.status(404).json({ error: 'Holiday data not found' });
        }
        let data = '';
        resp.setEncoding('utf8');
        resp.on('data', (chunk) => data += chunk);
        resp.on('end', () => {
            try {
                JSON.parse(data);
            } catch (e) {
                return res.status(500).json({ error: 'Invalid holiday data' });
            }
            fs.writeFile(filePath, data, 'utf8', (err) => {
                if (err) return res.status(500).json({ error: 'Write failed' });
                res.type('json').send(data);
            });
        });
    }).on('error', () => res.status(500).json({ error: 'Fetch failed' }));
});

// 6. CLI 重置命令
if (process.argv[2] === '--reset-admin') {
    const user = process.argv[3];
    const pass = process.argv[4];
    if (user && pass) {
        const dbCli = new (require('sqlite3').verbose()).Database(path.join(__dirname, 'database.sqlite'));
        dbCli.run("UPDATE users SET password = ?, is_admin = 1 WHERE username = ?", [pass, user], function(err) {
            console.log(this.changes > 0 ? `SUCCESS: User [${user}] is now Admin.` : `FAILED: User [${user}] not found.`);
            process.exit();
        });
    } else {
        console.log("Usage: node server.js --reset-admin <username> <newpassword>");
        process.exit();
    }
} else {
    const startServer = async () => {
        try {
            await ensureVapidKeys();
        } catch (e) {
            console.warn('vapid init failed', e);
        }
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`\n=== Glass Todo Modular Server Running ===`);
            console.log(`Local: http://localhost:${PORT}`);
            console.log(`=========================================\n`);
        });
    };
    startServer();
}
