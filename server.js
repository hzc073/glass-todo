const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const multer = require('multer');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const db = require('./server/db');
const { authenticate, requireAdmin, getOrInitInviteCode, generateInviteCode } = require('./server/auth');
const webpush = require('web-push');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
let VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const ATTACHMENT_MAX_SIZE = 50 * 1024 * 1024;
const ATTACHMENTS_DRIVER = String(process.env.ATTACHMENTS_DRIVER || 'local').toLowerCase();
const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR || path.join(__dirname, 'storage', 'attachments');
const ATTACHMENTS_TMP_DIR = path.join(ATTACHMENTS_DIR, '_tmp');
const ATTACHMENTS_S3_BUCKET = process.env.ATTACHMENTS_S3_BUCKET || process.env.S3_BUCKET || '';
const ATTACHMENTS_S3_REGION = process.env.ATTACHMENTS_S3_REGION || process.env.S3_REGION || 'auto';
const ATTACHMENTS_S3_ENDPOINT = process.env.ATTACHMENTS_S3_ENDPOINT || process.env.S3_ENDPOINT || '';
const ATTACHMENTS_S3_PREFIX = (() => {
    const raw = (process.env.ATTACHMENTS_S3_PREFIX || 'attachments/').replace(/^\/+/, '');
    return raw.endsWith('/') ? raw : `${raw}/`;
})();
const ATTACHMENTS_S3_FORCE_PATH_STYLE = String(process.env.ATTACHMENTS_S3_FORCE_PATH_STYLE || '').toLowerCase() === 'true';
const ATTACHMENTS_ALLOWED_EXTS = new Set([
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.rtf',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.svg',
    '.psd', '.psb', '.ai', '.sketch', '.fig', '.xd', '.indd'
]);
const PUSH_SCAN_INTERVAL_MS = 60 * 1000;
const PUSH_WINDOW_MS = 60 * 1000;
const streamPipeline = promisify(pipeline);
const isS3Driver = ATTACHMENTS_DRIVER === 's3' || ATTACHMENTS_DRIVER === 'r2';
const s3Client = isS3Driver ? new S3Client({
    region: ATTACHMENTS_S3_REGION,
    endpoint: ATTACHMENTS_S3_ENDPOINT || undefined,
    forcePathStyle: ATTACHMENTS_S3_FORCE_PATH_STYLE,
    credentials: process.env.ATTACHMENTS_S3_ACCESS_KEY_ID
        || process.env.ATTACHMENTS_S3_SECRET_ACCESS_KEY
        || process.env.S3_ACCESS_KEY_ID
        || process.env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.ATTACHMENTS_S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.ATTACHMENTS_S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY || ''
        }
        : undefined
}) : null;

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

