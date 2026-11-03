/* First-login password gate. The server independently blocks business APIs. */
(function (global) {
  'use strict';

  var active = null;
  function close() {
    var state = active;
    if (!state) return;
    active = null;
    if (state.controller) state.controller.abort();
    if (state.timer) global.clearTimeout(state.timer);
    state.form.reset();
    document.removeEventListener('keydown', state.keydown, true);
    document.removeEventListener('focusin', state.focusin, true);
    state.overlay.remove();
    document.body.style.overflow = state.bodyOverflow;
    if (state.root) {
      state.root.inert = state.rootInert;
      if (state.rootAria === null) state.root.removeAttribute('aria-hidden');
      else state.root.setAttribute('aria-hidden', state.rootAria);
    }
    if (state.previousFocus && state.previousFocus.isConnected) state.previousFocus.focus();
  }

  function show(options) {
    close();
    if (!options || !options.session || !options.session.user || !options.session.user.must_change_password) return false;
    if (typeof options.isCurrent !== 'function' || typeof options.onSuccess !== 'function' || typeof options.onLogout !== 'function') {
      throw new Error('改密页面缺少会话处理方法');
    }
    var overlay = document.createElement('div');
    overlay.className = 'password-change-overlay';
    overlay.innerHTML = '<section class="password-change-card" role="dialog" aria-modal="true" aria-labelledby="password-change-title" aria-describedby="password-change-description">'
      + '<div class="password-change-mark" aria-hidden="true">密</div><h1 id="password-change-title">设置新的登录密码</h1>'
      + '<p id="password-change-description">首次登录请先修改初始密码，再继续使用系统。</p>'
      + '<form class="password-change-form"><label for="password-change-current">当前密码</label>'
      + '<input id="password-change-current" name="currentPassword" type="password" autocomplete="current-password" required maxlength="128" placeholder="请输入当前密码">'
      + '<label for="password-change-new">新密码</label><input id="password-change-new" name="newPassword" type="password" autocomplete="new-password" required minlength="6" maxlength="128" aria-describedby="password-change-policy" placeholder="请输入新密码">'
      + '<p id="password-change-policy" class="password-change-policy">6 至 128 个字符，可使用纯数字。</p>'
      + '<label for="password-change-confirm">确认新密码</label><input id="password-change-confirm" name="confirmPassword" type="password" autocomplete="new-password" required minlength="6" maxlength="128" placeholder="请再次输入新密码">'
      + '<div class="password-change-message" role="status" aria-live="polite"></div>'
      + '<button class="password-change-submit" type="submit">确认修改并进入系统</button>'
      + '<button class="password-change-logout" type="button">退出登录</button></form></section>';
    var state = {overlay: overlay, form: overlay.querySelector('form'), options: options, busy: false, loggingOut: false,
      controller: null, timer: null, retryAt: 0, root: document.getElementById('root'), previousFocus: document.activeElement,
      bodyOverflow: document.body.style.overflow};
    state.currentInput = overlay.querySelector('[name="currentPassword"]');
    state.newInput = overlay.querySelector('[name="newPassword"]');
    state.confirmInput = overlay.querySelector('[name="confirmPassword"]');
    state.message = overlay.querySelector('.password-change-message');
    state.submit = overlay.querySelector('.password-change-submit');
    state.logout = overlay.querySelector('.password-change-logout');
    state.rootInert = state.root ? state.root.inert : false;
    state.rootAria = state.root ? state.root.getAttribute('aria-hidden') : null;
    active = state;
    function current() {
      if (active !== state) return false;
      try { return !!options.isCurrent(); } catch (error) { return false; }
    }
    function message(text) { state.message.textContent = text; }
    function update() {
      if (!current()) return;
      var waiting = Date.now() < state.retryAt;
      state.submit.disabled = state.busy || state.loggingOut || waiting;
      state.submit.textContent = state.busy ? '正在修改…' : '确认修改并进入系统';
      state.logout.disabled = state.loggingOut;
      [state.currentInput, state.newInput, state.confirmInput].forEach(function (input) { input.disabled = state.busy || state.loggingOut; });
      state.form.setAttribute('aria-busy', state.busy || state.loggingOut ? 'true' : 'false');
    }
    state.keydown = function (event) {
      if (active !== state) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); return; }
      if (event.key !== 'Tab') return;
      var focusable = Array.prototype.filter.call(overlay.querySelectorAll('input,button'), function (element) { return !element.disabled; });
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    state.focusin = function (event) {
      if (active === state && !overlay.contains(event.target)) (state.busy ? state.logout : state.currentInput).focus();
    };
    state.form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (!current() || state.busy || state.loggingOut || Date.now() < state.retryAt) return;
      var previous = state.currentInput.value, password = state.newInput.value;
      if (!previous) { message('请输入当前密码'); state.currentInput.focus(); return; }
      if (password.length < 6 || password.length > 128) {
        message('新密码须为 6 至 128 个字符，可使用纯数字'); state.newInput.focus(); return;
      }
      if (password === previous) { message('新密码不能与当前密码相同'); state.newInput.focus(); return; }
      if (password !== state.confirmInput.value) { message('两次输入的新密码不一致'); state.confirmInput.focus(); return; }
      state.busy = true; state.retryAt = Date.now() + 1500; message(''); update();
      state.controller = new global.AbortController();
      try {
        var response = await global.fetch('/api/auth/change-password', {method: 'POST', credentials: 'same-origin', signal: state.controller.signal,
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify({currentPassword: previous, newPassword: password})});
        previous = password = null;
        var result;
        try { result = await response.json(); } catch (error) { throw new Error('服务器响应异常，请稍后重试'); }
        if (!current() || state.loggingOut) return;
        if (!response.ok || !result || result.error) {
          message(result && result.error && result.error.message || '密码修改失败，请稍后重试'); return;
        }
        var session = result.data && result.data.session;
        if (!session || !session.user || session.user.id !== options.session.user.id || session.user.must_change_password !== false) {
          message('未能确认密码修改结果，请退出后重新登录'); return;
        }
        state.form.reset();
        close();
        await options.onSuccess(session);
      } catch (error) {
        if (current() && !state.loggingOut && error.name !== 'AbortError') message(error.message && error.message !== 'Failed to fetch' ? error.message : '无法连接服务器，请检查网络后重试');
      } finally {
        previous = password = null;
        if (current()) {
          state.busy = false; state.controller = null; update();
          if (Date.now() < state.retryAt) state.timer = global.setTimeout(update, state.retryAt - Date.now());
        }
      }
    });
    state.logout.addEventListener('click', async function () {
      if (!current() || state.loggingOut) return;
      state.loggingOut = true;
      if (state.controller) state.controller.abort();
      state.form.reset(); message('正在退出…'); update();
      try {
        await options.onLogout();
        if (active === state) close();
      } catch (error) {
        if (!current()) return;
        state.loggingOut = false; state.busy = false; message('退出失败，请检查网络后重试'); update();
      }
    });
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', state.keydown, true);
    document.addEventListener('focusin', state.focusin, true);
    state.currentInput.focus();
    if (state.root) { state.root.inert = true; state.root.setAttribute('aria-hidden', 'true'); }
    return true;
  }
  global.PasswordChange = {show: show, close: close};
})(window);
