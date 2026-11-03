/* Existing inputs retain their plain-text values and IDs; personal formatting follows the selected text. */
(function (global) {
  'use strict';
  var mounted = new Map(), configured = false, floating = null;
  function personalInput(input) {
    var shell = input.closest && input.closest('.planning-shell');
    if (shell) return !shell.classList.contains('manager-shell');
    return !!(input.closest && input.closest('[data-shared-rich-editor],[data-personal-rich-editor]'));
  }
  function buttons(toolbar) {
    ['加粗', '标红', '清除格式'].forEach(function (label, index) {
      var button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.dataset.format = ['bold', 'red', 'clear'][index]; button.setAttribute('aria-label', label);
      if (index < 2) button.setAttribute('aria-pressed', 'false');
      button.addEventListener('pointerdown', function (event) { event.preventDefault(); }); toolbar.appendChild(button);
    });
  }
  function hideSelection() {
    if (!floating) return;
    floating.toolbar.hidden = true; floating.active = null;
  }
  function selectionToolbar() {
    if (floating) return floating;
    var toolbar = document.createElement('div'); toolbar.className = 'selection-format-toolbar'; toolbar.hidden = true;
    toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '所选文字格式'); buttons(toolbar);
    document.body.appendChild(toolbar); floating = { toolbar: toolbar, active: null, dismissed: null };
    toolbar.addEventListener('click', function (event) {
      var button = event.target.closest('button'), entry = floating.active;
      if (button && !button.disabled && entry && entry.input.isConnected) entry.format(button.dataset.format);
    });
    toolbar.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !floating.active) return;
      var entry = floating.active; floating.dismissed = { entry: entry, index: entry.range.index, length: entry.range.length };
      hideSelection(); entry.quill.focus(); event.preventDefault();
    });
    document.addEventListener('pointerdown', function (event) {
      if (!floating.active || toolbar.contains(event.target) || floating.active.quill.root.contains(event.target)) return;
      hideSelection();
    }, true);
    document.addEventListener('focusin', function (event) {
      if (!floating.active || toolbar.contains(event.target) || floating.active.quill.root.contains(event.target)) return;
      hideSelection();
    });
    function reposition() { if (floating.active && !toolbar.hidden) floating.active.refresh(); }
    global.addEventListener('resize', reposition);
    global.addEventListener('scroll', reposition, true);
    if (global.visualViewport) {
      global.visualViewport.addEventListener('resize', reposition);
      global.visualViewport.addEventListener('scroll', reposition);
    }
    return floating;
  }
  function showSelection(entry, range, composing) {
    var tools = selectionToolbar(), q = entry.quill;
    if (!entry.input.isConnected || !entry.editable() || composing || !range || !range.length || (!q.hasFocus() && !tools.toolbar.contains(document.activeElement))) {
      if (tools.active === entry) hideSelection();
      return;
    }
    var end = Math.min(range.length, Math.max(0, q.getLength() - 1 - range.index));
    if (!end) { if (tools.active === entry) hideSelection(); return; }
    var dismissed = tools.dismissed;
    if (dismissed && dismissed.entry === entry && dismissed.index === range.index && dismissed.length === range.length) return;
    tools.dismissed = null; tools.active = entry; tools.toolbar.hidden = false;
    tools.toolbar.querySelectorAll('button').forEach(function (button) { button.disabled = false; });
    var format = q.getFormat(range);
    tools.toolbar.querySelector('[data-format="bold"]').setAttribute('aria-pressed', String(format.bold === true));
    tools.toolbar.querySelector('[data-format="red"]').setAttribute('aria-pressed', String(format.color === global.ZHRichText.RED));
    var bounds = q.getBounds(range.index, end), box = q.container.getBoundingClientRect();
    if (!bounds) { hideSelection(); return; }
    var viewport = global.visualViewport, left = viewport ? viewport.offsetLeft : 0, top = viewport ? viewport.offsetTop : 0;
    var width = viewport ? viewport.width : global.innerWidth, height = viewport ? viewport.height : global.innerHeight;
    var toolbarBox = tools.toolbar.getBoundingClientRect(), x = box.left + bounds.left + bounds.width / 2 - toolbarBox.width / 2;
    var y = box.top + bounds.top - toolbarBox.height - 8;
    if (y < top + 8) y = box.top + bounds.bottom + 8;
    tools.toolbar.style.left = Math.max(left + 8, Math.min(left + width - toolbarBox.width - 8, x)) + 'px';
    tools.toolbar.style.top = Math.max(top + 8, Math.min(top + height - toolbarBox.height - 8, y)) + 'px';
  }
  function mount(root, binding) {
    if (!global.Quill || !global.ZHRichText || !root.querySelectorAll) return;
    var model = global.ZHRichText;
    if (!configured) {
      var Color = global.Quill.import('attributors/style/color');
      // Accept the browser's equivalent spelling of the one supported color.
      Color.canAdd = function (_, value) {
        var normalized = typeof value === 'string' ? value.toLowerCase().replace(/\s+/g, '') : '';
        return normalized === model.RED || normalized === 'rgb(216,30,6)';
      };
      global.Quill.register(Color, true); configured = true;
    }
    mounted.forEach(function (_, input) { if (!input.isConnected) mounted.delete(input); });
    if (floating && floating.active && !floating.active.input.isConnected) hideSelection();
    var placements = [];
    root.querySelectorAll('input[data-rich],textarea[data-rich]').forEach(function (input) {
      if (mounted.has(input)) return;
      var multiline = input.tagName === 'TEXTAREA', personal = personalInput(input);
      function editable() { return input.isConnected && !input.disabled && !input.readOnly && !input.matches(':disabled'); }
      if (!multiline) {
        // Hidden text inputs sanitize newlines; use a textarea with the same contract.
        var replacement = document.createElement('textarea');
        Array.from(input.attributes).forEach(function (attribute) { if (attribute.name !== 'type' && attribute.name !== 'value') replacement.setAttribute(attribute.name, attribute.value); });
        replacement.value = input.getAttribute('value') == null ? input.value : input.getAttribute('value');
        input.replaceWith(replacement); input = replacement;
      }
      var link = binding(input.id), saved = link && link.get(), initial = model.fit(saved, input.value) || model.legacy(input.value);
      var wrap = document.createElement('div'); wrap.className = 'rich-input'; wrap.dataset.richEditorFor = input.id;
      wrap.style.cssText = input.style.cssText; wrap.dataset.multiline = multiline ? 'true' : 'false';
      if (personal) { wrap.dataset.selectionRich = 'true'; selectionToolbar(); }
      var toolbar = document.createElement('div'); toolbar.className = 'rich-toolbar'; toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '文字格式'); buttons(toolbar);
      var editor = document.createElement('div'); editor.className = 'rich-surface';
      if (!personal) wrap.appendChild(toolbar);
      // Build editors off-document, then attach together to avoid a layout per Quill instance.
      wrap.appendChild(editor); input.hidden = true; input.classList.add('rich-source');
      var q = new global.Quill(editor, { readOnly: !editable(), formats: ['bold', 'color'], modules: { toolbar: false, history: { delay: 600, maxStack: 100, userOnly: true } }, placeholder: input.placeholder || '' });
      q.root.setAttribute('role', 'textbox'); q.root.setAttribute('aria-label', input.getAttribute('aria-label') || input.placeholder || '填报内容');
      q.root.setAttribute('aria-readonly', String(!editable()));
      q.root.setAttribute('aria-disabled', String(input.disabled || input.matches(':disabled')));
      toolbar.querySelectorAll('button').forEach(function (button) { button.disabled = !editable(); });
      q.root.setAttribute('aria-multiline', 'true'); q.setContents({ ops: initial.ops.concat([{ insert: '\n' }]) }, 'silent');
      var lastRange = { index: 0, length: 0 }, composing = false, entry;
      function currentDoc() {
        var doc = model.normalize(q.getContents());
        return model.slice(doc, 0, Math.max(0, model.text(doc).length - 1));
      }
      function sync(notify) {
        if (!editable()) return;
        var doc = currentDoc(); input.value = model.text(doc); if (link) link.set(doc);
        if (notify) input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      function state(range) {
        var format = q.getFormat(range || lastRange);
        toolbar.querySelector('[data-format="bold"]').setAttribute('aria-pressed', String(format.bold === true));
        toolbar.querySelector('[data-format="red"]').setAttribute('aria-pressed', String(format.color === model.RED));
        if (entry && (personal || floating && floating.active === entry)) showSelection(entry, range || q.getSelection() || lastRange, composing);
      }
      function applyFormat(action) {
        if (composing || !editable()) return;
        var range = q.getSelection() || lastRange;
        if (personal && !range.length) return hideSelection();
        var format = q.getFormat(range); q.setSelection(range, 'silent'); q.history.cutoff();
        if (range.length) {
          var attrs = action === 'clear' ? { bold: false, color: false } : action === 'bold' ? { bold: format.bold !== true } : { color: format.color === model.RED ? false : model.RED };
          q.formatText(range.index, range.length, attrs, 'user');
        } else if (action === 'clear') { q.format('bold', false, 'user'); q.format('color', false, 'user'); }
        else q.format(action === 'bold' ? 'bold' : 'color', action === 'bold' ? format.bold !== true : format.color === model.RED ? false : model.RED, 'user');
        q.history.cutoff(); q.setSelection(range, 'silent'); lastRange = range; entry.range = range; sync(true); state(range);
      }
      entry = { input: input, quill: q, range: lastRange, editable: editable, sync: sync, format: applyFormat, refresh: function () { state(q.getSelection() || lastRange); } };
      q.root.addEventListener('contextmenu', function (event) {
        var range = q.getSelection() || lastRange;
        if (composing || !editable() || !range || !range.length) return;
        event.preventDefault(); selectionToolbar().dismissed = null;
        q.setSelection(range, 'silent'); lastRange = range; entry.range = range;
        showSelection(entry, range, composing);
      });
      q.on('selection-change', function (range) {
        if (range) { lastRange = range; entry.range = range; state(range); }
        else if (personal && floating && floating.active === entry && !floating.toolbar.contains(document.activeElement)) hideSelection();
        else if (!personal) hideSelection();
      });
      q.on('text-change', function () { if (!composing) sync(true); state(); });
      q.root.addEventListener('focusin', function () { if (!personal) hideSelection(); });
      q.root.addEventListener('keydown', function (event) {
        if (personal && event.altKey && event.key === 'F10' && lastRange.length) {
          state(lastRange); if (floating && !floating.toolbar.hidden) floating.toolbar.querySelector('button').focus(); event.preventDefault();
        } else if (personal && event.key === 'Escape') { hideSelection(); }
      });
      q.root.addEventListener('compositionstart', function () { composing = true; if (personal) hideSelection(); });
      q.root.addEventListener('compositionend', function () { composing = false; queueMicrotask(function () { if (!input.isConnected) return; q.update('user'); sync(true); state(); }); });
      toolbar.addEventListener('click', function (event) { var button = event.target.closest('button'); if (button) applyFormat(button.dataset.format); });
      q.root.addEventListener('paste', function () { queueMicrotask(function () { if (input.isConnected) sync(true); }); });
      input.addEventListener('focus', function () { q.focus(); });
      mounted.set(input, entry); sync(false); q.history.clear();
      placements.push({ input: input, wrap: wrap });
    });
    placements.forEach(function (item) { item.input.after(item.wrap); });
  }
  function flush() {
    mounted.forEach(function (entry, input) { if (input.isConnected) entry.sync(false); else mounted.delete(input); });
    if (floating && floating.active && !floating.active.input.isConnected) hideSelection();
  }
  global.ZHRichEditor = { mount: mount, flush: flush };
})(window);
