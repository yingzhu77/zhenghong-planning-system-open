import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/reporter-archive.js', import.meta.url), 'utf8');
function fixture(patch = {}) {
  const window = {};
  vm.runInNewContext(source, { window });
  const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return window.ZHReporterArchive.render({
    pid: 'p1', tab: 'plan', projects: [{ id: 'p1', name: '测试项目' }], fields: {}, phases: [], drawings: [], milestones: [],
    helpers: { esc, sd: value => value || '—', richItem: (row, key) => esc(row[key]), dayDiff: () => 3, lightOf: () => 'green', devTxt: () => '+3天' },
    ...patch
  });
}

test('reporter archive provides all seven categories without mutation controls', () => {
  const html = fixture();
  for (const title of ['项目总图', '基本资料', '规划指标', '产品构成', '产品面积占比', '户型比', '产品建设标准']) assert.ok(html.includes(title));
  assert.match(html, /项目总图展示（预售版）/);
  assert.match(html, /项目总图展示（调整版）/);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(html, /App\.reporterArchiveTab\('plan'\)/);
  assert.match(html, /App\.masterPick\(this.value\)/);
  assert.doesNotMatch(html, /masterSave|drawUpload|drawDel|phaseDel|phasesSave|type="file"/);
  assert.match(html, /只读：由运营管理员统一维护/);
});

test('drawing versions use explicit labels while preserving unclassified original files', () => {
  const html = fixture({ drawings: [
    { name: '总图预售版.png', kind: '项目总图', url: '/api/files/drawings/p1/pre.png' },
    { name: '总图调整版.png', kind: '项目总图', url: '/api/files/drawings/p1/revised.png' },
    { name: '原始总图.png', kind: '项目总图', url: '/api/files/drawings/p1/original.png' },
    { name: '分期图.pdf', kind: '分期图', url: '/api/files/drawings/p1/phase.pdf' }
  ] });
  assert.ok(html.indexOf('总图预售版.png') < html.indexOf('项目总图展示（调整版）'));
  assert.ok(html.indexOf('总图调整版.png') > html.indexOf('项目总图展示（调整版）'));
  assert.match(html, /原有总图资料/);
  assert.match(html, /原始总图\.png/);
  assert.match(html, /分期图\.pdf/);
  assert.match(html, /打开 PDF 文档/);
  assert.equal((html.match(/loading="lazy" decoding="async"/g) || []).length, 3);
  assert.doesNotMatch(html, /<iframe|<embed|<object/);
});

test('hidden categories do not render or load their attachment previews', () => {
  const html = fixture({ tab: 'basic', drawings: [{ name: 'picture.png', kind: '项目总图', url: '/api/files/drawings/p1/picture.png' }] });
  assert.doesNotMatch(html, /picture\.png|<img/);
  assert.match(html, /基本资料/);
});

test('project archive rejects script links and escapes names and text fields', () => {
  const html = fixture({ drawings: [{ name: '"><img src=x onerror=alert(1)>', kind: '项目总图', url: 'javascript:alert(1)' }] });
  assert.doesNotMatch(html, /href="javascript:|<img src=x/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /附件暂不可打开/);
  assert.match(fixture({ tab: 'basic', fields: { city: '<script>bad</script>', owner_company: '测试开发主体' } }), /&lt;script&gt;bad&lt;\/script&gt;/);
});

test('missing product and unit information shows empty state without invented ratios', () => {
  for (const tab of ['areas', 'units']) {
    const html = fixture({ tab });
    assert.match(html, /尚未登记/);
    assert.doesNotMatch(html, /NaN|Infinity|\d+%/);
  }
});

test('product area ratios require an explicit matching denominator and complete rows', () => {
  const products = [{ name: '产品甲', area: 30 }, { name: '产品乙', area: 70 }];
  const valid = fixture({ tab: 'areas', fields: { products, product_area_total: 100 } });
  assert.match(valid, /30%/); assert.match(valid, /70%/);
  for (const fields of [
    { products },
    { products, product_area_total: 200 },
    { products: [{ name: '产品甲', area: '' }, products[1]], product_area_total: 70 },
    { products: [{ name: '产品甲', area: -1 }, products[1]], product_area_total: 69 },
    { products: [null, products[1]], product_area_total: 70 }
  ]) {
    const html = fixture({ tab: 'areas', fields });
    assert.match(html, /暂不计算占比/);
    assert.doesNotMatch(html, /\d+%|NaN|Infinity/);
  }
});

test('unit ratios use complete phase totals and reject incomplete or fractional unit counts', () => {
  const unit_types = [{ name: '两居', units: 40 }, { name: '三居', units: 60 }];
  const phases = [{ name: '一期', units_total: 50 }, { name: '二期', units_total: 50 }];
  const valid = fixture({ tab: 'units', fields: { unit_types }, phases });
  assert.match(valid, /40%/); assert.match(valid, /60%/);
  for (const patch of [
    { fields: { unit_types }, phases: [phases[0], { name: '二期', units_total: null }] },
    { fields: { unit_types: [{ name: '两居', units: 39.5 }, { name: '三居', units: 60.5 }] }, phases },
    { fields: { unit_types }, phases: [{ name: '一期', units_total: 120 }] }
  ]) {
    const html = fixture({ tab: 'units', ...patch });
    assert.match(html, /暂不计算占比/);
    assert.doesNotMatch(html, /40%|60%|NaN|Infinity/);
  }
});

test('existing archive fields, phase rows, and rich milestone content remain accessible', () => {
  const fields = { city: '测试城市', fitout: '清水\n公共区域装修', area: 0, gfa: 1500, mix: '住宅' };
  assert.match(fixture({ tab: 'basic', fields, phases: [{ name: '一期', units_total: 10, units_launched: 0, units_sold: 0 }], milestones: [{ name: '关键节点', is_key: true }] }), /一期[\s\S]*关键节点/);
  assert.match(fixture({ tab: 'planning', fields }), /用地面积（㎡）<\/th><td>0<\/td>/);
  assert.match(fixture({ tab: 'standards', fields }), /清水\n公共区域装修/);
  assert.match(fixture({ tab: 'products', fields }), /住宅/);
});