const ensureDir = (dirPath) => {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

const createAttachmentId = () => {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return crypto.randomBytes(16).toString('hex');
};

const encodeRFC5987Value = (val) => encodeURIComponent(val)
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const buildDownloadDisposition = (filename) => {
    const safe = String(filename || 'attachment');
    const asciiFallback = safe.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRFC5987Value(safe)}`;
};

const maybeDecodeLatin1Filename = (name) => {
    if (!name) return '';
    const raw = String(name);
    if (!/[^\x00-\x7F]/.test(raw)) return raw;
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    const hasCjk = /[\u4E00-\u9FFF]/.test(decoded);
    const rawHasCjk = /[\u4E00-\u9FFF]/.test(raw);
    if (hasCjk && !rawHasCjk) return decoded;
    return raw;
};

const normalizeOriginalName = (name) => {
    const decoded = maybeDecodeLatin1Filename(name);
    const safe = path.basename(String(decoded || '').trim());
    return safe || 'attachment';
};

const buildAttachmentRelPath = (id, ext) => `${id.slice(0, 2)}/${id}${ext}`;

ensureDir(ATTACHMENTS_DIR);
ensureDir(ATTACHMENTS_TMP_DIR);

const attachmentUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, ATTACHMENTS_TMP_DIR),
        filename: (req, file, cb) => {
            if (!req.attachmentId) req.attachmentId = createAttachmentId();
            const ext = path.extname(file.originalname || '').toLowerCase();
            req.attachmentExt = ext;
            cb(null, `${req.attachmentId}${ext}.upload`);
        }
    }),
    limits: { fileSize: ATTACHMENT_MAX_SIZE },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        if (!ext || !ATTACHMENTS_ALLOWED_EXTS.has(ext)) {
            return cb(new Error('Unsupported file type'));
        }
        cb(null, true);
    }
});

const storeAttachmentFile = async ({ tmpPath, id, ext, mimeType, originalName, size }) => {
    if (isS3Driver) {
        if (!ATTACHMENTS_S3_BUCKET) throw new Error('Missing S3 bucket configuration');
        const key = `${ATTACHMENTS_S3_PREFIX}${id}${ext}`;
        const body = fs.createReadStream(tmpPath);
        await s3Client.send(new PutObjectCommand({
            Bucket: ATTACHMENTS_S3_BUCKET,
            Key: key,
            Body: body,
            ContentType: mimeType,
            Metadata: { original_name: encodeURIComponent(originalName) },
            ContentLength: size
        }));
        fs.unlink(tmpPath, () => {});
        return { storageDriver: ATTACHMENTS_DRIVER, storagePath: key };
    }
    const relPath = buildAttachmentRelPath(id, ext);
    const absPath = path.join(ATTACHMENTS_DIR, relPath);
    ensureDir(path.dirname(absPath));
    fs.renameSync(tmpPath, absPath);
    return { storageDriver: 'local', storagePath: relPath };
};

const deleteAttachmentFile = async ({ storageDriver, storagePath }) => {
    if (storageDriver === 'local') {
        const absPath = path.join(ATTACHMENTS_DIR, storagePath);
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
        return;
    }
    if (isS3Driver) {
        if (!ATTACHMENTS_S3_BUCKET) throw new Error('Missing S3 bucket configuration');
        await s3Client.send(new DeleteObjectCommand({
            Bucket: ATTACHMENTS_S3_BUCKET,
            Key: storagePath
        }));
    }
};

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

const getPomodoroDefaults = () => ({
    workMin: 25,
    shortBreakMin: 5,
    longBreakMin: 15,
    longBreakEvery: 4,
    autoStartNext: false,
    autoStartBreak: false,
    autoStartWork: false,
    autoFinishTask: false
});

const upsertPomodoroDailyStats = async (username, dateKey, workMinutes = 0, breakMinutes = 0) => {
    const rows = await dbAll(
        "SELECT work_sessions, work_minutes, break_minutes FROM pomodoro_daily_stats WHERE username = ? AND date_key = ?",
        [username, dateKey]
    );
    const updatedAt = Date.now();
    if (!rows.length) {
        await dbRun(
            "INSERT INTO pomodoro_daily_stats (username, date_key, work_sessions, work_minutes, break_minutes, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            [username, dateKey, workMinutes > 0 ? 1 : 0, workMinutes, breakMinutes, updatedAt]
        );
        return;
    }
    const current = rows[0];
    const nextSessions = current.work_sessions + (workMinutes > 0 ? 1 : 0);
    const nextWork = current.work_minutes + workMinutes;
    const nextBreak = current.break_minutes + breakMinutes;
    await dbRun(
        "UPDATE pomodoro_daily_stats SET work_sessions = ?, work_minutes = ?, break_minutes = ?, updated_at = ? WHERE username = ? AND date_key = ?",
        [nextSessions, nextWork, nextBreak, updatedAt, username, dateKey]
    );
};

const getUserSettingsDefaults = () => ({
    viewSettings: { calendar: true, matrix: true, pomodoro: true },
    calendarDefaultMode: 'day',
    autoMigrateEnabled: true,
    pushEnabled: false,
    calendarSettings: { showTime: true, showTags: true, showLunar: true, showHoliday: true }
});

const sanitizeUserSettings = (input = {}) => {
    const defaults = getUserSettingsDefaults();
    const viewSettings = { ...defaults.viewSettings, ...(input.viewSettings || {}) };
    const calendarSettings = { ...defaults.calendarSettings, ...(input.calendarSettings || {}) };
    const mode = ['day', 'week', 'month'].includes(input.calendarDefaultMode) ? input.calendarDefaultMode : defaults.calendarDefaultMode;
    return {
        viewSettings: {
            calendar: !!viewSettings.calendar,
            matrix: !!viewSettings.matrix,
            pomodoro: !!viewSettings.pomodoro
        },
        calendarDefaultMode: mode,
        autoMigrateEnabled: typeof input.autoMigrateEnabled === 'boolean' ? input.autoMigrateEnabled : defaults.autoMigrateEnabled,
        pushEnabled: typeof input.pushEnabled === 'boolean' ? input.pushEnabled : defaults.pushEnabled,
        calendarSettings: {
            showTime: !!calendarSettings.showTime,
            showTags: !!calendarSettings.showTags,
            showLunar: !!calendarSettings.showLunar,
            showHoliday: !!calendarSettings.showHoliday
        }
    };
};

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

// Attachments
app.post('/api/tasks/:taskId/attachments', authenticate, (req, res) => {
    attachmentUpload.single('file')(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const taskId = parseInt(req.params.taskId, 10);
        if (!Number.isFinite(taskId)) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({ error: 'Invalid task id' });
        }

        const originalName = normalizeOriginalName(req.file.originalname);
        const mimeType = req.file.mimetype || 'application/octet-stream';
        const size = req.file.size || 0;
        const attachmentId = req.attachmentId;
        const attachmentExt = req.attachmentExt || '';

        try {
            const row = await dbAll("SELECT json_data, version FROM data WHERE username = ?", [req.user.username]);
            const dataRow = row[0];
            const tasks = dataRow && dataRow.json_data ? JSON.parse(dataRow.json_data) : [];
            const task = tasks.find((t) => t && Number(t.id) === taskId);
            if (!task) {
                fs.unlink(req.file.path, () => {});
                return res.status(404).json({ error: 'Task not found' });
            }

            const stored = await storeAttachmentFile({
                tmpPath: req.file.path,
                id: attachmentId,
                ext: attachmentExt,
                mimeType,
                originalName,
                size
            });

            const createdAt = Date.now();
            const attachmentMeta = {
                id: attachmentId,
                name: originalName,
                mime: mimeType,
                size,
                createdAt
            };
            if (!Array.isArray(task.attachments)) task.attachments = [];
            task.attachments.push(attachmentMeta);

            const newVersion = Date.now();
            await dbRun('BEGIN');
            await dbRun(
                `INSERT INTO attachments
                (id, owner_user_id, task_id, original_name, mime_type, size, storage_driver, storage_path, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    attachmentId,
                    req.user.username,
                    taskId,
                    originalName,
                    mimeType,
                    size,
                    stored.storageDriver,
                    stored.storagePath,
                    createdAt
                ]
            );
            await dbRun(
                "INSERT OR REPLACE INTO data (username, json_data, version) VALUES (?, ?, ?)",
                [req.user.username, JSON.stringify(tasks), newVersion]
            );
            await dbRun('COMMIT');

            return res.json({ success: true, attachment: attachmentMeta, version: newVersion });
        } catch (e) {
            try { await dbRun('ROLLBACK'); } catch (rollbackErr) {}
            if (req.file?.path) fs.unlink(req.file.path, () => {});
            return res.status(500).json({ error: 'Attachment upload failed' });
        }
    });
});

