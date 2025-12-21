import api from './api.js';
import AdminPanel from './admin.js';
import CalendarView from './calendar.js';

async function loadAppConfig() {
    try {
        const res = await fetch('config.json', { cache: 'no-store' });
        if (!res.ok) return {};
        const json = await res.json();
        return json && typeof json === 'object' ? json : {};
    } catch (e) {
        return {};
    }
}

class TodoApp {
    constructor() {
        this.data = [];
        this.dataVersion = 0;
        this.isAdmin = false;
        
        // 状态
        this.currentDate = new Date();
        this.statsDate = new Date(); 
        this.currentTaskId = null;
        this.view = 'tasks';
        this.filter = { query: '', tag: '' };
        
        // 多选状态
        this.isSelectionMode = false;
        this.selectedTaskIds = new Set();
        this.longPressTimer = null;
        this.longPressStart = null;
        this.monthClickTimer = null;
        this.undoState = null;
        this.undoTimer = null;
        this.isLoggingOut = false;
        this.dragActive = false;
        this.dragEndAt = 0;
        this.mobileTaskIndex = 0;
        this.pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
        this.pushEnabled = false;
        this.pushSubscription = null;
        this.swRegistrationPromise = null;
        this.pomodoroSettings = this.getPomodoroDefaults();
        this.pomodoroState = this.getPomodoroStateDefaults();
        this.pomodoroHistory = this.getPomodoroHistoryDefaults();
        this.pomodoroTimerId = null;
        this.pomodoroAnimId = null;
        this.pomodoroUiBound = false;
        this.pomodoroSwipeBound = false;
        this.pomodoroPressTimer = null;
        this.pomodoroLongPressTriggered = false;
        this.pomodoroHistoryCollapsed = new Set();
        this.activeSettingsSection = 'settings-account';
        this.attachmentAllowedExts = new Set([
            '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.rtf',
            '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.svg',
            '.psd', '.psb', '.ai', '.sketch', '.fig', '.xd', '.indd'
        ]);
        this.attachmentAccept = Array.from(this.attachmentAllowedExts).join(',');
        this.pendingAttachmentDeletes = new Map();
        this.todoGroupCollapse = this.loadTodoGroupCollapse();


        this.holidaysByYear = {};
        this.holidayLoading = {};
        const defaults = this.getUserSettingsDefaults();
        this.viewSettings = { ...defaults.viewSettings };
        this.calendarDefaultMode = defaults.calendarDefaultMode;
        this.autoMigrateEnabled = defaults.autoMigrateEnabled;
        this.calendarSettings = { ...defaults.calendarSettings };
        this.tagColors = this.loadTagColors();

        // 模块初始化
        this.admin = new AdminPanel();
        this.calendar = new CalendarView(this); // 传递 this 给 Calendar

        this.exportSettings = {
            type: 'daily',
            dailyTemplate: "📅 {date} 日报\n------------------\n✅ 完成进度: {rate}%\n\n【今日完成】\n{tasks}\n\n【明日计划】\n{plan}",
            weeklyTemplate: "📅 {date} 周报\n==================\n✅ 本周进度: {rate}%\n\n【本周产出】\n{tasks}\n\n【下周规划】\n{plan}"
        };

        window.app = this;
    }

    async init() {
        this.registerServiceWorker();
        if(api.auth) {
            document.getElementById('login-modal').style.display = 'none';
            document.getElementById('current-user').innerText = api.user;
            await this.loadData();
            await this.syncPushSubscription();
        } else {
            document.getElementById('login-modal').style.display = 'flex';
        }
        
        await this.loadUserSettings();
        // 样式已移至 css/style.css，这里只保留基本的兼容性处理或空实现
        this.calendar.initControls(); // 委托 Calendar 初始化控件
        this.calendar.renderRuler();  // 委托 Calendar 渲染尺子
        this.applyViewSettings();
        this.initViewSettingsControls();
        this.initSettingsNav();
        this.initCalendarDefaultModeControl();
        this.initPushControls();
        this.syncAutoMigrateUI();
        this.initMobileSwipes();
        await this.initPomodoro();
        this.initLoginEnter();
        this.initAttachmentControls();
        if (api.auth) this.ensureHolidayYear(this.currentDate.getFullYear());
        
        setInterval(() => { if (!document.hidden) this.loadData(); }, 30000);
        document.addEventListener("visibilitychange", () => {
             if (document.visibilityState === 'visible') this.loadData();
        });
    }

