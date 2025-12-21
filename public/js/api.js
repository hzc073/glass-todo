// Simple API wrapper with optional local storage mode.
const api = {
    auth: localStorage.getItem('auth') || '',
    user: localStorage.getItem('user') || '',
    baseUrl: '',
    useLocalStorage: false,
    holidayJsonUrl: '',
    dataKey: 'glass_todo_data',
    dataVersionKey: 'glass_todo_version',

    setAuth(user, token) {
        this.user = user;
        this.auth = token;
        localStorage.setItem('user', user);
        localStorage.setItem('auth', token);
    },

    clearAuth() {
        this.auth = '';
        this.user = '';
        localStorage.removeItem('user');
        localStorage.removeItem('auth');
    },

    setConfig(config = {}) {
        const base = String(config.apiBaseUrl || '').trim();
        this.baseUrl = base ? base.replace(/\/+$/, '') : '';
        this.useLocalStorage = !!config.useLocalStorage;
        this.holidayJsonUrl = String(config.holidayJsonUrl || '').trim();
        if (!this.useLocalStorage && this.auth === 'local') {
            this.clearAuth();
        }
        if (this.useLocalStorage && !this.auth) {
            const existingUser = localStorage.getItem('user') || 'demo';
            this.setAuth(existingUser, 'local');
        }
    },

    isLocalMode() {
        return !!this.useLocalStorage;
    },

    buildUrl(path) {
        if (!this.baseUrl) return path;
        const p = path.startsWith('/') ? path : `/${path}`;
        return `${this.baseUrl}${p}`;
    },

    authHeaders() {
        return this.auth ? { 'Authorization': this.auth } : {};
    },

    loadLocalData() {
        const raw = localStorage.getItem(this.dataKey);
        const version = Number(localStorage.getItem(this.dataVersionKey) || 0);
        if (!raw) return { data: [], version };
        try {
            const parsed = JSON.parse(raw);
            return { data: Array.isArray(parsed) ? parsed : [], version };
        } catch (e) {
            return { data: [], version };
        }
    },

    saveLocalData(data) {
        const version = Date.now();
        localStorage.setItem(this.dataKey, JSON.stringify(data || []));
        localStorage.setItem(this.dataVersionKey, String(version));
        return { success: true, version };
    },

    async request(url, method = 'GET', body = null, headers = {}) {
        if (!this.auth && !this.useLocalStorage && !url.includes('login')) throw new Error('No auth');

        const opts = {
            method,
            headers: { 'Authorization': this.auth, 'Content-Type': 'application/json', ...headers }
        };
        if (body) opts.body = JSON.stringify(body);

        const res = await fetch(this.buildUrl(url), opts);
        if (res.status === 401) {
            if (window.app && typeof window.app.handleUnauthorized === 'function') {
                window.app.handleUnauthorized();
            } else {
                this.clearAuth();
            }
            throw new Error('Unauthorized');
        }
        return res;
    },

    async login(username, password, inviteCode) {
        if (this.useLocalStorage) {
            const name = (username || '').trim() || this.user || 'demo';
            this.setAuth(name, 'local');
            return { success: true, isAdmin: false };
        }
        const token = btoa(unescape(encodeURIComponent(username + ":" + password)));
        const headers = { 'Authorization': token };
        if (inviteCode) headers['x-invite-code'] = inviteCode;

        const res = await fetch(this.buildUrl('/api/login'), { method: 'POST', headers });
        const json = await res.json();

        if (res.ok) {
            this.setAuth(username, token);
            return { success: true, isAdmin: json.isAdmin };
        }
        return { success: false, error: json.error, needInvite: json.needInvite };
    },

    async loadData() {
        if (this.useLocalStorage) return this.loadLocalData();
        const res = await this.request('/api/data');
        return await res.json();
    },

    async saveData(data) {
        if (this.useLocalStorage) return this.saveLocalData(data);
        return await this.request('/api/data', 'POST', { data, version: Date.now(), force: true });
    },

    // Admin APIs
    async adminGetInvite() { return (await this.request('/api/admin/invite')).json(); },
    async adminRefreshInvite() { return (await this.request('/api/admin/invite/refresh', 'POST')).json(); },
    async adminGetUsers() { return (await this.request('/api/admin/users')).json(); },
    async adminResetPwd(targetUser) { return await this.request('/api/admin/reset-pwd', 'POST', { targetUser }); },
    async adminDeleteUser(targetUser) { return await this.request('/api/admin/delete-user', 'POST', { targetUser }); },

    // Password
    async changePassword(oldPassword, newPassword) {
        return await this.request('/api/change-pwd', 'POST', { oldPassword, newPassword });
    },

    // Push notifications
    async pushPublicKey() { return (await this.request('/api/push/public-key')).json(); },
    async pushSubscribe(subscription) { return (await this.request('/api/push/subscribe', 'POST', { subscription })).json(); },
    async pushUnsubscribe(endpoint) { return (await this.request('/api/push/unsubscribe', 'POST', { endpoint })).json(); },
    async pushTest() { return (await this.request('/api/push/test', 'POST')).json(); },
    // User settings
    async userGetSettings() { return (await this.request('/api/user/settings')).json(); },
    async userSaveSettings(settings) { return (await this.request('/api/user/settings', 'POST', settings)).json(); }
    ,
    // Pomodoro APIs
    async pomodoroGetSettings() { return (await this.request('/api/pomodoro/settings')).json(); },
    async pomodoroSaveSettings(settings) { return (await this.request('/api/pomodoro/settings', 'POST', settings)).json(); },
    async pomodoroGetState() { return (await this.request('/api/pomodoro/state')).json(); },
    async pomodoroSaveState(state) { return (await this.request('/api/pomodoro/state', 'POST', state)).json(); },
    async pomodoroGetSessions(limit = 50) { return (await this.request(`/api/pomodoro/sessions?limit=${limit}`)).json(); },
    async pomodoroGetSummary(days = 7) { return (await this.request(`/api/pomodoro/summary?days=${days}`)).json(); },
    async pomodoroSaveSession(session) { return (await this.request('/api/pomodoro/sessions', 'POST', session)).json(); }
    ,
    // Attachments
    async uploadAttachment(taskId, file) {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch(this.buildUrl(`/api/tasks/${taskId}/attachments`), {
            method: 'POST',
            headers: this.authHeaders(),
            body: formData
        });
        if (res.status === 401) {
            if (window.app && typeof window.app.handleUnauthorized === 'function') {
                window.app.handleUnauthorized();
            } else {
                this.clearAuth();
            }
            throw new Error('Unauthorized');
        }
        return res;
    },
    async deleteAttachment(taskId, attachmentId) {
        const res = await fetch(this.buildUrl(`/api/tasks/${taskId}/attachments/${attachmentId}`), {
            method: 'DELETE',
            headers: this.authHeaders()
        });
        if (res.status === 401) {
            if (window.app && typeof window.app.handleUnauthorized === 'function') {
                window.app.handleUnauthorized();
            } else {
                this.clearAuth();
            }
            throw new Error('Unauthorized');
        }
        return res;
    },
    async downloadAttachment(attachmentId) {
        const res = await fetch(this.buildUrl(`/api/attachments/${attachmentId}/download`), {
            method: 'GET',
            headers: this.authHeaders()
        });
        if (res.status === 401) {
            if (window.app && typeof window.app.handleUnauthorized === 'function') {
                window.app.handleUnauthorized();
            } else {
                this.clearAuth();
            }
            throw new Error('Unauthorized');
        }
        return res;
    }
};

export default api;