app.delete('/api/tasks/:taskId/attachments/:attachmentId', authenticate, async (req, res) => {
    const taskId = parseInt(req.params.taskId, 10);
    if (!Number.isFinite(taskId)) return res.status(400).json({ error: 'Invalid task id' });
    const attachmentId = String(req.params.attachmentId || '').trim();
    if (!attachmentId) return res.status(400).json({ error: 'Invalid attachment id' });

    try {
        const rows = await dbAll(
            "SELECT id, owner_user_id, task_id, storage_driver, storage_path, original_name, mime_type, size FROM attachments WHERE id = ? AND owner_user_id = ?",
            [attachmentId, req.user.username]
        );
        const attachment = rows[0];
        if (!attachment || Number(attachment.task_id) !== taskId) {
            return res.status(404).json({ error: 'Attachment not found' });
        }

        const dataRows = await dbAll("SELECT json_data FROM data WHERE username = ?", [req.user.username]);
        const tasks = dataRows[0] && dataRows[0].json_data ? JSON.parse(dataRows[0].json_data) : [];
        const task = tasks.find((t) => t && Number(t.id) === taskId);
        if (!task) return res.status(404).json({ error: 'Task not found' });

        if (Array.isArray(task.attachments)) {
            task.attachments = task.attachments.filter((a) => a && a.id !== attachmentId);
        }

        const newVersion = Date.now();
        await dbRun('BEGIN');
        await dbRun("DELETE FROM attachments WHERE id = ? AND owner_user_id = ?", [attachmentId, req.user.username]);
        await dbRun(
            "INSERT OR REPLACE INTO data (username, json_data, version) VALUES (?, ?, ?)",
            [req.user.username, JSON.stringify(tasks), newVersion]
        );
        await dbRun('COMMIT');

        try {
            await deleteAttachmentFile({
                storageDriver: attachment.storage_driver,
                storagePath: attachment.storage_path
            });
        } catch (e) {
            console.warn('delete attachment file failed', e);
        }

        return res.json({ success: true, version: newVersion });
    } catch (e) {
        try { await dbRun('ROLLBACK'); } catch (rollbackErr) {}
        return res.status(500).json({ error: 'Failed to delete attachment' });
    }
});

