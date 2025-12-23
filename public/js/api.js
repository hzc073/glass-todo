// Simple API wrapper with optional local storage mode.
const normalizeChecklistSubtasks = (input) => {
    let raw = input;
    if (typeof raw === 'string') {
        try {
            raw = JSON.parse(raw);
        } catch (e) {
            return [];
        }
    }
    if (!Array.isArray(raw)) return [];
    return raw
        .map((s) => {
            if (typeof s === 'string') {
                return { title: s.trim(), completed: false, note: '' };
            }
            const title = String(s?.title || s?.text || s?.name || '').trim();
            return {
                title,
                completed: !!s?.completed,
                note: String(s?.note || '').trim()
            };
        })
        .filter(s => s.title);
};

const api = {
    auth: localStorage.getItem('auth') || '',
    user: localStorage.getItem('user') || '',
    baseUrl: '',
    useLocalStorage: false,
    holidayJsonUrl: '',
    dataKey: 'glass_todo_data',
    dataVersionKey: 'glass_todo_version',
    checklistKey: 'glass_todo_checklists',
    checklistVersionKey: 'glass_todo_checklists_version',

    setAuth(user, token) {
        this.user = user;
        this.auth = token;
        localStorage.setItem('user', user);
        localStorage.setItem('auth', token);
    },
    loadLocalChecklistData() {
        const raw = localStorage.getItem(this.checklistKey);
        const version = Number(localStorage.getItem(this.checklistVersionKey) || 0);
        if (!raw) return { lists: [], items: {}, version };
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return { lists: [], items: {}, version };
            return {
                lists: Array.isArray(parsed.lists) ? parsed.lists : [],
                items: parsed.items && typeof parsed.items === 'object' ? parsed.items : {},
                columns: parsed.columns && typeof parsed.columns === 'object' ? parsed.columns : {},
                version
            };
        } catch (e) {
            return { lists: [], items: {}, version };
        }
    },

    saveLocalChecklistData(data) {
        const version = Date.now();
        const payload = {
            lists: Array.isArray(data?.lists) ? data.lists : [],
            items: data?.items && typeof data.items === 'object' ? data.items : {},
            columns: data?.columns && typeof data.columns === 'object' ? data.columns : {}
        };
        localStorage.setItem(this.checklistKey, JSON.stringify(payload));
        localStorage.setItem(this.checklistVersionKey, String(version));
        return { success: true, version };
    },

    genLocalId() {
        return Date.now() + Math.floor(Math.random() * 1000);
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

    // Checklists
    async getChecklists() {
        if (this.useLocalStorage) {
            const { lists } = this.loadLocalChecklistData();
            const withOwner = (lists || []).map(l => ({ ...l, owner: l.owner || this.user }));
            return { lists: withOwner };
        }
        const res = await this.request('/api/checklists');
        return await res.json();
    },
    async createChecklist(name) {
        if (this.useLocalStorage) {
            const data = this.loadLocalChecklistData();
            const now = Date.now();
            const id = this.genLocalId();
            const list = { id, name, owner: this.user, createdAt: now, updatedAt: now };
            data.lists.push(list);
            if (!data.items) data.items = {};
            data.items[id] = [];
            this.saveLocalChecklistData(data);
            return { success: true, list };
        }
        const res = await this.request('/api/checklists', 'POST', { name });
        return await res.json();
    },
    async renameChecklist(id, name) {
        if (this.useLocalStorage) {
            const data = this.loadLocalChecklistData();
            const idx = data.lists.findIndex(l => Number(l.id) === Number(id));
            if (idx === -1) return { success: false, error: 'Not found' };
            data.lists[idx] = { ...data.lists[idx], name, updatedAt: Date.now() };
            this.saveLocalChecklistData(data);
            return { success: true, list: data.lists[idx] };
        }
        const res = await this.request(`/api/checklists/${id}`, 'PATCH', { name });
        return await res.json();
    },
    async getChecklistItems(listId) {
        if (this.useLocalStorage) {
            const data = this.loadLocalChecklistData();
            const items = data.items?.[listId] || data.items?.[String(listId)] || [];
            return { items };
        }
        const res = await this.request(`/api/checklists/${listId}/items`);
        return await res.json();
    },
    async getChecklistColumns(listId) {
        if (this.useLocalStorage) {
            const data = this.loadLocalChecklistData();
            const cols = data.columns?.[listId] || data.columns?.[String(listId)] || [];
            return { columns: cols };
        }
        const res = await this.request(`/api/checklists/${listId}/columns`);
        return await res.json();
    },
    async createChecklistColumn(listId, name) {
        if (this.useLocalStorage) {
            const data = this.loadLocalChecklistData();
            const colsMap = data.columns && typeof data.columns === 'object' ? data.columns : {};
            const key = colsMap[listId] ? listId : String(listId);
            const cols = colsMap[key] || [];
            const now = Date.now();
            const col = { id: this.genLocalId(), listId, name, sortOrder: cols.length, createdAt: now, updatedAt: now };
            data.columns = { ...colsMap, [key]: [...cols, col] };
            this.saveLocalChecklistData(data);
            return { success: true, column: col };
        }
        const res = await this.request(`/api/checklists/${listId}/columns`, 'POST', { name });
        return await res.json();
    },
    async renameChecklistColumn(listId, columnId, name) {
        if (this.useLocalStorage) {
            const data = this.loadLocalChecklistData();
            const colsMap = data.columns && typeof data.columns === 'object' ? data.columns : {};
            const key = colsMap[listId] ? listId : String(listId);
            const cols = colsMap[key] || [];
            const idx = cols.findIndex(c => Number(c.id) === Number(columnId));
            if (idx === -1) return { success: false, error: 'Not found' };
            const updated = { ...cols[idx], name, updatedAt: Date.now() };
            const nextCols = cols.slice();
            nextCols[idx] = updated;
            data.columns = { ...colsMap, [key]: nextCols };
            this.saveLocalChecklistData(data);
            return { success: true, column: updated };
        }
        const res = await this.request(`/api/checklists/${listId}/columns/${columnId}`, 'PATCH', { name });
        return await res.json();
    },
    async deleteChecklistColumn(listId, columnId) {
        if (this.useLocalStorage) {
            const data = this.loadLocalChecklistData();
            const colsMap = data.columns && typeof data.columns === 'object' ? data.columns : {};
            const key = colsMap[listId] ? listId : String(listId);
            const cols = colsMap[key] || [];
            const nextCols = cols.filter(c => Number(c.id) !== Number(columnId));
            data.columns = { ...colsMap, [key]: nextCols };
            const itemsMap = data.items && typeof data.items === 'object' ? data.items : {};
            const itemsKey = itemsMap[listId] ? listId : String(listId);
            const items = itemsMap[itemsKey] || [];
            const fallbackId = nextCols[0]?.id ?? null;
            data.items = { ...itemsMap, [itemsKey]: items.map(i => i.columnId === columnId ? { ...i, columnId: fallbackId } : i) };
            this.saveLocalChecklistData(data);
            return { success: true, fallbackColumnId: fallbackId };
        }
        const res = await this.request(`/api/checklists/${listId}/columns/${columnId}`, 'DELETE');
        return await res.json();
    },
    async createChecklistItem(listId, title, columnId = null, subtasks = [], notes = '') {
        if (this.useLocalStorage) {
            const data = this.loadLocalChecklistData();
            const itemsMap = data.items && typeof data.items === 'object' ? data.items : {};
            const key = itemsMap[listId] ? listId : String(listId);
            const items = itemsMap[key] || [];
            const now = Date.now();
            const safeSubtasks = normalizeChecklistSubtasks(subtasks);
            const allDone = safeSubtasks.length ? safeSubtasks.every(s => s.completed) : false;
            const item = {
                id: this.genLocalId(),
                listId,
                columnId,
                title,
                completed: allDone,
                completedBy: allDone ? this.user : '',
                notes: String(notes || '').trim(),
                subtasks: safeSubtasks,
                createdAt: now,
                updatedAt: now
            };
            const nextItems = [...items, item];
            data.items = { ...itemsMap, [key]: nextItems };
            this.saveLocalChecklistData(data);
            return { success: true, item };
        }
        const res = await this.request(`/api/checklists/${listId}/items`, 'POST', { title, columnId, subtasks, notes });
        return await res.json();
    },
    async updateChecklistItem(listId, itemId, payload) {
        if (this.useLocalStorage) {
            const data = this.loadLocalChecklistData();
            const itemsMap = data.items && typeof data.items === 'object' ? data.items : {};
            const key = itemsMap[listId] ? listId : String(listId);
            const items = itemsMap[key] || [];
            const idx = items.findIndex(i => Number(i.id) === Number(itemId));
            if (idx === -1) return { success: false, error: 'Not found' };
            const base = items[idx];
            const rawSubtasks = payload.subtasks !== undefined ? payload.subtasks : base.subtasks;
            const nextSubtasks = normalizeChecklistSubtasks(rawSubtasks);
            let nextCompleted = typeof payload.completed === 'boolean' ? payload.completed : base.completed;
            if (payload.completed !== undefined && Array.isArray(nextSubtasks) && nextSubtasks.length) {
                nextSubtasks.forEach(s => { s.completed = !!payload.completed; });
            } else if (payload.subtasks !== undefined && Array.isArray(nextSubtasks) && nextSubtasks.length && payload.completed === undefined) {
                nextCompleted = nextSubtasks.every(s => s.completed);
            }
            const updated = {
                ...base,
                title: payload.title !== undefined ? payload.title : base.title,
                completed: nextCompleted,
                completedBy: typeof payload.completed === 'boolean'
                    ? (payload.completed ? this.user : '')
                    : (nextCompleted ? this.user : base.completedBy || ''),
                columnId: payload.columnId !== undefined ? payload.columnId : base.columnId,
                notes: payload.notes !== undefined ? String(payload.notes || '').trim() : (base.notes || ''),
                subtasks: nextSubtasks,
                updatedAt: Date.now()
            };
            const nextItems = items.slice();
            nextItems[idx] = updated;
            data.items = { ...itemsMap, [key]: nextItems };
            this.saveLocalChecklistData(data);
            return { success: true, item: updated };
        }
        const body = {};
        if (payload.title !== undefined) body.title = payload.title;
        if (payload.completed !== undefined) body.completed = payload.completed;
        if (payload.columnId !== undefined) body.columnId = payload.columnId;
        if (payload.subtasks !== undefined) body.subtasks = payload.subtasks;
        if (payload.notes !== undefined) body.notes = payload.notes;
        const res = await this.request(`/api/checklists/${listId}/items/${itemId}`, 'PATCH', body);
        return await res.json();
    },
    async deleteChecklistItem(listId, itemId) {
        if (this.useLocalStorage) {
            const data = this.loadLocalChecklistData();
            const itemsMap = data.items && typeof data.items === 'object' ? data.items : {};
            const key = itemsMap[listId] ? listId : String(listId);
            const items = itemsMap[key] || [];
            data.items = { ...itemsMap, [key]: items.filter(i => Number(i.id) !== Number(itemId)) };
            this.saveLocalChecklistData(data);
            return { success: true };
        }
        const res = await this.request(`/api/checklists/${listId}/items/${itemId}`, 'DELETE');
        return await res.json();
    },
    async getChecklistShares(listId) {
        if (this.useLocalStorage) return { shared: [], owner: this.user };
        const res = await this.request(`/api/checklists/${listId}/shares`);
        return await res.json();
    },
    async addChecklistShare(listId, user, payload = {}) {
        if (this.useLocalStorage) return { success: false, error: '本地模式不支持共享' };
        const body = { user };
        if (typeof payload.canEdit === 'boolean') body.canEdit = payload.canEdit;
        const res = await this.request(`/api/checklists/${listId}/shares`, 'POST', body);
        return await res.json();
    },
    async deleteChecklistShare(listId, user) {
        if (this.useLocalStorage) return { success: false, error: '本地模式不支持共享' };
        const res = await this.request(`/api/checklists/${listId}/shares/${encodeURIComponent(user)}`, 'DELETE');
        return await res.json();
    },
    async deleteChecklist(listId) {
        if (this.useLocalStorage) return { success: false, error: '本地模式不支持删除清单' };
        const res = await this.request(`/api/checklists/${listId}`, 'DELETE');
        return await res.json();
    },
    async updateChecklistShare(listId, user, payload = {}) {
        if (this.useLocalStorage) return { success: false, error: '本地模式不支持共享' };
        const body = {};
        if (typeof payload.canEdit === 'boolean') body.canEdit = payload.canEdit;
        const res = await this.request(`/api/checklists/${listId}/shares/${encodeURIComponent(user)}`, 'PATCH', body);
        return await res.json();
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
