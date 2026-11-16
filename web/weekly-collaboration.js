/* The collaborative form keeps its editors mounted while the server state changes. */
(function (global) {
  'use strict';

  const endpoint = '/api/weekly-collaboration/';
  const remoteUpdate = Symbol('server update');
  const statusMessages = {
    unconfigured: '本周还未指定提交负责人，请联系管理员。',
    submitter_unavailable: '本周负责人当前没有填报权限，请联系管理员核对。',
    missing_plan: '本周暂无可用事项，请刷新后重试。',
    legacy_report: '本周已有个人周报，请在历史记录查看。',
    plan_changed: '确认月计划已变化，协同编制已暂停，请联系管理员核对。',
    month_access_changed: '当月协同计划的成员范围已变化，请联系管理员核对。',
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

  function planField(plan, field, item, index) {
    const path = 'items.' + index + '.' + field;
    const doc = plan.rich_text && plan.rich_text.fields && plan.rich_text.fields[path];
    return doc && global.ZHRichText ? global.ZHRichText.render(doc) : esc(item[field] || '—');
  }

  function settings(root, config) {
    root.innerHTML = '<section class="card collaboration-panel">'
      + '<header><h2>周报协同设置</h2><p>按项目、专业和报告周选择负责人及协同人员。负责人也可以参与填写。</p></header>'
      + '<form class="collaboration-settings"><label>报告周起始日（周一）<input type="date" data-weekly-collaboration-week></label>'
      + '<button type="button" class="btn ghost" data-collaboration-load>读取该周</button>'
      + '<label>项目<select data-weekly-collaboration-project></select></label>'
      + '<label>汇报专业<select data-weekly-collaboration-profession></select></label>'
      + '<label>提交负责人<select data-weekly-collaboration-submitter required></select></label>'
      + '<fieldset data-collaboration-members><legend>协同人员</legend><div data-collaboration-member-list></div></fieldset>'
      + '<button type="submit" class="btn primary" data-weekly-collaboration-designate>保存协同设置</button></form>'
      + '<p role="status" class="collaboration-status" data-collaboration-status></p></section>';
    const date = root.querySelector('input');
    const project = root.querySelector('[data-weekly-collaboration-project]');
    const profession = root.querySelector('[data-weekly-collaboration-profession]');
    const select = root.querySelector('[data-weekly-collaboration-submitter]');
    const memberList = root.querySelector('[data-collaboration-member-list]');
    const memberIds=()=>Array.from(memberList.querySelectorAll('input:checked')).map(input=>input.value).filter(id=>id!==select.value).sort();
    const submit = root.querySelector('[data-weekly-collaboration-designate]');
    const reload = root.querySelector('[data-collaboration-load]');
    const status = root.querySelector('[data-collaboration-status]');
    let projects = [];
    let state, serial = 0;
    let closed = false;
    const controller = new AbortController();
    date.value = config.week;
    function show(state, text) {
      status.dataset.state = state;
      status.textContent = text;
    }
    function options(input, label, entries, previous) {
      input.replaceChildren(new Option(label, ''));
      for (const [name, value] of entries) input.append(new Option(name,value));
      input.value = entries.some(([,value]) => value === previous) ? previous : entries.length === 1 ? entries[0][1] : '';
    }
    function selectedProject() { return projects.find(entry => entry.project_id === project.value); }
    function resetReporter() {
      state = null;
      select.replaceChildren(new Option('请选择提交负责人', ''));
      memberList.replaceChildren();
      select.disabled = submit.disabled = true;
    }
    function refreshButton() {
      if(!state){submit.disabled=true;return;}
      for(const input of memberList.querySelectorAll('input'))input.disabled=state.status==='published' || input.value===select.value;
      const same=select.value===state.submitter_id && state.member_ids!==null
        && JSON.stringify(memberIds())===JSON.stringify([...state.member_ids].sort());
      submit.disabled = state.status==='published' || !select.value || same;
    }
    async function loadSettings(submitterId,members) {
      const version = ++serial;
      const target = selectedProject();
      resetReporter();
      if (!target || !profession.value) {
        show('blocked', target ? '请选择汇报专业。' : '请选择项目。');
        return;
      }
      if (submitterId) date.disabled = reload.disabled = project.disabled = profession.disabled = true;
      show('loading', submitterId ? '正在保存负责人…' : '正在读取本周协同设置…');
      try {
        const body = {week:date.value, project_id:target.project_id, report_scope_id:target.report_scope_id ?? null, line:profession.value};
        if (submitterId) Object.assign(body,{submitter_id:submitterId,member_ids:members});
        const next = await request('settings', body, controller.signal);
        if (closed || version !== serial) return;
        state = next;
        for (const person of next.eligible || []) {
          select.append(new Option(person.name, person.user_id));
          const label=document.createElement('label'),input=document.createElement('input');
          input.type='checkbox';input.value=person.user_id;
          input.checked=person.user_id===next.submitter_id || next.member_ids?.includes(person.user_id)
            || next.member_ids===null && !!next.submitter_id;
          label.append(input,document.createTextNode(' '+person.name));
          memberList.append(label);
        }
        select.value = next.submitter_id || '';
        select.disabled = !next.can_configure;
        refreshButton();
        const name = next.submitter_name ? '本周负责人为' + next.submitter_name + '。' : '';
        show('saved', (submitterId ? '已保存。' : '') + name + (statusMessages[next.status] || '')
          + (!next.can_configure && next.status === 'ready' ? '已有月计划或协同进展，负责人已锁定。' : ''));
      } catch (error) {
        if (closed || version !== serial) return;
        show(error.status ? 'error' : 'offline', error.status ? error.message : '连接中断，请重新读取该周。');
      } finally {
        if (submitterId && !closed && version === serial) date.disabled = reload.disabled = project.disabled = profession.disabled = false;
      }
    }
    function loadProfessions(previous) {
      const target = selectedProject();
      options(profession, '请选择汇报专业', (target?.professions || []).map(line => [line,line]), previous);
      profession.disabled = !target;
      loadSettings();
    }
    async function loadCatalog() {
      const version = ++serial;
      const week = date.value;
      const previousProject = project.value, previousLine = profession.value;
      project.disabled = profession.disabled = true;
      resetReporter();
      if (!week || global.PlanningWindows.periodStart(week) !== week) {
        show('error', '请选择周一作为报告周起始日。');
        return;
      }
      show('loading', '正在读取可启用协同的项目和专业…');
      try {
        const result = await request('catalog', {week}, controller.signal);
        if (closed || version !== serial) return;
        projects = result.projects;
        options(project,'请选择项目',projects.map(entry => [entry.project_name,entry.project_id]),previousProject);
        if (!projects.length) {
          options(profession, '请选择汇报专业', []);
          show('blocked','该报告周暂无可启用协同的项目专业。');
          return;
        }
        project.disabled = false;
        loadProfessions(project.value === previousProject ? previousLine : '');
      } catch (error) {
        if (closed || version !== serial) return;
        show(error.status ? 'error' : 'offline', error.status ? error.message : '连接中断，请重新读取该周。');
      }
    }
    date.addEventListener('change', loadCatalog);
    project.addEventListener('change', () => loadProfessions());
    profession.addEventListener('change', () => loadSettings());
    select.addEventListener('change', refreshButton);
    memberList.addEventListener('change', refreshButton);
    reload.addEventListener('click', loadCatalog);
    root.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      if (!submit.disabled) loadSettings(select.value,memberIds());
    });
    loadCatalog();
    return {root, close() { closed = true; controller.abort(); }, canLeave() { return true; }};
  }

  class Workspace {
    constructor(root, config) {
      this.root = root;
      this.config = config;
      const {project_id,line,report_scope_id} = config.scope;
      this.target = {week:config.week,project_id,line,report_scope_id,tab_id:uuid()};
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

    request(action, body, signal) {
      return request(action, {...this.target,...body}, signal);
    }

    markup() {
      this.root.innerHTML = '<section class="card plan-form-section collaboration-panel collaboration-entry" aria-labelledby="collaboration-title">'
        + '<header class="cardhd plan-section-head"><h3 id="collaboration-title">二、当月计划填报</h3>'
        + '<button type="button" class="btn ghost sm" data-collaboration-reference>查看其他专业填报</button></header>'
        + '<div class="monthly-plan-toolbar"><div class="actions">'
        + '<button type="button" class="btn primary" data-plan-month="current" aria-pressed="true">本月</button>'
        + '<button type="button" class="btn" data-plan-month="next" aria-pressed="false" hidden>准备下月</button>'
        + '<button type="button" class="btn ghost" data-confirm-shared-month hidden>确认本月计划</button>'
        + '<button type="button" class="btn ghost" data-withdraw-shared-month hidden>撤回确认并修改</button></div>'
        + '<p class="muted collaboration-month-note" data-month-plan-status></p></div>'
        + '<p class="notice warn" role="status" data-month-operation-status hidden></p>'
        + '<div class="collaboration-meta"><span data-collaboration-owner></span><span data-collaboration-presence></span></div>'
        + '<div class="collaboration-statusbar"><p class="collaboration-status" role="status" data-collaboration-status></p>'
        + '<button type="button" class="btn ghost sm" data-collaboration-retry hidden>重试连接</button>'
        + '<button type="button" class="btn ghost sm" data-collaboration-copy hidden>复制未同步内容</button></div>'
        + '<div class="collaboration-toolbar" aria-label="当前单元格文字格式" hidden><button type="button" data-collaboration-format="bold">加粗</button>'
        + '<button type="button" data-collaboration-format="red">标红</button><button type="button" data-collaboration-format="clear">清除格式</button></div>'
        + '<p role="status" class="collaboration-status" data-collaboration-notice hidden></p>'
        + '<div data-collaboration-table></div><div data-next-month-table hidden></div>'
        + '<button type="button" class="btn ghost sm collaboration-add-item" data-open-item-form hidden>＋ 增加事项</button>'
        + '<div data-collaboration-items hidden></div><p class="collaboration-attachments" data-collaboration-attachments hidden></p><footer class="collaboration-footer plan-form-actions" hidden>'
        + '<p data-collaboration-saved-info></p><button type="button" class="btn ghost" data-collaboration-result hidden>查看提交结果</button>'
        + '<button type="button" class="btn ghost" data-collaboration-withdraw hidden>撤回周报并修改</button>'
        + '<button type="button" class="btn primary" data-collaboration-publish hidden>提交专业周报</button></footer></section>';
      const find = selector => this.root.querySelector(selector);
      this.status = find('[data-collaboration-status]');
      this.noticeElement = find('[data-collaboration-notice]');
      this.attachments = find('[data-collaboration-attachments]');
      this.table = find('[data-collaboration-table]');
      this.nextTable = find('[data-next-month-table]');
      this.itemForm = find('[data-collaboration-items]');
      this.monthButtons = Array.from(this.root.querySelectorAll('[data-plan-month]'));
      this.monthStatus = find('[data-month-plan-status]');
      this.monthOperationStatus = find('[data-month-operation-status]');
      this.confirmButton = find('[data-confirm-shared-month]');
      this.withdrawButton = find('[data-withdraw-shared-month]');
      this.addItemButton = find('[data-open-item-form]');
      this.activeMonth = 'current';
      find('[data-collaboration-reference]').addEventListener('click',()=>this.config.openReference?.());
      for(const button of this.monthButtons)button.addEventListener('click',()=>this.selectMonth(button.dataset.planMonth));
      this.confirmButton.addEventListener('click',()=>this.saveMonthDecision('confirm'));
      this.withdrawButton.addEventListener('click',()=>this.saveMonthDecision('withdraw'));
      this.addItemButton.addEventListener('click',()=>{
        this.resetItemForm();
        this.openItemForm(this.selectedItemPlan());
        this.paint();this.itemForm.querySelector('[name=name]').focus();
      });
      const names=this.config.scope.projectNames || {};
      this.itemForm.innerHTML='<form><p class="muted" data-weekly-item-help hidden>新增事项在本周共享稿中保存，负责人提交周报后同步至本月计划。</p><div class="f2">'
        + (this.target.report_scope_id?'<label>实际项目／分期<select name="project_id" required>'
          +Object.entries(names).map(([id,name])=>'<option value="'+esc(id)+'">'+esc(name)+'</option>').join('')+'</select></label>':'')
        + '<label>模块<input name="mod" maxlength="200"></label><label class="collaboration-item-name">事项<textarea name="name" maxlength="10000" rows="2" required></textarea></label>'
        + '<label>完成时间<input name="due" type="date"></label></div>'
        + '<div class="actions"><button class="btn primary sm" type="submit">添加事项</button> <button class="btn ghost sm" type="button" data-cancel-item>取消</button>'
        + '<button class="btn ghost sm" type="button" data-delete-item hidden>删除事项</button></div>'
        + '<p role="status" data-item-status></p></form>';
      this.itemForm.querySelector('form').addEventListener('submit',event=>{
        event.preventDefault();this.saveItem();
      });
      this.itemForm.querySelector('[data-cancel-item]').addEventListener('click',()=>{
        this.resetItemForm();this.itemFormOpen=false;this.paint();this.addItemButton.focus();
      });
      this.itemForm.querySelector('[data-delete-item]').addEventListener('click',()=>this.saveItem('delete'));
      for(const table of [this.table,this.nextTable])table.addEventListener('click',event=>{
        const button=event.target.closest('[data-edit-item]');
        if(button)this.editItem(button.dataset.editItem);
      });
      this.footer = find('.collaboration-footer');
      this.toolbar = find('.collaboration-toolbar');
      this.publishButton = find('[data-collaboration-publish]');
      this.resultButton = find('[data-collaboration-result]');
      this.withdrawReportButton = find('[data-collaboration-withdraw]');
      this.retryButton = find('[data-collaboration-retry]');
      this.copyButton = find('[data-collaboration-copy]');
      this.retryButton.addEventListener('click', () => this.reconnect());
      this.copyButton.addEventListener('click', () => this.copyPending());
      this.publishButton.addEventListener('click', () => this.publish());
      this.resultButton.addEventListener('click', () => this.showResult());
      this.withdrawReportButton.addEventListener('click', () => this.withdrawReport());
      this.toolbar.addEventListener('pointerdown', event => { if (event.target.closest('button')) event.preventDefault(); });
      this.toolbar.addEventListener('click', event => {
        const button = event.target.closest('[data-collaboration-format]');
        if (button) this.format(button.dataset.collaborationFormat);
      });
      this.paint();
    }

    isComposing() { return Array.from(this.editors.values()).some(editor => editor.composing); }

    canLeave() { return !this.publishing && !this.withdrawingReport && !this.savingItem && !this.confirmingMonth && !this.itemFormChanged() && !this.isComposing() && (!this.queue.length || this.persisted); }

    canEdit() { return Boolean(this.state?.can_edit && this.state?.plan?.id === this.planId && !this.publishing && !this.withdrawingReport && !this.revoked); }

    async connect() {
      if (this.closed || this.connecting) return;
      this.connecting = true;
      const number = ++this.requestNumber;
      try {
        const next = await this.request('open', {}, this.controller.signal);
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
        this.nextTable.replaceChildren();
        this.resetItemForm();
        this.itemFormOpen=false;
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
        const {revision, cursor} = this.state;
        const next = await this.request('poll', {since_revision:revision, since_cursor:cursor, active_cell:this.activeCell || null}, controller.signal);
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
      const previousReport = this.state?.report;
      this.state = next;
      if (previousReport && next.status === 'ready') this.writeError = '';
      if (!next.plan && !this.queue.length && (this.editors.size || this.planId !== undefined)) {
        this.destroyEditors();
        this.table.replaceChildren();
        this.planId = undefined;
      }
      if (!next.report) this.publishedReport = null;
      this.syncEditors();
      if (next.report && String(next.report.id) !== String(previousReport?.id)) {
        this.config.onPublicationObserved?.();
      }
      for (const [cell, editor] of this.editors) {
        if (next.plan?.id === this.planId && next.cells && next.cells[cell] && editor.serverState !== next.cells[cell]) {
          editor.serverState = next.cells[cell];
          if (!editor.composing) this.applyServerUpdate(editor);
          if (cell.endsWith(':blocker') && editor.text.length && !editor.blockerShown) {
            editor.element.closest('details').open=true;
            editor.blockerShown=true;
          }
        }
      }
      if(next.report && !this.queue.length)this.showPublishedItems(next.report);
      if (!next.report && Array.isArray(next.withdrawn_attachment_ids) && next.withdrawn_revision != null) {
        this.config.onWithdrawn?.(next.withdrawn_revision, next.withdrawn_attachment_ids, previousReport);
      }
      this.schedulePlanResize();
      this.paint();
    }

    syncEditors() {
      const plan=this.state?.plan;
      if (!plan || this.queue.length || this.isComposing() || this.sending && !this.state?.can_edit) return;
      const itemKey=JSON.stringify([plan.unplanned,plan.confirmed_id,plan.can_add_weekly_items,plan.weekly_supplement_ids,plan.items]);
      if(plan.id!==this.planId || itemKey!==this.itemKey) {
        this.createEditors(plan,this.state.cells || {});
        this.itemKey=itemKey;
      }
    }

    selectedMonthPlan() {
      if(this.activeMonth==='next')return this.state?.month_plans?.next;
      const plan=this.state?.plan;
      if(plan?.unplanned && !plan.shared)return {...plan,revision:this.state.revision,can_edit:this.state.can_edit,legacyWeek:true};
      return this.state?.month_plans?.current ?? plan;
    }

    selectedItemPlan() {
      const plan = this.state?.plan;
      if (this.activeMonth === 'current' && plan?.can_add_weekly_items) {
        return {...plan, weeklySupplement:true, revision:this.state.revision, can_edit:this.state.can_edit};
      }
      return this.selectedMonthPlan();
    }

    selectMonth(month) {
      if(this.savingItem || this.confirmingMonth || this.withdrawingReport || this.activeMonth===month)return;
      if(this.itemFormChanged() && !global.confirm('事项尚未保存，是否切换月份？'))return;
      this.activeMonth=month;
      this.resetItemForm();this.itemFormOpen=false;
      this.showMonthMessage('');
      this.paint();
      if(month==='current')this.schedulePlanResize();
    }

    showMonthMessage(message) {
      this.monthOperationStatus.hidden=!message;
      this.monthOperationStatus.textContent=message;
    }

    itemFormValues() {
      const fields=this.itemForm.querySelector('form').elements;
      return Object.fromEntries(['project_id','mod','name','due'].filter(name=>fields[name]).map(name=>[name,fields[name].value]));
    }

    itemFormChanged() {
      return this.itemFormOpen && JSON.stringify(this.itemFormValues())!==this.itemFormBaseline;
    }

    itemFormScope(plan) {
      if (!plan) return null;
      if (plan.weeklySupplement) return 'week:'+plan.confirmed_id;
      return plan.legacyWeek ? 'legacy-week' : 'month:'+plan.month;
    }

    openItemForm(plan) {
      this.itemFormOpen = true;
      this.openItemFormScope = this.itemFormScope(plan);
    }

    resetItemForm() {
      this.editingItem=null;
      const form=this.itemForm.querySelector('form');
      form.reset();
      form.querySelector('[type=submit]').textContent='添加事项';
      form.querySelector('[data-delete-item]').hidden=true;
      form.querySelector('[data-item-status]').textContent='';
      this.itemFormBaseline=JSON.stringify(this.itemFormValues());
    }

    editItem(sourceId) {
      const plan=this.selectedItemPlan();
      if(!plan?.can_edit || this.publishing || this.savingItem || this.confirmingMonth) return;
      if (plan.weeklySupplement && !plan.weekly_supplement_ids?.includes(sourceId)) return;
      const item=plan.items.find(row=>row.source_id===sourceId);
      if(!item)return;
      if (this.itemFormChanged() && !global.confirm('事项尚未保存，是否切换到这条事项？')) return;
      this.editingItem={id:sourceId,revision:plan.revision};
      this.openItemForm(plan);
      const form=this.itemForm.querySelector('form');
      for(const field of ['mod','name','due','project_id'])if(form.elements[field])form.elements[field].value=item[field] || '';
      this.itemFormBaseline=JSON.stringify(this.itemFormValues());
      form.querySelector('[type=submit]').textContent='保存事项';
      form.querySelector('[data-delete-item]').hidden=!!plan.legacyWeek;
      form.querySelector('[data-item-status]').textContent='';
      this.paint();
      form.elements.name.focus();
    }

    async saveItem(action) {
      const plan=this.selectedItemPlan();
      if(!plan?.can_edit || !this.online || this.publishing || this.savingItem || this.confirmingMonth || this.queue.length || this.sending || this.isComposing())return;
      const form=this.itemForm.querySelector('form'), status=form.querySelector('[data-item-status]');
      if (this.openItemFormScope !== this.itemFormScope(plan)) {
        status.textContent='计划状态已变化。请保留当前输入，再重新打开事项。';
        return;
      }
      const editing=this.editingItem;
      const deleting=action==='delete';
      if (plan.weeklySupplement && editing && !plan.weekly_supplement_ids?.includes(editing.id)) {
        status.textContent='该事项已变化，请重新选择。';
        return;
      }
      if(deleting && (!editing || plan.legacyWeek || !global.confirm(plan.weeklySupplement?'删除此本周新增事项？':'删除此计划事项？')))return;
      const item=deleting?undefined:this.itemFormValues();
      const scope = plan.weeklySupplement ? {weekly_supplement:true,plan_id:plan.confirmed_id}
        : plan.legacyWeek ? {} : {month:plan.month};
      const payload={action:deleting?'delete':editing?'update':'add',revision:editing?.revision ?? plan.revision,item,
        ...(editing?{source_id:editing.id}:{}),...scope};
      const key=JSON.stringify([scope,payload.action,payload.source_id,item]);
      if(this.itemAttempt?.key!==key)this.itemAttempt={key,body:{...payload,operation_id:uuid()}};
      this.savingItem=true;status.textContent='正在保存事项…';this.paint();
      try {
        const number=++this.requestNumber;
        const next=await this.request(plan.legacyWeek || plan.weeklySupplement?'items':'month-items',this.itemAttempt.body,this.controller.signal);
        if(this.closed)return;
        this.itemAttempt=null;this.resetItemForm();this.itemFormOpen=false;this.accept(next,number);
        this.addItemButton.focus();
      } catch(error) {
        if(this.closed)return;
        if(error.status===401 || error.status===403)this.failed(error);
        else status.textContent=error.message || '事项保存未确认，请重试。';
        if(error.status && error.status<500 && error.status!==429)this.itemAttempt=null;
        if(error.status===409 && editing)status.textContent+=' 请重新选择该事项后修改。';
      } finally {this.savingItem=false;if(!this.closed)this.paint();}
    }

    async saveMonthDecision(action) {
      const plan=this.selectedMonthPlan();
      const confirm=action==='confirm';
      if(this.closed || (confirm ? this.confirmButton.disabled || !plan?.can_confirm : this.withdrawButton.disabled || !plan?.can_withdraw))return;
      const label=this.activeMonth==='next'?'下月':'本月';
      if(!global.confirm(confirm?'确认'+label+'计划后，模块、事项和完成时间将固定。是否确认？'
        :'撤回'+label+'计划的确认，让组员继续修改？'))return;
      const key=JSON.stringify([action,plan.month,plan.revision]);
      if(this.confirmAttempt?.key!==key)this.confirmAttempt={key,body:{month:plan.month,revision:plan.revision,operation_id:uuid()}};
      this.confirmingMonth=true;this.showMonthMessage('');this.paint();
      try {
        const number=++this.requestNumber;
        const next=await this.request(action+'-month',this.confirmAttempt.body,this.controller.signal);
        if(this.closed)return;
        this.confirmAttempt=null;this.accept(next,number);
      } catch(error) {
        if(this.closed)return;
        if(error.status===401 || error.status===403)this.failed(error);
        else this.showMonthMessage(error.message || '操作未完成，请重试。');
        if(error.status && error.status<500 && error.status!==429)this.confirmAttempt=null;
      } finally {this.confirmingMonth=false;if(!this.closed)this.paint();}
    }

    applyServerUpdate(editor) {
      if (!editor.serverState || editor.appliedState === editor.serverState) return;
      this.vendor.Y.applyUpdate(editor.doc, decoded(editor.serverState), remoteUpdate);
      editor.appliedState = editor.serverState;
    }

    renderTable(items, progress, rowHtml) {
      const hasSource=!!this.target.report_scope_id;
      const labels=(hasSource?['实际项目／分期']:[]).concat(['模块','事项','完成时间'],progress?['当周进展']:[]);
      return '<div class="tablewrap collaboration-tablewrap report3-monthly-wrap"><table class="plan-form-table collaboration-table">'
        +'<colgroup>'+(hasSource?'<col class="collaboration-project">':'')+'<col class="collaboration-module"><col class="collaboration-task">'
        +'<col class="collaboration-date">'+(progress?'<col class="collaboration-progress">':'')+'</colgroup>'
        +'<thead><tr>'+labels.map(label=>'<th scope="col">'+label+'</th>').join('')+'</tr></thead><tbody>'
        +(items.length?items.map(rowHtml).join(''):'<tr class="collaboration-empty-row"><td colspan="'+labels.length+'">暂无事项。</td></tr>')
        +'</tbody></table></div>';
    }

    itemColumns(plan,item,index,editable,supplemental=false) {
      const names=this.config.scope.projectNames || {};
      return (this.target.report_scope_id?'<td data-label="实际项目／分期"><div>'+esc(names[item.project_id] || '未明确')+'</div></td>':'')
        +'<td data-label="模块"><div>'+planField(plan,'mod',item,index)+'</div></td><td data-label="事项"><div>'+planField(plan,'name',item,index)
        +(supplemental?'<br><small class="muted">本周新增</small>':'')
        +'</div>'+(editable?'<button type="button" class="btn ghost sm collaboration-edit-item" data-edit-item="'+esc(item.source_id)+'">修改事项</button>':'')
        +'</td><td data-label="完成时间"><div>'+esc(item.due || '—')+'</div></td>';
    }

    itemActions(item,plan) {
      const action=this.config.itemAction?.(item,plan,this.state);
      return action?'<div class="plan-item-actions">'+action+'</div>':'';
    }

    showPublishedItems(report) {
      const key = JSON.stringify([report.id, report.updated_at || report.submitted_at]);
      if (this.publishedReport === key) return;
      this.publishedReport = key;
      const items=report.biz?.items || [];
      const fields={};
      for(const [key,value] of Object.entries(report.rich_text?.fields || {}))if(key.startsWith('biz.items.'))fields[key.slice(4)]=value;
      const plan={rich_text:{fields}};
      this.table.innerHTML=this.renderTable(items,true,(item,index)=>'<tr>'+this.itemColumns(plan,item,index,false)
        +'<td data-label="当周进展"><div class="collaboration-saved-progress">'+planField(plan,'prog',item,index)+'</div>'
        +(item.blocker?'<div class="collaboration-saved-blocker">卡点 '+planField(plan,'blocker',item,index)+'</div>':'')
        +this.itemActions(item,plan)+'</td></tr>');
    }

    showNextMonth(plan) {
      if(!plan){
        this.nextTable.replaceChildren();
        this.nextTableKey=null;
        return;
      }
      const key=JSON.stringify([plan.id,plan.revision,plan.confirmed_id,plan.can_edit,plan.unavailable]);
      if(key===this.nextTableKey)return;
      this.nextTableKey=key;
      this.nextTable.innerHTML=this.renderTable(plan.items,false,(item,index)=>'<tr>'+this.itemColumns(plan,item,index,plan.can_edit)+'</tr>');
    }

    resizePlanTable() {
      const items=this.state?.plan?.items || this.state?.report?.biz?.items;
      if(!items || !this.config.planWidths)return;
      const names=this.config.scope.projectNames || {};
      const widths=this.config.planWidths(items.map(item=>({...item,source:names[item.project_id],
        progress:this.editors.get(item.source_id+':prog')?.text.toString() ?? item.prog,
        blocker:this.editors.get(item.source_id+':blocker')?.text.toString() ?? item.blocker})),!!this.target.report_scope_id);
      if(widths)this.table.querySelectorAll('col').forEach((col,index)=>{
        if(widths[index] && col.style.width!==widths[index])col.style.width=widths[index];
      });
    }

    schedulePlanResize() {
      if(this.resizeFrame!=null)return;
      this.resizeFrame=global.requestAnimationFrame(()=>{
        this.resizeFrame=null;
        if(!this.closed)this.resizePlanTable();
      });
    }

    createEditors(plan, cells) {
      const active=this.activeCell, selection=this.editors.get(active)?.quill.getSelection();
      const openedBlockers=new Set([...this.editors.entries()].filter(([cell,editor])=>cell.endsWith(':blocker')
        && editor.element.closest('details').open).map(([cell])=>cell));
      this.destroyEditors();
      this.planId = plan.id;
      const {project_id,line,report_scope_id,week} = this.target;
      this.storageKey = 'zh_weekly_collaboration:' + JSON.stringify([this.config.uid,project_id,line,report_scope_id,week,this.planId]);
      this.legacyStorageKey = project_id === 'hf' && line === '设计部' && !report_scope_id
        ? 'zh_weekly_collaboration:' + JSON.stringify([this.config.uid,week,this.planId]) : '';
      this.vendor = global.PlanningCollaborationVendor;
      if (!this.vendor || !global.Quill) throw new Error('协同编辑组件未就绪。');
      const {Y, QuillBinding} = this.vendor;
      const items = Array.isArray(plan.items) ? plan.items : [];
      this.loadQueue(new Set(items.flatMap(item => [item.source_id + ':prog', item.source_id + ':blocker'])));
      const editorHtml=(item,field,label)=>'<div class="collaboration-cell" data-collaboration-cell="'
        +esc(item.source_id+':'+field)+'" data-editor-label="'+esc(item.name+' · '+label)
        +'"><div data-collaboration-editor></div><small data-collaboration-cell-presence></small></div>';
      const supplements = new Set(plan.weekly_supplement_ids || []);
      this.table.innerHTML=this.renderTable(items,true,(item,index)=>{
        const supplemental=supplements.has(item.source_id);
        return '<tr>'+this.itemColumns(plan,item,index,plan.unplanned || supplemental && plan.can_add_weekly_items,supplemental)
          +'<td data-label="当周进展">'+editorHtml(item,'prog','当周进展')
          +'<details class="collaboration-blocker"'+(cells[item.source_id+':blocker'] || openedBlockers.has(item.source_id+':blocker')?' open':'')+'><summary>卡点</summary>'
          +editorHtml(item,'blocker','卡点')+'</details>'+this.itemActions(item,plan)+'</td></tr>';
      });
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
        const editor = {doc,text,quill,element,serverState:cells[cell],blockerShown:!!cells[cell],
          presence:element.querySelector('[data-collaboration-cell-presence]')};
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
            this.syncEditors();
            this.paint();
          });
        });
      }
      if(selection && this.editors.has(active) && this.activeMonth==='current'){
        const {quill}=this.editors.get(active);
        quill.root.focus({preventScroll:true});
        const index=Math.min(selection.index,quill.getLength()-1);
        quill.setSelection(index,Math.min(selection.length,quill.getLength()-1-index),'silent');
      }
    }

    loadQueue(cells) {
      let unreadable = false;
      let records = [];
      try {
        const saved = global.localStorage.getItem(this.storageKey);
        const legacy = saved === null && this.legacyStorageKey ? global.localStorage.getItem(this.legacyStorageKey) : null;
        this.readLegacyQueue = legacy !== null;
        records = JSON.parse(saved ?? legacy ?? '[]');
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
      this.schedulePlanResize();
      this.paint();
      this.scheduleSend();
    }

    storeQueue() {
      try {
        if (this.queue.length) global.localStorage.setItem(this.storageKey, JSON.stringify(this.queue));
        else global.localStorage.removeItem(this.storageKey);
        if (this.readLegacyQueue) {
          global.localStorage.removeItem(this.legacyStorageKey);
          this.readLegacyQueue = false;
        }
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
        const next = await this.request('change', {plan_id:this.planId, cell, operation_id, update}, this.controller.signal);
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
      if (this.publishButton.disabled || this.closed || !this.state?.can_publish || this.queue.length || this.sending || this.savingItem
        || this.isComposing() || this.config.attachmentBusy?.()) return;
      if (this.state.plan?.weekly_supplement_ids?.length
        && !global.confirm('提交后，新增事项将同步至本月计划。是否提交专业周报？')) return;
      this.publishing = true;
      this.error = '';
      this.notice = '';
      const planRevision=this.state.plan?.revision;
      if (!this.publishAttempt || this.publishAttempt.revision !== this.state.revision || this.publishAttempt.plan_id !== this.planId
        || this.publishAttempt.plan_revision!==planRevision) {
        this.publishAttempt = {plan_id:this.planId, revision:this.state.revision, operation_id:uuid()};
        if(planRevision!==undefined)this.publishAttempt.plan_revision=planRevision;
        const ids = this.config.attachmentIds?.() || [];
        if (ids.length || this.state.withdrawn_revision != null) {
          Object.assign(this.publishAttempt, {attachment_ids:ids, period:this.config.period});
        }
      }
      const number = ++this.requestNumber;
      this.paint();
      try {
        const next = await this.request('publish', this.publishAttempt, this.controller.signal);
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

    async withdrawReport() {
      const report = this.state?.report;
      if (this.closed || this.withdrawingReport || this.withdrawReportButton.disabled || !report || !this.state.can_withdraw
        || this.config.attachmentBusy?.()) return;
      if (!global.confirm('撤回后，本周周报将从已提交结果中收起，协同人员可继续修改。修改完成后由负责人重新提交。是否撤回？')) return;

      const reportId = String(report.id), revision = this.state.revision;
      if (this.withdrawAttempt?.report_id !== reportId || this.withdrawAttempt.revision !== revision) {
        this.withdrawAttempt = {report_id:reportId, revision, operation_id:uuid()};
      }
      this.withdrawingReport = true;
      this.error = '';
      this.notice = '';
      const number = ++this.requestNumber;
      this.paint();
      try {
        const next = await this.request('withdraw', this.withdrawAttempt, this.controller.signal);
        if (this.closed) return;
        this.accept(next, number);
        this.withdrawAttempt = null;
        this.publishAttempt = null;
        if (!this.state?.report) this.config.notify('周报已撤回，组员可以继续修改。');
      } catch (error) {
        if (this.closed) return;
        if (error.status && error.status < 500 && error.status !== 429) this.withdrawAttempt = null;
        if (error.status === 409) {
          this.notice = error.message;
          this.reconnect();
        } else this.failed(error);
      } finally {
        this.withdrawingReport = false;
        if (!this.closed) { this.paint(); this.scheduleSend(); }
      }
    }

    async showResult() {
      const report = this.state?.report;
      if (!report || this.openingResult || this.withdrawingReport) return;
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

    paintMonth() {
      const plan=this.selectedMonthPlan(), next=this.state?.month_plans?.next;
      const itemPlan=this.selectedItemPlan();
      const current=this.state?.month_plans?.current || this.state?.plan;
      const isNext=this.activeMonth==='next';
      const busy=this.savingItem || this.confirmingMonth || this.withdrawingReport || this.publishing;
      const waiting=!!(this.queue.length || this.sending || this.isComposing());
      for(const button of this.monthButtons){
        const nextButton=button.dataset.planMonth==='next';
        const selected=button.dataset.planMonth===this.activeMonth;
        const month=nextButton?next?.month:current?.month ?? this.target.week.slice(0,7);
        button.hidden=nextButton && !next;
        button.classList.toggle('primary',selected);button.setAttribute('aria-pressed',String(selected));
        button.textContent=(nextButton?'准备下月':'本月')+(month?' '+month:'');
        button.disabled=busy;
      }
      this.table.hidden=isNext;
      this.nextTable.hidden=!isNext;
      if(isNext)this.showNextMonth(plan);
      this.monthStatus.textContent=plan?.legacyWeek
        ? '本周沿用已登记的事项。'
        : plan?.confirmed || plan && !plan.unplanned
          ? plan.month+' 月计划已确认'+(plan.confirmed_name?' · '+plan.confirmed_name:'')
            +(plan.confirmed_at && this.config.formatTime?' · '+this.config.formatTime(plan.confirmed_at):'')
          : plan?.unavailable?'当前成员无法读取该月计划。'
            : plan?.confirmation_conflict?'该月另有已确认计划，当前共同编制的事项已保留，请核对确认版本。'
              : plan?'组员共同编制'+(isNext?'下月':'本月')+'计划，负责人可在核对后确认。':'';
      this.confirmButton.hidden=!plan?.can_confirm;
      this.confirmButton.disabled=!this.online || busy || waiting || this.itemFormOpen;
      this.confirmButton.textContent=isNext?'确认下月计划':'确认本月计划';
      this.withdrawButton.hidden=!plan?.can_withdraw;
      this.withdrawButton.disabled=this.confirmButton.disabled;
      this.addItemButton.hidden=!itemPlan?.can_edit || !!this.itemFormOpen;
      this.addItemButton.disabled=busy || waiting || !this.online;
      this.addItemButton.textContent=itemPlan?.weeklySupplement?'＋ 新增本周事项':'＋ 增加事项';
      this.itemForm.hidden=!this.itemFormOpen || !itemPlan;
      const form=this.itemForm.querySelector('form');
      form.querySelector('[data-weekly-item-help]').hidden=!this.openItemFormScope?.startsWith('week:');
      for(const field of form.elements)field.disabled=busy;
      form.querySelector('[type=submit]').disabled=!itemPlan?.can_edit || !this.online || busy || waiting;
      form.querySelector('[data-delete-item]').disabled=!itemPlan?.can_edit || !this.online || busy || waiting;
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
      else if (this.withdrawingReport) { state = 'pending'; text = '正在撤回专业周报…'; }
      else if (next.status !== 'ready') {
        state = next.status === 'published' ? 'saved' : 'blocked';
        text = statusMessages[next.status] || '当前周无法协同填报。';
        if (next.withdraw_blocked) text += ' 这份周报已有事项申报，需联系管理员处理。';
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
      this.paintMonth();
      this.toolbar.hidden = this.activeMonth==='next' || !editable || !this.editors.size;
      this.footer.hidden = this.activeMonth==='next' || !(next?.plan || next?.report);
      this.publishButton.hidden = !next?.can_publish;
      this.publishButton.disabled = !editable || !this.online || Boolean(pending || message || this.sending || this.savingItem || this.confirmingMonth || this.itemFormOpen || this.isComposing());
      this.attachments.hidden = this.activeMonth==='next' || !next?.can_publish;
      if (next?.can_publish) {
        const count = this.config.attachmentIds?.().length || 0;
        const label = count ? '随专业周报提交 ' + count + ' 件已选附件。' : '可在本页上传并选入周报附件。';
        if (this.attachments.textContent !== label) this.attachments.textContent = label;
      }
      this.resultButton.hidden = !next?.report;
      this.resultButton.disabled = Boolean(this.withdrawingReport);
      this.withdrawReportButton.hidden = !next?.can_withdraw;
      this.withdrawReportButton.disabled = !this.online || Boolean(this.withdrawingReport || this.publishing || this.openingResult || this.confirmingMonth
        || this.savingItem || this.sending || this.isComposing());
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
      if(this.resizeFrame!=null)global.cancelAnimationFrame(this.resizeFrame);
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