app.get('/api/attachments/:attachmentId/download', authenticate, async (req, res) => {
    const attachmentId = String(req.params.attachmentId || '').trim();
    if (!attachmentId) return res.status(400).json({ error: 'Invalid attachment id' });

    try {
        const rows = await dbAll(
            "SELECT id, owner_user_id, original_name, mime_type, size, storage_driver, storage_path FROM attachments WHERE id = ? AND owner_user_id = ?",
            [attachmentId, req.user.username]
        );
        const attachment = rows[0];
        if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

        const safeName = normalizeOriginalName(attachment.original_name);
        res.setHeader('Content-Disposition', buildDownloadDisposition(safeName));
        res.setHeader('Content-Type', attachment.mime_type || 'application/octet-stream');

        if (attachment.storage_driver === 'local') {
            const absPath = path.join(ATTACHMENTS_DIR, attachment.storage_path);
            if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'File missing' });
            return res.sendFile(absPath);
        }

        if (!ATTACHMENTS_S3_BUCKET) return res.status(500).json({ error: 'Storage not configured' });
        const result = await s3Client.send(new GetObjectCommand({
            Bucket: ATTACHMENTS_S3_BUCKET,
            Key: attachment.storage_path
        }));
        if (result.ContentLength) res.setHeader('Content-Length', result.ContentLength);
        await streamPipeline(result.Body, res);
    } catch (e) {
        return res.status(500).json({ error: 'Failed to download attachment' });
    }
});

// User settings
app.get('/api/user/settings', authenticate, async (req, res) => {
    try {
        const rows = await dbAll("SELECT settings_json FROM user_settings WHERE username = ?", [req.user.username]);
        if (!rows.length || !rows[0].settings_json) return res.json({ settings: null });
        let parsed = null;
        try {
            parsed = JSON.parse(rows[0].settings_json);
        } catch (e) {
            parsed = null;
        }
        return res.json({ settings: parsed });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to load user settings' });
    }
});

app.post('/api/user/settings', authenticate, async (req, res) => {
    const raw = req.body && typeof req.body === 'object' ? (req.body.settings || req.body) : null;
    if (!raw || typeof raw !== 'object') return res.status(400).json({ error: 'Invalid settings' });
    const settings = sanitizeUserSettings(raw);
    try {
        await dbRun(
            "INSERT OR REPLACE INTO user_settings (username, settings_json, updated_at) VALUES (?, ?, ?)",
            [req.user.username, JSON.stringify(settings), Date.now()]
        );
        return res.json({ success: true, settings });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to save user settings' });
    }
});

