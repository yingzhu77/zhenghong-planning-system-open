/* Period report attachments. Files stay on the server; drafts contain UUIDs only. */
(function (global) {
  'use strict';
  var cfg, S, key, stateRef, sessionRef, operation = null, notices = [], storageLimit = false, previewElement, previousFocus;
  var FILE_LIMIT = 8 * 1024 * 1024, TOTAL_LIMIT = 40 * 1024 * 1024, COUNT_LIMIT = 20;
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var EXTENSION = /\.(?:png|jpe?g|gif|webp|pdf|docx?|xlsx?)$/i;
  var ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.doc,.docx,.xls,.xlsx';
  function scopeKey(state) {
    return JSON.stringify([state.uid, state.profile && state.profile.role, state.profile && state.profile.biz_line, state.pmProject, state.pmPeriod, state.pmLine || '综合',state.pmScopeId || '']);
  }
  function configure(options) {
    var nextKey = scopeKey(options.S);
    if (key !== nextKey || stateRef !== options.S || sessionRef !== options.S.session) {
      operation = null; notices = []; storageLimit = false; closePreview();
      key = nextKey; stateRef = options.S; sessionRef = options.S.session;
    }
    cfg = options; S = options.S;
  }
  function esc(value) { return cfg.esc(value == null ? '' : String(value)); }
  function editable() { return !!(S && S.profile && S.profile.role === 'pm' && S.profile.status === 'approved' && S.uid && S.pmProject && S.pmPeriod
    && (!cfg.canEditScope || cfg.canEditScope())); }
  function metadata() { return Array.isArray(S.reportAttachments) ? S.reportAttachments : []; }
  function metadataById() {
    var found = {};
    metadata().forEach(function (row) { if (row && typeof row.id === 'string' && UUID.test(row.id)) found[row.id] = row; });
    return found;
  }
  function ownScope(row) {
    return row && row.owner_id === S.uid && row.project_id === S.pmProject && row.period === S.pmPeriod && (row.line || '综合') === (S.pmLine || '综合')
      && (row.report_scope_id || '') === (S.pmScopeId || '');
  }
  function library() { return metadata().filter(ownScope); }
  function ids() { return Array.isArray(S.attachmentIds) ? S.attachmentIds.slice() : []; }
  function prepare() {
    var biz = S.pmReport && S.pmReport.biz;
    S.attachmentIds = biz && Object.prototype.hasOwnProperty.call(biz, 'attachments')
      ? (Array.isArray(biz.attachments) ? biz.attachments.slice() : biz.attachments) : [];
    notices = []; storageLimit = false;
  }
  /* Selection changes are handled immediately by toggle/upload, without File objects. */
  function capture() { return ids(); }
  function isUploading() { return !!(operation && S === operation.state && S.uid === operation.uid && S.session === operation.session && scopeKey(S) === operation.key); }
  function referenceError(list) {
    if (!Array.isArray(list) || list.some(function (id) { return typeof id !== 'string' || !UUID.test(id); })) return '附件记录格式异常，请刷新数据后重新核对。';
    if (new Set(list).size !== list.length) return '附件记录包含重复文件，请刷新数据后重新核对。';
    if (list.length > COUNT_LIMIT) return '每期最多选入 20 件附件，请先移除多余附件。';
    return '';
  }
  function selectedSize(list, found) {
    return list.reduce(function (sum, id) { return sum + (found[id] && Number(found[id].size) || 0); }, 0);
  }
  function validationError() {
    if (isUploading()) return '附件正在处理，请等待处理完成后再提交。';
    var issue = referenceError(S.attachmentIds === undefined ? [] : S.attachmentIds);
    if (issue) return issue;
    var list = ids(), found = metadataById();
    if (list.some(function (id) { return !found[id] || !Number.isSafeInteger(found[id].size) || found[id].size < 1; })) return '部分附件资料尚未加载，请刷新数据后再提交。';
    if (editable() && list.some(function (id) { return !ownScope(found[id]); })) return '所选附件不属于当前本人填报范围，请移除后重新选入。';
    if (selectedSize(list, found) > TOTAL_LIMIT) return '本期选入附件合计不能超过 40 MiB，请先移除部分附件。';
    return '';
  }
  function sizeText(value) {
    var n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '大小待加载';
    if (!n) return '0 MiB';
    return n < 1024 * 1024 ? Math.max(1, Math.ceil(n / 1024)) + ' KiB' : (Math.round(n / 1024 / 1024 * 10) / 10) + ' MiB';
  }
  function kind(row) {
    var mime = row && row.mime || '', name = row && row.name || '';
    if (/^image\/(?:png|jpeg|gif|webp)$/i.test(mime)) return 'image';
    if (mime === 'application/pdf') return 'pdf';
    if (/\.docx?$/i.test(name)) return 'word';
    if (/\.xlsx?$/i.test(name)) return 'excel';
    return 'file';
  }
  function kindLabel(row) { return { image: '图片', pdf: 'PDF', word: 'Word', excel: 'Excel', file: '附件' }[kind(row)]; }
  function url(id) { return '/api/report-attachments/' + id; }
  function downloadLink(id, row) {
    return '<a class="btn ghost sm" href="' + url(id) + '" download="' + esc(row && row.name || '') + '" target="_blank" rel="noopener noreferrer">下载' + (row ? kindLabel(row) : '') + '</a>';
  }
  function fileCard(id, row, selected, readOnly, linksOnly) {
    if (typeof id !== 'string' || !UUID.test(id)) return '';
    var name = row && row.name || '附件详情待加载', type = row && kind(row), inline = !linksOnly && row && row.inline === true && (type === 'image' || type === 'pdf');
    return '<article class="report-attachment-file' + (selected ? ' is-selected' : '') + '" data-attachment-id="' + id + '">'
      + (inline && type === 'image' ? '<button type="button" class="report-attachment-thumb" onclick="ReportAttachments.preview(\'' + id + '\')" aria-label="预览' + esc(name) + '">'
        + '<img src="' + url(id) + '" alt="' + esc(name) + '" width="96" height="72" loading="lazy" decoding="async"></button>'
        : '<div class="report-attachment-icon" aria-hidden="true">' + (row ? kindLabel(row) : '附件') + '</div>')
      + '<div class="report-attachment-info"><b>' + esc(name) + '</b><span class="muted">' + (row ? kindLabel(row) + ' · ' + sizeText(row.size) : '资料尚未加载') + '</span>'
      + '<div class="report-attachment-links">' + (inline ? '<button type="button" class="btn ghost sm" onclick="ReportAttachments.preview(\'' + id + '\')">' + (type === 'pdf' ? '预览 PDF' : '查看大图') + '</button>' : '')
      + downloadLink(id, row)
      + (!readOnly && !selected && row && ownScope(row) && row.referenced === false
        ? '<button type="button" class="btn ghost sm report-attachment-discard" onclick="ReportAttachments.discard(\'' + id + '\')" aria-label="永久删除未提交文件' + esc(name) + '"' + (isUploading() ? ' disabled' : '') + '>删除未提交文件</button>' : '')
      + '</div></div>'
      + (!readOnly ? '<label class="report-attachment-select"><input type="checkbox" aria-label="将' + esc(name) + '选入本期填报" onchange="ReportAttachments.toggle(\'' + id + '\',this.checked)"'
        + (selected ? ' checked' : '') + (isUploading() ? ' disabled' : '') + '><span>' + (selected ? '已选入' : '选入本期') + '</span></label>' : '') + '</article>';
  }
  function formHtml() {
    var list = ids(), found = metadataById(), selected = {}, available;
    list.forEach(function (id) { selected[id] = true; });
    available = library().filter(function (row) { return !selected[row.id]; });
    var issue = isUploading() ? '' : validationError();
    return '<section class="card report-attachments" id="report-attachments"><div class="cardhd"><h3>五、附件资料</h3>'
      + '<span class="hint">当前选入 ' + list.length + ' / 20 件 · ' + sizeText(selectedSize(list, found)) + ' / 40 MiB</span></div>'
      + '<p class="muted">支持图片（JPG、PNG、GIF、WebP）、PDF、Word、Excel；单件不超过 8 MiB。附件随本期填报提交，上传后仍需提交报告；移除选入不会删除已经提交的历史附件。</p>'
      + (editable() ? '<label class="btn ghost report-attachment-upload' + (isUploading() ? ' is-disabled' : '') + '"><input type="file" id="report-attachment-upload" multiple accept="' + ACCEPT + '" onchange="ReportAttachments.upload(this)"'
        + (isUploading() ? ' disabled' : '') + '><span>' + (isUploading() ? '附件处理中…' : '选择文件上传') + '</span></label>' : '')
      + (issue ? '<p class="report-attachment-error" role="alert">' + esc(issue) + '</p>' : '')
      + (isUploading() ? '<p class="report-attachment-progress" role="status" aria-live="polite">' + (operation.type === 'discard-inaccessible'
        ? '正在清理已撤销项目的未提交草稿' : operation.type === 'discard' ? '正在删除未提交文件 ' + esc(operation.name)
          : '正在上传 ' + esc(operation.name) + '（' + operation.position + ' / ' + operation.total + '）') + '，完成后可提交报告。</p>' : '')
      + (notices.length ? '<ul class="report-attachment-results" role="status">' + notices.map(function (entry) { return '<li class="' + (entry.error ? 'is-error' : 'is-success') + '">' + esc(entry.name) + '：' + esc(entry.message) + '</li>'; }).join('') + '</ul>' : '')
      + (editable() && storageLimit ? '<div class="report-attachment-restricted-cleanup"><p>如果以前上传的项目已撤销你的读取权限，可清理其中本人尚未提交的草稿；已提交附件和历史记录保留。</p>'
        + '<button type="button" class="btn ghost sm report-attachment-discard" onclick="ReportAttachments.discardInaccessible()"' + (isUploading() ? ' disabled' : '') + '>清理已撤销项目的未提交草稿</button></div>' : '')
      + (list.length ? '<div class="report-attachment-list">' + list.map(function (id) { return fileCard(id, found[id], true, !editable()); }).join('') + '</div>' : '<div class="empty">本期尚未选入附件。</div>')
      + '<p class="muted report-attachment-inventory">本人所有项目与周期的未提交草稿最多保留 100 件、合计 200 MiB。可切换对应项目／周期，删除不再需要的未提交文件。</p>'
      + (available.length ? '<details class="report-attachment-library"><summary>已上传但未选入本期的文件（' + available.length + ' 件）</summary><p class="muted">可重新选入；未曾用于提交的文件可以永久删除，已经提交的文件保留历史。</p><div class="report-attachment-list">'
        + available.map(function (row) { return fileCard(row.id, row, false, !editable()); }).join('') + '</div></details>' : '')
      + '</section>';
  }
  function repaint() { if (cfg.flush) cfg.flush(); if (cfg.render) cfg.render(); }
  function remember() {
    if (cfg.saveDraft) {
      try { cfg.saveDraft(); }
      catch (_) { cfg.toast('附件变更未能保存到本机草稿，请核对附件列表并重试保存。', 'err'); }
    }
  }
  function toggle(id, checked) {
    if (!editable() || isUploading() || typeof id !== 'string' || !UUID.test(id)) return;
    var found = metadataById(), before = ids();
    if (checked && (!found[id] || !ownScope(found[id]))) return cfg.toast('该文件不在当前本人填报范围，请刷新附件资料。', 'err');
    if (cfg.flush) cfg.flush();
    S.attachmentIds = before.filter(function (value) { return value !== id; });
    if (checked) S.attachmentIds.push(id);
    var issue = validationError();
    if (issue) { S.attachmentIds = before; cfg.toast(issue, 'err'); }
    else remember();
    repaint();
  }
  function fileError(file) {
    if (!file || typeof file.name !== 'string' || !EXTENSION.test(file.name)) return '不支持此文件格式，请选择图片、PDF、Word 或 Excel。';
    if (!Number.isSafeInteger(file.size) || file.size < 1) return '文件为空或大小无法读取。';
    if (file.size > FILE_LIMIT) return '单件文件不能超过 8 MiB。';
    return '';
  }
  function current(op) { return operation === op && stateRef === op.state && S.uid === op.uid && S.session === op.session && scopeKey(S) === op.key; }
  async function upload(input) {
    if (!editable() || isUploading()) return;
    var files = Array.prototype.slice.call(input && input.files || []);
    if (input) input.value = '';
    if (!files.length) return;
    var issue = validationError();
    if (issue) return cfg.toast(issue, 'err');
    notices = []; storageLimit = false;
    var valid = files.filter(function (file) {
      var error = fileError(file);
      if (error) notices.push({name:file && file.name || '未命名文件',message:error,error:true});
      return !error;
    });
    var chosen = ids(), found = metadataById();
    if (chosen.length + valid.length > COUNT_LIMIT || selectedSize(chosen, found) + valid.reduce(function (sum, file) { return sum + file.size; }, 0) > TOTAL_LIMIT) {
      cfg.toast('本批文件加上当前选入会超过 20 件或 40 MiB，请先移除部分选入，或减少本批文件。', 'err');
      repaint(); return;
    }
    if (!valid.length) { repaint(); return; }
    if (cfg.flush) cfg.flush();
    var active = cfg, op = {type:'upload',key:scopeKey(S),uid:S.uid,session:S.session,state:S,project:S.pmProject,period:S.pmPeriod,line:S.pmLine || '综合',reportScopeId:S.pmScopeId || '',position:0,total:valid.length,name:''};
    operation = op;
    try {
      for (var i = 0; i < valid.length; i++) {
        if (!current(op)) break;
        var file = valid[i]; op.position = i + 1; op.name = file.name; repaint();
        try {
          var endpoint = '/api/report-attachments/upload?project_id=' + encodeURIComponent(op.project) + '&period=' + encodeURIComponent(op.period)
            + '&line=' + encodeURIComponent(op.line) + '&filename=' + encodeURIComponent(file.name)+(op.reportScopeId?'&report_scope_id='+encodeURIComponent(op.reportScopeId):'');
          var response = await (active.fetch || global.fetch)(endpoint, {method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type || 'application/octet-stream'},body:file});
          var result = await response.json();
          if (!current(op)) break;
          if (!response.ok || result.error) {
            var failure = new Error(result.error && result.error.message || '上传失败（HTTP ' + response.status + '）');
            var full = result.error && result.error.code === 'draft_storage_limit';
            if (full) {
              storageLimit = true;
              failure.message += '；请先展开已上传但未选入的文件，删除不再需要的未提交文件后重试。如本页没有可删除文件，可切换之前上传的项目／周期清理。';
            }
            failure.stopUpload = response.status === 401 || response.status === 403 || full;
            throw failure;
          }
          var row = result.data;
          if (!row || !UUID.test(row.id || '') || !ownScope(row) || row.size !== file.size || !row.name || !row.mime) throw new Error('服务器返回的附件资料不完整，请刷新附件列表核对；已接收文件仍在服务器保留。');
          if (active.flush) active.flush();
          S.reportAttachments = metadata().filter(function (existing) { return existing.id !== row.id; }).concat([row]);
          if (ids().indexOf(row.id) < 0) S.attachmentIds = ids().concat([row.id]);
          notices.push({name:file.name,message:'上传成功，已选入本期；提交报告后生效。',error:false});
          remember();
        } catch (error) {
          if (!current(op)) break;
          notices.push({name:file.name,message:error && error.message || '无法连接服务器，请检查网络后重试。',error:true});
          if (error && error.stopUpload) break;
        }
        if (current(op)) repaint();
      }
    } finally {
      if (current(op)) { operation = null; repaint(); }
    }
  }
  async function discard(id) {
    if (!editable() || isUploading() || typeof id !== 'string' || !UUID.test(id)) return;
    var row = metadataById()[id];
    if (!row || !ownScope(row) || row.referenced !== false || ids().indexOf(id) >= 0) return cfg.toast('仅可删除本人当前范围中尚未提交且未选入的文件。', 'err');
    if (!global.confirm('永久删除未提交文件“' + row.name + '”？删除后无法恢复；已经提交的历史附件不会删除。')) return;
    if (cfg.flush) cfg.flush();
    var active = cfg, op = {type:'discard',key:scopeKey(S),uid:S.uid,session:S.session,state:S,name:row.name};
    operation = op; repaint();
    try {
      var response = await (active.fetch || global.fetch)('/api/report-attachments/discard', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})});
      var result = await response.json();
      if (!current(op)) return;
      if (!response.ok || result.error) throw new Error(result.error && result.error.message || '删除失败（HTTP ' + response.status + '）');
      if (!result.data || result.data.id !== id || result.data.discarded !== true) throw new Error('服务器未确认删除结果，请刷新附件列表核对。');
      if (active.flush) active.flush();
      S.reportAttachments = metadata().filter(function (existing) { return existing.id !== id; });
      S.attachmentIds = ids().filter(function (value) { return value !== id; });
      notices.push({name:row.name,message:'未提交文件已删除。',error:false});
      remember();
    } catch (error) {
      if (current(op)) notices.push({name:row.name,message:error && error.message || '无法连接服务器，请检查网络后重试删除。',error:true});
    } finally {
      if (current(op)) { operation = null; repaint(); }
    }
  }
  async function discardInaccessible() {
    if (!editable() || isUploading() || !storageLimit) return;
    if (!global.confirm('清理本人在已撤销项目读取权限范围内、从未用于提交的附件草稿？这些未提交文件删除后无法恢复；已提交附件、历史记录和当前可访问项目的文件不会删除。')) return;
    if (cfg.flush) cfg.flush();
    var active = cfg, op = {type:'discard-inaccessible',key:scopeKey(S),uid:S.uid,session:S.session,state:S};
    operation = op; repaint();
    try {
      var response = await (active.fetch || global.fetch)('/api/report-attachments/discard-inaccessible', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'});
      var result = await response.json();
      if (!current(op)) return;
      if (!response.ok || result.error) throw new Error(result.error && result.error.message || '清理失败（HTTP ' + response.status + '）');
      var data = result.data;
      if (!data || !Number.isSafeInteger(data.discarded_count) || data.discarded_count < 0 || !Number.isSafeInteger(data.freed_bytes) || data.freed_bytes < 0) throw new Error('服务器未确认清理结果，请稍后重试核对。');
      if (active.flush) active.flush();
      storageLimit = false;
      notices.push({name:'草稿清理',message:data.discarded_count ? '已清理 ' + data.discarded_count + ' 件未提交文件，释放 ' + sizeText(data.freed_bytes) + '。当前附件保持不变。'
        : '未发现可清理的已撤销项目草稿；请清理当前可访问项目中不再需要的未提交文件。',error:false});
      remember();
    } catch (error) {
      if (current(op)) notices.push({name:'草稿清理',message:error && error.message || '无法连接服务器，请检查网络后重试清理。',error:true});
    } finally {
      if (current(op)) { operation = null; repaint(); }
    }
  }
  function snapshotHtml(report, options) {
    var biz = report && report.biz;
    if (!biz || !Object.prototype.hasOwnProperty.call(biz, 'attachments')) return '';
    var list = biz.attachments, issue = referenceError(list), found = metadataById();
    if (!Array.isArray(list)) list = [];
    if (!list.length && !issue) return '';
    return '<section class="report-attachment-snapshot"><h4>附件资料<span class="chip">' + list.length + ' 件</span></h4>'
      + (issue ? '<p class="report-attachment-error" role="alert">' + esc(issue) + '</p>' : '')
      + '<div class="report-attachment-list">' + list.map(function (id) { return fileCard(id, found[id], true, true, options && options.linksOnly); }).join('') + '</div></section>';
  }
  function closePreview() {
    if (previewElement) { previewElement.remove(); previewElement = null; }
    if (global.document) global.document.removeEventListener('keydown', previewKeys);
    if (previousFocus && previousFocus.focus) previousFocus.focus();
    previousFocus = null;
  }
  function previewKeys(event) {
    if (event.key === 'Escape') closePreview();
    else if (event.key === 'Tab' && previewElement) {
      var items = previewElement.querySelectorAll('button,a[href],iframe'), first = items[0], last = items[items.length - 1];
      if (event.shiftKey && global.document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && global.document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }
  function preview(id) {
    if (typeof id !== 'string' || !UUID.test(id)) return;
    var row = metadataById()[id], type = row && kind(row);
    if (!row || row.inline !== true || (type !== 'image' && type !== 'pdf')) return;
    closePreview(); previousFocus = global.document.activeElement;
    previewElement = global.document.createElement('div'); previewElement.className = 'report-attachment-preview-overlay';
    previewElement.innerHTML = '<section class="report-attachment-preview" role="dialog" aria-modal="true" aria-label="' + esc(row.name) + '">'
      + '<header><b>' + esc(row.name) + '</b><div>' + downloadLink(id,row) + '<button type="button" class="btn ghost sm" data-close-attachment-preview>关闭预览</button></div></header>'
      + (type === 'image' ? '<div class="report-attachment-preview-image"><img src="' + url(id) + '" alt="' + esc(row.name) + '"></div>'
        : '<iframe src="' + url(id) + '" title="' + esc(row.name) + ' PDF 预览"></iframe><p class="muted">若浏览器无法显示 PDF，可使用上方下载。</p>') + '</section>';
    previewElement.addEventListener('click', function (event) {
      if (event.target === previewElement || event.target.closest('[data-close-attachment-preview]')) closePreview();
    });
    global.document.body.appendChild(previewElement); global.document.addEventListener('keydown',previewKeys);
    previewElement.querySelector('[data-close-attachment-preview]').focus();
  }
  global.ReportAttachments = {configure:configure,prepare:prepare,capture:capture,ids:ids,validationError:validationError,
    isUploading:isUploading,formHtml:formHtml,snapshotHtml:snapshotHtml,toggle:toggle,upload:upload,discard:discard,discardInaccessible:discardInaccessible,preview:preview,closePreview:closePreview};
})(window);
