/* The collaborative form keeps its editors mounted while the server state changes. */
(function (global) {
  'use strict';

  const endpoint = '/api/weekly-collaboration/';
  const remoteUpdate = Symbol('server update');
  const statusMessages = {
    unconfigured: '本周还未指定提交负责人，请联系管理员。',
    submitter_unavailable: '本周负责人当前没有填报权限，请联系管理员核对。',
    missing_plan: '请由本周负责人先在本期填报确认当月计划。',
    legacy_report: '本周已有个人周报，请在历史记录查看。',
    plan_changed: '确认月计划已变化，协同编制已暂停，请联系管理员核对。',
    published: '本周专业周报已提交。'
  };
  let mounted;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'})[char]);
  }

  async function request(action, body, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal && signal.aborted) abort();
    else if (signal) signal.addEventListener('abort', abort, {once:true});
    const timeout = setTimeout(abort, 25000);
    try {
      const response = await fetch(endpoint + action, {
        method:'POST', credentials:'same-origin', signal:controller.signal,
        headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
      });
      const result = await response.json();
      if (!response.ok || result.error) {
        const message = result.error && result.error.message;
        throw Object.assign(new Error(message || '服务器未能完成请求。'), {status:response.status});
      }
      return result.data;
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }

  function encoded(bytes) {
    let value = '';
    for (let index = 0; index < bytes.length; index += 8192) value += String.fromCharCode(...bytes.subarray(index, index + 8192));
    return btoa(value);
  }

  function decoded(value) {
    return Uint8Array.from(atob(value), char => char.charCodeAt(0));
  }

  function uuid() {
    // Some supported deployments use HTTP on a trusted network, where randomUUID is absent.
    if (global.crypto.randomUUID) return global.crypto.randomUUID();
    const bytes = global.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join('-');
  }

  function period(week) {
    const end = global.PlanningWindows.addDays(week, 6);
    return week + ' 至 ' + end;
  }

  function planField(plan, field, item, index) {
    const path = 'items.' + index + '.' + field;
    const doc = plan.rich_text && plan.rich_text.fields && plan.rich_text.fields[path];
    return doc && global.ZHRichText ? global.ZHRichText.render(doc) : esc(item[field] || '—');
  }

  function settings(root, config) {
    root.innerHTML = '<section class="card collaboration-panel">'
      + '<header><h2>弘坊设计部周报协同设置</h2><p>按报告周指定一位提交负责人。设计部成员可共同填写已确认月计划的周进展和卡点。</p></header>'
      + '<form class="collaboration-settings"><label>报告周起始日（周一）<input type="date" data-weekly-collaboration-week></label>'
      + '<button type="button" class="btn ghost" data-collaboration-load>读取该周</button>'
      + '<label>提交负责人<select data-weekly-collaboration-submitter required></select></label>'
      + '<button type="submit" class="btn primary" data-weekly-collaboration-designate>保存负责人</button></form>'
      + '<p role="status" class="collaboration-status" data-collaboration-status></p></section>';
    const date = root.querySelector('input');
    const select = root.querySelector('select');
    const submit = root.querySelector('[data-weekly-collaboration-designate]');
    const status = root.querySelector('[data-collaboration-status]');
    let state, serial = 0;
    let closed = false;
    const controller = new AbortController();
    date.value = config.week;
    function refreshButton() {
      submit.disabled = !state || !state.can_configure || !select.value || select.value === state.submitter_id;
    }
    async function load(submitterId) {
      const version = ++serial;
      const week = date.value;
      state = null;
      select.disabled = submit.disabled = true;
      if (!week || global.PlanningWindows.periodStart(week) !== week) {
        status.dataset.state = 'error'; status.textContent = '请选择周一作为报告周起始日。'; return;
      }
      status.dataset.state = 'loading'; status.textContent = '正在读取本周协同设置…';
      try {
        const body = submitterId ? {week, submitter_id:submitterId} : {week};
        const next = await request('settings', body, controller.signal);
        if (closed || version !== serial) return;
        state = next;
        select.replaceChildren(new Option('请选择提交负责人', ''));
        for (const person of next.eligible || []) select.append(new Option(person.name, person.user_id));
        select.value = next.submitter_id || '';
        select.disabled = !next.can_configure;
        refreshButton();
        const name = next.submitter_name ? '本周负责人为' + next.submitter_name + '。' : '';
        status.dataset.state = 'saved';
        status.textContent = (submitterId ? '已保存。' : '') + name + (statusMessages[next.status] || '')
          + (!next.can_configure && next.status === 'ready' ? '已有协同进展，负责人已锁定。' : '');
      } catch (error) {
        if (closed || version !== serial) return;
        status.dataset.state = error.status ? 'error' : 'offline';
        status.textContent = error.status ? error.message : '连接中断，请重新读取该周。';
      }
    }
    date.addEventListener('change', () => load());
    select.addEventListener('change', refreshButton);
    root.querySelector('[data-collaboration-load]').addEventListener('click', () => load());
    root.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      if (!submit.disabled) load(select.value);
    });
    load();
    return {root, close() { closed = true; controller.abort(); }, canLeave() { return true; }};
  }

  class Workspace {
    constructor(root, config) {
      this.root = root;
      this.config = config;
      this.state = null;
      this.editors = new Map();
      this.queue = [];
      this.persisted = true;
      this.controller = new AbortController();
      this.online = true;
      this.requestNumber = 0;
      this.acceptedRequest = 0;
      this.onNetwork = () => this.reconnect();
      this.onOffline = () => { this.online = false; this.paint(); };
      this.beforeUnload = event => {
        if (!this.canLeave()) { event.preventDefault(); event.returnValue = ''; }
      };
      global.addEventListener('online', this.onNetwork);
      global.addEventListener('offline', this.onOffline);
      global.addEventListener('beforeunload', this.beforeUnload);
      this.markup();
      this.connect();
    }

    markup() {
      this.root.innerHTML = '<section class="card collaboration-panel" aria-labelledby="collaboration-title">'
        + '<header class="collaboration-header"><div><h2 id="collaboration-title">弘坊设计部协同填报</h2><p>' + esc(period(this.config.week)) + ' · 共同填写当周进展和卡点</p></div>'
        + '<button type="button" class="btn ghost" onclick="App.view(\'form\')">返回本期填报</button></header>'
        + '<div class="collaboration-meta"><span data-collaboration-owner></span><span data-collaboration-presence></span></div>'
        + '<div class="collaboration-statusbar"><p class="collaboration-status" role="status" data-collaboration-status></p>'
        + '<button type="button" class="btn ghost sm" data-collaboration-retry hidden>重试连接</button>'
        + '<button type="button" class="btn ghost sm" data-collaboration-copy hidden>复制未同步内容</button></div>'
        + '<div class="collaboration-toolbar" aria-label="当前单元格文字格式" hidden><button type="button" data-collaboration-format="bold">加粗</button>'
        + '<button type="button" data-collaboration-format="red">标红</button><button type="button" data-collaboration-format="clear">清除格式</button></div>'
        + '<p role="status" class="collaboration-status" data-collaboration-notice hidden></p>'
        + '<div data-collaboration-table></div><p class="collaboration-attachments" data-collaboration-attachments hidden></p><footer class="collaboration-footer" hidden>'
        + '<p data-collaboration-saved-info></p><button type="button" class="btn ghost" data-collaboration-result hidden>查看提交结果</button>'
        + '<button type="button" class="btn primary" data-collaboration-publish hidden>提交专业周报</button></footer></section>';
      const find = selector => this.root.querySelector(selector);
      this.status = find('[data-collaboration-status]');
      this.noticeElement = find('[data-collaboration-notice]');
      this.attachments = find('[data-collaboration-attachments]');
      this.table = find('[data-collaboration-table]');
      this.footer = find('.collaboration-footer');
      this.toolbar = find('.collaboration-toolbar');
      this.publishButton = find('[data-collaboration-publish]');
      this.resultButton = find('[data-collaboration-result]');
      this.retryButton = find('[data-collaboration-retry]');
      this.copyButton = find('[data-collaboration-copy]');
      this.retryButton.addEventListener('click', () => this.reconnect());
      this.copyButton.addEventListener('click', () => this.copyPending());
      this.publishButton.addEventListener('click', () => this.publish());
      this.resultButton.addEventListener('click', () => this.showResult());
      this.toolbar.addEventListener('pointerdown', event => { if (event.target.closest('button')) event.preventDefault(); });
      this.toolbar.addEventListener('click', event => {
        const button = event.target.closest('[data-collaboration-format]');
        if (button) this.format(button.dataset.collaborationFormat);
      });
      this.paint();
    }

    isComposing() { return Array.from(this.editors.values()).some(editor => editor.composing); }

    canLeave() { return !this.publishing && !this.isComposing() && (!this.queue.length || this.persisted); }

    canEdit() { return Boolean(this.state?.can_edit && this.state?.plan?.id === this.planId && !this.publishing && !this.revoked); }

    async connect() {
      if (this.closed || this.connecting) return;
      this.connecting = true;
      const number = ++this.requestNumber;
      try {
        const next = await request('open', {week:this.config.week}, this.controller.signal);
        if (this.closed) return;
        clearTimeout(this.reconnectTimer);
        this.online = true;
        this.error = '';
        this.accept(next, number);
        this.poll();
        this.scheduleSend();
      } catch (error) {
        if (!this.closed) this.failed(error);
      } finally {
        this.connecting = false;
        if (!this.closed) this.paint();
      }
    }

    reconnect() {
      if (this.closed || this.revoked) return;
      this.online = false;
      this.error = '';
      this.writeError = '';
      clearTimeout(this.reconnectTimer);
      if (this.pollController) this.pollController.abort();
      this.connect();
      this.paint();
    }

    failed(error) {
      if (error.status === 401 || error.status === 403) {
        this.revoked = true;
        this.destroyEditors();
        this.table.replaceChildren();
        this.state = null;
        if (this.pollController) this.pollController.abort();
        this.error = '当前账号已无法查看本周协同稿，请重新登录或联系管理员。';
      } else if (!error.status || error.status >= 500 || error.status === 429) {
        this.online = false;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), 1800);
      } else {
        this.error = error.message;
      }
      this.paint();
    }

    async poll() {
      if (this.pollController || this.closed || !this.state || this.revoked) return;
      const controller = new AbortController();
      this.pollController = controller;
      const number = ++this.requestNumber;
      let repeat = true;
      try {
        const {week, revision, cursor} = this.state;
        const next = await request('poll', {week, since_revision:revision, since_cursor:cursor, active_cell:this.activeCell || null}, controller.signal);
        if (this.closed || this.revoked) return;
        this.online = true;
        if (next) this.accept(next, number);
        this.paint();
        this.scheduleSend();
      } catch (error) {
        if (!this.closed && !controller.signal.aborted) { repeat = false; this.failed(error); }
      } finally {
        if (this.pollController === controller) this.pollController = null;
        if (repeat && !this.closed && !this.revoked && !this.connecting) this.poll();
      }
    }

    accept(next, number) {
      if (!next || next.week !== this.config.week || this.revoked) return;
      if (this.state && (next.revision < this.state.revision
        || next.revision === this.state.revision && number < this.acceptedRequest)) return;
      this.acceptedRequest = number;
      this.state = next;
      if (!next.plan && !this.queue.length && this.editors.size) {
        this.destroyEditors();
        this.table.replaceChildren();
        this.planId = null;
      }
      if (next.plan && next.plan.id !== this.planId && !this.queue.length) this.createEditors(next.plan, next.cells || {});
      for (const [cell, editor] of this.editors) {
        if (next.plan?.id === this.planId && next.cells && next.cells[cell] && editor.serverState !== next.cells[cell]) {
          editor.serverState = next.cells[cell];
          if (!editor.composing) this.applyServerUpdate(editor);
        }
      }
      this.paint();
    }

    applyServerUpdate(editor) {
      if (!editor.serverState || editor.appliedState === editor.serverState) return;
      this.vendor.Y.applyUpdate(editor.doc, decoded(editor.serverState), remoteUpdate);
      editor.appliedState = editor.serverState;
    }

    createEditors(plan, cells) {
      this.destroyEditors();
      this.planId = plan.id;
      this.storageKey = 'zh_weekly_collaboration:' + JSON.stringify([this.config.uid, this.config.week, this.planId]);
      this.vendor = global.PlanningCollaborationVendor;
      if (!this.vendor || !global.Quill) throw new Error('协同编辑组件未就绪。');
      const {Y, QuillBinding} = this.vendor;
      const items = Array.isArray(plan.items) ? plan.items : [];
      this.loadQueue(new Set(items.flatMap(item => [item.source_id + ':prog', item.source_id + ':blocker'])));
      this.table.innerHTML = '<div class="tablewrap collaboration-tablewrap"><table class="collaboration-table">'
        + '<colgroup><col class="collaboration-module"><col class="collaboration-task"><col class="collaboration-date"><col><col></colgroup>'
        + '<thead><tr><th scope="col">模块</th><th scope="col">事项</th><th scope="col">完成时间</th><th scope="col">当周进展</th><th scope="col">卡点</th></tr></thead><tbody>'
        + items.map((item,index) => '<tr><td data-label="模块"><div>' + planField(plan, 'mod', item, index) + '</div></td><td data-label="事项"><div>' + planField(plan,'name',item,index)
          + '</div></td><td data-label="完成时间"><div>' + esc(item.due || '—') + '</div></td>'
          + [['prog','当周进展'],['blocker','卡点']].map(([field,label]) => '<td data-label="' + label + '"><div class="collaboration-cell" data-collaboration-cell="'
            + esc(item.source_id + ':' + field) + '" data-editor-label="' + esc(item.name + ' · ' + label) + '"><div data-collaboration-editor></div><small data-collaboration-cell-presence></small></div></td>').join('') + '</tr>').join('')
        + '</tbody></table></div>';
      for (const element of this.table.querySelectorAll('[data-collaboration-cell]')) {
        const cell = element.dataset.collaborationCell;
        const doc = new Y.Doc();
        const text = doc.getText('content');
        const quill = new global.Quill(element.querySelector('[data-collaboration-editor]'), {
          formats:['bold','color'], readOnly:!this.state.can_edit,
          placeholder:'填写' + (cell.endsWith(':prog') ? '本周进展' : '卡点'),
          modules:{toolbar:false, history:{userOnly:true}}
        });
        quill.root.setAttribute('role', 'textbox');
        quill.root.setAttribute('aria-label', element.dataset.editorLabel);
        quill.root.setAttribute('aria-multiline', 'true');
        const editor = {doc,text,quill,element,serverState:cells[cell],presence:element.querySelector('[data-collaboration-cell-presence]')};
        this.applyServerUpdate(editor);
        for (const queued of this.queue) if (queued.cell === cell) Y.applyUpdate(doc, decoded(queued.update), remoteUpdate);
        editor.binding = new QuillBinding(text, quill);
        this.editors.set(cell, editor);
        doc.on('update', (update, origin) => { if (origin !== remoteUpdate) this.enqueue(cell, update); });
        quill.root.addEventListener('focus', () => { this.lastEditor = editor; this.focusCell(cell); });
        quill.root.addEventListener('blur', () => { if (this.activeCell === cell) this.focusCell(null); });
        quill.root.addEventListener('compositionstart', () => { editor.composing = true; this.paint(); });
        quill.root.addEventListener('compositionend', () => {
          queueMicrotask(() => {
            if (this.closed || this.editors.get(cell) !== editor) return;
            quill.update('user');
            editor.composing = false;
            this.applyServerUpdate(editor);
            this.paint();
          });
        });
      }
    }

    loadQueue(cells) {
      let unreadable = false;
      let records = [];
      try {
        records = JSON.parse(global.localStorage.getItem(this.storageKey) || '[]');
        if (!Array.isArray(records)) { unreadable = true; records = []; }
      } catch (_) { unreadable = true; }
      this.queue = records.filter(record => {
        const valid = record && cells.has(record.cell) && typeof record.update === 'string' && record.update.length > 0
          && typeof record.operation_id === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(record.operation_id);
        if (valid) {
          try { this.vendor.Y.decodeUpdate(decoded(record.update)); return true; } catch (_) {}
        }
        unreadable = true;
        return false;
      });
      if (unreadable) this.cacheNotice = '有本机待同步记录无法读取。页面已载入服务器内容和可恢复的本机记录。';
    }

    focusCell(cell) {
      if (this.activeCell === cell) return;
      this.activeCell = cell;
      clearTimeout(this.focusTimer);
      this.focusTimer = setTimeout(() => {
        if (this.pollController) this.pollController.abort();
        else this.poll();
      }, 120);
    }

    format(kind) {
      if (!this.lastEditor || !this.canEdit() || this.lastEditor.composing) return;
      const quill = this.lastEditor.quill;
      const range = quill.getSelection(true);
      if (!range) return;
      const format = quill.getFormat(range);
      if (kind === 'clear') {
        quill.format('bold', false, 'user');
        quill.format('color', false, 'user');
      } else if (kind === 'bold') quill.format('bold', !format.bold, 'user');
      else if (kind === 'red') quill.format('color', format.color === '#d81e06' ? false : '#d81e06', 'user');
    }

    enqueue(cell, update) {
      if (this.closed || this.revoked) return;
      const tail = this.queue[this.queue.length - 1];
      if (tail && !tail.attempted && tail.cell === cell) tail.update = encoded(this.vendor.Y.mergeUpdates([decoded(tail.update),update]));
      else this.queue.push({cell, operation_id:uuid(), update:encoded(update)});
      this.storeQueue();
      this.paint();
      this.scheduleSend();
    }

    storeQueue() {
      try {
        if (this.queue.length) global.localStorage.setItem(this.storageKey, JSON.stringify(this.queue));
        else global.localStorage.removeItem(this.storageKey);
        this.persisted = true;
      } catch (_) { this.persisted = false; }
    }

    scheduleSend() {
      if (!this.queue.length || this.sending || this.writeError || !this.online || !this.canEdit() || this.closed || this.sendTimer) return;
      this.sendTimer = setTimeout(() => { this.sendTimer = null; this.send(); }, 120);
    }

    async send() {
      if (this.closed || this.sending || !this.online || !this.canEdit() || this.writeError || !this.queue.length) return;
      this.sending = true;
      const current = this.queue[0];
      current.attempted = true;
      this.storeQueue();
      const number = ++this.requestNumber;
      try {
        const {cell, operation_id, update} = current;
        const next = await request('change', {week:this.config.week, plan_id:this.planId, cell, operation_id, update}, this.controller.signal);
        if (this.closed || this.revoked) return;
        this.queue.shift();
        this.storeQueue();
        this.accept(next, number);
      } catch (error) {
        if (this.closed) return;
        if (error.status && error.status < 500 && ![401,403,429].includes(error.status)) {
          this.writeError = error.message;
          if (error.status === 409) this.connect();
        } else this.failed(error);
      } finally {
        this.sending = false;
        if (!this.closed) { this.paint(); this.scheduleSend(); }
      }
    }

    async publish() {
      if (this.publishButton.disabled || this.closed || !this.state?.can_publish || this.queue.length || this.sending || this.isComposing()) return;
      this.publishing = true;
      this.error = '';
      this.notice = '';
      if (!this.publishAttempt || this.publishAttempt.revision !== this.state.revision || this.publishAttempt.plan_id !== this.planId) {
        this.publishAttempt = {week:this.config.week, plan_id:this.planId, revision:this.state.revision, operation_id:uuid()};
        const ids = this.config.attachmentIds?.() || [];
        if (ids.length) Object.assign(this.publishAttempt, {attachment_ids:ids, period:this.config.period});
      }
      const number = ++this.requestNumber;
      this.paint();
      try {
        const next = await request('publish', this.publishAttempt, this.controller.signal);
        if (this.closed) return;
        this.accept(next, number);
        this.publishAttempt = null;
      } catch (error) {
        if (this.closed) return;
        if (error.status === 409) {
          this.publishAttempt = null;
          this.notice = error.message + ' 请核对最新协同稿后再提交。';
          this.reconnect();
        } else this.failed(error);
      } finally {
        this.publishing = false;
        if (!this.closed) {
          this.paint();
          if (this.state?.report) this.showResult();
        }
      }
    }

    async showResult() {
      const report = this.state?.report;
      if (!report || this.openingResult) return;
      this.openingResult = true;
      try { await this.config.onPublished(report); }
      catch (_) { this.error = '周报已提交，结果页暂未打开。请重试查看提交结果。'; }
      finally { this.openingResult = false; if (!this.closed) this.paint(); }
    }

    async copyPending() {
      const cells = new Set(this.queue.map(entry => entry.cell));
      const content = Array.from(this.editors).filter(([cell]) => cells.has(cell))
        .map(([,editor]) => editor.element.dataset.editorLabel + '\n' + editor.text.toString()).join('\n\n');
      if (!content) return;
      try { await global.navigator.clipboard.writeText(content); this.config.notify('已复制未同步内容。'); }
      catch (_) {
        let output = this.root.querySelector('[data-collaboration-copy-text]');
        if (!output) {
          output = document.createElement('textarea'); output.readOnly = true; output.className = 'collaboration-copy-text'; output.dataset.collaborationCopyText = '';
          output.setAttribute('aria-label', '未同步内容'); this.copyButton.parentElement.after(output);
        }
        output.value = content; output.focus(); output.select();
      }
    }

    paint() {
      if (this.closed) return;
      const next = this.state;
      const pending = this.queue.length;
      const editable = this.canEdit();
      const message = this.error || this.writeError;
      let state = 'saved', text = '协同稿已保存到服务器。';
      if (message) { state = 'error'; text = message; }
      else if (!this.online) { state = 'offline'; text = '连接中断，正在重连。'; }
      else if (!next) { state = 'loading'; text = '正在读取本周协同稿…'; }
      else if (this.publishing) { state = 'pending'; text = '正在提交专业周报…'; }
      else if (next.status !== 'ready') {
        state = next.status === 'published' ? 'saved' : 'blocked';
        text = statusMessages[next.status] || '当前周无法协同填报。';
      }
      else if (pending) { state = 'pending'; text = '正在同步至服务器…'; }
      if (pending && state !== 'pending') text += this.persisted ? ' 有未同步内容保存在当前浏览器。' : ' 有未同步内容仅在当前页面，请保留此页面。';
      if (!this.persisted && pending && state === 'pending') text += ' 本机暂存失败，请等候服务器保存。';
      if (this.status.dataset.state !== state) this.status.dataset.state = state;
      if (this.status.textContent !== text) this.status.textContent = text;
      const notice = [this.cacheNotice, this.notice].filter(Boolean).join(' ');
      this.noticeElement.hidden = !notice;
      this.noticeElement.dataset.state = 'error';
      if (this.noticeElement.textContent !== notice) this.noticeElement.textContent = notice;
      this.retryButton.hidden = !(message || !this.online) || Boolean(this.revoked);
      this.copyButton.hidden = !pending || !this.editors.size;
      this.toolbar.hidden = !editable || !this.editors.size;
      this.footer.hidden = !(next?.plan || next?.report);
      this.publishButton.hidden = !next?.can_publish;
      this.publishButton.disabled = !editable || !this.online || Boolean(pending || message || this.sending || this.isComposing());
      this.attachments.hidden = !next?.can_publish;
      if (next?.can_publish) {
        const count = this.config.attachmentIds?.().length || 0;
        const label = count ? '随专业周报提交 ' + count + ' 件已选附件。可返回本期填报调整。' : '如需随周报提交附件，请返回本期填报上传并选入。';
        if (this.attachments.textContent !== label) this.attachments.textContent = label;
      }
      this.resultButton.hidden = !next?.report;
      const owner = this.root.querySelector('[data-collaboration-owner]');
      owner.textContent = next?.submitter_name ? '本周提交负责人 ' + next.submitter_name : '';
      const people = next?.presence || [];
      const name = person => person.name + (person.user_id === this.config.uid ? '（你）' : '');
      this.root.querySelector('[data-collaboration-presence]').textContent = next ? '在线 ' + (people.length ? people.map(name).join('、') : '暂无成员') : '';
      const savedInfo = this.root.querySelector('[data-collaboration-saved-info]');
      savedInfo.textContent = next?.last_change?.actor_name ? '最近保存 ' + next.last_change.actor_name
        + (next.last_change.at ? ' · ' + new Date(next.last_change.at).toLocaleTimeString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false,hour:'2-digit',minute:'2-digit'}) : '') : '';
      for (const [cell, editor] of this.editors) {
        if (editor.quill.isEnabled() !== editable && !editor.composing) editor.quill.enable(editable);
        const active = people.filter(person => person.active_cell === cell).map(name);
        const label = active.length ? active.join('、') + '正在编辑' : '';
        if (editor.presence.textContent !== label) editor.presence.textContent = label;
      }
    }

    destroyEditors() {
      for (const editor of this.editors.values()) { editor.binding?.destroy(); editor.doc.destroy(); }
      this.editors.clear();
      this.lastEditor = null;
    }

    close() {
      this.closed = true;
      this.controller.abort();
      if (this.pollController) this.pollController.abort();
      clearTimeout(this.sendTimer); clearTimeout(this.reconnectTimer); clearTimeout(this.focusTimer);
      global.removeEventListener('online', this.onNetwork);
      global.removeEventListener('offline', this.onOffline);
      global.removeEventListener('beforeunload', this.beforeUnload);
      this.destroyEditors();
    }
  }

  global.WeeklyCollaboration = {
    mount(root, config) {
      if (mounted && mounted.root === root) return;
      if (mounted) mounted.close();
      mounted = root && config ? (config.mode === 'settings' ? settings(root, config) : new Workspace(root, config)) : null;
    },
    canLeave() { return !mounted || mounted.canLeave(); }
  };
})(window);
