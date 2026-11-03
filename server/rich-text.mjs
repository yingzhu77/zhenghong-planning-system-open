import { HttpError } from './errors.mjs';

// Formatting is a companion to the existing business strings. It never carries
// HTML, links, embeds, identity fields, dates, or authorization values.
export const RICH_TEXT_PATHS = Object.freeze({
  reports: /^(?:change_text|dev_text|projection|coord|decision|node_name|next_items\.(?:0|[1-9]\d*)|node_items\.(?:0|[1-9]\d*)\.(?:name|reason)|speed_items\.(?:0|[1-9]\d*)\.(?:act|gain|node|owner)|effect_items\.(?:0|[1-9]\d*)\.(?:act|target|node)|coord_items\.(?:0|[1-9]\d*)\.what|biz\.(?:nodes\.(?:0|[1-9]\d*)\.(?:name|prog)|items\.(?:0|[1-9]\d*)\.(?:mod|name|prog|blocker)|handover\.(?:0|[1-9]\d*)\.what|followups\.(?:0|[1-9]\d*)\.(?:what|progress)))$/,
  leader_reviews: /^note$/,
  leader_notes: /^what$/,
  milestones: /^note$/,
  coordination_tasks: /^what$/,
  completion_requests: /^(?:completion_note|review_note)$/
});
const fail = (message = '文字格式内容不正确') => { throw new HttpError(400, message, 'invalid_rich_text'); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
const ROOTS = {
  reports: new Set(['change_text', 'dev_text', 'projection', 'coord', 'decision', 'node_name', 'next_items', 'node_items', 'speed_items', 'effect_items', 'coord_items', 'biz']),
  leader_reviews: new Set(['note']), leader_notes: new Set(['what']), milestones: new Set(['note']),
  coordination_tasks: new Set(['what']), completion_requests: new Set(['completion_note', 'review_note'])
};
export const hasRichTextChanges = (table, row) => Object.keys(row).some((key) => ROOTS[table]?.has(key));

export function richTextValue(row, path) {
  let current = row;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

export function validateRichText(table, value, row) {
  if (!RICH_TEXT_PATHS[table] || !object(value)) fail();
  if (!Object.keys(value).length) return {};
  if (!exactKeys(value, ['v', 'fields']) || value.v !== 1 || !object(value.fields)) fail();
  const entries = Object.entries(value.fields);
  if (entries.length > 500) fail('文字格式字段过多');
  const result = { v: 1, fields: {} };
  let totalCharacters = 0;
  for (const [path, delta] of entries) {
    if (path.length > 100 || !RICH_TEXT_PATHS[table].test(path)) fail('不支持该字段的文字格式');
    if (!object(delta) || !exactKeys(delta, ['ops']) || !Array.isArray(delta.ops) || delta.ops.length > 2000) fail();
    let text = '';
    const ops = delta.ops.map((op) => {
      if (!object(op) || !exactKeys(op, ['insert', 'attributes']) || typeof op.insert !== 'string' || op.insert.includes('\u0000')) fail();
      text += op.insert;
      totalCharacters += op.insert.length;
      if (totalCharacters > 500000) fail('文字格式内容过长');
      const normalized = { insert: op.insert };
      if (Object.hasOwn(op, 'attributes')) {
        const attrs = op.attributes;
        if (!object(attrs) || !exactKeys(attrs, ['bold', 'color'])) fail('仅支持加粗与红色文字');
        if ((Object.hasOwn(attrs, 'bold') && attrs.bold !== true) || (Object.hasOwn(attrs, 'color') && attrs.color !== '#d81e06')) fail('仅支持加粗与红色文字');
        if (Object.keys(attrs).length) normalized.attributes = { ...attrs };
      }
      return normalized;
    });
    if (typeof richTextValue(row, path) !== 'string' || text !== richTextValue(row, path)) fail('文字与格式内容不一致，请刷新后重试');
    result.fields[path] = { ops };
  }
  return result;
}

export function prepareRichText(table, row, existing = {}) {
  if (!RICH_TEXT_PATHS[table]) return row;
  if (Object.hasOwn(row, 'rich_text')) return { ...row, rich_text: validateRichText(table, row.rich_text, { ...existing, ...row }) };
  // Older clients send plain business fields. Remove formatting for the roots
  // they replace so array insertions/deletions cannot apply old runs to new text.
  const prior = existing?.rich_text;
  if (prior?.v !== 1 || !object(prior.fields)) return row;
  const fields = Object.fromEntries(Object.entries(prior.fields).filter(([path]) => !Object.hasOwn(row, path.split('.')[0])));
  if (Object.keys(fields).length === Object.keys(prior.fields).length) return row;
  return { ...row, rich_text: { v: 1, fields } };
}
