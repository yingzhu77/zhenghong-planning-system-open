/* Restricted rich text model shared by editing, display and printing. No authored HTML. */
(function (global) {
  'use strict';
  var RED = '#d81e06', indexed = new WeakMap();
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function text(doc) { return doc.ops.map(function (op) { return op.insert; }).join(''); }
  function normalize(doc) {
    if (!doc || !Array.isArray(doc.ops)) return null;
    var ops = [];
    for (var i = 0; i < doc.ops.length; i++) {
      var op = doc.ops[i];
      if (!op || typeof op.insert !== 'string') return null;
      if (!op.insert) continue;
      var a = {}, input = op.attributes || {};
      if (input.bold === true) a.bold = true;
      if (String(input.color || '').toLowerCase() === RED) a.color = RED;
      var next = { insert: op.insert };
      if (Object.keys(a).length) next.attributes = a;
      var prev = ops[ops.length - 1];
      if (prev && JSON.stringify(prev.attributes || {}) === JSON.stringify(a)) prev.insert += next.insert;
      else ops.push(next);
    }
    return { ops: ops };
  }
  function slice(doc, start, end) {
    var offset = 0, ops = [];
    doc.ops.forEach(function (op) {
      var a = Math.max(0, start - offset), b = Math.min(op.insert.length, end - offset);
      if (b > a) ops.push(Object.assign({}, op, { insert: op.insert.slice(a, b) }));
      offset += op.insert.length;
    });
    return normalize({ ops: ops });
  }
  function fit(doc, value) {
    doc = normalize(doc); if (!doc) return null;
    var t = text(doc), s = String(value == null ? '' : value);
    if (t === s) return doc;
    if (t.trim() === s) return slice(doc, t.length - t.trimStart().length, t.trimEnd().length);
    return null;
  }
  function legacy(value) {
    var source = String(value == null ? '' : value), ops = [];
    function parse(s, attrs, depth) {
      if (depth > 8) { ops.push({ insert:s, attributes:attrs }); return; }
      var re = /\*\*|==/g, match, offset = 0;
      while ((match = re.exec(s))) {
        var mark = match[0], end = s.indexOf(mark, match.index + 2);
        if (end <= match.index + 2) continue;
        if (match.index > offset) ops.push({insert:s.slice(offset,match.index),attributes:attrs});
        var next = Object.assign({},attrs); next[mark === '**' ? 'bold' : 'color'] = mark === '**' ? true : RED;
        parse(s.slice(match.index+2,end),next,depth+1);
        offset = end+2; re.lastIndex = offset;
      }
      if (offset < s.length) ops.push({insert:s.slice(offset),attributes:attrs});
    }
    parse(source,{},0); return normalize({ops:ops});
  }
  function render(doc) {
    doc = normalize(doc); if (!doc) return '';
    return doc.ops.map(function (op) {
      var html = esc(op.insert).replace(/\n/g,'<br>'), a = op.attributes || {};
      if (a.bold) html = '<strong>' + html + '</strong>';
      if (a.color === RED) html = '<span class="rt-red">' + html + '</span>';
      return html;
    }).join('');
  }
  function valueAt(record, path) {
    return String(path).split('.').reduce(function (obj,key) { return obj == null ? undefined : obj[key]; },record);
  }
  function docFor(record, path) {
    if (!record || typeof record !== 'object') return null;
    var direct = record.rich_text && record.rich_text.fields && record.rich_text.fields[path];
    if (direct) return fit(direct,valueAt(record,path));
    var parts = String(path).split('.'), field = parts.pop(), owner = parts.length ? valueAt(record,parts.join('.')) : record;
    if (!owner || typeof owner !== 'object') return null;
    var map = owner._rich || indexed.get(owner);
    return map && fit(map[field],owner[field]);
  }
  function field(record,path,fallback) {
    var value = valueAt(record,path), doc = docFor(record,path);
    if (value == null || value === '') return esc(fallback == null ? '' : fallback);
    return render(doc || legacy(value));
  }
  function attach(record) {
    if (!record || typeof record !== 'object') return record;
    var fields = record.rich_text && record.rich_text.v === 1 && record.rich_text.fields || {};
    Object.keys(fields).forEach(function (path) {
      var parts = path.split('.'), key = parts.pop(), owner = parts.length ? valueAt(record,parts.join('.')) : record;
      if (!owner || typeof owner !== 'object') return;
      var doc = fit(fields[path],owner[key]); if (!doc) return;
      var map = indexed.get(owner) || {}; map[key] = doc; indexed.set(owner,map);
    });
    return record;
  }
  function copy(source,target,mapping) {
    if (!source || !target) return target;
    var map = mapping || Object.keys(source).reduce(function (out,key) { if (key !== '_rich') out[key] = key; return out; },{});
    Object.keys(map).forEach(function (key) {
      var doc = docFor(source,map[key]);
      if (doc) { if (!target._rich) target._rich={}; target._rich[key]=doc; }
    });
    return target;
  }
  function collect(record) {
    var fields = {};
    function walk(obj,prefix) {
      if (!obj || typeof obj !== 'object') return;
      Object.keys(obj._rich || {}).forEach(function (key) {
        var doc = fit(obj._rich[key],obj[key]);
        if (doc) fields[prefix+key] = doc;
      });
      delete obj._rich;
      Object.keys(obj).forEach(function (key) {
        if (key !== 'rich_text' && obj[key] && typeof obj[key] === 'object') walk(obj[key],prefix+key+'.');
      });
    }
    walk(record,''); record.rich_text = {v:1,fields:fields}; return record;
  }
  global.ZHRichText = { RED:RED, normalize:normalize, text:text, slice:slice, fit:fit, legacy:legacy, render:render, field:field, doc:docFor, attach:attach, copy:copy, collect:collect };
})(typeof window === 'undefined' ? globalThis : window);
