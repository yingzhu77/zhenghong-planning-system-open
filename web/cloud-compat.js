/* Browser client for the self-hosted API. Requests stay on the current origin. */
(function (global) {
  'use strict';

  function failure(message, code) { return { data: null, error: { message: message, code: code || 'CLIENT_ERROR' } }; }
  async function request(path, options) {
    var opts = Object.assign({ method: 'POST', credentials: 'same-origin' }, options || {});
    if (opts.json !== undefined) {
      opts.headers = Object.assign({}, opts.headers, { 'Content-Type': 'application/json' });
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    try {
      var response = await global.fetch(path, opts);
      var result;
      try { result = await response.json(); }
      catch (e) { return failure('服务器返回了无法识别的响应，请联系管理员。', 'INVALID_RESPONSE'); }
      if (!result || typeof result !== 'object' || !Object.prototype.hasOwnProperty.call(result, 'error')) {
        return failure('服务器响应格式不正确，请联系管理员。', 'INVALID_RESPONSE');
      }
      if (!response.ok && !result.error) return failure('请求失败（HTTP ' + response.status + '）', 'HTTP_' + response.status);
      return result;
    } catch (e) {
      return failure('无法连接服务器，请检查网络后重试。', 'NETWORK_ERROR');
    }
  }

  function query(table) {
    var body = { table: table, operation: 'select', filters: [], order: [], columns: '*', returning: false };
    var pending = null;
    function execute() {
      if (!pending) pending = request('/api/db', { json: body });
      return pending;
    }
    var q = {
      select: function (columns) {
        body.columns = columns || '*';
        if (body.operation !== 'select') body.returning = true;
        return q;
      },
      insert: function (values) { body.operation = 'insert'; body.values = values; return q; },
      update: function (values) { body.operation = 'update'; body.values = values; return q; },
      upsert: function (values, options) {
        body.operation = 'upsert'; body.values = values;
        body.onConflict = options && options.onConflict;
        return q;
      },
      delete: function () { body.operation = 'delete'; return q; },
      eq: function (column, value) { body.filters.push({ column: column, value: value }); return q; },
      order: function (column, options) { body.order.push({ column: column, ascending: !options || options.ascending !== false }); return q; },
      limit: function (limit) { body.limit = Number(limit); return q; },
      then: function (resolve, reject) { return execute().then(resolve, reject); },
      catch: function (reject) { return execute().catch(reject); },
      finally: function (callback) { return execute().finally(callback); }
    };
    return q;
  }

  function cleanPath(path) {
    var value = String(path || '');
    if (!value || value.charAt(0) === '/' || value.indexOf('\\') >= 0 || value.split('/').some(function (part) { return !part || part === '.' || part === '..'; })) {
      throw new Error('文件路径格式不正确');
    }
    return value;
  }
  function fileUrl(path) { return '/api/files/' + cleanPath(path).split('/').map(encodeURIComponent).join('/'); }

  function createWorkBuddyCloud() {
    var listeners = [];
    function emit(event) { listeners.slice().forEach(function (fn) { fn(event); }); }
    var auth = {
      signInWithPassword: function (values) { return request('/api/auth/login', { json: values }); },
      signOut: async function () {
        var result = await request('/api/auth/logout', { json: {} });
        if (!result.error) emit('SIGNED_OUT');
        return result;
      },
      getSession: function () { return request('/api/auth/session', { method: 'GET' }); },
      getUser: async function () {
        var result = await auth.getSession();
        if (result.error) return result;
        return { data: { user: result.data && result.data.session ? result.data.session.user : null }, error: null };
      },
      sendOtp: function (values) {
        return request('/api/auth/otp/send', { json: { email: values.email, purpose: values.purpose || 'login' } });
      },
      verifyOtp: function (values) { return request('/api/auth/otp/verify', { json: values }); },
      resetPasswordForEmail: async function (email) {
        var started = await request('/api/auth/password/reset/start', { json: { email: email } });
        if (started.error) return started;
        var verificationId = started.data && started.data.verificationId;
        if (!verificationId) return failure('未取得密码重置凭证，请重试。', 'INVALID_RESPONSE');
        return { data: {
          verificationId: verificationId,
          updateUser: function (values) {
            return request('/api/auth/password/reset/complete', { json: {
              email: email, verificationId: verificationId, token: values.nonce, password: values.password
            } });
          }
        }, error: null };
      },
      onAuthStateChange: function (callback) {
        listeners.push(callback);
        return { data: { subscription: { unsubscribe: function () { listeners = listeners.filter(function (fn) { return fn !== callback; }); } } } };
      }
    };
    return {
      database: { from: query },
      auth: auth,
      storage: {
        sharedPath: function (uid, path) { return cleanPath(path); },
        from: function (bucket) {
          if (bucket !== 'runtime') throw new Error('不支持的文件存储空间');
          return {
            upload: function (path, file) {
              var form = new global.FormData();
              form.append('path', cleanPath(path)); form.append('file', file);
              return request('/api/files/upload', { body: form });
            },
            getPublicUrl: function (path) { return { data: { publicUrl: fileUrl(path) }, error: null }; }
          };
        }
      }
    };
  }

  global.WorkBuddyCloud = { createWorkBuddyCloud: createWorkBuddyCloud };
})(window);
