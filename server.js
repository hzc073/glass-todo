const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const db = require('./server/db');
const { authenticate, requireAdmin, getOrInitInviteCode, generateInviteCode } = require('./server/auth');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

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
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n=== Glass Todo Modular Server Running ===`);
        console.log(`Local: http://localhost:${PORT}`);
        console.log(`=========================================\n`);
    });
}
