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
        this.pushEnabled = localStorage.getItem('glass_push_enabled') === 'true';
        this.pushSubscription = null;
        this.swRegistrationPromise = null;

        this.holidaysByYear = {};
        this.holidayLoading = {};
        this.viewSettings = JSON.parse(localStorage.getItem('glass_view_settings')) || {
            calendar: true,
            matrix: true
        };
        this.calendarDefaultMode = this.normalizeCalendarMode(localStorage.getItem('glass_calendar_default_mode')) || 'day';
        this.autoMigrateEnabled = this.loadAutoMigrateSetting();

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
        
        // 样式已移至 css/style.css，这里只保留基本的兼容性处理或空实现
        this.calendar.initControls(); // 委托 Calendar 初始化控件
        this.calendar.renderRuler();  // 委托 Calendar 渲染尺子
        this.applyViewSettings();
        this.initViewSettingsControls();
        this.initCalendarDefaultModeControl();
        this.initPushControls();
        this.syncAutoMigrateUI();
        this.initMobileSwipes();
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
            } else {
                if(result.needInvite) {
                    document.getElementById('invite-field').style.display = 'block';
                    alert("新用户注册需要管理员邀请码");
                } else alert("登录失败: " + result.error);
            }
        } catch(e) { console.error(e); alert("网络错误"); }
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
        
        this.render();
        if (v === 'tasks') this.applyTaskSwipePosition();
    }

    isViewEnabled(v) {
        if (v === 'calendar') return !!this.viewSettings.calendar;
        if (v === 'matrix') return !!this.viewSettings.matrix;
        if (v === 'inbox') return false;
        return true;
    }
    applyViewSettings() {
        const map = { calendar: this.viewSettings.calendar, matrix: this.viewSettings.matrix };
        Object.keys(map).forEach(key => {
            const visible = !!map[key];
            document.querySelectorAll(`#sidebar .nav-item[data-view="${key}"], #mobile-tabbar .tab-item[data-view="${key}"]`)
                .forEach(el => { el.style.display = visible ? '' : 'none'; });
        });
        if (!this.isViewEnabled(this.view)) this.switchView('tasks');
    }
    initViewSettingsControls() {
        document.querySelectorAll('.settings-toggle').forEach(item => {
            item.onclick = () => this.toggleViewSetting(item.dataset.key);
        });
        this.syncViewSettingUI();
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
        localStorage.setItem('glass_calendar_default_mode', normalized);
        if (this.view === 'calendar') this.calendar.setMode(normalized);
    }
    normalizeCalendarMode(mode) {
        if (!mode) return '';
        const value = String(mode).toLowerCase();
        return ['day','week','month'].includes(value) ? value : '';
    }
    toggleViewSetting(key) {
        if (key === 'auto-migrate') { this.toggleAutoMigrate(); return; }
        if (!['calendar', 'matrix'].includes(key)) return;
        this.viewSettings[key] = !this.viewSettings[key];
        localStorage.setItem('glass_view_settings', JSON.stringify(this.viewSettings));
        this.syncViewSettingUI();
        this.applyViewSettings();
    }
    syncViewSettingUI() {
        const mapping = {
            calendar: 'switch-view-calendar',
            matrix: 'switch-view-matrix',
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
        localStorage.setItem('glass_auto_migrate_overdue', String(this.autoMigrateEnabled));
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
            localStorage.setItem('glass_push_enabled', 'false');
            this.updatePushButton();
            return;
        }
        try {
            await this.ensurePushSubscription();
            this.pushEnabled = true;
            localStorage.setItem('glass_push_enabled', 'true');
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
        localStorage.setItem('glass_push_enabled', 'false');
        this.showToast('通知已关闭');
    }

    async syncPushSubscription() {
        if (!this.pushSupported || api.isLocalMode()) return;
        if (Notification.permission === 'denied') {
            this.pushEnabled = false;
            localStorage.setItem('glass_push_enabled', 'false');
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
            return;
        }
        const maxIndex = 2;
        this.mobileTaskIndex = Math.max(0, Math.min(maxIndex, this.mobileTaskIndex));
        board.style.transform = `translateX(-${this.mobileTaskIndex * 100}%)`;
        this.updateTaskColumnStates();
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
            return `
                <div class="task-group">
                    <div class="task-group-title">${g.title}<span class="task-group-count">${g.items.length}</span></div>
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
        const qColor = this.getQuadrantColor(t.quadrant);
        const tags = (t.tags||[]).map(tag => `<span class="tag-pill">#${tag}</span>`).join(' ');
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
                    <div style="margin-top:4px;">${tags}</div>
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
            subtasks, status,
            inbox: isInbox,
            completedAt,
            remindAt,
            notifiedAt,
            deletedAt: this.currentTaskId ? (this.data.find(i=>i.id==this.currentTaskId)?.deletedAt || null) : null
        };

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
        document.getElementById('tag-filter-list').innerHTML = Array.from(tags).map(tag => `
            <div class="nav-item ${this.filter.tag===tag?'active':''}" onclick="if(!event.target.closest('.tag-more')) app.setTagFilter('${tag}')">
                <div class="tag-dot"></div> 
                <span style="flex:1">${tag}</span>
                <div class="tag-more" onclick="event.stopPropagation();app.openTagMenu('${tag}')">⋯</div>
            </div>
        `).join('');
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

            const matchQuery = !q || t.title.includes(q) 
                || (t.tags||[]).some(tag => tag.includes(q))
                || (t.subtasks||[]).some(s => (s.title||'').includes(q));
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
    isInboxTask(t) { return !!t && ((!t.date && !t.start && !t.end) || t.inbox); }
    
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