    applyConfig(config = {}) {
        const title = String(config.appTitle || '').trim();
        if (!title) return;
        document.title = title;
        const sidebarTitle = document.querySelector('#sidebar h2');
        if (sidebarTitle) sidebarTitle.textContent = title;
    }
    getUserSettingsDefaults() {
        return {
            viewSettings: { calendar: true, matrix: true, pomodoro: true },
            calendarDefaultMode: 'day',
            autoMigrateEnabled: true,
            pushEnabled: false,
            calendarSettings: { showTime: true, showTags: true, showLunar: true, showHoliday: true }
        };
    }
    loadTodoGroupCollapse() {
        try {
            const raw = localStorage.getItem('glass_todo_groups_collapsed');
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }
    saveTodoGroupCollapse() {
        try {
            localStorage.setItem('glass_todo_groups_collapsed', JSON.stringify(this.todoGroupCollapse || {}));
        } catch (e) {
            // ignore
        }
    }
    toggleTodoGroup(key) {
        if (!key) return;
        this.todoGroupCollapse[key] = !this.todoGroupCollapse[key];
        this.saveTodoGroupCollapse();
        this.render();
    }

    loadTagColors() {
        try {
            const raw = localStorage.getItem('glass_tag_colors');
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }
    saveTagColors() {
        try {
            localStorage.setItem('glass_tag_colors', JSON.stringify(this.tagColors || {}));
        } catch (e) {
            // ignore
        }
    }
    hslToHex(h, s, l) {
        const sat = s / 100;
        const light = l / 100;
        const k = (n) => (n + h / 30) % 12;
        const a = sat * Math.min(light, 1 - light);
        const f = (n) => {
            const color = light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
            return Math.round(255 * color).toString(16).padStart(2, '0');
        };
        return `#${f(0)}${f(8)}${f(4)}`;
    }
    hexToRgba(hex, alpha) {
        const clean = hex.replace('#', '');
        if (clean.length !== 6) return `rgba(0,0,0,${alpha})`;
        const r = parseInt(clean.slice(0, 2), 16);
        const g = parseInt(clean.slice(2, 4), 16);
        const b = parseInt(clean.slice(4, 6), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }
    generateTagColor() {
        const hue = Math.floor(Math.random() * 360);
        return this.hslToHex(hue, 45, 78);
    }
    ensureTagColors(tags = []) {
        let changed = false;
        tags.forEach((tag) => {
            if (!this.tagColors[tag]) {
                this.tagColors[tag] = this.generateTagColor();
                changed = true;
            }
        });
        if (changed) this.saveTagColors();
    }
    getTagColor(tag) {
        if (!tag) return '#7AB9FF';
        if (!this.tagColors[tag]) {
            this.tagColors[tag] = this.generateTagColor();
            this.saveTagColors();
        }
        return this.tagColors[tag];
    }
    darkenColor(hex, factor = 0.6) {
        const clean = String(hex || '').replace('#', '');
        if (clean.length !== 6) return hex;
        const r = Math.max(0, Math.min(255, Math.round(parseInt(clean.slice(0, 2), 16) * factor)));
        const g = Math.max(0, Math.min(255, Math.round(parseInt(clean.slice(2, 4), 16) * factor)));
        const b = Math.max(0, Math.min(255, Math.round(parseInt(clean.slice(4, 6), 16) * factor)));
        return `rgb(${r},${g},${b})`;
    }
    getTagTextColor(tag) {
        return this.darkenColor(this.getTagColor(tag), 0.55);
    }
    loadUserSettingsFromLocal() {
        const defaults = this.getUserSettingsDefaults();
        let viewSettings = defaults.viewSettings;
        try {
            const raw = localStorage.getItem('glass_view_settings');
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && typeof parsed === 'object') {
                viewSettings = { ...defaults.viewSettings, ...parsed };
            }
        } catch (e) {}
        let calendarDefaultMode = defaults.calendarDefaultMode;
        const mode = this.normalizeCalendarMode(localStorage.getItem('glass_calendar_default_mode'));
        if (mode) calendarDefaultMode = mode;
        const autoMigrateRaw = localStorage.getItem('glass_auto_migrate_overdue');
        const autoMigrateEnabled = autoMigrateRaw === null ? defaults.autoMigrateEnabled : autoMigrateRaw === 'true';
        const pushEnabled = localStorage.getItem('glass_push_enabled') === 'true';
        let calendarSettings = defaults.calendarSettings;
        try {
            const raw = localStorage.getItem('glass_calendar_settings');
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && typeof parsed === 'object') {
                calendarSettings = { ...defaults.calendarSettings, ...parsed };
            }
        } catch (e) {}
        return {
            viewSettings,
            calendarDefaultMode,
            autoMigrateEnabled,
            pushEnabled,
            calendarSettings
        };
    }
    buildUserSettingsPayload() {
        return {
            viewSettings: { ...this.viewSettings },
            calendarDefaultMode: this.calendarDefaultMode,
            autoMigrateEnabled: !!this.autoMigrateEnabled,
            pushEnabled: !!this.pushEnabled,
            calendarSettings: { ...this.calendarSettings }
        };
    }
    applyUserSettings(settings = {}) {
        const defaults = this.getUserSettingsDefaults();
        const next = {
            ...defaults,
            ...settings,
            viewSettings: { ...defaults.viewSettings, ...(settings.viewSettings || {}) },
            calendarSettings: { ...defaults.calendarSettings, ...(settings.calendarSettings || {}) }
        };
        this.viewSettings = next.viewSettings;
        this.calendarDefaultMode = this.normalizeCalendarMode(next.calendarDefaultMode) || defaults.calendarDefaultMode;
        this.autoMigrateEnabled = typeof next.autoMigrateEnabled === 'boolean' ? next.autoMigrateEnabled : defaults.autoMigrateEnabled;
        this.pushEnabled = typeof next.pushEnabled === 'boolean' ? next.pushEnabled : defaults.pushEnabled;
        this.calendarSettings = next.calendarSettings;
        if (this.calendar && typeof this.calendar.setSettings === 'function') {
            this.calendar.setSettings(this.calendarSettings);
        }
    }
    async saveUserSettings() {
        const payload = this.buildUserSettingsPayload();
        if (api.isLocalMode() || !api.auth) {
            localStorage.setItem('glass_view_settings', JSON.stringify(payload.viewSettings));
            localStorage.setItem('glass_calendar_default_mode', payload.calendarDefaultMode);
            localStorage.setItem('glass_auto_migrate_overdue', String(payload.autoMigrateEnabled));
            localStorage.setItem('glass_push_enabled', String(payload.pushEnabled));
            localStorage.setItem('glass_calendar_settings', JSON.stringify(payload.calendarSettings));
            return;
        }
        try {
            await api.userSaveSettings({ settings: payload });
        } catch (e) {}
    }
    async loadUserSettings() {
        if (api.isLocalMode() || !api.auth) {
            this.applyUserSettings(this.loadUserSettingsFromLocal());
            return;
        }
        try {
            const json = await api.userGetSettings();
            const remote = json && typeof json === 'object' ? json.settings : null;
            if (!remote) {
                const local = this.loadUserSettingsFromLocal();
                this.applyUserSettings(local);
                await this.saveUserSettings();
                return;
            }
            this.applyUserSettings(remote);
        } catch (e) {
            this.applyUserSettings(this.loadUserSettingsFromLocal());
        }
    }
    syncCalendarDefaultModeUI() {
        const select = document.getElementById('calendar-default-mode');
        if (!select) return;
        select.value = this.calendarDefaultMode;
    }
    updateCalendarSettings(nextSettings) {
        this.calendarSettings = { ...this.calendarSettings, ...nextSettings };
        if (this.calendar && typeof this.calendar.setSettings === 'function') {
            this.calendar.setSettings(this.calendarSettings);
        }
        this.saveUserSettings();
    }
    renderInboxList(tasks, targetId) {
        const box = document.getElementById(targetId);
        if (!box) return;
        box.innerHTML = tasks.map(t => this.createCardHtml(t)).join('') || '<div style="opacity:0.7">&#26242;&#26080;&#24453;&#21150;&#31665;&#20219;&#21153;</div>';
    }

    // --- Auth & Admin (委托给 AdminPanel 或 API) ---
    async login() {
        const u = document.getElementById('login-user').value.trim();
        const p = document.getElementById('login-pwd').value.trim();
        const invite = document.getElementById('login-invite').value.trim();
        if(!u || !p) return alert("请输入用户名密码");
        try {
            const result = await api.login(u, p, invite);
            if(result.success) {
                this.isAdmin = result.isAdmin;
                this.isLoggingOut = false;
                document.getElementById('login-modal').style.display = 'none';
                document.getElementById('current-user').innerText = u;
                await this.loadData();
                await this.syncPushSubscription();
                await this.initPomodoro();
                await this.loadUserSettings();
                this.applyViewSettings();
                this.syncViewSettingUI();
                this.syncCalendarDefaultModeUI();
                this.syncAutoMigrateUI();
                this.updatePushButton();
            } else {
                if(result.needInvite) {
                    document.getElementById('invite-field').style.display = 'block';
                    alert("新用户注册需要管理员邀请码");
                } else alert("登录失败: " + result.error);
            }
        } catch(e) { console.error(e); alert("网络错误"); }
    }
    initLoginEnter() {
        const userInput = document.getElementById('login-user');
        const pwdInput = document.getElementById('login-pwd');
        const inviteInput = document.getElementById('login-invite');
        const handler = (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            this.login();
        };
        [userInput, pwdInput, inviteInput].forEach((el) => {
            if (el) el.addEventListener('keydown', handler);
        });
    }
    logout() { this.handleUnauthorized(true); }
    handleUnauthorized(fromLogout = false) {
        if (this.isLoggingOut) return;
        this.isLoggingOut = true;
        api.clearAuth();
        this.isAdmin = false;
        const adminBtn = document.getElementById('admin-btn');
        if (adminBtn) adminBtn.style.display = 'none';
        const loginModal = document.getElementById('login-modal');
        if (loginModal) loginModal.style.display = 'flex';
        if (fromLogout) this.showToast('已退出登录');
        setTimeout(() => { this.isLoggingOut = false; }, 300);
    }
    openAdminPanel() { this.admin.open(); }
    adminRefreshCode() { this.admin.refreshCode(); }
    adminResetPwd(u) { this.admin.resetPwd(u); }
    adminDelete(u) { this.admin.deleteUser(u); }
    async changePassword() {
        const oldPwd = document.getElementById('pwd-old')?.value.trim();
        const newPwd = document.getElementById('pwd-new')?.value.trim();
        const confirmPwd = document.getElementById('pwd-confirm')?.value.trim();
        if (!oldPwd || !newPwd || !confirmPwd) return alert("请填写完整");
        if (newPwd !== confirmPwd) return alert("两次新密码不一致");
        try {
            const res = await api.changePassword(oldPwd, newPwd);
            const json = await res.json();
            if (res.ok && json.success) {
                ['pwd-old','pwd-new','pwd-confirm'].forEach(id => document.getElementById(id).value = '');
                // 更新本地凭证，避免修改密码后仍使用旧凭证导致后续请求失败
                const token = btoa(unescape(encodeURIComponent(`${api.user}:${newPwd}`)));
                api.setAuth(api.user, token);
                this.showToast("密码已更新");
            } else {
                alert(json.error || "修改失败");
            }
        } catch (e) { console.error(e); alert("修改失败"); }
    }

    // --- 数据逻辑 ---
    async loadData() {
        if (!api.auth && !api.isLocalMode()) return;
        try {
            const json = await api.loadData();
            const newData = json.data || [];
            const newVer = json.version || 0;
            if (newVer > this.dataVersion || this.data.length === 0) {
                this.data = newData;
                this.dataVersion = newVer;
                // 清理过期回收站任务（7天）
                const cleaned = this.cleanupRecycle();
                const migrated = this.autoMigrateEnabled ? this.migrateOverdueTasks() : false;
                if (cleaned || migrated) await this.saveData(true);
                // 检查权限
                if (!api.isLocalMode()) {
                    const loginCheck = await api.request('/api/login', 'POST');
                    const loginJson = await loginCheck.json();
                    this.isAdmin = loginJson.isAdmin;
                    if(this.isAdmin) document.getElementById('admin-btn').style.display = 'block';
                } else {
                    this.isAdmin = false;
                    const adminBtn = document.getElementById('admin-btn');
                    if (adminBtn) adminBtn.style.display = 'none';
                }
                
                this.render();
                this.renderTags();
                this.showToast('数据已同步');
            }
        } catch(e) { console.error(e); if(e.message === 'Unauthorized') this.logout(); }
    }

    async saveData(force = false) {
        try {
            if (api.isLocalMode()) {
                const json = await api.saveData(this.data);
                if (json && json.success) this.dataVersion = json.version;
                return;
            }
            const body = { data: this.data, version: this.dataVersion, force: force };
            const res = await api.request('/api/data', 'POST', body);
            if (res.status === 409) {
                 const err = await res.json();
                 if (confirm(`同步冲突！\n云端版本(${err.serverVersion}) 比本地新。\n确定强制覆盖吗？(取消则拉取云端数据)`)) {
                     this.saveData(true);
                 } else {
                     this.dataVersion = 0;
                     this.loadData();
                 }
                 return;
            }
            const json = await res.json();
            if(json.success) this.dataVersion = json.version;
        } catch(e) { this.showToast("保存失败"); }
    }

    // --- 视图切换 ---
    switchView(v) {
        if (!this.isViewEnabled(v)) v = 'tasks';
        this.view = v;
        if(v !== 'tasks') this.exitSelectionMode();

        document.querySelectorAll('.view-container').forEach(e => e.classList.remove('active'));
        document.getElementById('view-'+v).classList.add('active');
        
        // 更新导航高亮 (Desktop & Mobile) 仅匹配 data-view，避免清除标签筛选状态
        document.querySelectorAll('#mobile-tabbar .tab-item').forEach(e => e.classList.toggle('active', e.dataset.view === v));
        document.querySelectorAll('#sidebar .nav-item[data-view]').forEach(e => e.classList.toggle('active', e.dataset.view === v));

        // 日历控件显隐委托给 CSS 或逻辑控制
        document.getElementById('calendar-controls').style.display = v === 'calendar' ? 'flex' : 'none';
        if (v === 'calendar') this.calendar.setMode(this.calendarDefaultMode);
        if (v === 'settings') this.showSettingsSection(this.activeSettingsSection, { updateHash: false });
        
        this.render();
        if (v === 'tasks') this.applyTaskSwipePosition();
    }

    isViewEnabled(v) {
        if (v === 'calendar') return !!this.viewSettings.calendar;
        if (v === 'matrix') return !!this.viewSettings.matrix;
        if (v === 'pomodoro') return !!this.viewSettings.pomodoro;
        if (v === 'inbox') return false;
        return true;
    }
    applyViewSettings() {
        const map = {
            calendar: this.viewSettings.calendar,
            matrix: this.viewSettings.matrix,
            pomodoro: this.viewSettings.pomodoro
        };
        Object.keys(map).forEach(key => {
            const visible = !!map[key];
            document.querySelectorAll(`#sidebar .nav-item[data-view="${key}"], #mobile-tabbar .tab-item[data-view="${key}"]`)
                .forEach(el => { el.style.display = visible ? '' : 'none'; });
        });
        if (!this.isViewEnabled(this.view)) this.switchView('tasks');
    }
    initViewSettingsControls() {
        document.querySelectorAll('.settings-toggle[data-key]').forEach(item => {
            item.onclick = () => this.toggleViewSetting(item.dataset.key);
        });
        this.syncViewSettingUI();
    }
    initSettingsNav() {
        const nav = document.querySelector('.settings-nav');
        if (!nav) return;
        const links = Array.from(nav.querySelectorAll('a[href^="#settings-"]'));
        const sections = Array.from(document.querySelectorAll('.settings-section'));
        if (!links.length || !sections.length) return;
        const validIds = new Set(sections.map(section => section.id));
        const initial = this.getSettingsSectionFromHash(validIds) || this.activeSettingsSection;
        this.showSettingsSection(initial, { updateHash: false });
        links.forEach(link => {
            link.addEventListener('click', (event) => {
                event.preventDefault();
                const targetId = (link.getAttribute('href') || '').replace('#', '');
                if (validIds.has(targetId)) this.showSettingsSection(targetId);
            });
        });
        window.addEventListener('hashchange', () => {
            const targetId = this.getSettingsSectionFromHash(validIds);
            if (targetId) this.showSettingsSection(targetId, { updateHash: false });
        });
    }
    getSettingsSectionFromHash(validIds) {
        const hash = (window.location.hash || '').replace('#', '');
        if (!hash) return '';
        if (validIds && !validIds.has(hash)) return '';
        const el = document.getElementById(hash);
        return el && el.classList.contains('settings-section') ? hash : '';
    }
    showSettingsSection(id, options = {}) {
        if (!id) return;
        const sections = Array.from(document.querySelectorAll('.settings-section'));
        const links = Array.from(document.querySelectorAll('.settings-nav a[href^="#settings-"]'));
        sections.forEach(section => {
            section.style.display = section.id === id ? '' : 'none';
        });
        links.forEach(link => {
            const targetId = (link.getAttribute('href') || '').replace('#', '');
            link.classList.toggle('active', targetId === id);
        });
        this.activeSettingsSection = id;
        if (options.updateHash === false) return;
        const nextHash = `#${id}`;
        if (window.location.hash !== nextHash) {
            history.replaceState(null, '', nextHash);
        }
    }
    initCalendarDefaultModeControl() {
        const select = document.getElementById('calendar-default-mode');
        if (!select) return;
        select.value = this.calendarDefaultMode;
        select.onchange = () => this.setCalendarDefaultMode(select.value);
    }
    setCalendarDefaultMode(mode) {
        const normalized = this.normalizeCalendarMode(mode) || 'day';
        this.calendarDefaultMode = normalized;
        this.saveUserSettings();
        if (this.view === 'calendar') this.calendar.setMode(normalized);
    }
    normalizeCalendarMode(mode) {
        if (!mode) return '';
        const value = String(mode).toLowerCase();
        return ['day','week','month'].includes(value) ? value : '';
    }
    toggleViewSetting(key) {
        if (key === 'auto-migrate') { this.toggleAutoMigrate(); return; }
        if (!['calendar', 'matrix', 'pomodoro'].includes(key)) return;
        this.viewSettings[key] = !this.viewSettings[key];
        this.saveUserSettings();
        this.syncViewSettingUI();
        this.applyViewSettings();
    }
    syncViewSettingUI() {
        const mapping = {
            calendar: 'switch-view-calendar',
            matrix: 'switch-view-matrix',
            pomodoro: 'switch-view-pomodoro',
            'auto-migrate': 'switch-auto-migrate'
        };
        Object.entries(mapping).forEach(([key, id]) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (key === 'auto-migrate') el.classList.toggle('active', !!this.autoMigrateEnabled);
            else el.classList.toggle('active', !!this.viewSettings[key]);
        });
    }
    loadAutoMigrateSetting() {
        const raw = localStorage.getItem('glass_auto_migrate_overdue');
        if (raw === null) return true;
        return raw === 'true';
    }
    toggleAutoMigrate() {
        this.autoMigrateEnabled = !this.autoMigrateEnabled;
        this.saveUserSettings();
        this.syncViewSettingUI();
    }
    syncAutoMigrateUI() { this.syncViewSettingUI(); }
    registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        this.swRegistrationPromise = navigator.serviceWorker.register('sw.js').catch((err) => {
            console.warn('Service worker registration failed', err);
            return null;
        });
    }

    initPushControls() {
        const btn = document.getElementById('push-toggle-btn');
        if (!btn) return;
        if (!this.pushSupported || api.isLocalMode()) {
            btn.disabled = true;
            btn.textContent = api.isLocalMode() ? '本地模式不支持' : '浏览器不支持';
            return;
        }
        btn.onclick = () => this.togglePushSubscription();
        const testBtn = document.getElementById('push-test-btn');
        if (testBtn) {
            testBtn.onclick = () => this.sendTestPush();
        }
        this.updatePushButton();
    }

    updatePushButton() {
        const btn = document.getElementById('push-toggle-btn');
        if (!btn) return;
        if (!this.pushSupported || api.isLocalMode()) return;
        const perm = Notification.permission;
        const enabled = this.pushEnabled && perm === 'granted';
        if (perm === 'denied') {
            btn.disabled = true;
            btn.textContent = '通知被禁用';
            return;
        }
        btn.disabled = false;
        btn.textContent = enabled ? '关闭通知' : '开启通知';
    }

    async togglePushSubscription() {
        if (!this.pushSupported || api.isLocalMode()) return;
        if (Notification.permission === 'denied') {
            this.showToast('通知权限被禁用');
            this.updatePushButton();
            return;
        }
        if (!this.pushEnabled) {
            await this.enablePush();
        } else {
            await this.disablePush();
        }
        this.updatePushButton();
    }

    async enablePush() {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
            this.pushEnabled = false;
            this.saveUserSettings();
            this.updatePushButton();
            return;
        }
        try {
            await this.ensurePushSubscription();
            this.pushEnabled = true;
            this.saveUserSettings();
            this.showToast('通知已开启');
        } catch (e) {
            console.error(e);
            this.showToast('开启通知失败');
        }
    }

    async disablePush() {
        try {
            await this.removePushSubscription();
        } catch (e) {
            console.warn(e);
        }
        this.pushEnabled = false;
        this.saveUserSettings();
        this.showToast('通知已关闭');
    }

    async syncPushSubscription() {
        if (!this.pushSupported || api.isLocalMode()) return;
        if (Notification.permission === 'denied') {
            this.pushEnabled = false;
            this.saveUserSettings();
            this.updatePushButton();
            return;
        }
        if (this.pushEnabled && Notification.permission === 'granted') {
            try {
                await this.ensurePushSubscription();
            } catch (e) {
                console.warn(e);
            }
        }
        this.updatePushButton();
    }

    async ensurePushSubscription() {
        const { key } = await api.pushPublicKey();
        const reg = this.swRegistrationPromise
            ? await this.swRegistrationPromise
            : await navigator.serviceWorker.ready;
        if (!reg) throw new Error('Service worker not ready');
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
            this.pushSubscription = existing;
            await api.pushSubscribe(existing);
            return;
        }
        const appKey = this.urlBase64ToUint8Array(key);
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
        this.pushSubscription = sub;
        await api.pushSubscribe(sub);
    }

    async removePushSubscription() {
        const reg = this.swRegistrationPromise
            ? await this.swRegistrationPromise
            : await navigator.serviceWorker.ready;
        if (!reg) return;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) {
            await api.pushUnsubscribe();
            return;
        }
        await api.pushUnsubscribe(sub.endpoint);
        await sub.unsubscribe();
    }

    async sendTestPush() {
        if (!this.pushSupported || api.isLocalMode()) return;
        if (Notification.permission !== 'granted') {
            this.showToast('请先开启通知权限');
            return;
        }
        try {
            await this.ensurePushSubscription();
            const res = await api.pushTest();
            if (res && res.success) {
                this.showToast('已发送测试通知');
            } else {
                this.showToast(res.error || '测试通知失败');
            }
        } catch (e) {
            console.error(e);
            this.showToast('测试通知失败');
        }
    }

    urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; i += 1) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    isMobileViewport() {
        return window.matchMedia('(max-width: 768px)').matches;
    }
    initMobileSwipes() {
        this.setupTaskSwipe();
        this.setupCalendarSwipe();
        window.addEventListener('resize', () => this.applyTaskSwipePosition());
    }
    setupTaskSwipe() {
        const board = document.querySelector('#view-tasks .task-board');
        if (!board) return;
        board.addEventListener('touchstart', (e) => {
            if (!this.isMobileViewport() || e.touches.length !== 1) return;
            const t = e.touches[0];
            this.taskSwipeStart = { x: t.clientX, y: t.clientY };
        }, { passive: true });
        board.addEventListener('touchend', (e) => {
            if (!this.isMobileViewport() || !this.taskSwipeStart) return;
            const t = e.changedTouches && e.changedTouches[0];
            const start = this.taskSwipeStart;
            this.taskSwipeStart = null;
            if (!t) return;
            const dx = t.clientX - start.x;
            const dy = t.clientY - start.y;
            const absX = Math.abs(dx);
            const absY = Math.abs(dy);
            if (absX < 40 || absX < absY * 1.2) return;
            this.setMobileTaskIndex(this.mobileTaskIndex + (dx < 0 ? 1 : -1));
        }, { passive: true });
        this.applyTaskSwipePosition();
    }
    applyTaskSwipePosition() {
        const board = document.querySelector('#view-tasks .task-board');
        if (!board) return;
        if (!this.isMobileViewport()) {
            board.style.transform = '';
            this.updateTaskColumnStates();
            this.updateTaskSwipeIndicator();
            return;
        }
        const maxIndex = 2;
        this.mobileTaskIndex = Math.max(0, Math.min(maxIndex, this.mobileTaskIndex));
        board.style.transform = `translateX(-${this.mobileTaskIndex * 100}%)`;
        this.updateTaskColumnStates();
        this.updateTaskSwipeIndicator();
    }
    setMobileTaskIndex(index) {
        const maxIndex = 2;
        const next = Math.max(0, Math.min(maxIndex, index));
        if (next === this.mobileTaskIndex) return;
        this.mobileTaskIndex = next;
        this.applyTaskSwipePosition();
    }
    updateTaskColumnStates() {
        const columns = document.querySelectorAll('#view-tasks .task-column');
        if (!columns.length) return;
        if (!this.isMobileViewport()) {
            columns.forEach(col => col.classList.remove('is-active'));
            return;
        }
        columns.forEach((col, idx) => col.classList.toggle('is-active', idx === this.mobileTaskIndex));
    }
    updateTaskSwipeIndicator() {
        const dots = Array.from(document.querySelectorAll('.task-swipe-dot'));
        if (!dots.length) return;
        if (!this.isMobileViewport()) {
            dots.forEach(dot => dot.classList.remove('active'));
            return;
        }
        dots.forEach((dot, idx) => dot.classList.toggle('active', idx === this.mobileTaskIndex));
    }
    setupCalendarSwipe() {
        const container = document.getElementById('view-calendar');
        if (!container) return;
        container.addEventListener('touchstart', (e) => {
            if (!this.isMobileViewport() || this.view !== 'calendar' || e.touches.length !== 1) return;
            const t = e.touches[0];
            this.calendarSwipeStart = { x: t.clientX, y: t.clientY };
        }, { passive: true });
        container.addEventListener('touchend', (e) => {
            if (!this.isMobileViewport() || this.view !== 'calendar' || !this.calendarSwipeStart) return;
            const t = e.changedTouches && e.changedTouches[0];
            const start = this.calendarSwipeStart;
            this.calendarSwipeStart = null;
            if (!t) return;
            const dx = t.clientX - start.x;
            const dy = t.clientY - start.y;
            const absX = Math.abs(dx);
            const absY = Math.abs(dy);
            if (absX < 40 || absX < absY * 1.2) return;
            const modes = ['day', 'week', 'month'];
            let idx = modes.indexOf(this.calendar.mode || this.calendarDefaultMode);
            if (idx < 0) idx = 0;
            const next = Math.max(0, Math.min(modes.length - 1, idx + (dx < 0 ? 1 : -1)));
            if (next !== idx) this.calendar.setMode(modes[next]);
        }, { passive: true });
    }

    // 代理日历方法，供 HTML onclick 调用
    setCalendarMode(mode) { this.calendar.setMode(mode); }
    changeDate(off) { this.calendar.changeDate(off); }
    dropOnTimeline(ev) { this.calendar.handleDropOnTimeline(ev); this.finishDrag(); }
    
    // HTML ondrop 代理
    allowDrop(ev) { ev.preventDefault(); ev.currentTarget.style.background = 'rgba(0,122,255,0.1)'; }
    leaveDrop(ev) { ev.currentTarget.style.background = ''; }
    dropOnDate(ev, dateStr) {
        ev.preventDefault();
        ev.currentTarget.style.background = '';
        const id = parseInt(ev.dataTransfer.getData("text"));
        const t = this.data.find(i => i.id === id);
        this.finishDrag();
        if (t && !t.deletedAt && t.date !== dateStr) {
            this.queueUndo('已移动日期');
            t.date = dateStr;
            t.inbox = false;
            this.saveData();
            this.render();
            this.showToast(`已移动到 ${dateStr}`);
        }
    }
    
    // 代理日历设置 (HTML onclick)
    toggleCalSetting(key) { this.calendar.toggleSetting(key); }

    // --- 渲染分发 ---
    render() {
        this.updateDateDisplay();
        const allTasks = this.getFilteredData();
        const inboxTasks = allTasks.filter(t => this.isInboxTask(t));
        const datedTasks = allTasks.filter(t => !this.isInboxTask(t));
        const deletedTasks = this.getFilteredData({ onlyDeleted: true });

        // 1. 渲染多选操作栏
        this.renderSelectionBar();

        // 2. 渲染视图
        if (this.view === 'search') {
            document.getElementById('search-results-list').innerHTML = allTasks.map(t => this.createCardHtml(t)).join('');
            return;
        }
        if (this.view === 'tasks') {
            const todoTasks = datedTasks.filter(t => t.status !== 'completed');
            const doneTasks = datedTasks.filter(t => t.status === 'completed');
            const todoBox = document.getElementById('list-todo');
            const doneBox = document.getElementById('list-done');
            if (todoBox) todoBox.innerHTML = this.buildTodoGroups(todoTasks);
            if (doneBox) doneBox.innerHTML = doneTasks
                .sort((a, b) => this.sortByDateTime(a, b, true))
                .map(t => this.createCardHtml(t))
                .join('') || '<div class="task-empty">暂无已完成任务</div>';
            const todoCountEl = document.getElementById('todo-count');
            const doneCountEl = document.getElementById('done-count');
            if (todoCountEl) todoCountEl.innerText = `${todoTasks.length}`;
            if (doneCountEl) doneCountEl.innerText = `${doneTasks.length}`;
            const inboxCountEl = document.getElementById('inbox-count');
            if (inboxCountEl) inboxCountEl.innerText = `${inboxTasks.length}`;
            this.renderInboxList(inboxTasks, 'list-inbox-desktop');
        }
        const mobileBox = document.getElementById('list-inbox-mobile');
        if (mobileBox) mobileBox.innerHTML = '';
        if (this.view === 'matrix') {
            const todayStr = this.formatDate(this.currentDate);
            ['q1','q2','q3','q4'].forEach(q => {
                document.querySelector('#'+q+' .q-list').innerHTML = datedTasks
                    .filter(t => t.status !== 'completed' && t.quadrant === q && t.date === todayStr)
                    .map(t => this.createCardHtml(t))
                    .join('');
            });
        }
        if (this.view === 'calendar') {
            this.calendar.render(); // 委托 Calendar 模块渲染
        }
        if (this.view === 'stats') {
             this.renderStats(allTasks);
        }
        if (this.view === 'pomodoro') {
            this.renderPomodoro();
        }
        if (this.view === 'recycle') {
            this.renderRecycle(deletedTasks);
        }
    }

    getDateStamp(dateStr) {
        if (!dateStr) return null;
        const ts = Date.parse(`${dateStr}T00:00:00`);
        return Number.isNaN(ts) ? null : ts;
    }
    sortByDateTime(a, b, desc = false) {
        const aStamp = this.getDateStamp(a.date) ?? 0;
        const bStamp = this.getDateStamp(b.date) ?? 0;
        if (aStamp !== bStamp) return desc ? bStamp - aStamp : aStamp - bStamp;
        const aTime = a.start ? this.timeToMinutes(a.start) : (a.end ? this.timeToMinutes(a.end) : 9999);
        const bTime = b.start ? this.timeToMinutes(b.start) : (b.end ? this.timeToMinutes(b.end) : 9999);
        if (aTime !== bTime) return desc ? bTime - aTime : aTime - bTime;
        return String(a.title || '').localeCompare(String(b.title || ''));
    }
    buildTodoGroups(tasks) {
        const todayStr = this.formatDate(this.currentDate);
        const todayStamp = this.getDateStamp(todayStr) ?? Date.now();
        const next7Stamp = todayStamp + 7 * 24 * 60 * 60 * 1000;

        const list = Array.isArray(tasks) ? tasks.slice() : [];
        const groups = [
            {
                key: 'overdue',
                title: '已过期',
                items: list.filter(t => {
                    const stamp = this.getDateStamp(t.date);
                    return stamp !== null && stamp < todayStamp;
                })
            },
            {
                key: 'today',
                title: '今天',
                items: list.filter(t => t.date === todayStr)
            },
            {
                key: 'next7',
                title: '最近7天',
                items: list.filter(t => {
                    const stamp = this.getDateStamp(t.date);
                    return stamp !== null && stamp > todayStamp && stamp <= next7Stamp;
                })
            },
            {
                key: 'later',
                title: '更晚',
                items: list.filter(t => {
                    const stamp = this.getDateStamp(t.date);
                    return stamp !== null && stamp > next7Stamp;
                })
            },
            {
                key: 'undated',
                title: '未设置日期',
                items: list.filter(t => this.getDateStamp(t.date) === null)
            }
        ];

        const sections = groups.map(g => {
            if (!g.items.length) return '';
            g.items.sort((a, b) => this.sortByDateTime(a, b));
            const itemsHtml = g.items.map(t => this.createCardHtml(t)).join('');
            const isCollapsed = !!this.todoGroupCollapse[g.key];
            return `
                <div class="task-group ${isCollapsed ? 'collapsed' : ''}" data-key="${g.key}">
                    <div class="task-group-title" onclick="app.toggleTodoGroup('${g.key}')">
                        <span class="task-group-toggle">${isCollapsed ? '+' : '-'}</span>
                        <span class="task-group-text">${g.title}</span>
                        <span class="task-group-count">${g.items.length}</span>
                    </div>
                    <div class="task-group-list">${itemsHtml}</div>
                </div>
            `;
        }).join('');

        return sections || '<div class="task-empty">暂无待办事项</div>';
    }

    // --- 辅助逻辑 ---
    renderSelectionBar() {
        const selBar = document.getElementById('selection-bar');
        if (this.isSelectionMode) {
            // 修复 Problem 6: 全选只针对未完成任务 (或者当前视图可见任务)
            // 这里我们定义“全选”为当前筛选下的 未完成任务 + 已选任务（避免取消掉已选的）
            // 或者更简单的逻辑：全选 = 当前视图所有可见任务。用户说“排除已完成”，通常指在全选时不要选中已完成列表里的。
            // 假设用户是在 Tasks 视图下操作，我们只选取 todo 列表中的。
            const visibleTasks = this.getFilteredData().filter(t => !this.isInboxTask(t) && t.status !== 'completed');
            const allSelected = visibleTasks.length > 0 && visibleTasks.every(t => this.selectedTaskIds.has(t.id));
            
            if (!selBar) {
                const bar = document.createElement('div');
                bar.id = 'selection-bar';
                bar.innerHTML = `
                    <div style="font-weight:bold" id="sel-count">已选 ${this.selectedTaskIds.size}</div>
                    <button class="btn btn-sm btn-secondary" id="btn-select-all" onclick="app.selectAllTasks()">全选</button>
                    <button class="btn btn-sm btn-danger" onclick="app.deleteSelectedTasks()">删除</button>
                    <button class="btn btn-sm btn-secondary" onclick="app.exitSelectionMode()">取消</button>
                `;
                document.body.appendChild(bar);
            } else {
                document.getElementById('sel-count').innerText = `已选 ${this.selectedTaskIds.size}`;
                document.getElementById('btn-select-all').innerText = allSelected ? '全不选' : '全选';
            }
        } else {
            if (selBar) selBar.remove();
        }
    }

    ensureInboxField() {
        const tagsInput = document.getElementById('task-tags');
        if (!tagsInput) return;
        const parent = tagsInput.closest('.form-group');
        if (!parent) return;
        if (!document.getElementById('task-inbox')) {
            const div = document.createElement('div');
            div.className = 'form-group';
            div.style.display = 'flex';
            div.style.gap = '10px';
            div.style.alignItems = 'center';
            div.innerHTML = `<input type="checkbox" id="task-inbox" style="width:auto; height:auto;"> <label for="task-inbox" class="form-label" style="margin:0;">加入待办箱（无日期/时间）</label>`;
            parent.insertAdjacentElement('afterend', div);
        }
    }

    createCardHtml(t) {
        const qColor = this.getQuadrantLightColor(t.quadrant);
        const tags = (t.tags||[]).map(tag => {
            const color = this.getTagTextColor(tag);
            return `<span class="tag-pill" style="color:${color}; background:rgba(0,0,0,0.08);">#${tag}</span>`;
        }).join(' ');
        const pomodoroCount = Number(t.pomodoros || 0);
        const pomodoroHtml = pomodoroCount ? `<span class="pomodoro-pill">🍅 ${pomodoroCount}</span>` : '';
        const attachmentCount = Array.isArray(t.attachments)
            ? t.attachments.filter((a) => a && !this.pendingAttachmentDeletes.has(a.id)).length
            : 0;
        const attachmentHtml = attachmentCount ? `<span class="attachment-pill">📎 ${attachmentCount}</span>` : '';
        const isSelected = this.selectedTaskIds.has(t.id);
        const dateText = this.isInboxTask(t) ? '待办箱' : (t.date || '未设日期');
        const isInbox = this.isInboxTask(t);
        
        const selClass = this.isSelectionMode ? `selection-mode ${isSelected ? 'selected' : ''}` : '';
        const clickHandler = `app.handleCardClick(event, ${t.id})`;
        
        let subHtml = '';
        if(t.subtasks && t.subtasks.length > 0 && !this.isSelectionMode) {
            const subRows = t.subtasks.map((sub, idx) => `
                <div class="card-subtask-item" onclick="event.stopPropagation(); ${isInbox ? `app.showToast('待办箱任务不可完成');` : `app.toggleSubtask(${t.id}, ${idx})`}">
                    <div class="sub-checkbox ${sub.completed?'checked':''} ${isInbox ? 'disabled' : ''}" ${isInbox ? 'title="待办箱任务不可完成"' : ''}></div>
                    <span style="${sub.completed?'text-decoration:line-through;opacity:0.6':''}">${sub.title}</span>
                </div>
            `).join('');
            subHtml = `<div class="card-subtask-list">${subRows}</div>`;
        }

        return `
            <div class="task-card ${t.status} ${selClass}" style="border-left-color:${qColor}" 
                 draggable="${!this.isSelectionMode}" 
                 ondragstart="app.drag(event, ${t.id})" 
                 ondragend="app.finishDrag()"
                 onmousedown="app.handleCardPress(event, ${t.id})" 
                 onmousemove="app.handleCardMove(event)"
                 onmouseup="app.handleCardRelease()" 
                 ontouchstart="app.handleCardPress(event, ${t.id})" 
                 ontouchmove="app.handleCardMove(event)"
                 ontouchend="app.handleCardRelease()" 
                 onclick="${clickHandler}">
                <div class="checkbox ${t.status==='completed'?'checked':''} ${isInbox ? 'disabled' : ''}" ${isInbox ? 'title="待办箱任务不可完成"' : ''} onclick="event.stopPropagation();${isInbox ? `app.showToast('待办箱任务不可完成');` : `app.toggleTask(${t.id})`}"></div>
                <div style="flex:1">
                    <div class="task-title">${t.title}</div>
                    <div style="font-size:0.75rem; color:#666; margin-top:2px;">📅 ${dateText}</div>
                    <div style="margin-top:4px;">${pomodoroHtml}${attachmentHtml}${tags}</div>
                    ${t.start ? `<div style="font-size:0.75rem; color:var(--primary)">⏰ ${t.start}</div>` : ''}
                    ${subHtml}
                </div>
            </div>
        `;
    }

    toggleRepeatOptions() {
        const enabled = document.getElementById('task-repeat-enabled')?.checked;
        const box = document.getElementById('repeat-options');
        if (box) box.style.display = enabled ? 'block' : 'none';
        if (enabled) this.updateRepeatOptionVisibility();
    }
    updateRepeatOptionVisibility() {
        const freq = document.getElementById('repeat-frequency')?.value || 'daily';
        const weekly = document.getElementById('repeat-weekly-options');
        const monthly = document.getElementById('repeat-monthly-options');
        if (weekly) weekly.style.display = freq === 'weekly' ? 'block' : 'none';
        if (monthly) monthly.style.display = freq === 'monthly' ? 'block' : 'none';
    }
    buildRepeatDates(startDate, options) {
        const { frequency, count, weekdays, monthlyDay } = options;
        const dates = [];
        const start = new Date(startDate);
        if (Number.isNaN(start.getTime())) return dates;
        const targetCount = Math.max(1, Math.min(365, count || 1));

        if (frequency === 'daily') {
            for (let i = 0; i < targetCount; i++) {
                const d = new Date(start);
                d.setDate(d.getDate() + i);
                dates.push(d);
            }
            return dates;
        }

        if (frequency === 'weekly') {
            const weekdaySet = new Set((weekdays || []).map(String));
            if (weekdaySet.size === 0) weekdaySet.add(String(start.getDay()));
            let cursor = new Date(start);
            while (dates.length < targetCount) {
                if (weekdaySet.has(String(cursor.getDay()))) dates.push(new Date(cursor));
                cursor.setDate(cursor.getDate() + 1);
            }
            return dates;
        }

        if (frequency === 'monthly') {
            const day = Math.min(31, Math.max(1, monthlyDay || start.getDate()));
            let i = 0;
            let guard = 0;
            while (dates.length < targetCount && guard < targetCount * 4) {
                const d = new Date(start.getFullYear(), start.getMonth() + i, day);
                if (d.getDate() === day) dates.push(d);
                i += 1;
                guard += 1;
            }
            return dates;
        }

        if (frequency === 'yearly') {
            const month = start.getMonth();
            const day = start.getDate();
            for (let i = 0; i < targetCount; i++) {
                const d = new Date(start.getFullYear() + i, month, day);
                dates.push(d);
            }
            return dates;
        }

        return [start];
    }

    // --- 任务操作 ---
    openModal(taskId = null, dateStr = null) {
        if (this.isSelectionMode) { if (taskId) this.toggleSelection(taskId); return; }

        this.currentTaskId = taskId;
        this.ensureInboxField();
        document.getElementById('modal-overlay').style.display = 'flex';
        document.getElementById('modal-title').innerText = taskId ? '✏️ 编辑任务' : '📝 新建任务';
        
        const t = taskId ? this.data.find(i => i.id === taskId) : null;
        const isInbox = t ? (t.inbox || this.isInboxTask(t)) : false;
        document.getElementById('task-title').value = t ? t.title : '';
        document.getElementById('task-date').value = t ? (t.date || '') : (dateStr || this.formatDate(this.currentDate));
        document.getElementById('task-start').value = t ? t.start || '' : '';
        document.getElementById('task-end').value = t ? t.end || '' : '';
        document.getElementById('task-quadrant').value = t ? t.quadrant || 'q2' : 'q2';
        document.getElementById('task-tags').value = t ? (t.tags || []).join(', ') : '';
        const inboxBox = document.getElementById('task-inbox');
        const remindBox = document.getElementById('task-remind');
        if (remindBox) {
            remindBox.checked = !!(t && t.remindAt);
            remindBox.disabled = isInbox;
            if (isInbox) remindBox.checked = false;
        }
        if (inboxBox) {
            inboxBox.checked = isInbox;
            inboxBox.onchange = () => {
                if (!inboxBox.checked) {
                    const dateEl = document.getElementById('task-date');
                    if (dateEl && !dateEl.value) dateEl.value = this.formatDate(this.currentDate);
                    if (remindBox) remindBox.disabled = false;
                } else {
                    document.getElementById('task-date').value = '';
                    document.getElementById('task-start').value = '';
                    document.getElementById('task-end').value = '';
                    if (remindBox) {
                        remindBox.checked = false;
                        remindBox.disabled = true;
                    }
                }
            };
        }
        if (isInbox) {
            document.getElementById('task-date').value = '';
            document.getElementById('task-start').value = '';
            document.getElementById('task-end').value = '';
            if (remindBox) {
                remindBox.checked = false;
                remindBox.disabled = true;
            }
        }

        const repeatBox = document.getElementById('task-repeat-enabled');
        const repeatOptions = document.getElementById('repeat-options');
        if (repeatBox) {
            repeatBox.checked = false;
            repeatBox.disabled = !!taskId;
        }
        if (repeatOptions) repeatOptions.style.display = 'none';
        if (!taskId) {
            const baseDate = document.getElementById('task-date').value;
            const baseDay = baseDate ? parseInt(baseDate.split('-')[2], 10) : this.currentDate.getDate();
            const monthlyDay = document.getElementById('repeat-monthly-day');
            if (monthlyDay) monthlyDay.value = baseDay || 1;
        }
        this.updateRepeatOptionVisibility();
        
        document.getElementById('subtask-container').innerHTML = '';
        const subs = t ? (t.subtasks || []) : [];
        if(subs.length === 0) this.addSubtaskInput(); 
        else subs.forEach(s => this.addSubtaskInput(s.title, s.completed));

        this.renderAttachments(t);
        this.syncAttachmentControls(t);

        setTimeout(() => document.getElementById('task-title').focus(), 100);
    }
    closeModal() { document.getElementById('modal-overlay').style.display = 'none'; this.currentTaskId = null; }

    saveTask() {
        const title = document.getElementById('task-title').value;
        if(!title) return alert("标题不能为空");
        const isEdit = !!this.currentTaskId;
        
        const inboxBox = document.getElementById('task-inbox');
        const dateVal = document.getElementById('task-date').value;
        const startVal = document.getElementById('task-start').value;
        const endVal = document.getElementById('task-end').value;
        let isInbox = inboxBox ? inboxBox.checked : false;
        if (dateVal || startVal || endVal) isInbox = false;
        const repeatEnabled = !isEdit && !isInbox && (document.getElementById('task-repeat-enabled')?.checked);
        const remindEnabled = document.getElementById('task-remind')?.checked;
        if (remindEnabled && (!dateVal || !startVal)) {
            return alert("Start time reminder requires a date and start time.");
        }
        if (repeatEnabled && !document.getElementById('task-date').value) {
            return alert("重复任务需要设置日期");
        }
        const subtasks = [];
        document.querySelectorAll('.subtask-item').forEach(item => {
            const input = item.querySelector('input[type="text"]');
            const check = item.querySelector('input[type="checkbox"]');
            if(input.value.trim()) subtasks.push({ title: input.value.trim(), completed: check.checked });
        });

        // 自动完成父任务逻辑
        let status = this.currentTaskId ? (this.data.find(i=>i.id==this.currentTaskId).status) : 'todo';
        if (subtasks.length > 0) {
            if (subtasks.every(s => s.completed)) status = 'completed';
            else if (status === 'completed') status = 'todo';
        }
        const nowStr = this.formatDate(new Date());
        const prevItem = this.currentTaskId ? this.data.find(i => i.id == this.currentTaskId) : null;
        let completedAt = null;
        if (status === 'completed') {
            completedAt = prevItem?.completedAt || nowStr;
        } else if (prevItem?.status === 'completed' && status !== 'completed') {
            completedAt = null;
        } else if (prevItem?.completedAt) {
            completedAt = prevItem.completedAt;
        }

        const remindAt = this.buildRemindAt(isInbox ? '' : dateVal, isInbox ? '' : startVal, !!remindEnabled);
        let notifiedAt = prevItem && prevItem.remindAt === remindAt ? (prevItem.notifiedAt || null) : null;

        const newItem = {
            id: this.currentTaskId || Date.now(),
            title, 
            date: isInbox ? '' : dateVal,
            start: isInbox ? '' : startVal,
            end: isInbox ? '' : endVal,
            quadrant: document.getElementById('task-quadrant').value,
            tags: document.getElementById('task-tags').value.split(/[,，]/).map(t => t.trim()).filter(t => t),
            pomodoros: prevItem?.pomodoros || 0,
            attachments: prevItem?.attachments || [],
            subtasks, status,
            inbox: isInbox,
            completedAt,
            remindAt,
            notifiedAt,
            deletedAt: this.currentTaskId ? (this.data.find(i=>i.id==this.currentTaskId)?.deletedAt || null) : null
        };
        this.ensureTagColors(newItem.tags);

        if (this.currentTaskId) {
            this.queueUndo('已更新任务');
            const idx = this.data.findIndex(t => t.id === this.currentTaskId);
            if (idx > -1) this.data[idx] = { ...this.data[idx], ...newItem };
        } else {
            this.queueUndo(repeatEnabled ? '已创建重复任务' : '已创建任务');
            if (repeatEnabled) {
                const frequency = document.getElementById('repeat-frequency')?.value || 'daily';
                const count = parseInt(document.getElementById('repeat-count')?.value, 10) || 1;
                const weekdays = Array.from(document.querySelectorAll('.repeat-weekday:checked')).map(el => el.value);
                const monthlyDay = parseInt(document.getElementById('repeat-monthly-day')?.value, 10) || new Date(newItem.date).getDate();
                const dates = this.buildRepeatDates(newItem.date, { frequency, count, weekdays, monthlyDay });
                const baseId = Date.now();
                dates.forEach((d, idx) => {
                    const dateStr = this.formatDate(d);
                    const repeatRemindAt = this.buildRemindAt(dateStr, startVal, !!remindEnabled);
                    this.data.push({
                        ...newItem,
                        id: baseId + idx,
                        date: dateStr,
                        remindAt: repeatRemindAt,
                        notifiedAt: null
                    });
                });
            } else {
                this.data.push(newItem);
            }
        }

        this.closeModal();
        this.saveData();
        this.render();
        this.renderTags();
    }

    // --- 多选逻辑 ---
    handleCardPress(e, id) {
        if (this.isSelectionMode) return;
        // 仅在任务列表或待办箱支持长按进入多选
        if (this.view !== 'tasks') return;
        const point = this.getPointerPoint(e);
        this.longPressStart = point ? { x: point.x, y: point.y } : null;
        this.longPressTimer = setTimeout(() => { this.enterSelectionMode(id); this.longPressTimer = null; }, 500);
    }
    handleCardMove(e) {
        if (!this.longPressTimer || !this.longPressStart) return;
        const point = this.getPointerPoint(e);
        if (!point) return;
        const dx = point.x - this.longPressStart.x;
        const dy = point.y - this.longPressStart.y;
        if ((dx * dx + dy * dy) > 36) this.cancelLongPress();
    }
    handleCardRelease() { this.cancelLongPress(); }
    cancelLongPress() {
        if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; }
        this.longPressStart = null;
    }
    getPointerPoint(e) {
        const touch = e.touches && e.touches[0];
        if (touch) return { x: touch.clientX, y: touch.clientY };
        if (typeof e.clientX === 'number' && typeof e.clientY === 'number') return { x: e.clientX, y: e.clientY };
        return null;
    }
    enterSelectionMode(initialId) { this.isSelectionMode = true; this.selectedTaskIds.clear(); if (initialId) this.selectedTaskIds.add(initialId); if(navigator.vibrate) navigator.vibrate(50); this.render(); }
    exitSelectionMode() { this.isSelectionMode = false; this.selectedTaskIds.clear(); this.render(); }
    toggleSelection(id) { if (this.selectedTaskIds.has(id)) this.selectedTaskIds.delete(id); else this.selectedTaskIds.add(id); this.render(); }
    
    selectAllTasks() {
        // 修复 Problem 6: 全选逻辑，只选中 visible 且未完成的任务
        const visibleTasks = this.getFilteredData().filter(t => t.status !== 'completed');
        const visibleIds = visibleTasks.map(t => t.id);
        
        // 检查是否所有未完成任务都已被选中
        const isAllSelected = visibleIds.length > 0 && visibleIds.every(id => this.selectedTaskIds.has(id));
        
        if (isAllSelected) {
            // 反选：清空当前选中的这些（保留不在当前视图的？通常全选操作清空就清空当前视图的）
            // 这里简单处理：如果全选了，就清空
            this.selectedTaskIds.clear();
        } else {
            // 全选：添加所有可见未完成任务ID
            visibleIds.forEach(id => this.selectedTaskIds.add(id));
        }
        this.render();
    }
    
    deleteSelectedTasks() {
        const count = this.selectedTaskIds.size;
        if (count === 0) return;
        if (!confirm(`确定删除选中的 ${count} 个任务吗？`)) return;
        this.queueUndo('已删除任务');
        const now = Date.now();
        this.data.forEach(t => {
            if (this.selectedTaskIds.has(t.id) && !t.deletedAt) {
                t.deletedAt = now;
            }
        });
        this.saveData();
        this.exitSelectionMode();
        this.showToast(`已移动到回收站: ${count} 个任务`);
    }

    deleteCurrentTask() {
        if (!this.currentTaskId) { this.closeModal(); return; }
        const t = this.data.find(x => x.id === this.currentTaskId);
        if (!t) { this.closeModal(); return; }
        if (!confirm(`确定删除任务 "${t.title}" 吗？`)) return;
        this.queueUndo('已删除任务');
        t.deletedAt = Date.now();
        this.saveData();
        this.closeModal();
        this.render();
        this.showToast('已移动到回收站');
    }

    restoreTask(id) {
        const t = this.data.find(x => x.id === id);
        if (t) {
            this.queueUndo('已还原任务');
            t.deletedAt = null;
            this.saveData();
            this.render();
            this.showToast('已还原');
        }
    }

    deleteForever(id) {
        if (!confirm('确定彻底删除该任务吗？')) return;
        this.queueUndo('已彻底删除任务');
        this.data = this.data.filter(t => t.id !== id);
        this.saveData();
        this.render();
    }
    emptyRecycle() {
        if (!confirm('确定清空回收站吗？此操作不可恢复')) return;
        this.queueUndo('已清空回收站');
        this.data = this.data.filter(t => !t.deletedAt);
        this.saveData();
        this.render();
        this.showToast('回收站已清空');
    }

    // --- 工具 & 统计 ---
    toggleTask(id) {
        if(this.isSelectionMode) return;
        const t = this.data.find(t => t.id === id);
        if (t && !t.deletedAt) {
            if (this.isInboxTask(t)) {
                this.showToast('待办箱任务不可完成，请先移出');
                return;
            }
            this.queueUndo('已更新任务状态');
            const nextStatus = t.status === 'completed' ? 'todo' : 'completed';
            t.status = nextStatus;
            t.completedAt = nextStatus === 'completed' ? this.formatDate(new Date()) : null;
            if (t.status === 'completed' && t.subtasks) t.subtasks.forEach(s => s.completed = true);
            this.saveData();
            this.render();
        }
    }
    toggleSubtask(taskId, subIndex) {
        if(this.isSelectionMode) return;
        const t = this.data.find(i => i.id === taskId);
        if(t && !t.deletedAt && t.subtasks && t.subtasks[subIndex]) {
            this.queueUndo('已更新子任务');
            t.subtasks[subIndex].completed = !t.subtasks[subIndex].completed;
            if (t.subtasks.every(s => s.completed)) {
                if (!this.isInboxTask(t)) {
                    t.status = 'completed';
                    t.completedAt = this.formatDate(new Date());
                    this.showToast('子任务全部完成，任务已自动勾选！');
                }
            }
            else { if (t.status === 'completed') { t.status = 'todo'; t.completedAt = null; } }
            this.saveData();
            this.render();
        }
    }
    addSubtaskInput(val = '', checked = false) {
        const div = document.createElement('div');
        div.className = 'subtask-item';
        div.innerHTML = `<input type="checkbox" ${checked?'checked':''}> <input type="text" class="form-input" style="margin:0; margin-left:8px; padding:6px; flex:1;" value="${val}" placeholder="子任务"> <span onclick="this.parentElement.remove()" style="cursor:pointer; margin-left:8px;">✕</span>`;
        document.getElementById('subtask-container').appendChild(div);
    }
    
    // Drag, Stats, Utils
    drag(ev, id) { 
        if(this.isSelectionMode) { ev.preventDefault(); return; } 
        const t = this.data.find(x => x.id === id);
        if (t && t.deletedAt) { ev.preventDefault(); return; }
        this.cancelLongPress();
        this.dragActive = true;
        this.dragEndAt = 0;
        ev.dataTransfer.setData("text", id);
        ev.dataTransfer.effectAllowed = 'move';
        ev.target.classList.add('dragging'); 
    }
    handleTrashDragOver(ev) {
        if (!this.dragActive) return;
        ev.preventDefault();
        const btn = document.getElementById('trash-drop');
        if (btn) btn.classList.add('is-drag-over');
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    }
    handleTrashDragLeave() {
        const btn = document.getElementById('trash-drop');
        if (btn) btn.classList.remove('is-drag-over');
    }
    async dropOnTrash(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const btn = document.getElementById('trash-drop');
        if (btn) btn.classList.remove('is-drag-over');
        const id = parseInt(ev.dataTransfer.getData("text"));
        const t = this.data.find(i => i.id === id);
        this.finishDrag();
        if (!t || t.deletedAt) return;
        let deleteAttachments = false;
        const attachments = Array.isArray(t.attachments) ? t.attachments : [];
        if (attachments.length) {
            deleteAttachments = confirm(`删除任务将同时删除 ${attachments.length} 个附件，是否继续？`);
            if (!deleteAttachments) return;
        }
        this.queueUndo('已删除任务');
        t.deletedAt = Date.now();
        if (deleteAttachments) {
            await this.deleteTaskAttachments(t);
        }
        this.saveData();
        this.render();
        this.renderTags();
        this.showToast('已移动到回收站');
    }
    drop(ev, quadrantId) {
        ev.preventDefault();
        const id = parseInt(ev.dataTransfer.getData("text"));
        const t = this.data.find(i => i.id === id);
        this.finishDrag();
        if(t && !t.deletedAt && t.quadrant !== quadrantId) {
            this.queueUndo('已移动象限');
            t.quadrant = quadrantId;
            this.saveData();
            this.render();
        }
    }

    handleCardClick(ev, id) {
        if (this.dragActive || (this.dragEndAt && Date.now() - this.dragEndAt < 200)) return;
        if (this.isSelectionMode) { this.toggleSelection(id); return; }
        this.openModal(id);
    }
    finishDrag() {
        this.dragActive = false;
        this.dragEndAt = Date.now();
        document.querySelector('.dragging')?.classList.remove('dragging');
    }
    dropOnTaskList(ev, target) {
        ev.preventDefault();
        ev.currentTarget.style.background = '';
        const id = parseInt(ev.dataTransfer.getData("text"));
        const t = this.data.find(i => i.id === id);
        this.finishDrag();
        if (!t || t.deletedAt) return;
        let changed = false;
        const todayStr = this.formatDate(new Date());
        const wasInbox = this.isInboxTask(t);
        if (target === 'todo') {
            if (t.status === 'completed') { t.status = 'todo'; t.completedAt = null; changed = true; }
            if (t.inbox) { t.inbox = false; changed = true; }
            if (!t.date && wasInbox) { t.date = todayStr; changed = true; }
        } else if (target === 'done') {
            if (t.status !== 'completed') { t.status = 'completed'; t.completedAt = todayStr; changed = true; }
            if (t.inbox) { t.inbox = false; changed = true; }
            if (!t.date && wasInbox) { t.date = todayStr; changed = true; }
            if (t.subtasks) {
                const hadIncomplete = t.subtasks.some(s => !s.completed);
                if (hadIncomplete) changed = true;
                t.subtasks.forEach(s => { s.completed = true; });
            }
        } else if (target === 'inbox') {
            if (!t.inbox || t.status === 'completed' || t.date || t.start || t.end) changed = true;
            t.inbox = true;
            t.status = 'todo';
            t.completedAt = null;
            t.date = '';
            t.start = '';
            t.end = '';
        }
        if (changed) {
            this.queueUndo('已移动任务');
            this.saveData();
            this.render();
        }
    }

    handleMonthTaskClick(ev, id) {
        ev.stopPropagation();
        if (this.monthClickTimer) clearTimeout(this.monthClickTimer);
        this.monthClickTimer = setTimeout(() => {
            this.openModal(id);
            this.monthClickTimer = null;
        }, 220);
    }
    handleMonthTaskDblClick(ev, id) {
        ev.stopPropagation();
        if (this.monthClickTimer) {
            clearTimeout(this.monthClickTimer);
            this.monthClickTimer = null;
        }
        this.toggleTask(id);
    }
    
    renderStats(tasks = this.getFilteredData()) {
        const allTasks = this.getFilteredData();
        const done = tasks.filter(t => t.status === 'completed').length;
        const total = tasks.length;
        const rate = total === 0 ? 0 : Math.round((done/total)*100);
        const rateEl = document.getElementById('completion-rate');
        if (rateEl) rateEl.innerText = rate + '%';
        
        const currentAnchor = new Date(this.statsDate);
        const day = currentAnchor.getDay();
        const diff = currentAnchor.getDate() - day + (day == 0 ? -6 : 1);
        const startOfWeek = new Date(currentAnchor.setDate(diff));
        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(startOfWeek.getDate() + 6);
        
        const getCompletionDate = (task) => task.completedAt || task.date || '';
        const weekData = [];
        for(let i=0; i<7; i++) {
            const d = new Date(startOfWeek); d.setDate(d.getDate() + i);
            const dStr = this.formatDate(d);
            const dayDone = tasks.filter(t => getCompletionDate(t) === dStr && t.status === 'completed').length;
            weekData.push({ day: ['一','二','三','四','五','六','日'][i], count: dayDone });
        }

        const weekTotal = tasks.filter(t => t.date >= this.formatDate(startOfWeek) && t.date <= this.formatDate(endOfWeek)).length;
        const maxVal = Math.max(weekTotal, 1);
        const barsHtml = weekData.map(d => `
            <div style="flex:1; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:flex-end;">
                <div style="width:20px; height:${Math.max(4, (d.count/maxVal)*100)}%; background:var(--primary); border-radius:4px 4px 0 0; opacity:0.8;"></div>
                <div style="font-size:0.7rem; color:#666; margin-top:5px;">${d.day}</div>
                <div style="font-size:0.7rem; font-weight:bold;">${d.count}</div>
            </div>`).join('');

        const completedByDate = {};
        tasks.forEach(t => {
            const dateStr = getCompletionDate(t);
            if (t.status !== 'completed' || !dateStr) return;
            completedByDate[dateStr] = (completedByDate[dateStr] || 0) + 1;
        });
        const completedByDateAll = {};
        allTasks.forEach(t => {
            const dateStr = getCompletionDate(t);
            if (t.status !== 'completed' || !dateStr) return;
            completedByDateAll[dateStr] = (completedByDateAll[dateStr] || 0) + 1;
        });
        const today = new Date();
        const startDate = new Date(today);
        startDate.setDate(startDate.getDate() - 364);
        const heatmapCells = [];
        const startDow = (startDate.getDay() + 6) % 7;
        for (let i = 0; i < startDow; i++) heatmapCells.push(null);
        for (let i = 0; i < 365; i++) {
            const d = new Date(startDate);
            d.setDate(startDate.getDate() + i);
            const dStr = this.formatDate(d);
            const count = completedByDate[dStr] || 0;
            const level = count === 0 ? 0 : count <= 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 3 : 4;
            heatmapCells.push({ date: dStr, count, level });
        }
        const heatmapHtml = heatmapCells.map(c => {
            if (!c) return `<div class="heatmap-cell empty"></div>`;
            return `<div class="heatmap-cell level-${c.level}" title="${c.date} 完成 ${c.count}"></div>`;
        }).join('');
        const todayStamp = this.getDateStamp(this.formatDate(today)) ?? 0;
        const last7Start = new Date(today);
        last7Start.setDate(today.getDate() - 6);
        const last7StartStamp = this.getDateStamp(this.formatDate(last7Start)) ?? 0;
        const last7Done = allTasks.filter(t => {
            const dateStr = getCompletionDate(t);
            if (t.status !== 'completed' || !dateStr) return false;
            const stamp = this.getDateStamp(dateStr) ?? 0;
            return stamp >= last7StartStamp && stamp <= todayStamp;
        }).length;
        const avgPerDay = Math.round((last7Done / 7) * 10) / 10;
        const avgText = Number.isInteger(avgPerDay) ? String(avgPerDay) : avgPerDay.toFixed(1);
        const pendingCount = allTasks.filter(t => t.status !== 'completed').length;
        let streak = 0;
        for (let i = 0; i < 366; i++) {
            const d = new Date(today);
            d.setDate(today.getDate() - i);
            const dStr = this.formatDate(d);
            if (completedByDateAll[dStr]) streak += 1;
            else break;
        }

        document.getElementById('view-stats').innerHTML = `
            <div class="stats-metrics">
                <div class="stats-metric-card">
                    <div class="stats-metric-title">近7天完成数</div>
                    <div class="stats-metric-value">${last7Done}</div>
                </div>
                <div class="stats-metric-card">
                    <div class="stats-metric-title">平均每天完成</div>
                    <div class="stats-metric-value">${avgText}</div>
                </div>
                <div class="stats-metric-card">
                    <div class="stats-metric-title">当前未完成</div>
                    <div class="stats-metric-value">${pendingCount}</div>
                </div>
                <div class="stats-metric-card">
                    <div class="stats-metric-title">连续完成天数</div>
                    <div class="stats-metric-value">${streak}</div>
                </div>
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:20px;">
                <div class="stats-card" style="flex:1; min-width:250px; text-align:center;">
                    <h3>📊 总完成率</h3>
                    <div style="width:120px; height:120px; border-radius:50%; background:conic-gradient(var(--primary) ${rate}%, #eee 0); margin:20px auto; display:flex; align-items:center; justify-content:center;">
                        <div style="width:100px; height:100px; background:rgba(255,255,255,0.9); border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:1.5rem;">${rate}%</div>
                    </div>
                    <p style="color:#666;">总任务: ${total} / 已完成: ${done}</p>
                </div>
                <div class="stats-card" style="flex:2; min-width:300px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                        <h3>📈 本周趋势</h3>
                        <div>
                            <button class="btn-text" onclick="app.changeStatsWeek(-1)">❮</button>
                            <span style="font-size:0.8rem; font-weight:bold; margin:0 10px;">${this.formatDate(startOfWeek).slice(5)} - ${this.formatDate(endOfWeek).slice(5)}</span>
                            <button class="btn-text" onclick="app.changeStatsWeek(1)">❯</button>
                        </div>
                    </div>
                    <div style="height:150px; display:flex; gap:5px; align-items:flex-end; padding-bottom:10px;">${barsHtml}</div>
                </div>
            </div>`;
        document.getElementById('view-stats').innerHTML += `
            <div class="stats-card" style="margin-top:20px;">
                <h3>过去一年完成热力图</h3>
                <div class="heatmap-grid">${heatmapHtml}</div>
                <div class="heatmap-legend">
                    <span>少</span>
                    <div class="heatmap-cell level-1"></div>
                    <div class="heatmap-cell level-2"></div>
                    <div class="heatmap-cell level-3"></div>
                    <div class="heatmap-cell level-4"></div>
                    <span>多</span>
                </div>
            </div>`;
    }
    changeStatsWeek(off) { this.statsDate.setDate(this.statsDate.getDate() + off * 7); this.render(); }

    renderRecycle(tasks, targetId = 'recycle-list') {
        const box = document.getElementById(targetId);
        if (!box) return;
        const clearBtn = `<div style="text-align:right; margin-bottom:10px;"><button class="btn btn-sm btn-danger" onclick="app.emptyRecycle()">清空回收站</button></div>`;
        if (!tasks.length) { box.innerHTML = clearBtn + '<div style="opacity:0.7">回收站空空如也</div>'; return; }
        box.innerHTML = clearBtn + tasks.map(t => `
            <div class="task-card" style="background:#f9f9f9; border-left-color:#aaa;">
                <div style="flex:1">
                    <div class="task-title">${t.title}</div>
                    <div style="font-size:0.75rem; color:#666; margin-top:4px;">删除时间：${new Date(t.deletedAt).toLocaleString()}</div>
                    <div style="margin-top:4px; font-size:0.75rem; color:#666;">标签：${(t.tags||[]).join(', ') || '无'}</div>
                </div>
                <div style="display:flex; gap:8px;">
                    <button class="btn btn-sm btn-secondary" onclick="app.restoreTask(${t.id})">还原</button>
                    <button class="btn btn-sm btn-danger" onclick="app.deleteForever(${t.id})">彻底删除</button>
                </div>
            </div>`).join('');
    }

    renderTags() {
        const tags = new Set(); this.data.filter(t => !t.deletedAt).forEach(t => (t.tags||[]).forEach(tag => tags.add(tag)));
        document.getElementById('tag-filter-list').innerHTML = Array.from(tags).map(tag => {
            const color = this.getTagColor(tag);
            return `
            <div class="nav-item ${this.filter.tag===tag?'active':''}" onclick="if(!event.target.closest('.tag-more')) app.setTagFilter('${tag}')">
                <div class="tag-dot" style="background:${color}"></div> 
                <span style="flex:1">${tag}</span>
                <div class="tag-more" onclick="event.stopPropagation();app.openTagMenu('${tag}')">⋯</div>
            </div>
        `;
        }).join('');
    }
    setTagFilter(tag) { this.filter.tag = this.filter.tag === tag ? '' : tag; this.renderTags(); this.render(); }
    deleteTag(tag) {
        if (!confirm(`删除标签 "${tag}" 会移除所有包含该标签的任务，确定吗？`)) return;
        this.queueUndo('已删除标签');
        const now = Date.now();
        this.data.forEach(t => {
            if ((t.tags||[]).includes(tag)) {
                t.deletedAt = now;
            }
        });
        this.saveData();
        this.render();
        this.renderTags();
        this.showToast(`已删除包含 ${tag} 的任务`);
    }

    openTagMenu(tag) {
        const newName = prompt(`标签操作: 输入新名称以重命名，或留空直接删除。\n当前: ${tag}`, tag);
        if (newName === null) return;
        const trimmed = newName.trim();
        if (trimmed === '' || trimmed === tag) {
            this.deleteTag(tag);
            return;
        }
        // 重命名
        this.queueUndo('已重命名标签');
        this.data.forEach(t => {
            if (t.tags) {
                t.tags = t.tags.map(x => x === tag ? trimmed : x);
            }
        });
        this.saveData();
        this.render();
        this.renderTags();
        this.showToast(`已重命名标签为 ${trimmed}`);
    }
    getFilteredData(options = {}) { 
        const { includeDeleted = false, onlyDeleted = false } = options;
        const q = this.filter.query ? this.filter.query.trim() : '';
        return this.data.filter(t => {
            if (onlyDeleted) {
                if (!t.deletedAt) return false;
            } else if (!includeDeleted && t.deletedAt) return false;

            const attachments = (t.attachments || []).filter((a) => a && !this.pendingAttachmentDeletes.has(a.id));
            const matchQuery = !q || t.title.includes(q) 
                || (t.tags||[]).some(tag => tag.includes(q))
                || (t.subtasks||[]).some(s => (s.title||'').includes(q))
                || attachments.some(a => (a.name || '').includes(q));
            const matchTag = !this.filter.tag || (t.tags||[]).includes(this.filter.tag);
            return matchQuery && matchTag;
        });
    }

    async ensureHolidayYear(year) {
        if (!api.auth) return;
        const y = String(year);
        if (this.holidaysByYear[y] || this.holidayLoading[y]) return;
        this.holidayLoading[y] = true;
        try {
            let json = null;
            if (api.holidayJsonUrl) {
                const url = api.holidayJsonUrl.includes('{year}')
                    ? api.holidayJsonUrl.replace('{year}', y)
                    : api.holidayJsonUrl;
                const res = await fetch(url, { cache: 'no-store' });
                if (!res.ok) throw new Error('holiday json fetch failed');
                json = await res.json();
            } else {
                if (api.isLocalMode() && !api.baseUrl) return;
                const res = await api.request(`/api/holidays/${y}`);
                if (!res.ok) throw new Error('holiday fetch failed');
                json = await res.json();
            }
            const map = {};
            (json.days || []).forEach(d => {
                map[d.date] = { name: d.name, isOffDay: d.isOffDay };
            });
            this.holidaysByYear[y] = map;
        } catch (e) {
            console.warn('holiday load failed', e);
        } finally {
            delete this.holidayLoading[y];
            this.render();
        }
    }
    getHolidayForDate(dateStr) {
        const year = String(dateStr || '').slice(0, 4);
        if (!/^\d{4}$/.test(year)) return null;
        const map = this.holidaysByYear[year];
        if (!map) {
            this.ensureHolidayYear(year);
            return null;
        }
        return map[dateStr] || null;
    }
    getLunarText(date) {
        try {
            const fmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' });
            const parts = fmt.formatToParts(date);
            const monthPart = parts.find(p => p.type === 'month')?.value || '';
            const dayPart = parts.find(p => p.type === 'day')?.value || '';
            const rawDay = dayPart.replace(/\s/g, '');
            const dayText = /\d+/.test(rawDay) ? this.formatLunarDay(parseInt(rawDay, 10)) : rawDay;
            return `${monthPart}${dayText}`.replace(/\s/g, '');
        } catch (e) {
            return '';
        }
    }
    formatLunarDay(day) {
        const map = {
            1: '初一', 2: '初二', 3: '初三', 4: '初四', 5: '初五',
            6: '初六', 7: '初七', 8: '初八', 9: '初九', 10: '初十',
            11: '十一', 12: '十二', 13: '十三', 14: '十四', 15: '十五',
            16: '十六', 17: '十七', 18: '十八', 19: '十九', 20: '二十',
            21: '廿一', 22: '廿二', 23: '廿三', 24: '廿四', 25: '廿五',
            26: '廿六', 27: '廿七', 28: '廿八', 29: '廿九', 30: '三十'
        };
        return map[day] || '';
    }

    cleanupRecycle() {
        const now = Date.now();
        const before = this.data.length;
        this.data = this.data.filter(t => !t.deletedAt || (now - t.deletedAt) <= 7 * 24 * 60 * 60 * 1000);
        return this.data.length !== before;
    }

    migrateOverdueTasks() {
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;
        let changed = false;
        this.data.forEach(t => {
            if (t.deletedAt) return;
            if (t.status === 'completed') return;
            const dateStamp = this.getDateStamp(t.date);
            if (dateStamp !== null) {
                const overdueMs = now - dateStamp;
                if (overdueMs > 30 * dayMs) {
                    t.deletedAt = now;
                    changed = true;
                    return;
                }
                if (overdueMs > 7 * dayMs && !this.isInboxTask(t)) {
                    t.inbox = true;
                    t.inboxAt = now;
                    t.date = '';
                    t.start = '';
                    t.end = '';
                    changed = true;
                }
                return;
            }
            if (this.isInboxTask(t) && t.inboxAt && (now - t.inboxAt) > 30 * dayMs) {
                t.deletedAt = now;
                changed = true;
            }
        });
        return changed;
    }
    // --- Pomodoro ---
    getPomodoroDefaults() {
        return {
            workMin: 25,
            shortBreakMin: 5,
            longBreakMin: 15,
            longBreakEvery: 4,
            autoStartNext: false,
            autoStartBreak: false,
            autoStartWork: false,
            autoFinishTask: false
        };
    }
    getPomodoroStateDefaults() {
        return {
            mode: 'work',
            remainingMs: 25 * 60 * 1000,
            isRunning: false,
            cycleCount: 0,
            currentTaskId: null,
            targetEnd: null
        };
    }
    getPomodoroHistoryDefaults() {
        return { totalWorkSessions: 0, totalWorkMinutes: 0, totalBreakMinutes: 0, days: {}, sessions: [] };
    }
    loadPomodoroSettings() {
        const defaults = this.getPomodoroDefaults();
        try {
            const raw = localStorage.getItem('glass_pomodoro_settings');
            const parsed = raw ? JSON.parse(raw) : {};
            const merged = { ...defaults, ...parsed };
            if (typeof merged.autoStartBreak !== 'boolean' || typeof merged.autoStartWork !== 'boolean') {
                const fallback = !!merged.autoStartNext;
                merged.autoStartBreak = fallback;
                merged.autoStartWork = fallback;
            }
            return merged;
        } catch (e) {
            return defaults;
        }
    }
    savePomodoroSettings() {
        if (api.isLocalMode() || !api.auth) {
            localStorage.setItem('glass_pomodoro_settings', JSON.stringify(this.pomodoroSettings));
            return;
        }
        const payload = {
            workMin: this.pomodoroSettings.workMin,
            shortBreakMin: this.pomodoroSettings.shortBreakMin,
            longBreakMin: this.pomodoroSettings.longBreakMin,
            longBreakEvery: this.pomodoroSettings.longBreakEvery,
            autoStartNext: this.pomodoroSettings.autoStartNext,
            autoStartBreak: this.pomodoroSettings.autoStartBreak,
            autoStartWork: this.pomodoroSettings.autoStartWork,
            autoFinishTask: this.pomodoroSettings.autoFinishTask
        };
        api.pomodoroSaveSettings(payload).catch(() => {});
    }
    loadPomodoroState() {
        const defaults = this.getPomodoroStateDefaults();
        try {
            const raw = localStorage.getItem('glass_pomodoro_state');
            const parsed = raw ? JSON.parse(raw) : {};
            return { ...defaults, ...parsed };
        } catch (e) {
            return defaults;
        }
    }
    savePomodoroState() {
        const state = {
            ...this.pomodoroState,
            remainingMs: Math.max(0, Math.floor(this.pomodoroState.remainingMs || 0))
        };
        if (api.isLocalMode() || !api.auth) {
            localStorage.setItem('glass_pomodoro_state', JSON.stringify(state));
            return;
        }
        const payload = {
            mode: state.mode,
            remainingMs: state.remainingMs,
            isRunning: state.isRunning,
            targetEnd: state.targetEnd,
            cycleCount: state.cycleCount,
            currentTaskId: state.currentTaskId
        };
        api.pomodoroSaveState(payload).catch(() => {});
    }
    loadPomodoroHistory() {
        const defaults = this.getPomodoroHistoryDefaults();
        try {
            const raw = localStorage.getItem('glass_pomodoro_history');
            const parsed = raw ? JSON.parse(raw) : {};
            return { ...defaults, ...parsed, days: parsed?.days || {}, sessions: parsed?.sessions || [] };
        } catch (e) {
            return defaults;
        }
    }
    savePomodoroHistory() {
        if (api.isLocalMode() || !api.auth) {
            localStorage.setItem('glass_pomodoro_history', JSON.stringify(this.pomodoroHistory));
        }
    }
    async loadPomodoroSettingsFromServer() {
        const defaults = this.getPomodoroDefaults();
        if (!api.auth || api.isLocalMode()) return defaults;
        try {
            const json = await api.pomodoroGetSettings();
            const settings = json?.settings || {};
            const merged = { ...defaults, ...settings };
            if (typeof merged.autoStartBreak !== 'boolean' || typeof merged.autoStartWork !== 'boolean') {
                const fallback = !!merged.autoStartNext;
                merged.autoStartBreak = fallback;
                merged.autoStartWork = fallback;
            }
            return merged;
        } catch (e) {
            return defaults;
        }
    }
    async loadPomodoroStateFromServer() {
        const defaults = this.getPomodoroStateDefaults();
        if (!api.auth || api.isLocalMode()) return defaults;
        try {
            const json = await api.pomodoroGetState();
            const state = json?.state;
            return state ? { ...defaults, ...state } : defaults;
        } catch (e) {
            return defaults;
        }
    }
    async loadPomodoroHistoryFromServer() {
        const defaults = this.getPomodoroHistoryDefaults();
        if (!api.auth || api.isLocalMode()) return defaults;
        try {
            const [summaryJson, sessionsJson] = await Promise.all([
                api.pomodoroGetSummary(7),
                api.pomodoroGetSessions(50)
            ]);
            const sessions = Array.isArray(sessionsJson?.sessions) ? sessionsJson.sessions : [];
            return this.buildPomodoroHistoryFromSummary(summaryJson, sessions);
        } catch (e) {
            return defaults;
        }
    }
    buildPomodoroHistoryFromSummary(summary = {}, sessions = []) {
        const history = this.getPomodoroHistoryDefaults();
        const byDay = summary?.days && typeof summary.days === 'object' ? summary.days : {};
        const sessionLabels = [];
        sessions.forEach((row) => {
            const endedAt = Number(row.ended_at || row.endedAt || 0);
            if (!endedAt) return;
            const dateKey = this.formatDate(new Date(endedAt));
            const timeLabel = new Date(endedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            const title = row.task_title || row.taskTitle || '专注';
            const label = `${title} (${timeLabel})`;
            sessionLabels.push(`${dateKey} | ${label}`);
        });
        const totals = summary?.totals || {};
        history.totalWorkSessions = totals.totalWorkSessions || 0;
        history.totalWorkMinutes = totals.totalWorkMinutes || 0;
        history.totalBreakMinutes = totals.totalBreakMinutes || 0;
        history.days = byDay;
        history.sessions = sessionLabels;
        return history;
    }
    getPomodoroDuration(mode) {
        const settings = this.pomodoroSettings || this.getPomodoroDefaults();
        if (mode === 'short') return settings.shortBreakMin * 60 * 1000;
        if (mode === 'long') return settings.longBreakMin * 60 * 1000;
        return settings.workMin * 60 * 1000;
    }
    async initPomodoro() {
        if (!api.auth && !api.isLocalMode()) {
            this.pomodoroSettings = this.getPomodoroDefaults();
            this.pomodoroHistory = this.getPomodoroHistoryDefaults();
            this.pomodoroState = this.getPomodoroStateDefaults();
        } else if (api.isLocalMode()) {
            this.pomodoroSettings = this.loadPomodoroSettings();
            this.pomodoroHistory = this.loadPomodoroHistory();
            this.pomodoroState = this.loadPomodoroState();
        } else {
            this.pomodoroSettings = await this.loadPomodoroSettingsFromServer();
            this.pomodoroHistory = await this.loadPomodoroHistoryFromServer();
            this.pomodoroState = await this.loadPomodoroStateFromServer();
        }
        this.initPomodoroTicks();
        if (!['work', 'short', 'long'].includes(this.pomodoroState.mode)) {
            this.pomodoroState.mode = 'work';
        }
        const duration = this.getPomodoroDuration(this.pomodoroState.mode);
        if (!Number.isFinite(this.pomodoroState.remainingMs) || this.pomodoroState.remainingMs <= 0 || this.pomodoroState.remainingMs > duration) {
            this.pomodoroState.remainingMs = duration;
        }
        if (this.pomodoroState.isRunning) {
            if (typeof this.pomodoroState.targetEnd !== 'number') {
                this.pomodoroState.isRunning = false;
                this.pomodoroState.targetEnd = null;
            } else {
                const remaining = this.pomodoroState.targetEnd - Date.now();
                if (remaining <= 0) {
                    this.pomodoroState.remainingMs = 0;
                    this.pomodoroState.isRunning = false;
                    this.pomodoroState.targetEnd = null;
                    this.finishPomodoroSession(true);
                } else {
                    this.pomodoroState.remainingMs = remaining;
                }
            }
        }
        this.savePomodoroState();
        if (this.pomodoroTimerId) clearInterval(this.pomodoroTimerId);
        this.pomodoroTimerId = setInterval(() => this.pomodoroTick(), 1000);
        this.startPomodoroAnimation();
        this.bindPomodoroUI();
        this.renderPomodoro();
    }
    startPomodoroAnimation() {
        if (this.pomodoroAnimId) return;
        const step = () => {
            if (this.view === 'pomodoro') this.updatePomodoroDisplay();
            this.pomodoroAnimId = requestAnimationFrame(step);
        };
        this.pomodoroAnimId = requestAnimationFrame(step);
    }
    bindPomodoroUI() {
        if (this.pomodoroUiBound) return;
        const actionBtn = document.getElementById('pomodoro-action-btn');
        const confirmBtn = document.getElementById('pomodoro-settings-confirm');
        const settingsOverlay = document.getElementById('pomodoro-settings-overlay');
        const autoStartRow = document.getElementById('pomodoro-auto-switch')?.closest('.settings-toggle');
        const autoBreakRow = document.getElementById('pomodoro-auto-break-switch')?.closest('.settings-toggle');
        const autoWorkRow = document.getElementById('pomodoro-auto-work-switch')?.closest('.settings-toggle');
        const autoFinishRow = document.getElementById('pomodoro-auto-finish-switch')?.closest('.settings-toggle');
        const completedList = document.getElementById('pomodoro-completed-list');
        if (actionBtn) {
            const clearPress = () => {
                if (this.pomodoroPressTimer) {
                    clearTimeout(this.pomodoroPressTimer);
                    this.pomodoroPressTimer = null;
                }
            };
            actionBtn.addEventListener('pointerdown', () => {
                if (!this.pomodoroState.isRunning) return;
                clearPress();
                this.pomodoroLongPressTriggered = false;
                this.pomodoroPressTimer = setTimeout(() => {
                    this.pomodoroLongPressTriggered = true;
                    const ok = confirm('停止计时将丢失本次番茄，确认停止？');
                    if (ok) {
                        this.resetPomodoro();
                        this.showToast('已停止番茄钟');
                    }
                }, 700);
            });
            actionBtn.addEventListener('pointerup', clearPress);
            actionBtn.addEventListener('pointerleave', clearPress);
            actionBtn.addEventListener('pointercancel', clearPress);
            actionBtn.addEventListener('click', () => {
                if (this.pomodoroLongPressTriggered) {
                    this.pomodoroLongPressTriggered = false;
                    return;
                }
                this.togglePomodoroRun();
            });
        }
        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                this.updatePomodoroSettingsFromUI();
                this.closePomodoroSettings();
            });
        }
        if (settingsOverlay) {
            settingsOverlay.addEventListener('click', (e) => {
                if (e.target === settingsOverlay) this.closePomodoroSettings();
            });
        }
        if (autoStartRow) {
            autoStartRow.addEventListener('click', () => this.togglePomodoroAutoStart());
        }
        if (autoBreakRow) {
            autoBreakRow.addEventListener('click', () => this.togglePomodoroAutoStartBreak());
        }
        if (autoWorkRow) {
            autoWorkRow.addEventListener('click', () => this.togglePomodoroAutoStartWork());
        }
        if (autoFinishRow) {
            autoFinishRow.addEventListener('click', () => this.togglePomodoroAutoFinishTask());
        }
        if (completedList) {
            completedList.addEventListener('click', (e) => {
                const header = e.target.closest('.pomodoro-history-date');
                if (!header) return;
                const dateKey = header.getAttribute('data-date');
                if (!dateKey) return;
                this.togglePomodoroHistoryGroup(dateKey);
            });
        }
        document.addEventListener('click', (e) => {
            const picker = document.getElementById('pomodoro-task-picker');
            const title = document.getElementById('pomodoro-task-title');
            if (!picker || !title) return;
            if (picker.contains(e.target) || title.contains(e.target)) return;
            picker.classList.remove('open');
        });
        this.bindPomodoroSwipe();
        this.pomodoroUiBound = true;
    }
    togglePomodoroHistoryGroup(dateKey) {
        if (this.pomodoroHistoryCollapsed.has(dateKey)) {
            this.pomodoroHistoryCollapsed.delete(dateKey);
        } else {
            this.pomodoroHistoryCollapsed.add(dateKey);
        }
        this.renderPomodoro();
    }
    bindPomodoroSwipe() {
        if (this.pomodoroSwipeBound) return;
        const swipe = document.querySelector('.pomodoro-swipe');
        const dots = Array.from(document.querySelectorAll('.pomodoro-swipe-dot'));
        if (!swipe || dots.length === 0) {
            this.pomodoroSwipeBound = true;
            return;
        }
        const update = () => this.updatePomodoroSwipeIndicator();
        let rafId = null;
        swipe.addEventListener('scroll', () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                update();
            });
        });
        dots.forEach((dot, index) => {
            dot.addEventListener('click', () => {
                swipe.scrollTo({ left: swipe.clientWidth * index, behavior: 'smooth' });
            });
        });
        update();
        this.pomodoroSwipeBound = true;
    }
    updatePomodoroSwipeIndicator() {
        const swipe = document.querySelector('.pomodoro-swipe');
        const dots = Array.from(document.querySelectorAll('.pomodoro-swipe-dot'));
        if (!swipe || dots.length === 0) return;
        const width = swipe.clientWidth || 1;
        const index = Math.round(swipe.scrollLeft / width);
        const safeIndex = Math.min(dots.length - 1, Math.max(0, index));
        dots.forEach((dot, i) => dot.classList.toggle('active', i === safeIndex));
    }
    pomodoroTick() {
        if (!this.pomodoroState?.isRunning) return;
        const remaining = this.pomodoroState.targetEnd - Date.now();
        if (remaining <= 0) {
            this.finishPomodoroSession(true);
            return;
        }
        this.pomodoroState.remainingMs = remaining;
        this.savePomodoroState();
        this.updatePomodoroDisplay();
    }
    getPomodoroRemainingMs() {
        if (this.pomodoroState?.isRunning && typeof this.pomodoroState.targetEnd === 'number') {
            return Math.max(0, this.pomodoroState.targetEnd - Date.now());
        }
        return Math.max(0, this.pomodoroState?.remainingMs || 0);
    }
    isPomodoroTaskLocked() {
        if (this.pomodoroState?.mode !== 'work') return false;
        const duration = this.getPomodoroDuration('work');
        const remaining = this.getPomodoroRemainingMs();
        return remaining < duration;
    }
    togglePomodoroRun() {
        if (this.pomodoroState.isRunning) {
            this.pausePomodoro();
        } else {
            this.startPomodoro();
        }
    }
    startPomodoro() {
        if (this.pomodoroState.isRunning) return;
        const duration = this.getPomodoroDuration(this.pomodoroState.mode);
        if (!Number.isFinite(this.pomodoroState.remainingMs) || this.pomodoroState.remainingMs <= 0) {
            this.pomodoroState.remainingMs = duration;
        }
        this.pomodoroState.targetEnd = Date.now() + this.pomodoroState.remainingMs;
        this.pomodoroState.isRunning = true;
        this.savePomodoroState();
        this.updatePomodoroDisplay();
    }
    pausePomodoro() {
        if (!this.pomodoroState.isRunning) return;
        this.pomodoroState.remainingMs = Math.max(0, this.pomodoroState.targetEnd - Date.now());
        this.pomodoroState.isRunning = false;
        this.pomodoroState.targetEnd = null;
        this.savePomodoroState();
        this.updatePomodoroDisplay();
    }
    resetPomodoro() {
        const ok = confirm('停止计时将丢失本次番茄，确认停止？');
        if (!ok) return;
        this.pomodoroState.mode = 'work';
        this.pomodoroState.remainingMs = this.getPomodoroDuration('work');
        this.pomodoroState.isRunning = false;
        this.pomodoroState.targetEnd = null;
        this.pomodoroState.cycleCount = 0;
        this.savePomodoroState();
        this.renderPomodoro();
    }
    skipPomodoro() {
        this.finishPomodoroSession(false);
    }
    finishPomodoroSession(recordStats) {
        const prevMode = this.pomodoroState.mode;
        if (prevMode === 'work') {
            if (recordStats) this.recordPomodoroWork();
            if (recordStats) {
                this.pomodoroState.cycleCount = (this.pomodoroState.cycleCount || 0) + 1;
            }
            const cycles = this.pomodoroState.cycleCount || 0;
            const isLongBreak = cycles > 0 && (cycles % this.pomodoroSettings.longBreakEvery) === 0;
            this.pomodoroState.mode = isLongBreak ? 'long' : 'short';
            this.pomodoroState.remainingMs = this.getPomodoroDuration(this.pomodoroState.mode);
            if (recordStats) {
                const label = this.pomodoroState.mode === 'long' ? '长休' : '短休';
                this.showToast(`完成 1 个番茄，进入${label}`);
                this.playPomodoroAlert('work');
            }
        } else {
            if (recordStats) this.recordPomodoroBreak(prevMode);
            this.pomodoroState.mode = 'work';
            this.pomodoroState.remainingMs = this.getPomodoroDuration('work');
            if (recordStats) {
                this.showToast('休息结束，开始专注');
                this.playPomodoroAlert('break');
            }
        }
        const nextModeIsBreak = this.pomodoroState.mode !== 'work';
        const autoStart = nextModeIsBreak ? this.pomodoroSettings.autoStartBreak : this.pomodoroSettings.autoStartWork;
        this.pomodoroState.isRunning = !!autoStart;
        this.pomodoroState.targetEnd = this.pomodoroState.isRunning ? Date.now() + this.pomodoroState.remainingMs : null;
        this.savePomodoroState();
        this.renderPomodoro();
    }
    recordPomodoroWork() {
        const dateKey = this.formatDate(new Date());
        const day = this.pomodoroHistory.days[dateKey] || { workSessions: 0, workMinutes: 0, breakMinutes: 0 };
        day.workSessions += 1;
        day.workMinutes += this.pomodoroSettings.workMin;
        this.pomodoroHistory.days[dateKey] = day;
        this.pomodoroHistory.totalWorkSessions += 1;
        this.pomodoroHistory.totalWorkMinutes += this.pomodoroSettings.workMin;
        const taskId = this.pomodoroState.currentTaskId;
        const task = taskId ? this.data.find(t => t.id === taskId && !t.deletedAt) : null;
        const timeLabel = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        const sessionLabel = task ? `${task.title} (${timeLabel})` : `专注 (${timeLabel})`;
        const sessionWithDate = `${dateKey} | ${sessionLabel}`;
        this.pomodoroHistory.sessions = [sessionWithDate, ...(this.pomodoroHistory.sessions || [])].slice(0, 50);
        this.savePomodoroHistory();
        if (!api.isLocalMode() && api.auth) {
            api.pomodoroSaveSession({
                taskId: taskId || null,
                taskTitle: task ? task.title : null,
                startedAt: null,
                endedAt: Date.now(),
                durationMin: this.pomodoroSettings.workMin,
                dateKey
            }).catch(() => {});
        }

        if (taskId) {
            if (task) {
                task.pomodoros = (task.pomodoros || 0) + 1;
                if (this.pomodoroSettings.autoFinishTask && task.status !== 'completed') {
                    task.status = 'completed';
                    task.completedAt = this.formatDate(new Date());
                }
                this.saveData();
                this.render();
            }
        }
    }
    recordPomodoroBreak(mode) {
        const dateKey = this.formatDate(new Date());
        const day = this.pomodoroHistory.days[dateKey] || { workSessions: 0, workMinutes: 0, breakMinutes: 0 };
        const mins = mode === 'long' ? this.pomodoroSettings.longBreakMin : this.pomodoroSettings.shortBreakMin;
        day.breakMinutes += mins;
        this.pomodoroHistory.days[dateKey] = day;
        this.pomodoroHistory.totalBreakMinutes += mins;
        this.savePomodoroHistory();
    }
    formatPomodoroTime(ms) {
        const totalSeconds = Math.max(0, Math.ceil((ms || 0) / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    getPomodoroModeLabel(mode) {
        if (mode === 'short') return '短休';
        if (mode === 'long') return '长休';
        return '专注';
    }
    setPomodoroTask(taskId) {
        const parsed = parseInt(taskId, 10);
        this.pomodoroState.currentTaskId = Number.isNaN(parsed) ? null : parsed;
        this.savePomodoroState();
        this.renderPomodoro();
    }
    togglePomodoroAutoStart() {
        this.pomodoroSettings.autoStartNext = !this.pomodoroSettings.autoStartNext;
        this.pomodoroSettings.autoStartBreak = !!this.pomodoroSettings.autoStartNext;
        this.pomodoroSettings.autoStartWork = !!this.pomodoroSettings.autoStartNext;
        this.savePomodoroSettings();
        this.renderPomodoro();
    }
    togglePomodoroAutoStartBreak() {
        this.pomodoroSettings.autoStartBreak = !this.pomodoroSettings.autoStartBreak;
        this.pomodoroSettings.autoStartNext = this.pomodoroSettings.autoStartBreak && this.pomodoroSettings.autoStartWork;
        this.savePomodoroSettings();
        this.renderPomodoro();
    }
    togglePomodoroAutoStartWork() {
        this.pomodoroSettings.autoStartWork = !this.pomodoroSettings.autoStartWork;
        this.pomodoroSettings.autoStartNext = this.pomodoroSettings.autoStartBreak && this.pomodoroSettings.autoStartWork;
        this.savePomodoroSettings();
        this.renderPomodoro();
    }
    togglePomodoroAutoFinishTask() {
        this.pomodoroSettings.autoFinishTask = !this.pomodoroSettings.autoFinishTask;
        this.savePomodoroSettings();
        this.renderPomodoro();
    }
    openPomodoroSettings() {
        const settingsOverlay = document.getElementById('pomodoro-settings-overlay');
        if (settingsOverlay) settingsOverlay.classList.add('show');
        const workInput = document.getElementById('pomodoro-work-min');
        if (workInput) workInput.focus();
    }
    closePomodoroSettings() {
        const settingsOverlay = document.getElementById('pomodoro-settings-overlay');
        if (settingsOverlay) settingsOverlay.classList.remove('show');
    }
    togglePomodoroTaskPicker() {
        if (this.isPomodoroTaskLocked()) {
            this.showToast('本轮番茄结束前无法更换任务');
            return;
        }
        const picker = document.getElementById('pomodoro-task-picker');
        if (picker) picker.classList.toggle('open');
    }
    setPomodoroTaskFromPicker(taskId) {
        if (this.isPomodoroTaskLocked()) {
            this.showToast('本轮番茄结束前无法更换任务');
            return;
        }
        this.setPomodoroTask(taskId);
        const picker = document.getElementById('pomodoro-task-picker');
        if (picker) picker.classList.remove('open');
    }
    updatePomodoroDisplay() {
        const timeEl = document.getElementById('pomodoro-time');
        const timeTextEl = document.getElementById('pomodoro-time-text');
        const modeEl = document.getElementById('pomodoro-mode-label');
        const remainingMs = this.getPomodoroRemainingMs();
        const timeText = this.formatPomodoroTime(remainingMs);
        if (timeTextEl) {
            timeTextEl.innerText = timeText;
        } else if (timeEl) {
            timeEl.innerText = timeText;
        }
        if (timeEl) {
            timeEl.classList.toggle('work', this.pomodoroState.mode === 'work');
            timeEl.classList.toggle('break', this.pomodoroState.mode !== 'work');
        }
        const progressEl = document.getElementById('pomodoro-progress');
        const ringEl = document.getElementById('pomodoro-ring');
        if (progressEl && ringEl) {
            const radius = ringEl.r?.baseVal?.value || 54;
            const circumference = 2 * Math.PI * radius;
            const duration = this.getPomodoroDuration(this.pomodoroState.mode);
            const remaining = Math.max(0, remainingMs || 0);
            const rawProgress = duration > 0 ? (remaining / duration) : 0;
            const progress = Math.min(1, Math.max(0, rawProgress));
            ringEl.style.strokeDasharray = `${circumference}`;
            ringEl.style.strokeDashoffset = `${-circumference * (1 - progress)}`;
            progressEl.classList.toggle('work', this.pomodoroState.mode === 'work');
            progressEl.classList.toggle('break', this.pomodoroState.mode !== 'work');
        }
        if (modeEl) modeEl.innerText = this.getPomodoroModeLabel(this.pomodoroState.mode);
        const actionBtn = document.getElementById('pomodoro-action-btn');
        if (actionBtn) {
            actionBtn.classList.toggle('is-running', this.pomodoroState.isRunning);
            actionBtn.setAttribute('aria-label', this.pomodoroState.isRunning ? '暂停' : '开始');
        }
    }
    updatePomodoroSettingsFromUI() {
        const workInput = document.getElementById('pomodoro-work-min');
        const shortInput = document.getElementById('pomodoro-short-min');
        const longInput = document.getElementById('pomodoro-long-min');
        const everyInput = document.getElementById('pomodoro-long-every');
        const workMin = Math.max(1, parseInt(workInput?.value, 10) || this.pomodoroSettings.workMin);
        const shortMin = Math.max(1, parseInt(shortInput?.value, 10) || this.pomodoroSettings.shortBreakMin);
        const longMin = Math.max(1, parseInt(longInput?.value, 10) || this.pomodoroSettings.longBreakMin);
        const longEvery = Math.max(1, parseInt(everyInput?.value, 10) || this.pomodoroSettings.longBreakEvery);
        this.pomodoroSettings.workMin = workMin;
        this.pomodoroSettings.shortBreakMin = shortMin;
        this.pomodoroSettings.longBreakMin = longMin;
        this.pomodoroSettings.longBreakEvery = longEvery;
        this.savePomodoroSettings();
        if (!this.pomodoroState.isRunning) {
            this.pomodoroState.remainingMs = this.getPomodoroDuration(this.pomodoroState.mode);
            this.savePomodoroState();
            this.updatePomodoroDisplay();
        }
        this.renderPomodoro();
    }
    playPomodoroAlert(kind) {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) {
                const ctx = new AudioCtx();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = kind === 'work' ? 880 : 660;
                gain.gain.value = 0.12;
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start();
                setTimeout(() => { osc.stop(); ctx.close(); }, 220);
            }
        } catch (e) {}
        if (navigator.vibrate) navigator.vibrate([200, 120, 200]);
        if ('Notification' in window && Notification.permission === 'granted') {
            const title = kind === 'work' ? '番茄完成' : '休息结束';
            const body = kind === 'work' ? '进入休息时间' : '开始新的专注';
            try { new Notification(title, { body }); } catch (e) {}
        }
    }
    initPomodoroTicks() {
        const ticksEl = document.getElementById('pomodoro-ticks');
        if (!ticksEl || ticksEl.childElementCount > 0) return;
        const ns = 'http://www.w3.org/2000/svg';
        const cx = 200;
        const cy = 200;
        const outerR = 170;
        const shortLen = 6;
        const longLen = 12;
        for (let i = 0; i < 60; i++) {
            const angle = (i / 60) * Math.PI * 2;
            const isMajor = i % 5 === 0;
            const len = isMajor ? longLen : shortLen;
            const r1 = outerR - len;
            const r2 = outerR;
            const x1 = cx + Math.cos(angle) * r1;
            const y1 = cy + Math.sin(angle) * r1;
            const x2 = cx + Math.cos(angle) * r2;
            const y2 = cy + Math.sin(angle) * r2;
            const line = document.createElementNS(ns, 'line');
            line.setAttribute('x1', x1.toFixed(2));
            line.setAttribute('y1', y1.toFixed(2));
            line.setAttribute('x2', x2.toFixed(2));
            line.setAttribute('y2', y2.toFixed(2));
            ticksEl.appendChild(line);
        }
    }
    renderPomodoro() {
        const container = document.getElementById('view-pomodoro');
        if (!container) return;
        this.initPomodoroTicks();

        const taskId = this.pomodoroState.currentTaskId;
        const task = taskId ? this.data.find(t => t.id === taskId && !t.deletedAt) : null;
        if (!task && taskId) {
            this.pomodoroState.currentTaskId = null;
            this.savePomodoroState();
        }

        const taskTitleEl = document.getElementById('pomodoro-task-title');
        if (taskTitleEl) taskTitleEl.innerText = task ? task.title : '点击选择任务';
        const taskHintEl = document.getElementById('pomodoro-task-hint');
        if (taskHintEl) taskHintEl.innerText = task ? '点击更换任务' : '点击选择任务';

        const listEl = document.getElementById('pomodoro-task-list');
        if (listEl) {
            const tasks = this.data.filter(t => !t.deletedAt);
            const noneActive = !task;
            const items = [];
            items.push(
                `<button class="pomodoro-task-item ${noneActive ? 'active' : ''}" type="button" onclick="app.setPomodoroTaskFromPicker('')">不选择任务<span>${noneActive ? '当前' : ''}</span></button>`
            );
            tasks.forEach(t => {
                const active = task && t.id === task.id;
                const status = t.status === 'completed' ? '已完成' : '';
                items.push(
                    `<button class="pomodoro-task-item ${active ? 'active' : ''}" type="button" onclick="app.setPomodoroTaskFromPicker('${t.id}')">${t.title}<span>${status}</span></button>`
                );
            });
            if (!tasks.length) items.push('<div class="pomodoro-task-empty">暂无任务</div>');
            listEl.innerHTML = items.join('');
        }

        const cycleEl = document.getElementById('pomodoro-cycle-label');
        if (cycleEl) cycleEl.innerText = `已完成 ${this.pomodoroState.cycleCount || 0} 个番茄`;

        const autoSwitch = document.getElementById('pomodoro-auto-switch');
        if (autoSwitch) autoSwitch.classList.toggle('active', !!this.pomodoroSettings.autoStartNext);
        const autoBreakSwitch = document.getElementById('pomodoro-auto-break-switch');
        if (autoBreakSwitch) autoBreakSwitch.classList.toggle('active', !!this.pomodoroSettings.autoStartBreak);
        const autoWorkSwitch = document.getElementById('pomodoro-auto-work-switch');
        if (autoWorkSwitch) autoWorkSwitch.classList.toggle('active', !!this.pomodoroSettings.autoStartWork);
        const autoFinishSwitch = document.getElementById('pomodoro-auto-finish-switch');
        if (autoFinishSwitch) autoFinishSwitch.classList.toggle('active', !!this.pomodoroSettings.autoFinishTask);

        const workInput = document.getElementById('pomodoro-work-min');
        const shortInput = document.getElementById('pomodoro-short-min');
        const longInput = document.getElementById('pomodoro-long-min');
        const everyInput = document.getElementById('pomodoro-long-every');
        if (workInput) workInput.value = this.pomodoroSettings.workMin;
        if (shortInput) shortInput.value = this.pomodoroSettings.shortBreakMin;
        if (longInput) longInput.value = this.pomodoroSettings.longBreakMin;
        if (everyInput) everyInput.value = this.pomodoroSettings.longBreakEvery;

        const todayKey = this.formatDate(new Date());
        const day = this.pomodoroHistory.days[todayKey] || { workSessions: 0, workMinutes: 0, breakMinutes: 0 };
        const todayCountEl = document.getElementById('pomodoro-today-count');
        const todayMinutesEl = document.getElementById('pomodoro-today-minutes');
        const totalCountEl = document.getElementById('pomodoro-total-count');
        const totalMinutesEl = document.getElementById('pomodoro-total-minutes');
        if (todayCountEl) todayCountEl.innerText = String(day.workSessions || 0);
        if (todayMinutesEl) todayMinutesEl.innerText = String(day.workMinutes || 0);
        if (totalCountEl) totalCountEl.innerText = String(this.pomodoroHistory.totalWorkSessions || 0);
        if (totalMinutesEl) totalMinutesEl.innerText = String(this.pomodoroHistory.totalWorkMinutes || 0);

        const recentEl = document.getElementById('pomodoro-recent-list');
        if (recentEl) {
            const items = Object.entries(this.pomodoroHistory.days || {})
                .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
                .slice(0, 7)
                .map(([date, info]) => {
                    const count = info.workSessions || 0;
                    const minutes = info.workMinutes || 0;
                    return `<div class="pomodoro-history-item"><span>${date}</span><span>${count} 🍅 / ${minutes} 分钟</span></div>`;
                });
            recentEl.innerHTML = items.join('') || '<div style="font-size:0.85rem; color:#777;">暂无记录</div>';
        }

        const completedEl = document.getElementById('pomodoro-completed-list');
        if (completedEl) {
            const sessions = (this.pomodoroHistory.sessions || []).slice(0, 10);
            const grouped = new Map();
            const order = [];
            sessions.forEach((item) => {
                const parts = String(item).split(' | ');
                const dateKey = parts.length > 1 ? parts[0] : '未记录日期';
                const label = parts.length > 1 ? parts.slice(1).join(' | ') : item;
                if (!grouped.has(dateKey)) {
                    grouped.set(dateKey, []);
                    order.push(dateKey);
                }
                grouped.get(dateKey).push(label);
            });
            const items = order.flatMap((dateKey) => {
                const rows = grouped.get(dateKey) || [];
                const collapsed = this.pomodoroHistoryCollapsed.has(dateKey);
                return [
                    `<div class="pomodoro-history-date${collapsed ? ' is-collapsed' : ''}" data-date="${dateKey}">${dateKey}</div>`,
                    `<div class="pomodoro-history-group" data-date="${dateKey}" data-collapsed="${collapsed ? 'true' : 'false'}">` +
                        rows.map(label => `<div class="pomodoro-history-item"><span>${label}</span></div>`).join('') +
                    `</div>`
                ];
            });
            completedEl.innerHTML = items.join('') || '<div style="font-size:0.85rem; color:#777;">暂无记录</div>';
        }

        this.updatePomodoroDisplay();
        this.updatePomodoroSwipeIndicator();
    }

    handleSearch(val) { this.filter.query = val; if(val && this.view!=='search') this.switchView('search'); this.render(); }
    
    updateDateDisplay() {
        const dateText = this.formatDate(this.currentDate);
        const dateEl = document.getElementById('date-display');
        const calDateEl = document.getElementById('cal-date-display');
        if (dateEl) dateEl.innerText = dateText;
        if (calDateEl) calDateEl.innerText = dateText;
        const showLunar = this.calendar?.settings?.showLunar !== false;
        const lunarText = showLunar ? this.getLunarText(this.currentDate) : '';
        const lunarEl = document.getElementById('lunar-display');
        if (lunarEl) lunarEl.innerText = lunarText ? `农历 ${lunarText}` : '';
    }
    showToast(msg) { 
        const div = document.createElement('div'); 
        div.className = 'toast show'; 
        div.innerText = msg; 
        document.getElementById('toast-container').appendChild(div); 
        setTimeout(() => div.remove(), 2000); 
    }
    showUndoToast(msg) {
        const div = document.createElement('div');
        div.className = 'toast show undo';
        div.innerHTML = `<span>${msg}</span><button type="button">撤回</button>`;
        div.querySelector('button').onclick = (e) => { e.stopPropagation(); this.undoLast(); };
        document.getElementById('toast-container').appendChild(div);
        return div;
    }
    queueUndo(msg) {
        const snapshot = JSON.parse(JSON.stringify(this.data));
        if (this.undoTimer) clearTimeout(this.undoTimer);
        if (this.undoState?.toastEl) this.undoState.toastEl.remove();
        const toastEl = this.showUndoToast(msg);
        this.undoState = { snapshot, toastEl };
        this.undoTimer = setTimeout(() => this.clearUndo(), 2000);
    }
    clearUndo() {
        if (this.undoTimer) clearTimeout(this.undoTimer);
        this.undoTimer = null;
        if (this.undoState?.toastEl) this.undoState.toastEl.remove();
        this.undoState = null;
    }
    undoLast() {
        if (!this.undoState) return;
        this.data = this.undoState.snapshot;
        this.clearUndo();
        this.saveData(true);
        this.render();
        this.renderTags();
        this.showToast('已撤回');
    }
    
    buildRemindAt(dateStr, startStr, enabled) {
        if (!enabled || !dateStr || !startStr) return null;
        const dt = new Date(`${dateStr}T${startStr}:00`);
        const ts = dt.getTime() - (60 * 1000);
        return Number.isNaN(ts) ? null : ts;
    }

    formatDate(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
    timeToMinutes(str) { const [h,m] = str.split(':').map(Number); return h*60+m; }
    minutesToTime(m) { const h = Math.floor(m/60); const min = Math.floor(m%60); return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`; }
    getQuadrantColor(q) { return {q1:'var(--danger)', q2:'var(--primary)', q3:'var(--warning)', q4:'var(--success)'}[q || 'q2']; }
    getQuadrantLightColor(q) { return {q1:'var(--quad-danger)', q2:'var(--quad-primary)', q3:'var(--quad-warning)', q4:'var(--quad-success)'}[q || 'q2']; }
    isInboxTask(t) { return !!t && ((!t.date && !t.start && !t.end) || t.inbox); }

    initAttachmentControls() {
        const input = document.getElementById('task-attachments-input');
        if (!input) return;
        input.accept = this.attachmentAccept;
        input.onchange = async () => {
            const files = Array.from(input.files || []);
            input.value = '';
            if (!files.length) return;
            await this.uploadAttachments(files);
        };
    }

    getAttachmentExtension(name) {
        const idx = String(name || '').lastIndexOf('.');
        return idx >= 0 ? String(name).slice(idx).toLowerCase() : '';
    }

    isAttachmentAllowed(file) {
        const ext = this.getAttachmentExtension(file?.name);
        return !!ext && this.attachmentAllowedExts.has(ext);
    }

    formatFileSize(bytes) {
        const size = Number(bytes) || 0;
        if (size < 1024) return `${size} B`;
        const kb = size / 1024;
        if (kb < 1024) return `${kb.toFixed(1)} KB`;
        const mb = kb / 1024;
        return `${mb.toFixed(1)} MB`;
    }

    syncAttachmentControls(task) {
        const input = document.getElementById('task-attachments-input');
        const hint = document.getElementById('task-attachments-hint');
        const uploadBtn = document.getElementById('task-attachments-btn');
        if (!input || !uploadBtn || !hint) return;
        const disabled = api.isLocalMode();
        input.disabled = disabled;
        uploadBtn.classList.toggle('disabled', disabled);
        uploadBtn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        if (api.isLocalMode()) {
            hint.innerText = '本地模式不支持附件上传';
        } else if (!task || !task.id) {
            hint.innerText = '请先填写标题再上传附件';
        } else {
            hint.innerText = '支持常见文档与图片，单文件不超过 50MB，仅提供下载。';
        }
    }

    renderAttachments(task) {
        const list = document.getElementById('task-attachments-list');
        if (!list) return;
        const attachments = task && Array.isArray(task.attachments)
            ? task.attachments.filter((a) => a && !this.pendingAttachmentDeletes.has(a.id))
            : [];
        list.innerHTML = '';
        if (!attachments.length) {
            const empty = document.createElement('div');
            empty.className = 'attachment-empty';
            empty.innerText = '暂无附件';
            list.appendChild(empty);
            return;
        }
        attachments.forEach((att) => {
            if (!att) return;
            const item = document.createElement('div');
            item.className = 'attachment-item';

            const info = document.createElement('div');
            info.className = 'attachment-info';
            const name = document.createElement('span');
            name.className = 'attachment-name';
            name.innerText = att.name || '附件';
            const meta = document.createElement('span');
            meta.className = 'attachment-meta';
            meta.innerText = this.formatFileSize(att.size || 0);
            info.appendChild(name);
            info.appendChild(meta);

            const actions = document.createElement('div');
            actions.className = 'attachment-actions';
            const downloadBtn = document.createElement('button');
            downloadBtn.type = 'button';
            downloadBtn.className = 'btn btn-sm';
            downloadBtn.innerText = '下载';
            downloadBtn.onclick = () => this.downloadAttachment(att);
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'btn btn-sm btn-secondary';
            deleteBtn.innerText = '删除';
            deleteBtn.onclick = () => this.deleteAttachment(att);
            actions.appendChild(downloadBtn);
            actions.appendChild(deleteBtn);

            item.appendChild(info);
            item.appendChild(actions);
            list.appendChild(item);
        });
    }

    async uploadAttachments(files) {
        if (api.isLocalMode()) return alert('本地模式不支持附件上传');
        if (!this.currentTaskId) {
            const created = await this.createTaskForAttachmentUpload();
            if (!created) return;
        }
        const task = this.data.find((t) => t && t.id === this.currentTaskId);
        if (!task) return alert('任务不存在');

        for (const file of files) {
            if (!this.isAttachmentAllowed(file)) {
                this.showToast(`不支持的文件类型: ${file.name}`);
                continue;
            }
            if (file.size > 50 * 1024 * 1024) {
                this.showToast(`文件过大: ${file.name}`);
                continue;
            }
            try {
                const res = await api.uploadAttachment(task.id, file);
                const json = await res.json();
                if (!res.ok) {
                    this.showToast(json.error || '上传失败');
                    continue;
                }
                task.attachments = Array.isArray(task.attachments) ? task.attachments : [];
                task.attachments.push(json.attachment);
                if (json.version) this.dataVersion = json.version;
                this.showToast('附件已上传');
            } catch (e) {
                this.showToast('上传失败');
            }
        }
        this.renderAttachments(task);
    }

    async createTaskForAttachmentUpload() {
        const title = document.getElementById('task-title')?.value.trim();
        if (!title) {
            alert('请先填写任务标题再上传附件');
            return false;
        }
        const inboxBox = document.getElementById('task-inbox');
        const dateVal = document.getElementById('task-date').value;
        const startVal = document.getElementById('task-start').value;
        const endVal = document.getElementById('task-end').value;
        let isInbox = inboxBox ? inboxBox.checked : false;
        if (dateVal || startVal || endVal) isInbox = false;
        const remindEnabled = document.getElementById('task-remind')?.checked;
        if (remindEnabled && (!dateVal || !startVal)) {
            alert('Start time reminder requires a date and start time.');
            return false;
        }
        const subtasks = [];
        document.querySelectorAll('.subtask-item').forEach(item => {
            const input = item.querySelector('input[type="text"]');
            const check = item.querySelector('input[type="checkbox"]');
            if (input.value.trim()) subtasks.push({ title: input.value.trim(), completed: check.checked });
        });
        const remindAt = this.buildRemindAt(isInbox ? '' : dateVal, isInbox ? '' : startVal, !!remindEnabled);
        const newItem = {
            id: Date.now(),
            title,
            date: isInbox ? '' : dateVal,
            start: isInbox ? '' : startVal,
            end: isInbox ? '' : endVal,
            quadrant: document.getElementById('task-quadrant').value,
            tags: document.getElementById('task-tags').value.split(/[,，]/).map(t => t.trim()).filter(t => t),
            pomodoros: 0,
            attachments: [],
            subtasks,
            status: 'todo',
            inbox: isInbox,
            completedAt: null,
            remindAt,
            notifiedAt: null,
            deletedAt: null
        };
        this.queueUndo('已创建任务');
        this.data.push(newItem);
        this.currentTaskId = newItem.id;
        await this.saveData();
        this.render();
        this.renderTags();
        this.showToast('已创建任务，可继续上传附件');
        return true;
    }

    async deleteAttachment(att) {
        if (!att || !att.id) return;
        if (api.isLocalMode()) return;
        if (!this.currentTaskId) return;
        if (!confirm(`确定删除附件 "${att.name || '附件'}" 吗？`)) return;
        if (this.pendingAttachmentDeletes.has(att.id)) return;
        const taskId = this.currentTaskId;
        const pending = {
            id: att.id,
            taskId,
            attachment: { ...att },
            toastEl: null,
            timerId: null
        };
        const undo = () => this.undoPendingAttachmentDelete(att.id);
        pending.toastEl = this.showAttachmentUndoToast('已删除附件', undo);
        pending.timerId = setTimeout(() => this.finalizeAttachmentDelete(att.id), 2000);
        this.pendingAttachmentDeletes.set(att.id, pending);
        const task = this.data.find((t) => t && t.id === taskId);
        this.renderAttachments(task);
        this.render();
    }

    async downloadAttachment(att) {
        if (!att || !att.id) return;
        try {
            const res = await api.downloadAttachment(att.id);
            if (!res.ok) {
                const json = await res.json();
                return alert(json.error || '下载失败');
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = att.name || 'attachment';
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            this.showToast('下载失败');
        }
    }

    async deleteTaskAttachments(task) {
        if (!task || !Array.isArray(task.attachments) || task.attachments.length === 0) return;
        const attachments = task.attachments.slice();
        const pendingIds = attachments.map((a) => a && a.id).filter(Boolean);
        pendingIds.forEach((id) => {
            const pending = this.pendingAttachmentDeletes.get(id);
            if (pending) {
                if (pending.timerId) clearTimeout(pending.timerId);
                if (pending.toastEl) pending.toastEl.remove();
                this.pendingAttachmentDeletes.delete(id);
            }
        });
        task.attachments = [];
        if (api.isLocalMode()) return;
        let failed = 0;
        for (const att of attachments) {
            if (!att || !att.id) continue;
            try {
                const res = await api.deleteAttachment(task.id, att.id);
                const json = await res.json();
                if (!res.ok) throw new Error(json.error || '删除失败');
                if (json.version) this.dataVersion = json.version;
            } catch (e) {
                failed += 1;
            }
        }
        if (failed) {
            this.showToast(`有 ${failed} 个附件删除失败`);
        }
    }

    showAttachmentUndoToast(msg, onUndo) {
        const div = document.createElement('div');
        div.className = 'toast show undo';
        div.innerHTML = `<span>${msg}</span><button type="button">撤回</button>`;
        div.querySelector('button').onclick = (e) => {
            e.stopPropagation();
            onUndo();
        };
        document.getElementById('toast-container').appendChild(div);
        return div;
    }

    undoPendingAttachmentDelete(attachmentId) {
        const pending = this.pendingAttachmentDeletes.get(attachmentId);
        if (!pending) return;
        if (pending.timerId) clearTimeout(pending.timerId);
        if (pending.toastEl) pending.toastEl.remove();
        this.pendingAttachmentDeletes.delete(attachmentId);
        const task = this.data.find((t) => t && t.id === pending.taskId);
        this.renderAttachments(task);
        this.render();
        this.showToast('已撤回');
    }

    async finalizeAttachmentDelete(attachmentId) {
        const pending = this.pendingAttachmentDeletes.get(attachmentId);
        if (!pending) return;
        this.pendingAttachmentDeletes.delete(attachmentId);
        if (pending.toastEl) pending.toastEl.remove();
        try {
            const res = await api.deleteAttachment(pending.taskId, pending.attachment.id);
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || '删除失败');
            const task = this.data.find((t) => t && t.id === pending.taskId);
            if (task && Array.isArray(task.attachments)) {
                task.attachments = task.attachments.filter((a) => a && a.id !== pending.attachment.id);
            }
            if (json.version) this.dataVersion = json.version;
            this.renderAttachments(task);
            this.render();
        } catch (e) {
            const task = this.data.find((t) => t && t.id === pending.taskId);
            if (task && Array.isArray(task.attachments)) {
                const exists = task.attachments.some((a) => a && a.id === pending.attachment.id);
                if (!exists) task.attachments.push(pending.attachment);
            }
            this.renderAttachments(task);
            this.render();
            this.showToast('删除失败，已恢复附件');
        }
    }
    
    // 导出
    openExportModal() { document.getElementById('export-modal-overlay').style.display = 'flex'; this.setExportType('daily'); }
    setExportType(type) {
        this.exportSettings.type = type;
        document.getElementById('export-template').value = type === 'daily' ? this.exportSettings.dailyTemplate : this.exportSettings.weeklyTemplate;
        document.getElementById('btn-export-daily').className = type==='daily'?'btn btn-sm':'btn btn-sm btn-secondary';
        document.getElementById('btn-export-weekly').className = type==='weekly'?'btn btn-sm':'btn btn-sm btn-secondary';
        this.renderExportPreview();
    }
    handleTemplateChange(val) { 
        if(this.exportSettings.type === 'daily') this.exportSettings.dailyTemplate = val; else this.exportSettings.weeklyTemplate = val;
        this.renderExportPreview(); 
    }
    renderExportPreview() {
        const tmpl = document.getElementById('export-template').value;
        const now = this.formatDate(new Date());
        const todayTasks = this.data.filter(t => t.date === now);
        const done = todayTasks.filter(t => t.status === 'completed');
        const res = tmpl.replace('{date}', now).replace('{tasks}', done.map(t=>`- ${t.title}`).join('\n')||'(无)').replace('{rate}', todayTasks.length ? Math.round((done.length/todayTasks.length)*100) : 0).replace('{plan}', '(请填写)');
        document.getElementById('export-preview').innerText = res;
    }
    copyReport() { navigator.clipboard.writeText(document.getElementById('export-preview').innerText); this.showToast('已复制'); document.getElementById('export-modal-overlay').style.display = 'none'; }
    downloadJSON() {
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(this.data, null, 2)], {type: "application/json"}));
        a.download = `glass-todo-${this.formatDate(new Date())}.json`; a.click();
    }

    async importJSON(file) {
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            if (!Array.isArray(parsed)) throw new Error('文件格式错误');
            this.data = parsed;
            this.dataVersion = Date.now();
            this.cleanupRecycle();
            await this.saveData(true);
            this.render();
            this.renderTags();
            this.showToast('导入成功');
        } catch (e) {
            console.error(e);
            alert('导入失败：' + (e.message || '解析错误'));
        }
    }
}
const app = new TodoApp();
loadAppConfig().then((config) => {
    api.setConfig(config);
    app.applyConfig(config);
    app.init();
});


