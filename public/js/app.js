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
        this.filter = { query: '', tag: '', status: 'all', quadrant: 'all' };
        this.taskPanel = 'today';
        this.tasklistCollapse = { checklists: false, tags: false, filters: false };
        this.activeTaskDetailId = null;
        this.noteSaveTimer = null;
        this.activeSubtaskDetail = null;
        this.activeChecklistDetail = null;
        this.checklistNoteSaveTimer = null;
        this.taskPanelCollapse = this.loadTaskPanelCollapse();
        
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
        this.checklists = [];
        this.checklistItems = {};
        this.checklistColumns = {};
        this.activeChecklistId = null;
        this.checklistsLoaded = false;
        this.checklistsLoading = false;
        this.checklistActionOpenId = null;
        this.checklistShares = {};
        this.checklistShareModalListId = null;
        this.checklistMenuPos = null;
        this.checklistShareReadonly = false;
        this.loadingChecklistId = null;
        this.checklistItemModalListId = null;
        this.checklistItemModalColumnId = null;
        this.checklistItemModalItemId = null;
        this.checklistColumnDeleteResolve = null;
        this.checklistColumnPrompted = new Set();
        this.checklistColumnMenu = null;
        this.taskCardMenu = null;
        this.taskModalCollapsed = false;
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
            await this.loadChecklists();
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
        this.initCalendarTimelineStartControl();
        this.initPushControls();
        this.syncAutoMigrateUI();
        this.initMobileSwipes();
        await this.initPomodoro();
        this.initLoginEnter();
        this.initGlobalShortcuts();
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
            calendarSettings: { showTime: true, showTags: true, showLunar: true, showHoliday: true, timelineStartMinutes: 480 }
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
    loadTaskPanelCollapse() {
        try {
            const raw = localStorage.getItem('glass_task_panel_collapse');
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }
    saveTaskPanelCollapse() {
        try {
            localStorage.setItem('glass_task_panel_collapse', JSON.stringify(this.taskPanelCollapse || {}));
        } catch (e) {
            // ignore
        }
    }
    toggleTaskPanelCollapse(key) {
        if (!key) return;
        if (!this.taskPanelCollapse || typeof this.taskPanelCollapse !== 'object') {
            this.taskPanelCollapse = {};
        }
        this.taskPanelCollapse[key] = !this.taskPanelCollapse[key];
        this.saveTaskPanelCollapse();
        this.render();
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
        if (select) select.value = this.calendarDefaultMode;
        this.syncCalendarTimelineStartUI();
    }
    syncCalendarTimelineStartUI() {
        const input = document.getElementById('calendar-timeline-start');
        if (!input) return;
        const minutes = this.getCalendarTimelineStartMinutes();
        input.value = this.minutesToTime(minutes);
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
                await this.loadChecklists();
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
    initGlobalShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (e.defaultPrevented || e.isComposing) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key && e.key.toLowerCase() !== 'n') return;
            const target = e.target;
            const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
            if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return;
            if (this.isAnyModalOpen()) return;
            e.preventDefault();
            this.openModal();
        });
    }
    isAnyModalOpen() {
        const overlayIds = [
            'modal-overlay',
            'login-modal',
            'export-modal-overlay',
            'admin-modal',
            'checklist-share-modal',
            'checklist-item-modal',
            'checklist-column-delete-modal'
        ];
        if (overlayIds.some((id) => this.isElementVisible(document.getElementById(id)))) return true;
        const pomoOverlay = document.getElementById('pomodoro-settings-overlay');
        return !!pomoOverlay?.classList.contains('show');
    }
    isElementVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    logout() { this.handleUnauthorized(true); }
    handleUnauthorized(fromLogout = false) {
        if (this.isLoggingOut) return;
        this.isLoggingOut = true;
        api.clearAuth();
        this.isAdmin = false;
        this.checklists = [];
        this.checklistItems = {};
        this.checklistColumns = {};
        this.activeChecklistId = null;
        this.checklistsLoaded = false;
        this.checklistActionOpenId = null;
        this.checklistShares = {};
        this.checklistShareModalListId = null;
        this.checklistShareReadonly = false;
        this.checklistItemModalListId = null;
        this.checklistItemModalColumnId = null;
        this.checklistItemModalItemId = null;
        const checklistItemModal = document.getElementById('checklist-item-modal');
        if (checklistItemModal) checklistItemModal.style.display = 'none';
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
        if (v === 'checklists' && !this.checklistsLoaded) this.loadChecklists();
        
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
    initCalendarTimelineStartControl() {
        const input = document.getElementById('calendar-timeline-start');
        if (!input) return;
        input.value = this.minutesToTime(this.getCalendarTimelineStartMinutes());
        input.onchange = () => this.setCalendarTimelineStartMinutes(input.value);
    }
    setCalendarDefaultMode(mode) {
        const normalized = this.normalizeCalendarMode(mode) || 'day';
        this.calendarDefaultMode = normalized;
        this.saveUserSettings();
        if (this.view === 'calendar') this.calendar.setMode(normalized);
    }
    getCalendarTimelineStartMinutes() {
        const rawMin = this.calendarSettings?.timelineStartMinutes;
        let parsed = Number.parseInt(rawMin, 10);
        if (!Number.isFinite(parsed)) {
            const rawHour = this.calendarSettings?.timelineStartHour;
            const hour = Number.parseInt(rawHour, 10);
            if (Number.isFinite(hour)) parsed = hour * 60;
        }
        if (!Number.isFinite(parsed)) parsed = 480;
        return Math.min(1439, Math.max(0, parsed));
    }
    setCalendarTimelineStartMinutes(value) {
        let minutes = null;
        if (typeof value === 'string' && value.includes(':')) {
            minutes = this.timeToMinutes(value);
        } else {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed)) minutes = parsed;
        }
        if (!Number.isFinite(minutes)) minutes = 480;
        minutes = Math.min(1439, Math.max(0, minutes));
        this.updateCalendarSettings({ timelineStartMinutes: minutes });
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

    getDragPayload(ev) {
        const raw = ev?.dataTransfer?.getData('text/plain') || ev?.dataTransfer?.getData('text') || '';
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') return parsed;
            if (Number.isFinite(parsed)) return { type: 'task', id: Number(parsed) };
            return null;
        } catch (e) {
            const trimmed = String(raw).trim();
            if (/^\d+$/.test(trimmed)) {
                return { type: 'task', id: Number(trimmed) };
            }
            return null;
        }
    }
    getDraggedTaskId(ev) {
        const payload = this.getDragPayload(ev);
        if (payload && payload.type === 'task' && Number.isFinite(Number(payload.id))) {
            return Number(payload.id);
        }
        const raw = ev?.dataTransfer?.getData('text');
        const id = parseInt(raw, 10);
        return Number.isFinite(id) ? id : null;
    }
    allowNavDrop(ev) {
        ev.preventDefault();
        ev.currentTarget?.classList.add('is-drop-target');
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    }
    leaveNavDrop(ev) {
        ev.currentTarget?.classList.remove('is-drop-target');
    }
    dropOnTaskNav(ev, target) {
        ev.preventDefault();
        ev.currentTarget?.classList.remove('is-drop-target');
        const payload = this.getDragPayload(ev);
        if (payload?.type === 'checklist-item') {
            const sourceListId = Number(payload.listId);
            const itemId = Number(payload.itemId);
            this.finishDrag();
            this.moveChecklistItemToTask(sourceListId, itemId, target);
            return;
        }
        const id = this.getDraggedTaskId(ev);
        const t = this.data.find(i => i.id === id);
        this.finishDrag();
        if (!t || t.deletedAt) return;
        const todayStr = this.formatDate(new Date());
        let changed = false;
        if (target === 'today') {
            if (t.date !== todayStr || t.inbox) {
                t.date = todayStr;
                t.inbox = false;
                changed = true;
            }
        } else if (target === 'tomorrow') {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const tomorrowStr = this.formatDate(tomorrow);
            if (t.date !== tomorrowStr || t.inbox) {
                t.date = tomorrowStr;
                t.inbox = false;
                changed = true;
            }
        } else if (target === 'inbox') {
            if (!t.inbox || t.date || t.start || t.end || t.status === 'completed') changed = true;
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
    allowChecklistListDrop(ev, listId) {
        this.allowNavDrop(ev);
        if (this.dragActive) this.previewChecklistDrop(listId);
    }
    previewChecklistDrop(listId) {
        if (!this.dragActive || !Number.isFinite(Number(listId))) return;
        if (this.taskPanel === `checklist:${listId}` && Number(this.activeChecklistId) === Number(listId)) return;
        this.selectTaskChecklist(listId);
    }
    async dropOnChecklistList(ev, listId) {
        ev.preventDefault();
        ev.currentTarget?.classList.remove('is-drop-target');
        const taskId = this.getDraggedTaskId(ev);
        this.finishDrag();
        if (!Number.isFinite(Number(taskId)) || !Number.isFinite(Number(listId))) return;
        const list = this.checklists.find(l => Number(l.id) === Number(listId));
        if (!list) return;
        if (!this.checklistColumns[listId]) await this.loadChecklistColumns(listId);
        let cols = this.checklistColumns[listId] || [];
        if (!cols.length) {
            const createdId = await this.ensureDefaultChecklistColumn(listId, list.name);
            if (!createdId) {
                this.showToast('请先创建栏目');
                return;
            }
            cols = this.checklistColumns[listId] || [];
        }
        if (cols.length > 1) {
            this.previewChecklistDrop(listId);
            this.showToast('请拖拽到具体栏目');
            return;
        }
        await this.moveTaskToChecklist(taskId, listId, cols[0].id);
    }
    async moveTaskToChecklist(taskId, listId, columnId = null) {
        const task = this.data.find(t => Number(t.id) === Number(taskId));
        if (!task || task.deletedAt) return;
        const title = String(task.title || '').trim() || '未命名任务';
        const subtasks = Array.isArray(task.subtasks)
            ? task.subtasks.map((s) => {
                if (typeof s === 'string') {
                    return { title: s.trim(), completed: false, note: '' };
                }
                const title = String(s?.title || s?.text || s?.name || '').trim();
                return {
                    title,
                    completed: !!s?.completed,
                    note: String(s?.note || '').trim()
                };
            }).filter(s => s.title)
            : [];
        try {
            const json = await api.createChecklistItem(listId, title, columnId, subtasks, task.notes || '');
            if (json?.item) {
                const items = this.checklistItems[listId] || [];
                this.checklistItems[listId] = [...items, json.item];
                this.data = this.data.filter(t => Number(t.id) !== Number(taskId));
                this.saveData();
                this.renderChecklistsView();
                if (this.view === 'tasks') this.render();
                this.renderTags();
                this.showToast('已移入清单');
            } else if (json?.error) {
                this.showToast(json.error);
            }
        } catch (e) {
            console.error(e);
            this.showToast('移入清单失败');
        }
    }
    async moveChecklistItemToChecklist(sourceListId, itemId, targetListId, targetColumnId) {
        if (!Number.isFinite(Number(sourceListId)) || !Number.isFinite(Number(itemId))) return;
        if (!Number.isFinite(Number(targetListId)) || !Number.isFinite(Number(targetColumnId))) return;
        const sourceItems = this.checklistItems[sourceListId] || [];
        const item = sourceItems.find(it => Number(it.id) === Number(itemId));
        if (!item) return;
        const title = String(item.title || '').trim() || '未命名事项';
        const subtasks = Array.isArray(item.subtasks)
            ? item.subtasks.map((s) => {
                if (typeof s === 'string') {
                    return { title: s.trim(), completed: false, note: '' };
                }
                const title = String(s?.title || s?.text || s?.name || '').trim();
                return {
                    title,
                    completed: !!s?.completed,
                    note: String(s?.note || '').trim()
                };
            }).filter(s => s.title)
            : [];
        try {
            const created = await api.createChecklistItem(targetListId, title, targetColumnId, subtasks, item.notes || '');
            if (!created?.item) {
                if (created?.error) this.showToast(created.error);
                return;
            }
            const targetItems = this.checklistItems[targetListId] || [];
            this.checklistItems[targetListId] = [...targetItems, created.item];
            if (item.completed && !created.item.completed) {
                const updated = await api.updateChecklistItem(targetListId, created.item.id, { completed: true });
                if (updated?.item) {
                    this.checklistItems[targetListId] = this.checklistItems[targetListId]
                        .map(it => Number(it.id) === Number(created.item.id) ? { ...it, ...updated.item } : it);
                }
            }
            const deleted = await api.deleteChecklistItem(sourceListId, itemId);
            if (deleted?.success) {
                this.checklistItems[sourceListId] = sourceItems.filter(it => Number(it.id) !== Number(itemId));
            } else if (deleted?.error) {
                const rollback = await api.deleteChecklistItem(targetListId, created.item.id);
                if (rollback?.success) {
                    this.checklistItems[targetListId] = this.checklistItems[targetListId]
                        .filter(it => Number(it.id) !== Number(created.item.id));
                }
                this.showToast(deleted.error || '移动失败');
                return;
            }
            this.renderChecklistsView();
            if (this.view === 'tasks') this.render();
        } catch (e) {
            console.error(e);
            this.showToast('移动失败');
        }
    }

    async moveChecklistItemToTask(sourceListId, itemId, target) {
        if (!Number.isFinite(Number(sourceListId)) || !Number.isFinite(Number(itemId))) return;
        const sourceItems = this.checklistItems[sourceListId] || [];
        const item = sourceItems.find(it => Number(it.id) === Number(itemId));
        if (!item) return;
        const now = new Date();
        const todayStr = this.formatDate(now);
        const tomorrow = new Date(now);
        tomorrow.setDate(now.getDate() + 1);
        const tomorrowStr = this.formatDate(tomorrow);
        const subtasks = this.normalizeChecklistSubtasks(item.subtasks);
        const newTask = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            title: String(item.title || '').trim() || '未命名任务',
            date: '',
            start: '',
            end: '',
            quadrant: '',
            tags: [],
            pomodoros: 0,
            attachments: [],
            notes: String(item.notes || ''),
            subtasks,
            status: 'todo',
            inbox: false,
            completedAt: null,
            remindAt: null,
            notifiedAt: null,
            deletedAt: null
        };
        if (target === 'inbox') {
            newTask.inbox = true;
            newTask.inboxAt = Date.now();
        } else if (target === 'today') {
            newTask.date = todayStr;
        } else if (target === 'tomorrow') {
            newTask.date = tomorrowStr;
        } else if (target === 'done') {
            newTask.date = todayStr;
            newTask.status = 'completed';
            newTask.completedAt = todayStr;
        } else {
            const panel = this.taskPanel;
            if (panel === 'tomorrow' || panel === 'next7') {
                newTask.date = tomorrowStr;
            } else {
                newTask.date = todayStr;
            }
        }
        if (newTask.status === 'completed' && subtasks.length) {
            subtasks.forEach(s => { s.completed = true; });
        }
        try {
            this.data.push(newTask);
            this.queueUndo('已移入任务');
            const deleted = await api.deleteChecklistItem(sourceListId, itemId);
            if (!deleted?.success) {
                this.data = this.data.filter(t => Number(t.id) !== Number(newTask.id));
                if (deleted?.error) this.showToast(deleted.error);
                return;
            }
            this.checklistItems[sourceListId] = sourceItems.filter(it => Number(it.id) !== Number(itemId));
            this.saveData();
            this.renderChecklistsView();
            if (this.view === 'tasks') this.render();
            this.renderTags();
        } catch (e) {
            console.error(e);
            this.data = this.data.filter(t => Number(t.id) !== Number(newTask.id));
            this.showToast('移动失败');
        }
    }

    // 清单拖拽
    startChecklistDrag(ev, listId, itemId) {
        if (!ev?.dataTransfer) return;
        this.dragActive = true;
        this.dragEndAt = 0;
        const payload = JSON.stringify({ type: 'checklist-item', listId, itemId });
        ev.dataTransfer.setData('text/plain', payload);
        ev.dataTransfer.setData('text', payload);
        ev.dataTransfer.effectAllowed = 'move';
        ev.currentTarget?.classList.add('dragging');
    }
    allowChecklistDrop(ev) {
        ev.preventDefault();
        ev.currentTarget?.classList.add('is-drop-target');
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    }
    leaveChecklistDrop(ev) {
        ev.currentTarget?.classList.remove('is-drop-target');
    }
    async dropChecklistItem(ev, targetColumnId) {
        ev.preventDefault();
        ev.currentTarget?.classList.remove('is-drop-target');
        const payload = this.getDragPayload(ev);
        if (payload && payload.type === 'task') {
            const taskId = Number(payload.id);
            const listId = Number(this.activeChecklistId);
            if (!Number.isFinite(taskId) || !Number.isFinite(listId)) {
                this.finishDrag();
                return;
            }
            await this.moveTaskToChecklist(taskId, listId, targetColumnId);
            this.finishDrag();
            return;
        }
        if (!payload || payload.type !== 'checklist-item') {
            this.finishDrag();
            return;
        }
        const listId = Number(payload.listId);
        const itemId = Number(payload.itemId);
        if (!Number.isFinite(listId) || !Number.isFinite(itemId)) {
            this.finishDrag();
            return;
        }
        const targetListId = Number(this.activeChecklistId);
        if (!Number.isFinite(targetListId)) {
            this.finishDrag();
            return;
        }
        if (Number(listId) !== Number(targetListId)) {
            await this.moveChecklistItemToChecklist(listId, itemId, targetListId, targetColumnId);
            this.finishDrag();
            return;
        }
        const items = this.checklistItems[listId] || [];
        const current = items.find(it => Number(it.id) === Number(itemId));
        if (!current || Number(current.columnId) === Number(targetColumnId)) {
            this.finishDrag();
            return;
        }
        try {
            const json = await api.updateChecklistItem(listId, itemId, { columnId: targetColumnId });
            if (json?.item) {
                this.checklistItems[listId] = items.map(it => Number(it.id) === Number(itemId) ? { ...it, columnId: json.item.columnId } : it);
                this.renderChecklistsView();
            } else if (json?.success) {
                this.checklistItems[listId] = items.map(it => Number(it.id) === Number(itemId) ? { ...it, columnId: targetColumnId } : it);
                this.renderChecklistsView();
            } else if (json?.error) {
                this.showToast(json.error);
            }
        } catch (e) {
            console.error(e);
            this.showToast('移动失败');
        } finally {
            this.finishDrag();
        }
    }
    
    // 代理日历设置 (HTML onclick)
    toggleCalSetting(key) { this.calendar.toggleSetting(key); }

    toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;
        sidebar.classList.toggle('is-collapsed');
    }

    async openChecklistItemFromTasks(listId, columnId, itemId) {
        if (!Number.isFinite(Number(listId))) return;
        this.closeTaskDetail();
        const changed = Number(this.activeChecklistId) !== Number(listId);
        this.activeChecklistId = listId;
        if (!this.checklistColumns[listId] || changed) await this.loadChecklistColumns(listId);
        if (!this.checklistItems[listId] || changed) await this.loadChecklistItems(listId);
        this.openChecklistItemModal(columnId, itemId);
    }

    openTaskDetail(taskId) {
        if (!Number.isFinite(Number(taskId))) return;
        this.activeTaskDetailId = taskId;
        this.activeSubtaskDetail = null;
        this.renderTaskDetail();
    }
    openSubtaskDetail(taskId, subIndex) {
        if (!Number.isFinite(Number(taskId)) || !Number.isFinite(Number(subIndex))) return;
        const task = this.data.find(t => Number(t.id) === Number(taskId));
        if (!task || task.deletedAt || !Array.isArray(task.subtasks) || !task.subtasks[subIndex]) return;
        this.activeTaskDetailId = taskId;
        this.activeSubtaskDetail = { taskId, subIndex };
        this.renderTaskDetail();
    }
    getActiveSubtaskDetail() {
        const detail = this.activeSubtaskDetail;
        if (!detail) return null;
        const task = this.data.find(t => Number(t.id) === Number(detail.taskId));
        if (!task || task.deletedAt || !Array.isArray(task.subtasks) || !task.subtasks[detail.subIndex]) return null;
        return { task, subtask: task.subtasks[detail.subIndex], subIndex: detail.subIndex };
    }
    closeTaskDetail() {
        this.activeTaskDetailId = null;
        this.activeSubtaskDetail = null;
        this.renderTaskDetail();
    }
    updateTaskNotes(val) {
        const subDetail = this.getActiveSubtaskDetail();
        if (!subDetail && this.activeSubtaskDetail) this.activeSubtaskDetail = null;
        if (subDetail) {
            subDetail.subtask.note = val;
        } else {
            if (!this.activeTaskDetailId) return;
            const task = this.data.find(t => t.id === this.activeTaskDetailId);
            if (!task) return;
            task.notes = val;
        }
        if (this.noteSaveTimer) clearTimeout(this.noteSaveTimer);
        this.noteSaveTimer = setTimeout(() => {
            this.saveData();
        }, 300);
    }
    renderTaskDetail() {
        const layout = document.querySelector('#view-tasks .tasklist-layout');
        const panel = document.getElementById('task-detail-panel');
        if (!layout || !panel || this.view !== 'tasks') return;
        const subDetail = this.getActiveSubtaskDetail();
        const task = subDetail ? subDetail.task : (this.activeTaskDetailId ? this.data.find(t => t.id === this.activeTaskDetailId) : null);
        if (!task || task.deletedAt) {
            this.activeSubtaskDetail = null;
            layout.classList.remove('has-detail');
            const nameEl = document.getElementById('task-detail-name');
            const timeEl = document.getElementById('task-detail-time');
            const dateEl = document.getElementById('task-detail-date');
            const notesEl = document.getElementById('task-detail-notes');
            const titleEl = panel.querySelector('.task-detail-title');
            if (nameEl) nameEl.textContent = '--';
            if (timeEl) timeEl.textContent = '--';
            if (dateEl) dateEl.textContent = '--';
            if (notesEl) notesEl.value = '';
            if (titleEl) titleEl.textContent = '任务详情';
            return;
        }
        layout.classList.add('has-detail');
        const dateLabel = this.isInboxTask(task) ? '待办箱' : (task.date || '未设日期');
        const timeLabel = task.start && task.end ? `${task.start}~${task.end}` : (task.start || task.end || '');
        const timeLine = timeLabel ? `${dateLabel}，${timeLabel}` : dateLabel;
        const nameEl = document.getElementById('task-detail-name');
        const timeEl = document.getElementById('task-detail-time');
        const dateEl = document.getElementById('task-detail-date');
        const notesEl = document.getElementById('task-detail-notes');
        const titleEl = panel.querySelector('.task-detail-title');
        if (subDetail) {
            if (nameEl) nameEl.textContent = subDetail.subtask.title || '--';
            const parentLine = task.title ? `${task.title} · ${timeLine}` : timeLine;
            if (timeEl) timeEl.textContent = parentLine || '--';
            if (dateEl) dateEl.textContent = '';
            if (notesEl && document.activeElement !== notesEl) notesEl.value = subDetail.subtask.note || '';
            if (titleEl) titleEl.textContent = task.title || '任务详情';
        } else {
            if (nameEl) nameEl.textContent = task.title || '--';
            if (timeEl) timeEl.textContent = timeLine;
            if (dateEl) dateEl.textContent = '';
            if (notesEl && document.activeElement !== notesEl) notesEl.value = task.notes || '';
            if (titleEl) titleEl.textContent = '任务详情';
        }
    }

    openChecklistDetail(listId, itemId, skipListRender = false) {
        if (!Number.isFinite(Number(listId)) || !Number.isFinite(Number(itemId))) return;
        this.activeChecklistDetail = { listId, itemId };
        if (this.view === 'checklists') {
            if (!skipListRender && this.taskCardMenu) this.taskCardMenu = null;
            if (skipListRender) {
                this.renderChecklistDetail();
            } else {
                this.renderChecklistsView();
            }
        } else {
            this.renderChecklistDetail();
        }
    }
    closeChecklistDetail() {
        this.activeChecklistDetail = null;
        if (this.view === 'checklists') {
            this.renderChecklistsView();
        } else {
            this.renderChecklistDetail();
        }
    }
    getActiveChecklistDetail() {
        const detail = this.activeChecklistDetail;
        if (!detail) return null;
        const listId = Number(detail.listId);
        const items = this.checklistItems[listId] || [];
        const item = items.find(it => Number(it.id) === Number(detail.itemId));
        if (!item) return null;
        return { listId, item };
    }
    updateChecklistNotes(val) {
        const detail = this.getActiveChecklistDetail();
        if (!detail) return;
        const nextNotes = String(val || '');
        const listId = detail.listId;
        const itemId = detail.item.id;
        detail.item.notes = nextNotes;
        if (this.checklistNoteSaveTimer) clearTimeout(this.checklistNoteSaveTimer);
        this.checklistNoteSaveTimer = setTimeout(async () => {
            const items = this.checklistItems[listId] || [];
            const currentItem = items.find(it => Number(it.id) === Number(itemId));
            if (!currentItem) return;
            try {
                const json = await api.updateChecklistItem(listId, itemId, { notes: nextNotes });
                if (json?.item) {
                    this.checklistItems[listId] = items.map(it => Number(it.id) === Number(itemId)
                        ? { ...it, ...json.item }
                        : it);
                } else if (json?.error) {
                    this.showToast(json.error);
                }
            } catch (e) {
                console.error(e);
                this.showToast('保存失败');
            }
        }, 300);
    }
    renderChecklistDetail() {
        const layout = document.querySelector('#view-checklists .checklist-layout');
        const panel = document.getElementById('checklist-detail-panel');
        if (!layout || !panel || this.view !== 'checklists') return;
        const detail = this.getActiveChecklistDetail();
        if (!detail || Number(detail.listId) !== Number(this.activeChecklistId)) {
            this.activeChecklistDetail = null;
            layout.classList.remove('has-detail');
            const nameEl = document.getElementById('checklist-detail-name');
            const metaEl = document.getElementById('checklist-detail-meta');
            const notesEl = document.getElementById('checklist-detail-notes');
            const titleEl = panel.querySelector('.task-detail-title');
            if (nameEl) nameEl.textContent = '--';
            if (metaEl) metaEl.textContent = '--';
            if (notesEl) notesEl.value = '';
            if (titleEl) titleEl.textContent = '清单事项';
            return;
        }
        layout.classList.add('has-detail');
        const listName = this.getChecklistListName(detail.listId);
        const columnName = this.getChecklistColumnName(detail.listId, detail.item.columnId);
        const meta = [listName, columnName].filter(Boolean).join(' · ');
        const nameEl = document.getElementById('checklist-detail-name');
        const metaEl = document.getElementById('checklist-detail-meta');
        const notesEl = document.getElementById('checklist-detail-notes');
        const titleEl = panel.querySelector('.task-detail-title');
        if (nameEl) nameEl.textContent = detail.item.title || '--';
        if (metaEl) metaEl.textContent = meta || '--';
        if (notesEl && document.activeElement !== notesEl) notesEl.value = detail.item.notes || '';
        if (titleEl) titleEl.textContent = listName || '清单事项';
    }

    setTaskPanel(panel) {
        const allowed = new Set(['today', 'tomorrow', 'next7', 'inbox']);
        if (!allowed.has(panel)) return;
        this.taskPanel = panel;
        this.render();
    }
    toggleTasklistSection(section) {
        if (!this.tasklistCollapse || typeof this.tasklistCollapse !== 'object') {
            this.tasklistCollapse = { checklists: false, tags: false, filters: false };
        }
        if (!(section in this.tasklistCollapse)) return;
        this.tasklistCollapse[section] = !this.tasklistCollapse[section];
        this.applyTasklistSectionState();
    }
    applyTasklistSectionState() {
        document.querySelectorAll('.tasklist-section-body[data-section]').forEach((el) => {
            const section = el.dataset.section;
            const collapsed = !!this.tasklistCollapse?.[section];
            el.classList.toggle('is-collapsed', collapsed);
        });
        document.querySelectorAll('.tasklist-section-toggle[data-section]').forEach((btn) => {
            const section = btn.dataset.section;
            const collapsed = !!this.tasklistCollapse?.[section];
            btn.classList.toggle('is-collapsed', collapsed);
        });
    }
    async selectTaskChecklist(listId) {
        if (!Number.isFinite(Number(listId))) return;
        const changed = Number(this.activeChecklistId) !== Number(listId);
        this.activeChecklistId = listId;
        this.taskPanel = `checklist:${listId}`;
        if (!this.checklistColumns[listId] || changed) await this.loadChecklistColumns(listId);
        if (!this.checklistItems[listId] || changed) await this.loadChecklistItems(listId);
        this.checklistActionOpenId = null;
        this.render();
    }
    renderTaskChecklists() {
        const box = document.getElementById('tasklist-checklists');
        if (!box) return;
        if (this.checklistsLoading) {
            box.innerHTML = '<div class="checklist-empty">加载中...</div>';
            return;
        }
        if (!this.checklists.length) {
            box.innerHTML = '<div class="checklist-empty">暂无清单</div>';
            return;
        }
        const isChecklistPanel = this.taskPanel && this.taskPanel.startsWith('checklist:');
        const panelId = isChecklistPanel ? Number(this.taskPanel.split(':')[1]) : null;
        const activeId = Number.isFinite(panelId) ? panelId : null;
        box.innerHTML = this.checklists.map((list) => {
            const active = activeId !== null && Number(list.id) === Number(activeId);
            return `
                <div class="tasklist-list-item ${active ? 'active' : ''}" onclick="app.selectTaskChecklist(${list.id})" ondragenter="app.previewChecklistDrop(${list.id})" ondragover="app.allowChecklistListDrop(event, ${list.id})" ondragleave="app.leaveNavDrop(event)" ondrop="app.dropOnChecklistList(event, ${list.id})">
                    <span class="tasklist-list-name">${this.escapeHtml(list.name || '未命名清单')}</span>
                    <button class="btn-icon btn-ghost tasklist-list-delete" type="button" title="删除" onclick="event.stopPropagation(); app.deleteChecklist(${list.id});">×</button>
                </div>
            `;
        }).join('');
    }
    getChecklistColumnName(listId, columnId) {
        const cols = this.checklistColumns[listId] || [];
        const found = cols.find(c => Number(c.id) === Number(columnId));
        return found ? (found.name || '栏目') : '';
    }
    getChecklistListName(listId) {
        const list = this.checklists.find(l => Number(l.id) === Number(listId));
        return list ? (list.name || '清单') : '清单';
    }
    formatChecklistColumnTitle(listName, columnName) {
        const list = String(listName || '').trim();
        const col = String(columnName || '').trim();
        if (!col) return '栏目';
        if (list && col === list) return '默认栏目';
        return col;
    }
    shouldPromptChecklistColumn(listId) {
        const id = Number(listId);
        if (!Number.isFinite(id)) return false;
        if (this.checklistColumnPrompted.has(id)) return false;
        if (this.view === 'checklists') return true;
        return this.view === 'tasks' && this.taskPanel === `checklist:${id}`;
    }
    maybePromptChecklistColumn(listId) {
        const id = Number(listId);
        if (!Number.isFinite(id)) return;
        const cols = this.checklistColumns[id] || [];
        if (cols.length) return;
        if (!this.shouldPromptChecklistColumn(id)) return;
        this.checklistColumnPrompted.add(id);
        setTimeout(() => {
            if (Number(this.activeChecklistId) !== id) return;
            if (!this.shouldPromptChecklistColumn(id)) return;
            if ((this.checklistColumns[id] || []).length) return;
            this.promptCreateChecklistColumn();
        }, 0);
    }
    getChecklistItemsForTasks(listId = null) {
        const listIds = listId ? [listId] : this.checklists.map(l => l.id);
        const items = [];
        listIds.forEach((id) => {
            const arr = this.checklistItems[id] || [];
            arr.forEach((item) => items.push({ ...item, listId: id }));
        });
        return items;
    }
    createChecklistCardHtml(item) {
        const listName = this.getChecklistListName(item.listId);
        const columnName = this.getChecklistColumnName(item.listId, item.columnId);
        const labelParts = [listName, columnName].filter(Boolean);
        const label = labelParts.join(' · ') || '清单';
        const isCompleted = !!item.completed;
        const completedClass = isCompleted ? 'completed' : '';
        const menuOpen = this.taskCardMenu
            && this.taskCardMenu.type === 'checklist'
            && Number(this.taskCardMenu.id) === Number(item.id)
            && Number(this.taskCardMenu.listId) === Number(item.listId);
        const menuClass = menuOpen ? 'menu-open' : '';
        const menuHtml = menuOpen ? `
            <div class="task-card-menu">
                <button class="task-card-menu-item" onclick="event.stopPropagation(); app.closeTaskCardMenu(); app.openChecklistItemFromTasks(${item.listId}, ${item.columnId ?? 'null'}, ${item.id})">编辑</button>
                <button class="task-card-menu-item danger" onclick="event.stopPropagation(); app.closeTaskCardMenu(); app.deleteChecklistItem(${item.listId}, ${item.id})">删除</button>
            </div>
        ` : '';
        const subTasks = Array.isArray(item.subtasks) ? item.subtasks : [];
        let subHtml = '';
        if (subTasks.length > 0 && !this.isSelectionMode) {
            const subRows = subTasks.map((sub, idx) => `
                <div class="card-subtask-item" onclick="event.stopPropagation(); app.openChecklistItemFromTasks(${item.listId}, ${item.columnId ?? 'null'}, ${item.id})">
                    <div class="sub-checkbox ${sub.completed ? 'checked' : ''}"
                        onclick="event.stopPropagation(); app.toggleChecklistSubtask(${item.listId}, ${item.id}, ${idx})">
                    </div>
                    <span class="card-subtask-title" style="${sub.completed ? 'text-decoration:line-through;opacity:0.6' : ''}">
                        ${this.escapeHtml(sub.title || '')}
                    </span>
                </div>
            `).join('');
            subHtml = `<div class="card-subtask-list">${subRows}</div>`;
        }
        return `
            <div class="task-card ${completedClass} ${menuClass}" style="border-left-color:rgba(0,0,0,0.08)"
                 onclick="app.openChecklistItemFromTasks(${item.listId}, ${item.columnId ?? 'null'}, ${item.id})">
                <button class="task-edit-btn" title="更多" onclick="event.stopPropagation(); app.toggleTaskCardMenu('checklist', ${item.id}, ${item.listId})">...</button>
                ${menuHtml}
                <div class="checkbox ${isCompleted ? 'checked' : ''}" onclick="event.stopPropagation(); app.toggleChecklistItem(${item.listId}, ${item.id}, ${!isCompleted})"></div>
                <div style="flex:1">
                    <div class="task-title">${this.escapeHtml(item.title || '')}</div>
                    <div style="font-size:0.75rem; color:#666; margin-top:2px;">${this.escapeHtml(label)}</div>
                    ${subHtml}
                </div>
            </div>
        `;
    }
    renderTaskPanel(tasks) {
        const titleEl = document.getElementById('tasklist-title');
        const subtitleEl = document.getElementById('tasklist-subtitle');
        const listEl = document.getElementById('tasklist-items');
        const actionsEl = document.getElementById('tasklist-actions');
        if (!listEl) return;

        const panel = this.taskPanel || 'today';
        const headerEl = document.querySelector('.tasklist-content-header');
        if (headerEl) {
            headerEl.classList.toggle('is-compact', panel.startsWith('checklist:'));
            headerEl.classList.toggle('inline-subtitle', panel === 'today');
        }
        if (actionsEl) actionsEl.innerHTML = '';
        if (panel.startsWith('checklist:')) {
            const listId = Number(panel.split(':')[1]);
            this.renderTaskChecklistPanel(listId, { titleEl, subtitleEl, listEl, actionsEl });
            return;
        }
        const today = new Date();
        const todayStr = this.formatDate(today);
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        const tomorrowStr = this.formatDate(tomorrow);
        const todayStamp = this.getDateStamp(todayStr) ?? Date.now();
        const next7Stamp = todayStamp + 7 * 24 * 60 * 60 * 1000;

        let title = '今天';
        let subtitle = todayStr;
        let matchFn = (t) => t.date === todayStr;

        if (panel === 'tomorrow') {
            title = '明天';
            subtitle = tomorrowStr;
            matchFn = (t) => t.date === tomorrowStr;
        } else if (panel === 'next7') {
            const next7End = new Date(todayStamp + 7 * 24 * 60 * 60 * 1000);
            title = '最近七天';
            subtitle = `${tomorrowStr} - ${this.formatDate(next7End)}`;
            matchFn = (t) => {
                const stamp = this.getDateStamp(t.date);
                return stamp !== null && stamp > todayStamp && stamp <= next7Stamp;
            };
        } else if (panel === 'inbox') {
            title = '待办箱';
            subtitle = '无日期/时间任务';
            matchFn = (t) => this.isInboxTask(t);
        }

        if (titleEl) titleEl.textContent = title;
        if (subtitleEl) subtitleEl.textContent = subtitle;

        const scoped = panel === 'inbox'
            ? tasks.filter((t) => matchFn(t))
            : tasks.filter((t) => !this.isInboxTask(t) && matchFn(t));
        const statusFilter = this.filter.status || 'all';
        const allowTodo = statusFilter === 'all' || statusFilter === 'todo';
        const allowDone = statusFilter === 'all' || statusFilter === 'completed';
        const pending = scoped.filter((t) => t.status !== 'completed').map(t => ({ type: 'task', data: t }));
        const done = scoped.filter((t) => t.status === 'completed').map(t => ({ type: 'task', data: t }));
        if (panel === 'inbox' && !this.filter.tag) {
            const allChecklistItems = this.getChecklistItemsForTasks();
            if (allowTodo) {
                const checklistItems = allChecklistItems
                    .filter(item => !item.completed)
                    .map(item => ({ type: 'checklist', data: item }));
                pending.push(...checklistItems);
            }
            if (allowDone) {
                const checklistDone = allChecklistItems
                    .filter(item => item.completed)
                    .map(item => ({ type: 'checklist', data: item }));
                done.push(...checklistDone);
            }
        }

        pending.sort((a, b) => (a.type === 'task' && b.type === 'task')
            ? this.sortByDateTime(a.data, b.data)
            : 0);
        done.sort((a, b) => (a.type === 'task' && b.type === 'task')
            ? this.sortByDateTime(a.data, b.data, true)
            : 0);

        const pendingTarget = panel === 'inbox' ? 'inbox' : (panel === 'today' ? 'today' : 'todo');
        const pendingHtml = pending.map((item) => item.type === 'task'
            ? this.createCardHtml(item.data)
            : this.createChecklistCardHtml(item.data)).join('') || '<div class="task-empty">暂无待办事项</div>';
        const doneHtml = done.map((item) => item.type === 'task'
            ? this.createCardHtml(item.data)
            : this.createChecklistCardHtml(item.data)).join('') || '<div class="task-empty">暂无已完成任务</div>';
        const doneCollapsed = !!this.taskPanelCollapse?.done;
        const showDone = panel !== 'inbox';

        listEl.innerHTML = `
            <div class="tasklist-panel tasklist-panel--pending">
                <div class="tasklist-panel-header">
                    <span class="tasklist-panel-title">待办</span>
                    <span class="tasklist-panel-count">${pending.length}</span>
                </div>
                <div id="tasklist-pending" class="tasklist-panel-body task-section" ondragover="app.allowDrop(event)" ondragleave="app.leaveDrop(event)" ondrop="app.dropOnTaskList(event, '${pendingTarget}')">${pendingHtml}</div>
            </div>
            ${showDone ? `
            <div class="tasklist-panel tasklist-panel--done ${doneCollapsed ? 'is-collapsed' : ''}">
                <div class="tasklist-panel-header">
                    <div class="tasklist-panel-label">
                        <button class="tasklist-panel-toggle" type="button" title="展开/收起" onclick="app.toggleTaskPanelCollapse('done')">
                            <span class="tasklist-panel-caret ${doneCollapsed ? 'is-collapsed' : ''}">&#9662;</span>
                        </button>
                        <span class="tasklist-panel-title">已完成</span>
                    </div>
                    <span class="tasklist-panel-count">${done.length}</span>
                </div>
                <div id="tasklist-done" class="tasklist-panel-body task-section" ondragover="app.allowDrop(event)" ondragleave="app.leaveDrop(event)" ondrop="app.dropOnTaskList(event, 'done')">${doneHtml}</div>
            </div>
            ` : ''}
        `;

        document.querySelectorAll('.tasklist-item[data-panel]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.panel === panel);
        });
    }
    renderTaskChecklistPanel(listId, { titleEl, subtitleEl, listEl, actionsEl }) {
        document.querySelectorAll('.tasklist-item[data-panel]').forEach((btn) => {
            btn.classList.remove('active');
        });
        const list = this.checklists.find((l) => Number(l.id) === Number(listId));
        if (!list) {
            if (titleEl) titleEl.textContent = '请选择清单';
            if (subtitleEl) subtitleEl.textContent = '';
            listEl.innerHTML = '<div class="checklist-empty">请选择左侧任务功能或清单</div>';
            return;
        }
        if (titleEl) titleEl.textContent = list.name || '未命名清单';
        if (subtitleEl) subtitleEl.textContent = '';
        if (actionsEl) {
            actionsEl.innerHTML = '<button class="btn-icon" type="button" title="新建栏目" onclick="app.promptCreateChecklistColumn()">+</button>';
        }
        if (this.loadingChecklistId && Number(this.loadingChecklistId) === Number(listId)) {
            listEl.innerHTML = '<div class="checklist-empty">加载中...</div>';
            return;
        }
        const columns = (this.checklistColumns[listId] || []).slice().sort((a, b) => {
            const aOrder = Number(a.sortOrder) || 0;
            const bOrder = Number(b.sortOrder) || 0;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return Number(a.id) - Number(b.id);
        });
        if (!columns.length) {
            listEl.innerHTML = '<div class="checklist-empty">还没有栏目，点击右上角 + 新建栏目</div>';
            this.maybePromptChecklistColumn(listId);
            return;
        }
        const items = this.checklistItems[listId] || [];
        const statusFilter = this.filter.status || 'all';
        const columnsHtml = columns.map((col) => {
            const colItems = items.filter((item) => Number(item.columnId) === Number(col.id));
            const filteredItems = statusFilter === 'all'
                ? colItems
                : colItems.filter(it => statusFilter === 'todo' ? !it.completed : it.completed);
            const totalCount = filteredItems.length;
            const doneCount = filteredItems.filter((it) => it.completed).length;
            const itemHtml = filteredItems.length ? filteredItems.map((item) => {
                const checked = item.completed ? 'checked' : '';
                const completedClass = item.completed ? 'completed' : '';
                const menuOpen = this.taskCardMenu
                    && this.taskCardMenu.type === 'checklist'
                    && Number(this.taskCardMenu.id) === Number(item.id)
                    && Number(this.taskCardMenu.listId) === Number(listId);
                const menuHtml = menuOpen ? `
                    <div class="task-card-menu">
                        <button class="task-card-menu-item" onclick="event.stopPropagation(); app.closeTaskCardMenu(); app.openChecklistItemModal(${item.columnId ?? col.id}, ${item.id})">编辑</button>
                        <button class="task-card-menu-item danger" onclick="event.stopPropagation(); app.closeTaskCardMenu(); app.deleteChecklistItem(${listId}, ${item.id})">删除</button>
                    </div>
                ` : '';
                const subTasks = Array.isArray(item.subtasks) ? item.subtasks : [];
                const subRows = subTasks.map((sub, idx) => `
                    <div class="checklist-subtask ${sub.completed ? 'completed' : ''}"
                        onclick="event.stopPropagation(); app.openChecklistItemModal(${item.columnId ?? col.id}, ${item.id})">
                        <span class="checklist-subtask-box"
                            onclick="event.stopPropagation(); app.toggleChecklistSubtask(${listId}, ${item.id}, ${idx})"></span>
                        <span class="checklist-subtask-title">
                            ${this.escapeHtml(sub.title || '')}
                        </span>
                    </div>
                `).join('');
                const subHtml = subRows ? `<div class="checklist-subtask-list">${subRows}</div>` : '';
                const completedBy = item.completedBy ? `<span class="checklist-completed-by">完成人: ${this.escapeHtml(item.completedBy)}</span>` : '';
                return `
                    <div class="checklist-item-card">
                        <button class="task-edit-btn" title="更多" onclick="event.stopPropagation(); app.toggleTaskCardMenu('checklist', ${item.id}, ${listId})">...</button>
                        ${menuHtml}
                        <div class="checklist-item-row ${completedClass}" draggable="true" ondragstart="app.startChecklistDrag(event, ${listId}, ${item.id})" ondragend="app.finishDrag()">
                            <label class="checklist-item-main">
                                <input type="checkbox" ${checked} onchange="app.toggleChecklistItem(${listId}, ${item.id}, this.checked)">
                                <input type="text" value="${this.escapeHtml(item.title || '')}" onchange="app.updateChecklistItemTitle(${listId}, ${item.id}, this.value)" class="checklist-item-input" placeholder="请输入内容">
                                ${completedBy}
                            </label>
                        </div>
                        ${subHtml}
                    </div>
                `;
            }).join('') : '<div class="checklist-empty">暂无事项</div>';
            const columnMenuOpen = this.checklistColumnMenu
                && Number(this.checklistColumnMenu.listId) === Number(listId)
                && Number(this.checklistColumnMenu.colId) === Number(col.id);
            const columnMenuHtml = columnMenuOpen ? `
                <div class="task-card-menu checklist-column-menu">
                    <button class="task-card-menu-item" onclick="event.stopPropagation(); app.closeChecklistColumnMenu(); app.promptRenameChecklistColumn(${listId}, ${col.id})">编辑</button>
                    <button class="task-card-menu-item danger" onclick="event.stopPropagation(); app.closeChecklistColumnMenu(); app.deleteChecklistColumn(${listId}, ${col.id})">删除</button>
                </div>
            ` : '';
            return `
                <div class="checklist-column" ondragover="app.allowChecklistDrop(event)" ondragleave="app.leaveChecklistDrop(event)" ondrop="app.dropChecklistItem(event, ${col.id})">
                    <div class="checklist-column-header">
                        <div class="checklist-column-title">${this.escapeHtml(this.formatChecklistColumnTitle(list.name, col.name))}</div>
                        <div class="checklist-column-progress">(${doneCount}/${totalCount})</div>
                        <div class="checklist-column-actions" onclick="event.stopPropagation()">
                            <button class="btn-icon btn-ghost" title="新建事项" onclick="app.promptCreateChecklistItem(${col.id})">+</button>
                            <button class="btn-icon btn-ghost" title="更多" onclick="event.stopPropagation(); app.toggleChecklistColumnMenu(${listId}, ${col.id})">...</button>
                            ${columnMenuHtml}
                        </div>
                    </div>
                    <div class="checklist-column-list">
                        ${itemHtml}
                    </div>
                </div>
            `;
        }).join('');
        listEl.innerHTML = `<div class="checklist-items">${columnsHtml}</div>`;
    }
  
    // --- 渲染分发 ---
    render() {
        this.updateDateDisplay();
        if (this.view === 'checklists') {
            this.renderChecklistsView();
            return;
        }
        const allTasks = this.getFilteredData();
        const inboxTasks = allTasks.filter(t => this.isInboxTask(t));
        const datedTasks = allTasks.filter(t => !this.isInboxTask(t));
        const deletedTasks = this.getFilteredData({ onlyDeleted: true });

        // 1. 渲染多选操作栏
        this.renderSelectionBar();

        // 2. 渲染视图
        if (this.view === 'search') {
            const list = document.getElementById('search-results-list');
            if (!list) return;
            const query = this.filter.query ? this.filter.query.trim() : '';
            const tagFilter = this.filter.tag;
            const checklistItems = (!tagFilter && query) ? this.getChecklistItemsForTasks()
                .filter(item => String(item.title || '').includes(query) || (Array.isArray(item.subtasks) && item.subtasks.some(s => String(s.title || '').includes(query))))
                .map(item => this.createChecklistCardHtml(item)) : [];
            list.innerHTML = allTasks.map(t => this.createCardHtml(t)).join('') + checklistItems.join('');
            return;
        }
        if (this.view === 'tasks') {
            if (!this.checklistsLoaded && !this.checklistsLoading) {
                this.loadChecklists();
            }
            this.renderTaskChecklists();
            this.renderTaskPanel(allTasks);
            this.applyTasklistSectionState();
            this.renderTaskDetail();
            this.syncTaskFilterUI();
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

    getActiveChecklist() {
        return this.checklists.find(l => Number(l.id) === Number(this.activeChecklistId));
    }
    syncActiveChecklist() {
        const active = this.getActiveChecklist();
        if (active || !this.checklists.length) return active || null;
        this.activeChecklistId = this.checklists[0].id;
        return this.getActiveChecklist();
    }

    async loadChecklists() {
        if (!api.auth && !api.isLocalMode()) return;
        this.checklistsLoading = true;
        this.renderChecklistsView();
        try {
            const json = await api.getChecklists();
            this.checklists = Array.isArray(json?.lists) ? json.lists : [];
            if (!this.activeChecklistId && this.checklists.length) this.activeChecklistId = this.checklists[0].id;
            this.checklistsLoaded = true;
            if (this.activeChecklistId) {
                await this.loadChecklistColumns(this.activeChecklistId);
                await this.loadChecklistItems(this.activeChecklistId);
            }
        } catch (e) {
            console.error(e);
            this.showToast('清单加载失败');
        } finally {
            this.checklistsLoading = false;
            this.renderChecklistsView();
            if (this.view === 'tasks') this.renderTaskChecklists();
            if (this.view === 'tasks') this.render();
        }
    }

    async selectChecklist(listId) {
        if (!Number.isFinite(Number(listId))) return;
        const changed = Number(this.activeChecklistId) !== Number(listId);
        this.activeChecklistId = listId;
        if (!this.checklistColumns[listId] || changed) await this.loadChecklistColumns(listId);
        if (!this.checklistItems[listId] || changed) await this.loadChecklistItems(listId);
        this.checklistActionOpenId = null;
        this.renderChecklistsView();
    }

    async loadChecklistItems(listId) {
        if (!api.auth && !api.isLocalMode()) return;
        if (!Number.isFinite(Number(listId))) return;
        this.loadingChecklistId = listId;
        this.renderChecklistsView();
        try {
            const json = await api.getChecklistItems(listId);
            const items = Array.isArray(json?.items) ? json.items : [];
            this.checklistItems[listId] = items.map(item => ({
                ...item,
                notes: String(item?.notes || ''),
                subtasks: this.normalizeChecklistSubtasks(item.subtasks)
            }));
        } catch (e) {
            console.error(e);
            this.showToast('加载清单条目失败');
        } finally {
            this.loadingChecklistId = null;
            this.renderChecklistsView();
            if (this.view === 'tasks') this.render();
        }
    }

    async loadChecklistColumns(listId) {
        if (!api.auth && !api.isLocalMode()) return;
        if (!Number.isFinite(Number(listId))) return;
        try {
            const json = await api.getChecklistColumns(listId);
            this.checklistColumns[listId] = Array.isArray(json?.columns) ? json.columns : [];
        } catch (e) {
            console.error(e);
            this.showToast('加载栏目失败');
        }
        if (this.view === 'tasks') this.render();
    }

    openChecklistMenu(listId, e) {
        if (e) e.stopPropagation();
        if (this.checklistActionOpenId === listId) {
            this.checklistActionOpenId = null;
            this.checklistMenuPos = null;
            this.renderChecklistsView();
            return;
        }
        const btn = e?.currentTarget || e?.target;
        const rect = btn?.getBoundingClientRect ? btn.getBoundingClientRect() : null;
        if (rect) {
            const menuWidth = 160;
            const sidebar = document.getElementById('sidebar');
            const sidebarRect = sidebar?.getBoundingClientRect ? sidebar.getBoundingClientRect() : null;
            const sidebarLeft = sidebarRect ? (sidebarRect.left + window.scrollX) : 8;
            const sidebarRight = sidebarRect ? (sidebarRect.right + window.scrollX - 8) : (window.scrollX + window.innerWidth / 3);
            const preferredLeft = rect.left + window.scrollX; // align to button left
            const maxLeft = sidebarRight - menuWidth;
            const left = Math.max(sidebarLeft + 4, Math.min(preferredLeft, maxLeft));
            const top = rect.bottom + window.scrollY + 6;
            this.checklistMenuPos = { top, left };
        } else {
            this.checklistMenuPos = null;
        }
        this.checklistActionOpenId = listId;
        this.renderChecklistsView();
    }
    closeChecklistMenu() {
        if (this.checklistActionOpenId !== null) {
            this.checklistActionOpenId = null;
            this.checklistMenuPos = null;
            this.renderChecklistsView();
        }
    }
    toggleChecklistColumnMenu(listId, colId) {
        if (!Number.isFinite(Number(listId)) || !Number.isFinite(Number(colId))) return;
        const same = this.checklistColumnMenu
            && Number(this.checklistColumnMenu.listId) === Number(listId)
            && Number(this.checklistColumnMenu.colId) === Number(colId);
        this.checklistColumnMenu = same ? null : { listId: Number(listId), colId: Number(colId) };
        if (this.view === 'checklists') {
            this.renderChecklistsView();
        } else {
            this.render();
        }
    }
    closeChecklistColumnMenu() {
        if (!this.checklistColumnMenu) return;
        this.checklistColumnMenu = null;
        if (this.view === 'checklists') {
            this.renderChecklistsView();
        } else {
            this.render();
        }
    }
    toggleTaskCardMenu(type, id, listId = null) {
        if (!Number.isFinite(Number(id))) return;
        const listValue = Number.isFinite(Number(listId)) ? Number(listId) : null;
        const normalized = {
            type,
            id: Number(id),
            listId: type === 'checklist' ? listValue : null
        };
        const sameType = this.taskCardMenu && this.taskCardMenu.type === type;
        const sameId = sameType && Number(this.taskCardMenu.id) === normalized.id;
        const sameList = type === 'checklist'
            ? sameId && Number(this.taskCardMenu.listId) === normalized.listId
            : sameId;
        this.taskCardMenu = sameList ? null : normalized;
        this.render();
    }
    closeTaskCardMenu() {
        if (!this.taskCardMenu) return;
        this.taskCardMenu = null;
        this.render();
    }
    async deleteTaskById(id) {
        const t = this.data.find(x => Number(x.id) === Number(id));
        if (!t || t.deletedAt) return;
        if (!confirm(`确定删除任务 "${t.title}" 吗？`)) return;
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
        this.taskCardMenu = null;
        this.render();
        this.renderTags();
        this.showToast('已移动到回收站');
    }

    async promptCreateChecklist() {
        const name = prompt('清单名称');
        if (name === null) return;
        const trimmed = name.trim();
        if (!trimmed) return this.showToast('名称不能为空');
        try {
            const json = await api.createChecklist(trimmed);
            if (json?.list) {
                this.checklists.push(json.list);
                this.checklistItems[json.list.id] = [];
                this.checklistColumns[json.list.id] = [];
                this.activeChecklistId = json.list.id;
                this.checklistsLoaded = true;
                await this.ensureDefaultChecklistColumn(json.list.id, json.list.name || trimmed);
                if (this.view === 'tasks') {
                    await this.selectTaskChecklist(json.list.id);
                } else {
                    await this.selectChecklist(json.list.id);
                }
            } else if (json?.error) {
                this.showToast(json.error);
            }
        } catch (e) {
            console.error(e);
            this.showToast('创建清单失败');
        }
    }

    async promptRenameChecklist(listId) {
        const target = this.checklists.find(l => Number(l.id) === Number(listId));
        if (!target) return;
        const name = prompt('重命名清单', target.name || '');
        if (name === null) return;
        const trimmed = name.trim();
        if (!trimmed) return this.showToast('名称不能为空');
        try {
            const json = await api.renameChecklist(listId, trimmed);
            if (json?.list) {
                this.checklists = this.checklists.map(l => Number(l.id) === Number(listId) ? { ...l, name: trimmed, updatedAt: json.list.updatedAt || Date.now() } : l);
                this.renderChecklistsView();
            } else if (json?.error) {
                this.showToast(json.error);
            }
        } catch (e) {
            console.error(e);
            this.showToast('重命名失败');
        }
    }

    async promptCreateChecklistColumn() {
        const active = this.syncActiveChecklist();
        if (!active) return this.showToast('请先新建清单');
        const name = prompt('栏目名称');
        if (name === null) return;
        const trimmed = name.trim();
        if (!trimmed) return this.showToast('名称不能为空');
        try {
            const json = await api.createChecklistColumn(active.id, trimmed);
            if (json?.column) {
                const listId = active.id;
                const cols = this.checklistColumns[listId] || [];
                this.checklistColumns[listId] = [...cols, json.column];
                this.renderChecklistsView();
                if (this.view === 'tasks') this.render();
            } else if (json?.error) {
                this.showToast(json.error);
            }
        } catch (e) {
            console.error(e);
            this.showToast('创建栏目失败');
        }
    }

    async promptRenameChecklistColumn(listId, columnId) {
        const cols = this.checklistColumns[listId] || [];
        const target = cols.find(c => Number(c.id) === Number(columnId));
        if (!target) return;
        const name = prompt('重命名栏目', target.name || '');
        if (name === null) return;
        const trimmed = name.trim();
        if (!trimmed) return this.showToast('名称不能为空');
        try {
            const json = await api.renameChecklistColumn(listId, columnId, trimmed);
            if (json?.column) {
                this.checklistColumns[listId] = cols.map(c => Number(c.id) === Number(columnId) ? { ...c, name: trimmed } : c);
                this.renderChecklistsView();
                if (this.view === 'tasks') this.render();
            } else if (json?.error) {
                this.showToast(json.error);
            }
        } catch (e) {
            console.error(e);
            this.showToast('重命名栏目失败');
        }
    }

    findChecklistInboxColumn(listId) {
        const cols = this.checklistColumns[listId] || [];
        const existing = cols.find(c => String(c.name || '').trim() === '待办箱');
        return existing ? existing.id : null;
    }
    async ensureDefaultChecklistColumn(listId, listName) {
        if (!Number.isFinite(Number(listId))) return null;
        const cols = this.checklistColumns[listId] || [];
        if (cols.length) return cols[0].id;
        const name = '待办箱';
        try {
            const json = await api.createChecklistColumn(listId, name);
            if (json?.column) {
                this.checklistColumns[listId] = [...cols, json.column];
                return json.column.id;
            }
        } catch (e) {
            console.error(e);
        }
        return null;
    }
    openChecklistColumnDeleteModal(listId, columnId) {
        const modal = document.getElementById('checklist-column-delete-modal');
        if (!modal) return Promise.resolve(null);
        const nameEl = document.getElementById('checklist-column-delete-name');
        const cols = this.checklistColumns[listId] || [];
        const col = cols.find(c => Number(c.id) === Number(columnId));
        if (nameEl) nameEl.textContent = col?.name || '栏目';
        modal.style.display = 'flex';
        return new Promise((resolve) => {
            this.checklistColumnDeleteResolve = resolve;
        });
    }
    confirmChecklistColumnDelete(action) {
        const modal = document.getElementById('checklist-column-delete-modal');
        if (modal) modal.style.display = 'none';
        if (this.checklistColumnDeleteResolve) {
            this.checklistColumnDeleteResolve(action || null);
        }
        this.checklistColumnDeleteResolve = null;
    }
    cancelChecklistColumnDelete() {
        this.confirmChecklistColumnDelete(null);
    }
    async deleteChecklistColumn(listId, columnId) {
        const action = await this.openChecklistColumnDeleteModal(listId, columnId);
        if (!action) return;
        try {
            if (action === 'delete') {
                const items = this.checklistItems[listId] || [];
                const targets = items.filter(item => Number(item.columnId) === Number(columnId));
                for (const item of targets) {
                    await api.deleteChecklistItem(listId, item.id);
                }
                this.checklistItems[listId] = items.filter(item => Number(item.columnId) !== Number(columnId));
            } else {
                const inboxColumnId = this.findChecklistInboxColumn(listId);
                if (!inboxColumnId) {
                    this.showToast('未找到待办箱栏目，请先创建');
                    return;
                }
                const items = this.checklistItems[listId] || [];
                const targets = items.filter(item => Number(item.columnId) === Number(columnId));
                for (const item of targets) {
                    const res = await api.updateChecklistItem(listId, item.id, { columnId: inboxColumnId });
                    if (res?.item) {
                        item.columnId = res.item.columnId;
                    }
                }
                this.checklistItems[listId] = items.map(item => Number(item.columnId) === Number(columnId)
                    ? { ...item, columnId: inboxColumnId }
                    : item);
            }
            const json = await api.deleteChecklistColumn(listId, columnId);
            if (json?.success) {
                const cols = this.checklistColumns[listId] || [];
                this.checklistColumns[listId] = cols.filter(c => Number(c.id) !== Number(columnId));
                this.renderChecklistsView();
                if (this.view === 'tasks') this.render();
            } else if (json?.error) {
                this.showToast(json.error);
            }
        } catch (e) {
            console.error(e);
            this.showToast('删除栏目失败');
        }
    }

    async openChecklistShareModal(listId, e) {
        if (e) e.stopPropagation();
        if (api.isLocalMode()) {
            this.showToast('本地模式不支持共享');
            return;
        }
        this.checklistShareModalListId = listId;
        this.checklistShareReadonly = false;
        const modal = document.getElementById('checklist-share-modal');
        if (modal) modal.style.display = 'flex';
        const input = document.getElementById('checklist-share-user');
        if (input) input.value = '';
        await this.loadChecklistShares(listId);
        this.renderChecklistShareModal();
    }

    closeChecklistShareModal() {
        const modal = document.getElementById('checklist-share-modal');
        if (modal) modal.style.display = 'none';
        this.checklistShareModalListId = null;
        this.checklistShareReadonly = false;
    }

    async loadChecklistShares(listId) {
        if (!Number.isFinite(Number(listId))) return;
        try {
            const json = await api.getChecklistShares(listId);
            if (json?.shared) this.checklistShares[listId] = json.shared;
            this.checklistShareReadonly = !!json?.readonly;
        } catch (e) {
            console.error(e);
            this.showToast('加载共享用户失败');
        }
    }

    async addChecklistShare() {
        if (!this.checklistShareModalListId) return;
        const input = document.getElementById('checklist-share-user');
        const user = input ? input.value.trim() : '';
        if (!user) return this.showToast('请输入用户名');
        const canEdit = document.getElementById('share-can-edit')?.checked ?? true;
        try {
            const json = await api.addChecklistShare(this.checklistShareModalListId, user, { canEdit });
            if (json?.success) {
                const listId = this.checklistShareModalListId;
                const arr = this.checklistShares[listId] || [];
                this.checklistShares[listId] = [...arr, { user: json.user, canEdit: !!json.canEdit, createdAt: json.createdAt }];
                if (input) input.value = '';
                const editBox = document.getElementById('share-can-edit');
                if (editBox) editBox.checked = true;
                this.renderChecklistShareModal();
            } else if (json?.error) {
                this.showToast(json.error);
            }
        } catch (e) {
            console.error(e);
            this.showToast('共享失败');
        }
    }

    async removeChecklistShare(listId, user) {
        if (!Number.isFinite(Number(listId)) || !user) return;
        if (api.isLocalMode()) {
            this.showToast('本地模式不支持共享');
            return;
        }
        try {
            const res = await api.deleteChecklistShare(listId, user);
            if (res?.success) {
                const arr = this.checklistShares[listId] || [];
                this.checklistShares[listId] = arr.filter(s => s.user !== user);
                this.renderChecklistShareModal();
            } else if (res?.error) {
                this.showToast(res.error);
            }
        } catch (e) {
            console.error(e);
            this.showToast('取消共享失败');
        }
    }

    async updateChecklistShare(listId, user, payload = {}) {
        try {
            const res = await api.updateChecklistShare(listId, user, payload);
            if (res?.success) {
                const arr = this.checklistShares[listId] || [];
                this.checklistShares[listId] = arr.map(s => s.user === user ? { ...s, canEdit: !!res.canEdit } : s);
                this.renderChecklistShareModal();
            } else if (res?.error) {
                this.showToast(res.error);
            }
        } catch (e) {
            console.error(e);
            this.showToast('更新权限失败');
        }
    }

    isSharedChecklist(list) {
        if (!list) return false;
        const owner = list.owner || '';
        if (owner && api.user && owner !== api.user) return true;
        if (Number(list.sharedCount) > 0) return true;
        const shares = this.checklistShares[list.id] || [];
        return shares.length > 0;
    }

    renderChecklistShareModal() {
        const listId = this.checklistShareModalListId;
        const list = this.checklists.find(l => Number(l.id) === Number(listId));
        const nameEl = document.getElementById('checklist-share-name');
        const listEl = document.getElementById('checklist-share-list');
        const formEl = document.getElementById('checklist-share-form');
        const permsEl = document.getElementById('checklist-share-perms');
        if (formEl) formEl.style.display = this.checklistShareReadonly ? 'none' : '';
        if (permsEl) permsEl.style.display = this.checklistShareReadonly ? 'none' : '';
        if (nameEl) nameEl.textContent = list ? list.name : '清单';
        if (!listEl) return;
        const shared = this.checklistShares[listId] || [];
        if (!shared.length) {
            listEl.innerHTML = '<div class="checklist-empty">暂无共享用户</div>';
            return;
        }
        listEl.innerHTML = shared.map(s => `
            <div class="share-user-row">
                <div style="display:flex; flex-direction:column; gap:4px; flex:1;">
                    <span>👤 ${this.escapeHtml(s.user)}</span>
                    <div class="share-perms">
                        <label><input type="checkbox" ${s.canEdit ? 'checked' : ''} ${this.checklistShareReadonly ? 'disabled' : ''} onchange="app.updateChecklistShare(${listId}, '${this.escapeHtml(s.user)}', { canEdit: this.checked })"> 可编辑</label>
                    </div>
                </div>
                ${this.checklistShareReadonly ? '' : `<button class="btn-text" data-user="${this.escapeHtml(s.user)}" onclick="app.removeChecklistShare(${listId}, this.dataset.user)">取消共享</button>`}
            </div>
        `).join('');
    }

    promptCreateChecklistItem(columnId = null) {
        this.openChecklistItemModal(columnId, null);
    }

    openChecklistItemModal(columnId = null, itemId = null) {
        const active = this.getActiveChecklist();
        if (!active) return this.showToast('请先新建清单');
        this.checklistItemModalListId = active.id;
        this.checklistItemModalColumnId = columnId;
        this.checklistItemModalItemId = itemId;
        const modal = document.getElementById('checklist-item-modal');
        const titleInput = document.getElementById('checklist-item-title');
        const subtaskBox = document.getElementById('checklist-subtask-container');
        if (subtaskBox) subtaskBox.innerHTML = '';
        const items = this.checklistItems[active.id] || [];
        const current = itemId ? items.find(it => Number(it.id) === Number(itemId)) : null;
        if (titleInput) titleInput.value = current ? (current.title || '') : '';
        const subs = current && Array.isArray(current.subtasks) ? current.subtasks : [];
        if (subs.length) {
            subs.forEach(s => this.addChecklistSubtaskInput(s.title, s.completed, s.note));
        }
        if (modal) modal.style.display = 'flex';
    }

    closeChecklistItemModal() {
        const modal = document.getElementById('checklist-item-modal');
        if (modal) modal.style.display = 'none';
        this.checklistItemModalListId = null;
        this.checklistItemModalColumnId = null;
        this.checklistItemModalItemId = null;
    }

    addChecklistSubtaskInput(val = '', checked = false, note = '') {
        const container = document.getElementById('checklist-subtask-container');
        if (!container) return;
        const div = document.createElement('div');
        div.className = 'checklist-subtask-item';
        div.dataset.note = String(note || '');
        div.innerHTML = `
            <input type="checkbox" ${checked ? 'checked' : ''}>
            <div class="subtask-fields">
                <input type="text" class="form-input checklist-subtask-input checklist-subtask-title-input" value="${this.escapeHtml(val)}" placeholder="子任务">
            </div>
            <span class="checklist-subtask-remove subtask-remove" onclick="this.parentElement.remove()">×</span>
        `;
        container.appendChild(div);
    }

    collectChecklistSubtasks() {
        const subs = [];
        document.querySelectorAll('#checklist-subtask-container .checklist-subtask-item').forEach(item => {
            const input = item.querySelector('.checklist-subtask-title-input');
            const check = item.querySelector('input[type="checkbox"]');
            const title = input ? input.value.trim() : '';
            const note = String(item.dataset.note || '').trim();
            if (title) subs.push({ title, completed: !!check?.checked, note });
        });
        return subs;
    }

    async saveChecklistItemModal() {
        const listId = this.checklistItemModalListId;
        if (!listId) return;
        const titleInput = document.getElementById('checklist-item-title');
        const title = titleInput ? titleInput.value.trim() : '';
        if (!title) return this.showToast('内容不能为空');
        const subtasks = this.collectChecklistSubtasks();
        const itemId = this.checklistItemModalItemId;
        try {
            if (itemId) {
                const json = await api.updateChecklistItem(listId, itemId, { title, subtasks });
                if (json?.item) {
                    const items = this.checklistItems[listId] || [];
                    this.checklistItems[listId] = items.map(it => Number(it.id) === Number(itemId) ? { ...it, ...json.item } : it);
                } else if (json?.error) {
                    return this.showToast(json.error);
                }
            } else {
                const json = await api.createChecklistItem(listId, title, this.checklistItemModalColumnId, subtasks);
                if (json?.item) {
                    const arr = this.checklistItems[listId] || [];
                    this.checklistItems[listId] = [...arr, json.item];
                } else if (json?.error) {
                    return this.showToast(json.error);
                }
            }
            this.closeChecklistItemModal();
            this.renderChecklistsView();
            if (this.view === 'tasks') this.render();
        } catch (e) {
            console.error(e);
            this.showToast('保存失败');
        }
    }

    async toggleChecklistItem(listId, itemId, checked) {
        try {
            const items = this.checklistItems[listId] || [];
            const current = items.find(it => Number(it.id) === Number(itemId));
            const payload = { completed: !!checked };
            if (current && Array.isArray(current.subtasks) && current.subtasks.length) {
                payload.subtasks = current.subtasks.map(s => ({ ...s, completed: !!checked }));
            }
            const json = await api.updateChecklistItem(listId, itemId, payload);
            if (json?.item) {
                this.checklistItems[listId] = items.map(it => Number(it.id) === Number(itemId) ? {
                    ...it,
                    completed: !!checked,
                    completedBy: json.item.completedBy || (checked ? api.user : ''),
                    subtasks: json.item.subtasks || it.subtasks,
                    updatedAt: json.item.updatedAt || Date.now()
                } : it);
                this.renderChecklistsView();
                if (this.view === 'tasks') this.render();
            } else if (json?.error) {
                this.showToast(json.error);
            }
        } catch (e) {
            console.error(e);
            this.showToast('更新失败');
            this.renderChecklistsView();
        }
    }

    async updateChecklistItemTitle(listId, itemId, title) {
        const trimmed = (title || '').trim();
        if (!trimmed) { this.showToast('内容不能为空'); this.renderChecklistsView(); return; }
        try {
            const json = await api.updateChecklistItem(listId, itemId, { title: trimmed });
            if (json?.item) {
                const items = this.checklistItems[listId] || [];
                this.checklistItems[listId] = items.map(it => Number(it.id) === Number(itemId) ? { ...it, title: trimmed, updatedAt: json.item.updatedAt || Date.now() } : it);
                this.renderChecklistsView();
                if (this.view === 'tasks') this.render();
            } else if (json?.error) {
                this.showToast(json.error);
            }
        } catch (e) {
            console.error(e);
            this.showToast('更新失败');
        }
    }

    async toggleChecklistSubtask(listId, itemId, subIndex) {
        const items = this.checklistItems[listId] || [];
        const current = items.find(it => Number(it.id) === Number(itemId));
        if (!current || !Array.isArray(current.subtasks) || !current.subtasks[subIndex]) return;
        const nextSubtasks = current.subtasks.map((s, idx) => idx === subIndex ? { ...s, completed: !s.completed } : s);
        const allDone = nextSubtasks.length ? nextSubtasks.every(s => s.completed) : false;
        const payload = { subtasks: nextSubtasks };
        if (allDone !== !!current.completed) payload.completed = allDone;
        try {
            const json = await api.updateChecklistItem(listId, itemId, payload);
            if (json?.item) {
                this.checklistItems[listId] = items.map(it => Number(it.id) === Number(itemId) ? { ...it, ...json.item } : it);
                this.renderChecklistsView();
                if (this.view === 'tasks') this.render();
            } else if (json?.error) {
                this.showToast(json.error);
            }
        } catch (e) {
            console.error(e);
            this.showToast('更新失败');
        }
    }

    async deleteChecklistItem(listId, itemId) {
        try {
            const json = await api.deleteChecklistItem(listId, itemId);
            if (json?.success) {
                const items = this.checklistItems[listId] || [];
                this.checklistItems[listId] = items.filter(it => Number(it.id) !== Number(itemId));
                this.renderChecklistsView();
                if (this.view === 'tasks') this.render();
            } else if (json?.error) {
                this.showToast(json.error);
            }
        } catch (e) {
            console.error(e);
            this.showToast('删除失败');
        }
    }

    async deleteChecklist(listId) {
        if (!Number.isFinite(Number(listId))) return;
        if (!confirm('确认删除该清单及其所有条目吗？')) return;
        try {
            const res = await api.deleteChecklist(listId);
            if (res?.success) {
                this.checklists = this.checklists.filter(l => Number(l.id) !== Number(listId));
                delete this.checklistItems[listId];
                delete this.checklistShares[listId];
                if (Number(this.activeChecklistId) === Number(listId)) {
                    this.activeChecklistId = this.checklists[0]?.id || null;
                }
                this.renderChecklistsView();
                if (this.view === 'tasks') this.render();
            } else if (res?.error) {
                this.showToast(res.error);
            }
        } catch (e) {
            console.error(e);
            this.showToast('删除清单失败');
        }
    }

    renderChecklistsView() {
        const listBox = document.getElementById('checklist-list');
        const itemsBox = document.getElementById('checklist-items');
        const titleEl = document.getElementById('checklist-active-name');
        const addBtn = document.getElementById('checklist-add-btn');
        if (!listBox || !itemsBox) return;

        const activeChecklist = this.syncActiveChecklist();
        if (addBtn) addBtn.disabled = !activeChecklist;

        if (this.checklistsLoading) {
            listBox.innerHTML = '<div class="checklist-empty">加载中...</div>';
        } else if (!this.checklists.length) {
            listBox.innerHTML = '<div class="checklist-empty">暂无清单，先新建一个吧</div>';
        } else {
            listBox.innerHTML = this.checklists.map(l => {
                const active = Number(l.id) === Number(this.activeChecklistId);
                const menuOpen = Number(this.checklistActionOpenId) === Number(l.id);
                const menuStyle = menuOpen && this.checklistMenuPos
                    ? `style="top:${this.checklistMenuPos.top}px; left:${this.checklistMenuPos.left}px"`
                    : '';
                return `
                    <div class="checklist-nav-item ${active ? 'active' : ''}" onclick="app.selectChecklist(${l.id})">
                        <div class="checklist-nav-name">
                            <div>${this.escapeHtml(l.name || '未命名')}</div>
                            <div class="checklist-nav-owner">${this.isSharedChecklist(l) ? '共享清单' : ''}</div>
                        </div>
                        <div class="checklist-nav-actions" onclick="event.stopPropagation()">
                            <button class="btn-icon btn-ghost" title="操作" onclick="app.openChecklistMenu(${l.id}, event)">⋯</button>
                            ${menuOpen ? `
                                <div class="checklist-menu" ${menuStyle}>
                                    <div class="checklist-menu-item" onclick="app.promptRenameChecklist(${l.id}); app.closeChecklistMenu();">重命名</div>
                                    <div class="checklist-menu-item" onclick="app.openChecklistShareModal(${l.id}, event); app.closeChecklistMenu();">共享</div>
                                    <div class="checklist-menu-item checklist-menu-danger" onclick="app.deleteChecklist(${l.id}); app.closeChecklistMenu();">删除</div>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                `;
            }).join('');
        }

        const active = activeChecklist;
        if (!active) {
            if (titleEl) titleEl.textContent = '请选择清单';
            itemsBox.innerHTML = '<div class="checklist-empty">左侧选择或创建清单</div>';
            this.renderChecklistDetail();
            return;
        }
        if (titleEl) titleEl.textContent = active.name || '未命名清单';

        if (this.loadingChecklistId && Number(this.loadingChecklistId) === Number(active.id)) {
            itemsBox.innerHTML = '<div class="checklist-empty">加载中...</div>';
            this.renderChecklistDetail();
            return;
        }

        const columns = (this.checklistColumns[active.id] || []).slice().sort((a, b) => {
            const aOrder = Number(a.sortOrder) || 0;
            const bOrder = Number(b.sortOrder) || 0;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return Number(a.id) - Number(b.id);
        });
        if (!columns.length) {
            itemsBox.innerHTML = '<div class="checklist-empty">还没有栏目，点击右上角 + 新建栏目</div>';
            this.maybePromptChecklistColumn(active.id);
            this.renderChecklistDetail();
            return;
        }

        const items = this.checklistItems[active.id] || [];
        const fallbackColumnId = columns[0]?.id ?? null;
        const grouped = {};
        items.forEach(item => {
            const key = item.columnId ?? fallbackColumnId;
            if (key === null || key === undefined) return;
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(item);
        });

        itemsBox.innerHTML = columns.map(col => {
            const colItems = grouped[col.id] || [];
            const totalCount = colItems.length;
            const doneCount = colItems.reduce((sum, item) => sum + (item.completed ? 1 : 0), 0);
            const itemsHtml = colItems.length ? colItems.map(item => {
                const checked = item.completed ? 'checked' : '';
                const completedClass = item.completed ? 'completed' : '';
                const activeDetail = this.activeChecklistDetail
                    && Number(this.activeChecklistDetail.listId) === Number(active.id)
                    && Number(this.activeChecklistDetail.itemId) === Number(item.id);
                const detailClass = activeDetail ? 'is-active' : '';
                const menuOpen = this.taskCardMenu
                    && this.taskCardMenu.type === 'checklist'
                    && Number(this.taskCardMenu.id) === Number(item.id)
                    && Number(this.taskCardMenu.listId) === Number(active.id);
                const menuHtml = menuOpen ? `
                    <div class="task-card-menu">
                        <button class="task-card-menu-item" onclick="event.stopPropagation(); app.closeTaskCardMenu(); app.openChecklistItemModal(${item.columnId ?? col.id}, ${item.id})">编辑</button>
                        <button class="task-card-menu-item danger" onclick="event.stopPropagation(); app.closeTaskCardMenu(); app.deleteChecklistItem(${active.id}, ${item.id})">删除</button>
                    </div>
                ` : '';
                const completedBy = item.completedBy ? `<span class="checklist-completed-by">完成人: ${this.escapeHtml(item.completedBy)}</span>` : '';
                const subtaskHtml = Array.isArray(item.subtasks) && item.subtasks.length
                    ? `
                        <div class="checklist-subtask-list">
                            ${item.subtasks.map((sub, idx) => `
                                <div class="checklist-subtask ${sub.completed ? 'completed' : ''}"
                                    onclick="event.stopPropagation(); app.openChecklistItemModal(${item.columnId ?? col.id}, ${item.id})">
                                    <span class="checklist-subtask-box"
                                        onclick="event.stopPropagation(); app.toggleChecklistSubtask(${active.id}, ${item.id}, ${idx})"></span>
                                    <span class="checklist-subtask-title">
                                        ${this.escapeHtml(sub.title || '')}
                                    </span>
                                </div>
                            `).join('')}
                        </div>
                    `
                    : '';
                return `
                    <div class="checklist-item-card ${detailClass}">
                        <button class="task-edit-btn" title="更多" onclick="event.stopPropagation(); app.toggleTaskCardMenu('checklist', ${item.id}, ${active.id})">...</button>
                        ${menuHtml}
                        <div class="checklist-item-row ${completedClass}" draggable="true" onclick="app.openChecklistDetail(${active.id}, ${item.id})" ondragstart="app.startChecklistDrag(event, ${active.id}, ${item.id})" ondragend="app.finishDrag()">
                            <label class="checklist-item-main">
                                <input type="checkbox" ${checked} onclick="event.stopPropagation()" onchange="app.toggleChecklistItem(${active.id}, ${item.id}, this.checked)">
                                <input type="text" value="${this.escapeHtml(item.title || '')}" onclick="event.stopPropagation()" onfocus="app.openChecklistDetail(${active.id}, ${item.id}, true)" onchange="app.updateChecklistItemTitle(${active.id}, ${item.id}, this.value)" class="checklist-item-input" placeholder="请输入内容">
                                ${completedBy}
                            </label>
                        </div>
                        ${subtaskHtml}
                    </div>
                `;
            }).join('') : '<div class="checklist-empty">暂无事项</div>';
            const columnMenuOpen = this.checklistColumnMenu
                && Number(this.checklistColumnMenu.listId) === Number(active.id)
                && Number(this.checklistColumnMenu.colId) === Number(col.id);
            const columnMenuHtml = columnMenuOpen ? `
                <div class="task-card-menu checklist-column-menu">
                    <button class="task-card-menu-item" onclick="event.stopPropagation(); app.closeChecklistColumnMenu(); app.promptRenameChecklistColumn(${active.id}, ${col.id})">编辑</button>
                    <button class="task-card-menu-item danger" onclick="event.stopPropagation(); app.closeChecklistColumnMenu(); app.deleteChecklistColumn(${active.id}, ${col.id})">删除</button>
                </div>
            ` : '';
            return `
                <div class="checklist-column" ondragover="app.allowChecklistDrop(event)" ondragleave="app.leaveChecklistDrop(event)" ondrop="app.dropChecklistItem(event, ${col.id})">
                    <div class="checklist-column-header">
                        <div class="checklist-column-title">${this.escapeHtml(this.formatChecklistColumnTitle(active.name, col.name))}</div>
                        <div class="checklist-column-progress">(${doneCount}/${totalCount})</div>
                        <div class="checklist-column-actions" onclick="event.stopPropagation()">
                            <button class="btn-icon btn-ghost" title="新建事项" onclick="app.promptCreateChecklistItem(${col.id})">+</button>
                            <button class="btn-icon btn-ghost" title="更多" onclick="event.stopPropagation(); app.toggleChecklistColumnMenu(${active.id}, ${col.id})">...</button>
                            ${columnMenuHtml}
                        </div>
                    </div>
                    <div class="checklist-column-list">
                        ${itemsHtml}
                    </div>
                </div>
            `;
        }).join('');
        this.renderChecklistDetail();
    }

    escapeHtml(str = '') {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
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
        const menuOpen = this.taskCardMenu
            && this.taskCardMenu.type === 'task'
            && Number(this.taskCardMenu.id) === Number(t.id);
        const menuClass = menuOpen ? 'menu-open' : '';
        const menuHtml = menuOpen ? `
            <div class="task-card-menu">
                <button class="task-card-menu-item" onclick="event.stopPropagation(); app.closeTaskCardMenu(); app.openModal(${t.id})">编辑</button>
                <button class="task-card-menu-item danger" onclick="event.stopPropagation(); app.deleteTaskById(${t.id})">删除</button>
            </div>
        ` : '';
        
        const selClass = this.isSelectionMode ? `selection-mode ${isSelected ? 'selected' : ''}` : '';
        const activeClass = Number(this.activeTaskDetailId) === Number(t.id) ? 'is-active' : '';
        const clickHandler = `app.handleCardClick(event, ${t.id})`;
        
        let subHtml = '';
        if(t.subtasks && t.subtasks.length > 0 && !this.isSelectionMode) {
            const subRows = t.subtasks.map((sub, idx) => `
                <div class="card-subtask-item" onclick="event.stopPropagation(); app.openSubtaskDetail(${t.id}, ${idx})">
                    <div class="sub-checkbox ${sub.completed ? 'checked' : ''} ${isInbox ? 'disabled' : ''}"
                        ${isInbox ? 'title="待办箱任务不可完成"' : ''}
                        onclick="event.stopPropagation(); ${isInbox ? `app.showToast('待办箱任务不可完成');` : `app.toggleSubtask(${t.id}, ${idx})`}">
                    </div>
                    <span class="card-subtask-title" style="${sub.completed ? 'text-decoration:line-through;opacity:0.6' : ''}">
                        ${this.escapeHtml(sub.title || '')}
                    </span>
                </div>
            `).join('');
            subHtml = `<div class="card-subtask-list">${subRows}</div>`;
        }

          return `
              <div class="task-card ${t.status} ${selClass} ${activeClass} ${menuClass}" style="border-left-color:${qColor}" 
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
                 <button class="task-edit-btn" title="更多" onclick="event.stopPropagation(); app.toggleTaskCardMenu('task', ${t.id})">...</button>
                  ${menuHtml}
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
    setTaskModalCollapsed(collapsed) {
        this.taskModalCollapsed = !!collapsed;
        const box = document.getElementById('task-modal-box');
        if (box) box.classList.toggle('is-collapsed', this.taskModalCollapsed);
        const toggle = document.getElementById('task-modal-toggle');
        if (toggle) toggle.textContent = this.taskModalCollapsed ? '展开' : '收起';
    }
    toggleTaskModalDetails() {
        this.setTaskModalCollapsed(!this.taskModalCollapsed);
    }
    clearTaskQuadrant() {
        const select = document.getElementById('task-quadrant');
        if (select) select.value = '';
    }
    openModal(taskId = null, dateStr = null) {
        if (this.isSelectionMode) { if (taskId) this.toggleSelection(taskId); return; }

        this.currentTaskId = taskId;
        this.ensureInboxField();
        document.getElementById('modal-overlay').style.display = 'flex';
        this.setTaskModalCollapsed(true);
        document.getElementById('modal-title').innerText = taskId ? '✏️ 编辑任务' : '📝 新建任务';
        
        const t = taskId ? this.data.find(i => i.id === taskId) : null;
        const isNew = !taskId;
        let defaultDate = dateStr || this.formatDate(this.currentDate);
        let defaultInbox = false;
        if (isNew && !dateStr && this.view === 'tasks') {
            if (this.taskPanel === 'tomorrow') {
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                defaultDate = this.formatDate(tomorrow);
            } else if (this.taskPanel === 'inbox') {
                defaultDate = '';
                defaultInbox = true;
            } else {
                defaultDate = this.formatDate(new Date());
            }
        }
        const isInbox = t ? (t.inbox || this.isInboxTask(t)) : defaultInbox;
        document.getElementById('task-title').value = t ? t.title : '';
        document.getElementById('task-date').value = t ? (t.date || '') : (defaultDate || '');
        document.getElementById('task-start').value = t ? t.start || '' : '';
        document.getElementById('task-end').value = t ? t.end || '' : '';
        document.getElementById('task-quadrant').value = t ? (t.quadrant || '') : '';
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
        
        const taskTitleInput = document.getElementById('task-title');
        if (taskTitleInput) {
            taskTitleInput.oninput = () => this.syncTaskSubtaskNoteLabels();
            taskTitleInput.onkeydown = (e) => {
                if (e.key !== 'Enter' || e.isComposing) return;
                e.preventDefault();
                this.saveTask();
            };
        }

        document.getElementById('subtask-container').innerHTML = '';
        const subs = t ? (t.subtasks || []) : [];
        if (subs.length) subs.forEach(s => this.addSubtaskInput(s.title, s.completed, s.note));
        this.syncTaskSubtaskNoteLabels();

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
            const input = item.querySelector('.subtask-title-input');
            const noteInput = item.querySelector('.subtask-note-input');
            const check = item.querySelector('input[type="checkbox"]');
            const title = input ? input.value.trim() : '';
            const note = noteInput ? noteInput.value.trim() : String(item.dataset.note || '').trim();
            if (title) subtasks.push({ title, completed: !!check?.checked, note });
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
            notes: prevItem?.notes || '',
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
    getSubtaskNoteLabelText() {
        return '备注';
    }
    normalizeChecklistSubtasks(input) {
        let raw = input;
        if (typeof raw === 'string') {
            try {
                raw = JSON.parse(raw);
            } catch (e) {
                raw = [];
            }
        }
        if (!Array.isArray(raw)) return [];
        return raw.map((s) => {
            if (typeof s === 'string') {
                return { title: s.trim(), completed: false, note: '' };
            }
            const title = String(s?.title || s?.text || s?.name || '').trim();
            return {
                title,
                completed: !!s?.completed,
                note: String(s?.note || '').trim()
            };
        }).filter(s => s.title);
    }
    getTaskSubtaskParentTitle() {
        return document.getElementById('task-title')?.value.trim() || '';
    }
    getChecklistSubtaskParentTitle() {
        return document.getElementById('checklist-item-title')?.value.trim() || '';
    }
    syncTaskSubtaskNoteLabels() {
        const parentTitle = this.getTaskSubtaskParentTitle();
        document.querySelectorAll('#subtask-container .subtask-item').forEach(item => {
            const label = item.querySelector('.subtask-note-label');
            const subTitle = item.querySelector('.subtask-title-input')?.value.trim() || '';
            if (label) label.textContent = this.getSubtaskNoteLabelText(parentTitle, subTitle);
        });
    }
    syncChecklistSubtaskNoteLabels() {
        const parentTitle = this.getChecklistSubtaskParentTitle();
        document.querySelectorAll('#checklist-subtask-container .checklist-subtask-item').forEach(item => {
            const label = item.querySelector('.subtask-note-label');
            const subTitle = item.querySelector('.checklist-subtask-title-input')?.value.trim() || '';
            if (label) label.textContent = this.getSubtaskNoteLabelText(parentTitle, subTitle);
        });
    }
    addSubtaskInput(val = '', checked = false, note = '') {
        const div = document.createElement('div');
        div.className = 'subtask-item';
        div.dataset.note = String(note || '');
        div.innerHTML = `
            <input type="checkbox" ${checked ? 'checked' : ''}>
            <div class="subtask-fields">
                <input type="text" class="form-input subtask-title-input" value="${this.escapeHtml(val)}" placeholder="子任务">
            </div>
            <span class="subtask-remove" onclick="this.parentElement.remove()">×</span>
        `;
        const label = div.querySelector('.subtask-note-label');
        const titleInput = div.querySelector('.subtask-title-input');
        if (label) {
            const parentTitle = this.getTaskSubtaskParentTitle();
            const subTitle = titleInput ? titleInput.value.trim() : '';
            label.textContent = this.getSubtaskNoteLabelText(parentTitle, subTitle);
        }
        if (titleInput) {
            titleInput.oninput = () => this.syncTaskSubtaskNoteLabels();
        }
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
        const payload = JSON.stringify({ type: 'task', id });
        ev.dataTransfer.setData("text/plain", payload);
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
        const hadMenu = !!this.taskCardMenu;
        if (hadMenu) this.taskCardMenu = null;
        if (this.isSelectionMode) { this.toggleSelection(id); return; }
        if (this.view === 'tasks') {
            this.openTaskDetail(id);
            this.render();
            return;
        }
        this.openModal(id);
        if (hadMenu) this.render();
    }
    finishDrag() {
        this.dragActive = false;
        this.dragEndAt = Date.now();
        document.querySelector('.dragging')?.classList.remove('dragging');
    }
    dropOnTaskList(ev, target) {
        ev.preventDefault();
        ev.currentTarget.style.background = '';
        const payload = this.getDragPayload(ev);
        if (payload?.type === 'checklist-item') {
            const sourceListId = Number(payload.listId);
            const itemId = Number(payload.itemId);
            this.finishDrag();
            this.moveChecklistItemToTask(sourceListId, itemId, target);
            return;
        }
        const id = payload?.type === 'task' ? Number(payload.id) : parseInt(ev.dataTransfer.getData("text"), 10);
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
        } else if (target === 'today') {
            if (t.status === 'completed') { t.status = 'todo'; t.completedAt = null; changed = true; }
            if (t.inbox) { t.inbox = false; changed = true; }
            if (t.date !== todayStr) { t.date = todayStr; changed = true; }
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
        const list = Array.from(tags);
        const listEl = document.getElementById('tag-filter-list');
        if (listEl) listEl.innerHTML = list.map(tag => {
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
    setFilterStatus(value) {
        this.filter.status = value || 'all';
        this.syncTaskFilterUI();
        this.render();
    }
    setFilterQuadrant(value) {
        this.filter.quadrant = value || 'all';
        this.syncTaskFilterUI();
        this.render();
    }
    clearTaskFilters() {
        this.filter.status = 'all';
        this.filter.quadrant = 'all';
        this.syncTaskFilterUI();
        this.render();
    }
    syncTaskFilterUI() {
        const statusEl = document.getElementById('task-filter-status');
        if (statusEl) statusEl.value = this.filter.status || 'all';
        const quadEl = document.getElementById('task-filter-quadrant');
        if (quadEl) quadEl.value = this.filter.quadrant || 'all';
        const clearBtn = document.getElementById('task-filter-clear');
        if (clearBtn) {
            const active = (this.filter.status && this.filter.status !== 'all')
                || (this.filter.quadrant && this.filter.quadrant !== 'all');
            clearBtn.disabled = !active;
        }
    }
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
            const statusFilter = this.filter.status || 'all';
            const quadrantFilter = this.filter.quadrant || 'all';
            const matchStatus = statusFilter === 'all'
                || (statusFilter === 'todo' ? t.status !== 'completed' : t.status === 'completed');
            const matchQuadrant = quadrantFilter === 'all'
                || (quadrantFilter === 'none' ? !t.quadrant : t.quadrant === quadrantFilter);
            return matchQuery && matchTag && matchStatus && matchQuadrant;
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
    getQuadrantLightColor(q) {
        const map = { q1: 'var(--quad-danger)', q2: 'var(--quad-primary)', q3: 'var(--quad-warning)', q4: 'var(--quad-success)' };
        return map[q] || 'rgba(0,0,0,0.08)';
    }
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
            const input = item.querySelector('.subtask-title-input');
            const noteInput = item.querySelector('.subtask-note-input');
            const check = item.querySelector('input[type="checkbox"]');
            const title = input ? input.value.trim() : '';
            const note = noteInput ? noteInput.value.trim() : String(item.dataset.note || '').trim();
            if (title) subtasks.push({ title, completed: !!check?.checked, note });
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
            notes: '',
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
    async downloadJSON() {
        try {
            const payload = await this.buildExportPayload();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {type: "application/json"}));
            a.download = `glass-todo-${this.formatDate(new Date())}.json`;
            a.click();
        } catch (e) {
            console.error(e);
            alert('导出失败：' + (e.message || '未知错误'));
        }
    }

    async buildExportPayload() {
        const tasks = Array.isArray(this.data) ? this.data : [];
        const checklists = await this.collectChecklistExportData();
        const pomodoro = this.collectPomodoroExportData();
        return {
            version: 2,
            exportedAt: Date.now(),
            tasks,
            checklists,
            pomodoro
        };
    }

    collectPomodoroExportData() {
        return {
            settings: this.pomodoroSettings || this.getPomodoroDefaults(),
            state: this.pomodoroState || this.getPomodoroStateDefaults(),
            history: this.pomodoroHistory || this.getPomodoroHistoryDefaults()
        };
    }

    async collectChecklistExportData() {
        if (!api.auth && !api.isLocalMode()) {
            return { lists: [], items: {}, columns: {} };
        }
        try {
            const json = await api.getChecklists();
            const lists = Array.isArray(json?.lists) ? json.lists : [];
            const items = {};
            const columns = {};
            for (const list of lists) {
                const listId = list?.id;
                if (!Number.isFinite(Number(listId))) continue;
                const [itemsJson, columnsJson] = await Promise.all([
                    api.getChecklistItems(listId),
                    api.getChecklistColumns(listId)
                ]);
                const rawItems = Array.isArray(itemsJson?.items) ? itemsJson.items : [];
                items[listId] = rawItems.map((item) => ({
                    ...item,
                    notes: String(item?.notes || ''),
                    subtasks: this.normalizeChecklistSubtasks(item?.subtasks)
                }));
                columns[listId] = Array.isArray(columnsJson?.columns) ? columnsJson.columns : [];
            }
            return { lists, items, columns };
        } catch (e) {
            console.error(e);
            return { lists: [], items: {}, columns: {} };
        }
    }

    async importJSON(file) {
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            let tasks = null;
            let checklists = null;
            let pomodoro = null;
            if (Array.isArray(parsed)) {
                tasks = parsed;
            } else if (parsed && typeof parsed === 'object') {
                if (Array.isArray(parsed.tasks)) tasks = parsed.tasks;
                else if (Array.isArray(parsed.data)) tasks = parsed.data;
                else tasks = [];
                if (parsed.checklists && typeof parsed.checklists === 'object') checklists = parsed.checklists;
                if (parsed.pomodoro && typeof parsed.pomodoro === 'object') pomodoro = parsed.pomodoro;
            }
            if (!Array.isArray(tasks)) throw new Error('文件格式错误');
            this.data = tasks;
            this.dataVersion = Date.now();
            this.cleanupRecycle();
            await this.saveData(true);
            await this.importChecklistPayload(checklists);
            this.importPomodoroPayload(pomodoro);
            this.render();
            this.renderTags();
            this.showToast('导入成功');
        } catch (e) {
            console.error(e);
            alert('导入失败：' + (e.message || '解析错误'));
        }
    }

    async importChecklistPayload(payload) {
        if (!payload || typeof payload !== 'object') return;
        if (!api.isLocalMode()) {
            this.showToast('清单导入仅支持本地模式');
            return;
        }
        const lists = Array.isArray(payload.lists) ? payload.lists : [];
        const itemsRaw = payload.items && typeof payload.items === 'object' ? payload.items : {};
        const columnsRaw = payload.columns && typeof payload.columns === 'object' ? payload.columns : {};
        const items = {};
        Object.entries(itemsRaw).forEach(([key, value]) => {
            const arr = Array.isArray(value) ? value : [];
            items[key] = arr.map((item) => ({
                ...item,
                notes: String(item?.notes || ''),
                subtasks: this.normalizeChecklistSubtasks(item?.subtasks)
            }));
        });
        const columns = {};
        Object.entries(columnsRaw).forEach(([key, value]) => {
            columns[key] = Array.isArray(value) ? value : [];
        });
        api.saveLocalChecklistData({ lists, items, columns });
        this.checklists = lists;
        this.checklistItems = items;
        this.checklistColumns = columns;
        this.checklistsLoaded = true;
        this.checklistsLoading = false;
        this.activeChecklistId = lists[0]?.id || null;
        this.renderChecklistsView();
        if (this.view === 'tasks') this.renderTaskChecklists();
    }

    importPomodoroPayload(payload) {
        if (!payload || typeof payload !== 'object') return;
        const defaultsSettings = this.getPomodoroDefaults();
        const defaultsState = this.getPomodoroStateDefaults();
        const defaultsHistory = this.getPomodoroHistoryDefaults();
        const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : null;
        const state = payload.state && typeof payload.state === 'object' ? payload.state : null;
        const history = payload.history && typeof payload.history === 'object' ? payload.history : null;

        if (settings) this.pomodoroSettings = { ...defaultsSettings, ...settings };
        if (state) this.pomodoroState = { ...defaultsState, ...state };
        if (history) {
            this.pomodoroHistory = {
                ...defaultsHistory,
                ...history,
                days: history.days || {},
                sessions: history.sessions || []
            };
        }
        if (api.isLocalMode()) {
            this.savePomodoroSettings();
            this.savePomodoroState();
            this.savePomodoroHistory();
        } else if (settings || state) {
            this.savePomodoroSettings();
            this.savePomodoroState();
            if (history) this.showToast('番茄钟历史仅支持本地模式导入');
        }
        if (this.view === 'pomodoro') this.renderPomodoro();
    }
}
const app = new TodoApp();
loadAppConfig().then((config) => {
    api.setConfig(config);
    app.applyConfig(config);
    app.init();
});
