import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const sandbox=vm.createContext({});
for(const name of ['rich-text.js','planning-ai-draft.js'])vm.runInContext(readFileSync(new URL('../web/'+name,import.meta.url),'utf8'),sandbox);
const helper=sandbox.PlanningAIDraft, rich=sandbox.ZHRichText;
function fixture(){
  const rows=[{source_id:'fixed',mod:'机电',name:'设备安装',due:'2026-10-30',prog:'原进展',_rich:{prog:{ops:[{insert:'原进展',attributes:{bold:true,color:'#d81e06'}}]}}}];
  const current=()=>({key:'user:project:week:line',identityKey:'session-a',canEdit:true,items:helper.items(rows)});
  const context=current();
  return {rows,current,context,draft:{items:[{id:'monthly:0',progress:'设备已就位。'}]}};
}
test('AI append preserves original rich text and fixed monthly columns, only saving a local draft',()=>{
  const f=fixture();let saves=0;
  const result=helper.apply({...f,current:f.current(),richText:rich,save:()=>{saves++;return true;}});
  assert.equal(result.count,1);assert.match(result.message,/尚未提交/);assert.equal(saves,1);
  assert.equal(f.rows[0].prog,'原进展\n设备已就位。');
  assert.equal(f.rows[0]._rich.prog.ops[0].attributes.bold,true);
  assert.equal(f.rows[0]._rich.prog.ops[0].attributes.color,'#d81e06');
  assert.equal(f.rows[0].source_id,'fixed');assert.equal(f.rows[0].due,'2026-10-30');assert.equal(f.rows[0].name,'设备安装');
  assert.throws(()=>helper.apply({...f,current:f.current(),save:()=>true}),/已修改/);
});
test('scope changes, text and formatting edits, fixed column edits and unauthorized contexts reject old suggestions',()=>{
  for(const mutate of [f=>f.rows[0].prog='手动新进展',f=>f.rows[0]._rich.prog.ops[0].attributes.bold=false,f=>f.rows[0].due='2026-11-01']){
    const f=fixture();mutate(f);const before=JSON.stringify(f.rows);
    assert.throws(()=>helper.apply({...f,current:f.current(),save:()=>true}),/已修改/);assert.equal(JSON.stringify(f.rows),before);
  }
  for(const patch of [{key:'another-week'},{identityKey:'another-session'},{canEdit:false}]){
    const f=fixture();assert.throws(()=>helper.apply({...f,current:{...f.current(),...patch},save:()=>true}),/范围已变化/);
  }
});

test('shared source ids from different professional plans cannot reuse AI proposals, provenance or undo',()=>{
  for(const field of ['monthly_plan_id','project_id']){
    const f=fixture();f.rows[0].monthly_plan_id='professional-plan-a';f.rows[0].project_id='phase-a';f.context=f.current();
    f.rows[0][field]='another-source';const before=JSON.stringify(f.rows);
    assert.throws(()=>helper.apply({...f,current:f.current(),save:()=>true}),/已修改/);
    assert.equal(JSON.stringify(f.rows),before);
  }
  const f=fixture(),ledger=[];f.rows[0].monthly_plan_id='professional-plan-a';f.rows[0].project_id='phase-a';
  const current=()=>({...f.current(),applied:helper.entries(f.rows,ledger)});
  const result=helper.apply({...f,context:current(),current:current(),entries:ledger,save:()=>true});
  assert.equal(ledger.length,1);
  f.rows[0].monthly_plan_id='professional-plan-b';
  assert.equal(helper.entries(f.rows,ledger).length,0);
  assert.throws(()=>helper.undo({transaction:result.transaction,current:current(),rows:f.rows,entries:ledger,save:()=>true}),/后续修改/);
});
test('a bad target or duplicate suggestion rejects the whole batch, and failed storage rolls back all fields',()=>{
  for(const bad of [{id:'monthly:19',progress:'不存在'}, {id:'monthly:0',progress:'重复'}]){
    const f=fixture(), before=JSON.stringify(f.rows);f.draft.items.push(bad);
    assert.throws(()=>helper.apply({...f,current:f.current(),save:()=>true}));assert.equal(JSON.stringify(f.rows),before);
  }
  const f=fixture(), before=JSON.stringify(f.rows);
  assert.throws(()=>helper.apply({...f,current:f.current(),richText:rich,save:()=>false}),/保存失败/);
  assert.equal(JSON.stringify(f.rows),before);
});
test('saved AI segments can be replaced or removed after reload without changing original rich text, with undo',()=>{
  const f=fixture(),ledger=[];
  function current(){return {...f.current(),applied:helper.entries(f.rows,ledger)};}
  function apply(draft){const context=current();return helper.apply({context,current:current(),draft,rows:f.rows,entries:ledger,richText:rich,save:()=>true});}
  apply(f.draft);assert.equal(ledger.length,1);const id=ledger[0].entry_id;
  const restored=JSON.parse(JSON.stringify(ledger));ledger.splice(0,ledger.length,...restored);
  const replacement={items:[{id:'monthly:0',entry_id:id,operation:'replace',progress:'设备正在试运行。'}]};
  assert.equal(helper.preview(current(),replacement)[0].after,'原进展\n设备正在试运行。');
  const saved=apply(replacement);assert.equal(f.rows[0].prog,'原进展\n设备正在试运行。');assert.equal(f.rows[0]._rich.prog.ops[0].attributes.bold,true);
  helper.undo({transaction:saved.transaction,current:current(),rows:f.rows,entries:ledger,save:()=>true});assert.equal(f.rows[0].prog,'原进展\n设备已就位。');
  apply({items:[{id:'monthly:0',entry_id:id,operation:'remove',progress:''}]});
  assert.equal(f.rows[0].prog,'原进展');assert.equal(ledger.length,0);assert.equal(f.rows[0]._rich.prog.ops[0].attributes.color,'#d81e06');
});
test('manual edits invalidate AI deletion, and failed replacement rolls back both text and provenance',()=>{
  const f=fixture(),ledger=[],current=()=>({...f.current(),applied:helper.entries(f.rows,ledger)});
  const save=(draft,persist=()=>true)=>helper.apply({context:current(),current:current(),draft,rows:f.rows,entries:ledger,richText:rich,save:persist});
  save(f.draft);const suggestion={items:[{id:'monthly:0',entry_id:ledger[0].entry_id,operation:'replace',progress:'替换进展'}]},before=JSON.stringify([f.rows,ledger]);
  assert.throws(()=>save(suggestion,()=>false),/保存失败/);assert.equal(JSON.stringify([f.rows,ledger]),before);
  f.rows[0].prog='原进展\n用户已自行调整的文字';assert.equal(current().applied.length,0);
  assert.throws(()=>save({items:[{...suggestion.items[0],operation:'remove',progress:''}]}),/找不到/);
});
