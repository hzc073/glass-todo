export default class CalendarView {
    constructor(app) {
        this.app = app; // 持有主程序引用以访问数据
        this.mode = 'day'; // day, week, month
        this.settings = (this.app && this.app.calendarSettings) || { showTime: true, showTags: true, showLunar: true, showHoliday: true };
        this.resizing = null;
        this.clickTimer = null;

        // 绑定拖拽事件监听
        window.addEventListener('mousemove', (e) => this.handleResizeMove(e));
        window.addEventListener('mouseup', () => this.handleResizeEnd());
    }

    // --- 初始化控件 (跳转今天, 设置面板) ---
    initControls() {
        const calHeader = document.querySelector('#view-calendar > div');
        if (!calHeader) return;

        // 1. 跳转今天按钮
        if (!calHeader.querySelector('.btn-today-jump')) {
            const btn = document.createElement('button');
            btn.className = 'btn-sm btn-secondary btn-today-jump'; // CSS中已优化样式
            btn.innerText = '今';
            btn.style.marginLeft = '10px';
            btn.onclick = () => this.jumpToday();
            calHeader.appendChild(btn);
        }

        // 2. 设置按钮
        if (!document.getElementById('cal-settings-container')) {
            const container = document.createElement('div');
            container.id = 'cal-settings-container';
            container.style.position = 'relative';
            container.style.display = 'inline-block';
            container.innerHTML = `
                <button id="btn-cal-settings" class="btn-text" style="font-size:1.2rem; margin-left:10px;">⚙️</button>
                <span class="help-icon" title="操作提示：单击编辑任务块，双击完成任务块，任务块可自由拖拽。">?</span>
                <div id="cal-settings-panel">
                    <div style="font-weight:bold; margin-bottom:10px; color:#333; font-size:0.9rem;">日历显示设置</div>
                    <div class="cal-setting-item" data-key="showTime">
                        <span>显示时间</span>
                        <div class="toggle-switch ${this.settings.showTime?'active':''}" id="switch-showTime"></div>
                    </div>
                    <div class="cal-setting-item" data-key="showTags">
                        <span>显示标签</span>
                        <div class="toggle-switch ${this.settings.showTags?'active':''}" id="switch-showTags"></div>
                    </div>
                    <div class="cal-setting-item" data-key="showLunar">
                        <span>显示农历</span>
                        <div class="toggle-switch ${this.settings.showLunar?'active':''}" id="switch-showLunar"></div>
                    </div>
                    <div class="cal-setting-item" data-key="showHoliday">
                        <span>显示节假日</span>
                        <div class="toggle-switch ${this.settings.showHoliday?'active':''}" id="switch-showHoliday"></div>
                    </div>
                </div>
            `;
            calHeader.appendChild(container);

            // 绑定事件
            const btn = document.getElementById('btn-cal-settings');
            const panel = document.getElementById('cal-settings-panel');
            btn.onclick = (e) => { e.stopPropagation(); panel.classList.toggle('show'); };
            
            container.querySelectorAll('.cal-setting-item').forEach(item => {
                item.onclick = (e) => {
                    e.stopPropagation();
                    this.toggleSetting(item.dataset.key);
                };
            });

            document.addEventListener('click', (e) => {
                if(panel.classList.contains('show') && !container.contains(e.target)) panel.classList.remove('show');
            });
        }
    }

    toggleSetting(key) {
        this.settings[key] = !this.settings[key];
        if (this.app && typeof this.app.updateCalendarSettings === 'function') {
            this.app.updateCalendarSettings(this.settings);
        }
        
        const switchEl = document.getElementById('switch-'+key);
        if(switchEl) switchEl.classList.toggle('active', this.settings[key]);
        this.render();
    }


    setSettings(nextSettings) {
        this.settings = { ...this.settings, ...(nextSettings || {}) };
        this.updateSettingsUI();
        this.render();
    }

    updateSettingsUI() {
        ['showTime', 'showTags', 'showLunar', 'showHoliday'].forEach((key) => {
            const switchEl = document.getElementById('switch-' + key);
            if (switchEl) switchEl.classList.toggle('active', !!this.settings[key]);
        });
    }

    setMode(mode) {
        this.mode = mode;
        document.querySelectorAll('.view-switch-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
        document.getElementById('cal-day-view').style.display = mode === 'day' ? 'block' : 'none';
        document.getElementById('cal-week-view').style.display = mode === 'week' ? 'flex' : 'none';
        document.getElementById('cal-month-view').style.display = mode === 'month' ? 'block' : 'none';
        this.render();
    }

    jumpToday() {
        this.app.currentDate = new Date();
        this.app.render(); // 通知 App 重新渲染 (会调用 this.render)
    }

    changeDate(off) {
        const d = this.app.currentDate;
        if(this.mode === 'month') d.setMonth(d.getMonth() + off);
        else if(this.mode === 'week') d.setDate(d.getDate() + off * 7);
        else d.setDate(d.getDate() + off);
        this.app.render();
    }

    // --- 核心渲染 ---
    render() {
        // 更新日期显示
        const dStr = this.app.formatDate(this.app.currentDate);
        const el = document.getElementById('cal-date-display');
        if(el) {
            el.innerText = dStr;
            el.style.cursor = 'pointer';
            el.onclick = () => this.openDatePicker(dStr);
        }
        if (this.settings.showHoliday) this.app.ensureHolidayYear(this.app.currentDate.getFullYear());
        const lunarText = this.settings.showLunar ? this.app.getLunarText(this.app.currentDate) : '';
        const lunarEl = document.getElementById('cal-lunar-display');
        if (lunarEl) lunarEl.innerText = lunarText ? `农历 ${lunarText}` : '';
        const holiday = this.settings.showHoliday ? this.app.getHolidayForDate(dStr) : null;
        const holidayEl = document.getElementById('cal-holiday-display');
        if (holidayEl) {
            if (holiday) {
                const flag = holiday.isOffDay ? '休' : '班';
                holidayEl.innerHTML = `<span class="holiday-tag ${holiday.isOffDay ? 'off' : 'work'}">${holiday.name}·${flag}</span>`;
            } else {
                holidayEl.innerText = '';
            }
        }

        const tasks = this.app.getFilteredData();

        if (this.mode === 'day') this.renderTimeline(tasks, dStr);
        if (this.mode === 'week') this.renderWeek(tasks);
        if (this.mode === 'month') this.renderMonth(tasks);
    }

    renderTimeline(tasks, dateStr) {
        const dayTasks = tasks.filter(t => t.date === dateStr);
        
        // 全天任务
        document.getElementById('cal-allday-list').innerHTML = dayTasks.filter(t => !t.start).map(t => 
            `<div class="task-card btn-sm ${t.status}" style="display:inline-block; margin:2px; cursor:grab;" draggable="true" ondragstart="app.drag(event, ${t.id})" ondragend="app.finishDrag()" onclick="app.handleCardClick(event, ${t.id})">${t.title}</div>`
        ).join('');

        const container = document.getElementById('day-timeline');
        if (container && !container.dataset.clickBind) {
            container.addEventListener('click', (ev) => {
                if (ev.target.closest('.time-slot')) return;
                const viewContainer = container.closest('.view-container');
                const scrollTop = viewContainer ? viewContainer.scrollTop : 0;
                const minutes = this.getMinutesFromEvent(container, ev, scrollTop);
                const dStr = this.app.formatDate(this.app.currentDate);
                this.createTaskAtTime(dStr, minutes);
            });
            container.dataset.clickBind = 'true';
        }
        // 清理旧元素保留尺子
        Array.from(container.children).forEach(c => { 
            if(!c.classList.contains('time-ruler') && c.id !== 'ghost-line') c.remove(); 
        });

        // 时间轴任务
        dayTasks.filter(t => t.start).forEach(t => {
            const startMin = this.app.timeToMinutes(t.start);
            let height = 60;
            if(t.end) height = this.app.timeToMinutes(t.end) - startMin;
            
            const isCompact = height < 35;
            const compactClass = isCompact ? 'is-compact' : '';

            const div = document.createElement('div');
            div.className = `time-slot ${t.status} ${compactClass}`;
            div.setAttribute('data-id', t.id);
            div.setAttribute('draggable', 'true');
            div.ondragstart = (ev) => this.app.drag(ev, t.id);
            div.ondragend = () => this.app.finishDrag();
            
            div.style.top = startMin + 'px';
            div.style.height = Math.max(15, height) + 'px';
            div.style.borderLeftColor = this.app.getQuadrantLightColor(t.quadrant);
            
            const timeLabel = this.settings.showTime && t.start ? `${t.start}${t.end ? `-${t.end}` : ''}` : '';
            const inlineTagHtml = this.settings.showTags && t.tags && t.tags.length
                ? t.tags.map((tag) => {
                    const color = this.app.getTagTextColor(tag);
                    return `<span class="time-tag" style="color:${color}">#${tag}</span>`;
                }).join(' ')
                : '';
            const inlineMeta = `${timeLabel ? ` <span class="time-chip small">${timeLabel}</span>` : ''}${inlineTagHtml ? ` ${inlineTagHtml}` : ''}`;
            const titleHtml = `<div class="task-title-text" style="font-size:0.8rem; overflow:hidden; text-overflow:ellipsis; font-weight:500;">${t.title}${inlineMeta}</div>`;

            div.innerHTML = `
                <div class="resize-handle top" onmousedown="app.calendar.handleResizeStart(event, ${t.id}, 'top')"></div>
                <div class="time-slot-content">
                    ${titleHtml}
                </div>
                <div class="resize-handle bottom" onmousedown="app.calendar.handleResizeStart(event, ${t.id}, 'bottom')"></div>
            `;
            div.onclick = (e) => { e.stopPropagation(); this.handleCalendarClick(e, t.id); };
            div.ondblclick = (e) => { e.stopPropagation(); this.handleCalendarDblClick(e, t.id); };
            container.appendChild(div);
        });
    }

    renderWeek(tasks) {
        const headerRow = document.getElementById('week-header-row');
        const daysEl = document.getElementById('week-days');
        if (!headerRow || !daysEl) return;
        headerRow.innerHTML = '';
        daysEl.innerHTML = '';
        const headerTime = document.createElement('div');
        headerTime.className = 'week-header-time';
        const headerScroll = document.createElement('div');
        headerScroll.className = 'week-header-scroll';
        const headerDays = document.createElement('div');
        headerDays.className = 'week-header-days';
        headerScroll.appendChild(headerDays);
        headerRow.appendChild(headerTime);
        headerRow.appendChild(headerScroll);

        const weekTimeline = document.getElementById('week-timeline');
        if (weekTimeline) {
            weekTimeline.onscroll = () => {
                headerScroll.scrollLeft = weekTimeline.scrollLeft;
            };
            headerScroll.scrollLeft = weekTimeline.scrollLeft;
        }
        const start = new Date(this.app.currentDate);
        start.setDate(start.getDate() - start.getDay());
        
        for(let i=0; i<7; i++) {
            const d = new Date(start); d.setDate(d.getDate() + i);
            const dStr = this.app.formatDate(d);
            const isToday = dStr === this.app.formatDate(new Date());
            const lunarText = this.settings.showLunar ? this.app.getLunarText(d) : '';
            const holiday = this.settings.showHoliday ? this.app.getHolidayForDate(dStr) : null;
            const holidayHtml = holiday
                ? `<div class="holiday-tag ${holiday.isOffDay ? 'off' : 'work'}">${holiday.name}${holiday.isOffDay ? '' : '·班'}</div>`
                : `<div class="holiday-tag placeholder"></div>`;

            const headerCell = document.createElement('div');
            headerCell.className = 'week-header-cell';
            if (isToday) headerCell.style.cssText = 'background:rgba(0,122,255,0.1);color:var(--primary);';
            headerCell.innerHTML = `
                <div>${['日','一','二','三','四','五','六'][i]}</div>
                <div style="font-weight:bold">${d.getDate()}</div>
                ${lunarText ? `<div class="lunar-text">${lunarText}</div>` : ''}
                ${holidayHtml}
            `;
            headerCell.setAttribute('ondragover', 'app.allowDrop(event)');
            headerCell.setAttribute('ondrop', `app.dropOnDate(event, '${dStr}')`);
            headerCell.setAttribute('ondragleave', 'app.leaveDrop(event)');
            headerCell.addEventListener('click', () => this.app.openModal(null, dStr));

            const allDayTasks = tasks.filter(t => t.date === dStr && !t.start);
            if (allDayTasks.length) {
                const list = document.createElement('div');
                list.className = 'week-allday-list';
                allDayTasks.forEach((t) => {
                    const item = document.createElement('div');
                    item.className = `week-allday-item ${t.status}`;
                    item.textContent = t.title;
                    item.draggable = true;
                    item.ondragstart = (ev) => this.app.drag(ev, t.id);
                    item.ondragend = () => this.app.finishDrag();
                    item.onclick = (ev) => { ev.stopPropagation(); this.handleCalendarClick(ev, t.id); };
                    item.ondblclick = (ev) => { ev.stopPropagation(); this.handleCalendarDblClick(ev, t.id); };
                    list.appendChild(item);
                });
                headerCell.appendChild(list);
            }
            headerDays.appendChild(headerCell);

            const col = document.createElement('div');
            col.className = 'week-day-column';
            col.setAttribute('ondragover', 'app.allowDrop(event)');
            col.setAttribute('ondrop', `app.dropOnDate(event, '${dStr}')`);
            col.setAttribute('ondragleave', 'app.leaveDrop(event)');
            col.addEventListener('click', (ev) => {
                if (ev.target.closest('.week-time-slot')) return;
                if (ev.target.closest('.week-allday-item')) return;
                const weekTimeline = document.getElementById('week-timeline');
                const scrollTop = weekTimeline ? weekTimeline.scrollTop : 0;
                const minutes = this.getMinutesFromEvent(weekTimeline || col, ev, scrollTop);
                this.createTaskAtTime(dStr, minutes);
            });

            const timedTasks = tasks
                .filter(t => t.date === dStr && t.start)
                .map(t => {
                    const startMin = this.app.timeToMinutes(t.start);
                    const endMin = t.end ? this.app.timeToMinutes(t.end) : startMin + 60;
                    return { task: t, startMin, endMin: Math.max(startMin + 15, Math.min(1439, endMin)) };
                })
                .sort((a, b) => a.startMin - b.startMin);

            const lanes = [];
            let maxLanes = 1;
            timedTasks.forEach((item) => {
                let laneIndex = lanes.findIndex(endMin => endMin <= item.startMin);
                if (laneIndex === -1) {
                    laneIndex = lanes.length;
                    lanes.push(item.endMin);
                } else {
                    lanes[laneIndex] = item.endMin;
                }
                item.laneIndex = laneIndex;
                maxLanes = Math.max(maxLanes, lanes.length);
            });

            timedTasks.forEach((item) => {
                const t = item.task;
                const height = Math.max(15, item.endMin - item.startMin);
                const isCompact = height < 32;
                const slot = document.createElement('div');
                slot.className = `week-time-slot ${t.status} ${isCompact ? 'is-compact' : ''}`;
                slot.style.top = item.startMin + 'px';
                slot.style.height = height + 'px';
                slot.style.borderLeftColor = this.app.getQuadrantLightColor(t.quadrant);

                const widthPercent = 100 / maxLanes;
                const leftPercent = item.laneIndex * widthPercent;
                slot.style.left = `calc(${leftPercent}% + 4px)`;
                slot.style.width = `calc(${widthPercent}% - 8px)`;

                const timeLabel = this.settings.showTime && t.start ? `${t.start}${t.end ? `-${t.end}` : ''}` : '';
                const inlineTagHtml = this.settings.showTags && t.tags && t.tags.length
                    ? t.tags.map((tag) => {
                        const color = this.app.getTagTextColor(tag);
                        return `<span class="week-inline-tag" style="color:${color}">#${tag}</span>`;
                    }).join(' ')
                    : '';
                const inlineMeta = `${timeLabel ? ` <span class="time-chip small">${timeLabel}</span>` : ''}${inlineTagHtml ? ` ${inlineTagHtml}` : ''}`;
                const titleHtml = `<div class="task-title-text">${t.title}${inlineMeta}</div>`;

                slot.innerHTML = `<div class="week-slot-content">${titleHtml}</div>`;
                slot.draggable = true;
                slot.ondragstart = (ev) => this.app.drag(ev, t.id);
                slot.ondragend = () => this.app.finishDrag();
                slot.onclick = (ev) => { ev.stopPropagation(); this.handleCalendarClick(ev, t.id); };
                slot.ondblclick = (ev) => { ev.stopPropagation(); this.handleCalendarDblClick(ev, t.id); };
                col.appendChild(slot);
            });

            daysEl.appendChild(col);
        }
    }

    renderMonth(tasks) {
        const grid = document.getElementById('month-grid');
        grid.innerHTML = '';
        const y = this.app.currentDate.getFullYear(), m = this.app.currentDate.getMonth();
        const daysInMonth = new Date(y, m+1, 0).getDate();
        const firstDay = new Date(y, m, 1).getDay();
        
        for(let i=0; i<firstDay; i++) grid.innerHTML += '<div class="month-cell"></div>';
        for(let d=1; d<=daysInMonth; d++) {
            const dStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
            const cell = document.createElement('div');
            cell.className = 'month-cell' + (dStr === this.app.formatDate(new Date()) ? ' today' : '');
            const holiday = this.settings.showHoliday ? this.app.getHolidayForDate(dStr) : null;
            const lunarText = this.settings.showLunar ? this.app.getLunarText(new Date(y, m, d)) : '';
            if (holiday) {
                cell.classList.add(holiday.isOffDay ? 'holiday-off' : 'holiday-work');
            }
            const holidayHtml = holiday ? `<span class="holiday-tag ${holiday.isOffDay ? 'off' : 'work'}">${holiday.name}${holiday.isOffDay ? '' : '·班'}</span>` : '';
            
            cell.setAttribute('ondragover', 'app.allowDrop(event)');
            cell.setAttribute('ondrop', `app.dropOnDate(event, '${dStr}')`);
            cell.setAttribute('ondragleave', 'app.leaveDrop(event)');
            
            cell.onclick = () => { this.app.currentDate = new Date(y,m,d); this.setMode('day'); };
            cell.innerHTML = `
                <div class="month-cell-header">
                    <div style="font-weight:bold; font-size:0.8rem;">${d}</div>
                    ${holidayHtml}
                </div>
                ${lunarText ? `<div class="lunar-text">${lunarText}</div>` : ''}
            `;
            
            tasks.filter(t=>t.date===dStr).slice(0,4).forEach(t => {
                const showTags = this.settings.showTags && t.tags && t.tags.length;
                const tagText = showTags
                    ? ` <span class="month-tag" style="color:${this.app.getTagTextColor(t.tags[0])}">#${t.tags[0]}</span>`
                    : '';
                const timeText = this.settings.showTime && t.start ? `${t.start}${t.end ? `-${t.end}` : ''}` : '';
                const timeHtml = timeText ? `<span class="month-time">${timeText}</span>` : '';
                const qColor = this.app.getQuadrantLightColor(t.quadrant);
                cell.innerHTML += `<div class="month-task-pill ${t.status}" style="background:${qColor}; border:1px solid rgba(0,0,0,0.1);" draggable="true" ondragstart="app.drag(event, ${t.id})" ondragend="app.finishDrag()" onclick="app.handleMonthTaskClick(event, ${t.id})" ondblclick="app.handleMonthTaskDblClick(event, ${t.id})">${timeHtml}${t.title}${tagText}</div>`;
            });
            grid.appendChild(cell);
        }
    }

    openDatePicker(current) {
        let picker = document.getElementById('calendar-date-picker-hidden');
        if (!picker) {
            picker = document.createElement('input');
            picker.type = 'date';
            picker.id = 'calendar-date-picker-hidden';
            picker.style.position = 'absolute';
            picker.style.opacity = '0.01';
            picker.style.zIndex = '2000';
            document.body.appendChild(picker);
        }
        picker.value = current;
        const target = document.getElementById('cal-date-display');
        if (target) {
            const rect = target.getBoundingClientRect();
            picker.style.left = `${rect.left + window.scrollX}px`;
            picker.style.top = `${rect.bottom + window.scrollY + 4}px`;
        } else {
            picker.style.left = `0px`;
            picker.style.top = `0px`;
        }
        picker.onchange = () => {
            const v = picker.value;
            if (v) {
                const [y,m,d] = v.split('-').map(Number);
                this.app.currentDate = new Date(y, m-1, d);
                this.app.render();
            }
        };
        if (picker.showPicker) picker.showPicker();
        else { picker.focus(); picker.click(); }
    }

    renderRuler() {
        const hourHtml = Array.from({length:24}, (_,i) => `<div class="hour-mark">${i}:00</div>`).join('');
        const ruler = document.getElementById('time-ruler');
        if (ruler) ruler.innerHTML = hourHtml;
        const weekRuler = document.getElementById('week-time-ruler');
        if (weekRuler) weekRuler.innerHTML = hourHtml;
    }

    // --- 交互逻辑 (Timeline Drop & Resize) ---
    
    handleDropOnTimeline(ev) {
        ev.preventDefault();
        const id = parseInt(ev.dataTransfer.getData("text"));
        const t = this.app.data.find(i => i.id === id);
        document.querySelector('.dragging')?.classList.remove('dragging');
        
        if (t) {
            this.app.queueUndo('已调整时间');
            const rect = ev.currentTarget.getBoundingClientRect();
            const scrollTop = ev.currentTarget.scrollTop || 0;
            const minutes = Math.floor(ev.clientY - rect.top + scrollTop);
            const h = Math.floor(minutes / 60);
            const m = Math.floor((minutes % 60) / 15) * 15;

            // 保留时长
            let duration = 60; 
            if (t.start && t.end) {
                duration = Math.max(15, this.app.timeToMinutes(t.end) - this.app.timeToMinutes(t.start));
            }

            const safeH = Math.min(23, Math.max(0, h));
            const newStartMins = safeH * 60 + m;
            
            t.start = this.app.minutesToTime(newStartMins);
            t.end = this.app.minutesToTime(Math.min(1439, newStartMins + duration));
            
            this.app.saveData();
            this.app.render();
            this.app.showToast(`已移动到 ${t.start}`);
        }
    }

    clampMinutes(val) { return Math.max(0, Math.min(1439, val)); }
    snapToQuarter(val) { return Math.round(val / 15) * 15; }
    getMinutesFromEvent(container, ev, scrollTop = 0) {
        const rect = container.getBoundingClientRect();
        const offsetY = ev.clientY - rect.top + scrollTop;
        return this.snapToQuarter(this.clampMinutes(Math.floor(offsetY)));
    }

    createTaskAtTime(dateStr, minutes) {
        this.app.openModal(null, dateStr);
        const start = this.app.minutesToTime(minutes);
        const startEl = document.getElementById('task-start');
        if (startEl) startEl.value = start;
    }

    handleResizeStart(e, id, direction) {
        if(this.app.isSelectionMode) return;
        e.preventDefault(); e.stopPropagation();
        const t = this.app.data.find(i => i.id === id);
        if(!t) return;
        
        const div = e.target.closest('.time-slot');
        const startMin = this.app.timeToMinutes(t.start);
        const endMin = t.end ? this.app.timeToMinutes(t.end) : startMin + 60;
        this.resizing = {
            id, direction, startY: e.clientY,
            startTop: parseInt(div.style.top),
            startHeight: parseInt(div.style.height),
            startMin,
            endMin,
            updatedStart: startMin,
            updatedEnd: endMin
        };
        document.getElementById('ghost-line').style.display = 'block';
    }

    handleResizeMove(e) {
        if(!this.resizing) return;
        e.preventDefault();
        const delta = e.clientY - this.resizing.startY;
        const snappedDelta = this.snapToQuarter(delta);
        const ghost = document.getElementById('ghost-line');
        const div = document.querySelector(`.time-slot[data-id="${this.resizing.id}"]`);
        
        let displayTime;
        if(this.resizing.direction === 'bottom') {
            let newEnd = this.clampMinutes(this.resizing.startMin + this.resizing.startHeight + snappedDelta);
            newEnd = Math.max(newEnd, this.resizing.startMin + 15);
            const newH = newEnd - this.resizing.startMin;
            div.style.height = newH + 'px';
            ghost.style.top = (this.resizing.startTop + newH) + 'px';
            displayTime = this.app.minutesToTime(newEnd);
            this.resizing.updatedEnd = newEnd;
        } else {
            let newStart = this.clampMinutes(this.resizing.startMin + snappedDelta);
            newStart = Math.min(newStart, this.resizing.endMin - 15);
            const newH = this.resizing.endMin - newStart;
            div.style.top = newStart + 'px';
            div.style.height = newH + 'px';
            ghost.style.top = newStart + 'px';
            displayTime = this.app.minutesToTime(newStart);
            this.resizing.updatedStart = newStart;
        }
        ghost.setAttribute('data-time', displayTime);
        this.resizing.currentDisplayTime = displayTime;
    }

    handleResizeEnd() {
        if(!this.resizing) return;
        const t = this.app.data.find(i => i.id === this.resizing.id);
        if(t) {
            this.app.queueUndo('已调整时间');
            const startMin = this.resizing.updatedStart ?? this.resizing.startMin;
            const endMin = this.resizing.updatedEnd ?? this.resizing.endMin;
            t.start = this.app.minutesToTime(startMin);
            t.end = this.app.minutesToTime(endMin);
            this.app.saveData();
            this.app.render();
        }
        this.resizing = null;
        document.getElementById('ghost-line').style.display = 'none';
    }

    handleCalendarClick(e, id) {
        if (this.clickTimer) clearTimeout(this.clickTimer);
        this.clickTimer = setTimeout(() => {
            this.app.handleCardClick(e, id);
            this.clickTimer = null;
        }, 200);
    }
    handleCalendarDblClick(e, id) {
        if (this.clickTimer) {
            clearTimeout(this.clickTimer);
            this.clickTimer = null;
        }
        this.app.toggleTask(id);
    }
}