// Pomodoro settings/state/sessions
app.get('/api/pomodoro/settings', authenticate, async (req, res) => {
    try {
        const rows = await dbAll(
            "SELECT work_min, short_break_min, long_break_min, long_break_every, auto_start_next, auto_start_break, auto_start_work, auto_finish_task FROM pomodoro_settings WHERE username = ?",
            [req.user.username]
        );
        if (!rows.length) {
            return res.json({ settings: getPomodoroDefaults() });
        }
        const r = rows[0];
        res.json({
            settings: {
                workMin: r.work_min,
                shortBreakMin: r.short_break_min,
                longBreakMin: r.long_break_min,
                longBreakEvery: r.long_break_every,
                autoStartNext: !!r.auto_start_next,
                autoStartBreak: r.auto_start_break === null || typeof r.auto_start_break === 'undefined' ? !!r.auto_start_next : !!r.auto_start_break,
                autoStartWork: r.auto_start_work === null || typeof r.auto_start_work === 'undefined' ? !!r.auto_start_next : !!r.auto_start_work,
                autoFinishTask: !!r.auto_finish_task
            }
        });
    } catch (e) {
        res.status(500).json({ error: "Failed to load pomodoro settings" });
    }
});

app.post('/api/pomodoro/settings', authenticate, async (req, res) => {
    const defaults = getPomodoroDefaults();
    const workMin = Math.max(1, parseInt(req.body.workMin, 10) || defaults.workMin);
    const shortMin = Math.max(1, parseInt(req.body.shortBreakMin, 10) || defaults.shortBreakMin);
    const longMin = Math.max(1, parseInt(req.body.longBreakMin, 10) || defaults.longBreakMin);
    const longEvery = Math.max(1, parseInt(req.body.longBreakEvery, 10) || defaults.longBreakEvery);
    const autoStartNext = req.body.autoStartNext ? 1 : 0;
    const autoStartBreak = (typeof req.body.autoStartBreak === 'boolean' ? req.body.autoStartBreak : req.body.autoStartNext) ? 1 : 0;
    const autoStartWork = (typeof req.body.autoStartWork === 'boolean' ? req.body.autoStartWork : req.body.autoStartNext) ? 1 : 0;
    const autoFinishTask = req.body.autoFinishTask ? 1 : 0;
    const updatedAt = Date.now();
    try {
        await dbRun(
            `INSERT OR REPLACE INTO pomodoro_settings 
            (username, work_min, short_break_min, long_break_min, long_break_every, auto_start_next, auto_start_break, auto_start_work, auto_finish_task, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.username, workMin, shortMin, longMin, longEvery, autoStartNext, autoStartBreak, autoStartWork, autoFinishTask, updatedAt]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to save pomodoro settings" });
    }
});

app.get('/api/pomodoro/state', authenticate, async (req, res) => {
    try {
        const rows = await dbAll(
            "SELECT mode, remaining_ms, is_running, target_end, cycle_count, current_task_id FROM pomodoro_state WHERE username = ?",
            [req.user.username]
        );
        if (!rows.length) {
            return res.json({ state: null });
        }
        const r = rows[0];
        res.json({
            state: {
                mode: r.mode,
                remainingMs: r.remaining_ms,
                isRunning: !!r.is_running,
                targetEnd: r.target_end,
                cycleCount: r.cycle_count,
                currentTaskId: r.current_task_id
            }
        });
    } catch (e) {
        res.status(500).json({ error: "Failed to load pomodoro state" });
    }
});

app.post('/api/pomodoro/state', authenticate, async (req, res) => {
    const allowedModes = new Set(['work', 'short', 'long']);
    const mode = allowedModes.has(req.body.mode) ? req.body.mode : 'work';
    const remainingMs = Math.max(0, parseInt(req.body.remainingMs, 10) || 0);
    const isRunning = req.body.isRunning ? 1 : 0;
    const targetEndParsed = parseInt(req.body.targetEnd, 10);
    const targetEnd = Number.isFinite(targetEndParsed) ? targetEndParsed : null;
    const cycleCount = Math.max(0, parseInt(req.body.cycleCount, 10) || 0);
    const currentTaskParsed = parseInt(req.body.currentTaskId, 10);
    const currentTaskId = Number.isFinite(currentTaskParsed) ? currentTaskParsed : null;
    const updatedAt = Date.now();
    try {
        await dbRun(
            `INSERT OR REPLACE INTO pomodoro_state 
            (username, mode, remaining_ms, is_running, target_end, cycle_count, current_task_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.username, mode, remainingMs, isRunning, targetEnd, cycleCount, currentTaskId, updatedAt]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to save pomodoro state" });
    }
});

app.get('/api/pomodoro/summary', authenticate, async (req, res) => {
    const days = Math.min(60, Math.max(1, parseInt(req.query.days, 10) || 7));
    try {
        const rows = await dbAll(
            `SELECT date_key, work_sessions, work_minutes, break_minutes 
             FROM pomodoro_daily_stats WHERE username = ? ORDER BY date_key DESC LIMIT ?`,
            [req.user.username, days]
        );
        const totals = await dbAll(
            `SELECT 
                COALESCE(SUM(work_sessions), 0) AS total_sessions,
                COALESCE(SUM(work_minutes), 0) AS total_minutes,
                COALESCE(SUM(break_minutes), 0) AS total_break
             FROM pomodoro_daily_stats WHERE username = ?`,
            [req.user.username]
        );
        const daysMap = {};
        rows.forEach((row) => {
            daysMap[row.date_key] = {
                workSessions: row.work_sessions,
                workMinutes: row.work_minutes,
                breakMinutes: row.break_minutes
            };
        });
        const totalRow = totals[0] || {};
        res.json({
            totals: {
                totalWorkSessions: totalRow.total_sessions || 0,
                totalWorkMinutes: totalRow.total_minutes || 0,
                totalBreakMinutes: totalRow.total_break || 0
            },
            days: daysMap
        });
    } catch (e) {
        res.status(500).json({ error: "Failed to load pomodoro summary" });
    }
});

app.get('/api/pomodoro/sessions', authenticate, async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    try {
        const rows = await dbAll(
            `SELECT id, task_id, task_title, started_at, ended_at, duration_min 
             FROM pomodoro_sessions WHERE username = ? ORDER BY ended_at DESC LIMIT ?`,
            [req.user.username, limit]
        );
        res.json({ sessions: rows });
    } catch (e) {
        res.status(500).json({ error: "Failed to load pomodoro sessions" });
    }
});

app.post('/api/pomodoro/sessions', authenticate, async (req, res) => {
    const taskIdParsed = parseInt(req.body.taskId, 10);
    const taskId = Number.isFinite(taskIdParsed) ? taskIdParsed : null;
    const taskTitle = req.body.taskTitle ? String(req.body.taskTitle) : null;
    const startedAtParsed = parseInt(req.body.startedAt, 10);
    const startedAt = Number.isFinite(startedAtParsed) ? startedAtParsed : null;
    const endedAtParsed = parseInt(req.body.endedAt, 10);
    const endedAt = Number.isFinite(endedAtParsed) ? endedAtParsed : Date.now();
    const durationMin = Math.max(1, parseInt(req.body.durationMin, 10) || 1);
    const dateKey = req.body.dateKey ? String(req.body.dateKey) : null;
    try {
        await dbRun(
            `INSERT INTO pomodoro_sessions 
            (username, task_id, task_title, started_at, ended_at, duration_min, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [req.user.username, taskId, taskTitle, startedAt, endedAt, durationMin, Date.now()]
        );
        if (dateKey) {
            await upsertPomodoroDailyStats(req.user.username, dateKey, durationMin, 0);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to save pomodoro session" });
    }
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
