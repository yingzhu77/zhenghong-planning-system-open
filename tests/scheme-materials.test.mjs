import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {prepareSchemeMaterials} from '../scripts/protect-scheme-materials.mjs';
import {loadSchemeKey,verifySealedSchemeFile,SCHEME_VAULT_MAGIC} from '../server/scheme-vault.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'scheme-materials-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const input=path.join(root,'input'),output=path.join(root,'protected'),keyFile=path.join(root,'keys','vault.key'),manifestFile=path.join(root,'private-manifest.json');
  await mkdir(path.join(input,'drawings','p1'),{recursive:true});
  const source=Buffer.from('%PDF-1.7\nanonymous-source-only\n%%EOF\n');
  const red=await sharp({create:{width:30,height:80,channels:3,background:'#ff0000'}}).png().toBuffer();
  const preview=await sharp({create:{width:120,height:80,channels:3,background:'#0033ff'}}).composite([{input:red,left:0,top:0}]).withMetadata().png().toBuffer();
  await writeFile(path.join(input,'drawings/p1/source.pdf'),source);await writeFile(path.join(input,'drawings/p1/overview.png'),preview);
  const manifest={version:1,projects:[{project_id:'p1',source:{path:'drawings/p1/source.pdf',sha256:digest(source)},preview:{path:'drawings/p1/overview.png',sha256:digest(preview),width:120,height:80,source_page:3,crop:{left:40,top:20,width:60,height:40},masks:[{left:50,top:30,width:10,height:10}]}}]};
  const options={input,output,keyFile,manifest:manifestFile,createKey:true};
  async function save(value=manifest){await writeFile(manifestFile,JSON.stringify(value));}
  await save();return {root,input,output,keyFile,manifestFile,manifest,options,save,source,preview};
}
async function files(root,prefix=''){
  const result={};
  for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})){
    const relative=prefix?prefix+'/'+entry.name:entry.name;
    if(entry.isDirectory())Object.assign(result,await files(root,relative));
    else{const filename=path.join(root,relative);result[relative]={sha:digest(await readFile(filename)),mtime:(await stat(filename)).mtimeMs};}
  }
  return result;
}

test('offline preparation seals both originals and publishes only a real cropped image with fixed white masks and no source metadata',async t=>{
  const f=await fixture(t),before=await files(f.input),result=await prepareSchemeMaterials(f.options);
  assert.equal(result.status,'prepared');assert.equal(result.projects,1);assert.equal(result.protected_files,2);assert.equal(result.previews,1);
  const registry=JSON.parse(await readFile(path.join(f.output,'scheme-protection/registry.json'),'utf8')),entry=registry.projects[0];
  assert.deepEqual(entry.protected_paths,['drawings/p1/source.pdf','drawings/p1/overview.png']);assert.equal(entry.project_id,'p1');
  assert.match(entry.preview.path,/^scheme-previews\/p1\/[a-f0-9]{64}\.webp$/);assert.equal(entry.preview.source_page,3);assert.equal(entry.preview.width,60);assert.equal(entry.preview.height,40);
  const derived=await readFile(path.join(f.output,entry.preview.path)),metadata=await sharp(derived).metadata();
  assert.equal(digest(derived),entry.preview.sha256);assert.equal(metadata.format,'webp');assert.equal(metadata.width,60);assert.equal(metadata.height,40);assert.equal(metadata.exif,undefined);assert.equal(metadata.icc,undefined);
  const {data,info}=await sharp(derived).removeAlpha().raw().toBuffer({resolveWithObject:true}),pixel=(x,y)=>[...data.subarray((y*info.width+x)*info.channels,(y*info.width+x)*info.channels+3)];
  assert.deepEqual(pixel(0,0),[0,51,255]);assert.deepEqual(pixel(15,15),[255,255,255]);
  assert.equal([...Array(info.width*info.height)].some((_,i)=>data[i*info.channels]===255 && data[i*info.channels+1]===0 && data[i*info.channels+2]===0),false,'the excluded red margin is absent from the encoded pixels');
  const key=await loadSchemeKey(f.keyFile);
  for(const reference of [f.manifest.projects[0].source,f.manifest.projects[0].preview]){
    const encrypted=await readFile(path.join(f.output,reference.path));assert.ok(encrypted.subarray(0,8).equals(SCHEME_VAULT_MAGIC));
    const receipt=await verifySealedSchemeFile({input:path.join(f.output,reference.path),key,context:'p1:'+reference.path,expectedSha256:reference.sha256});assert.equal(receipt.plaintext_sha256,reference.sha256);
    await assert.rejects(verifySealedSchemeFile({input:path.join(f.output,reference.path),key,context:'p2:'+reference.path}),/认证失败/);
  }
  assert.deepEqual(await files(f.input),before,'preparation never rewrites source bytes or timestamps');
  const prepared=await files(f.output);assert.equal(Object.keys(prepared).length,5);assert.equal(Object.keys(prepared).some(name=>/\.key$|private-manifest/.test(name)),false);
  assert.doesNotMatch(await readFile(path.join(f.output,'scheme-protection/preparation.json'),'utf8'),/crop|key|drawings|left|top/);
});

test('reruns authenticate the same output without replacing its key or bytes; another crop, key or damaged output cannot overwrite it',async t=>{
  const f=await fixture(t);await prepareSchemeMaterials(f.options);const before=await files(f.output),keyBefore=await readFile(f.keyFile);
  await prepareSchemeMaterials({...f.options,createKey:false});assert.deepEqual(await files(f.output),before);assert.deepEqual(await readFile(f.keyFile),keyBefore);
  const changed=structuredClone(f.manifest);changed.projects[0].preview.crop.width--;
  await f.save(changed);await assert.rejects(prepareSchemeMaterials(f.options),/不同材料或裁剪清单/);assert.deepEqual(await files(f.output),before);
  await f.save();const otherKey=path.join(f.root,'keys','other.key');await loadSchemeKey(otherKey,{create:true});
  await assert.rejects(prepareSchemeMaterials({...f.options,keyFile:otherKey,createKey:false}),/认证失败/);assert.deepEqual(await files(f.output),before);assert.deepEqual(await readFile(f.keyFile),keyBefore);
  const registry=JSON.parse(await readFile(path.join(f.output,'scheme-protection/registry.json'),'utf8'));
  await writeFile(path.join(f.output,registry.projects[0].preview.path),Buffer.from('tampered preview'));
  await assert.rejects(prepareSchemeMaterials(f.options),/关键摘图摘要不一致/);
});

test('missing crop, unbound hash or dimensions and whole-page fallback fail before any prepared registry exists',async t=>{
  const f=await fixture(t),changes=[
    [row=>delete row.preview.crop,/裁剪区域/],
    [row=>row.preview.sha256='0'.repeat(64),/摘要与清单不一致/],
    [row=>row.source.sha256='0'.repeat(64),/摘要与清单不一致/],
    [row=>row.preview.width++,/尺寸、格式或方向已变化/],
    [row=>row.preview.crop={left:0,top:0,width:120,height:80},/不能回退整页/],
    [row=>row.preview.masks=[{left:0,top:0,width:10,height:10}],/必须位于裁剪区域内/]
  ];
  for(const [change,message] of changes){const manifest=structuredClone(f.manifest);change(manifest.projects[0]);await f.save(manifest);await assert.rejects(prepareSchemeMaterials(f.options),message);}
  await assert.rejects(readFile(path.join(f.output,'scheme-protection/registry.json')),{code:'ENOENT'});await assert.rejects(readFile(f.keyFile),{code:'ENOENT'});
});

test('path traversal, foreign project files, overlapping trees, embedded keys and symlinks are rejected',async t=>{
  const f=await fixture(t);
  for(const unsafe of ['drawings/p2/source.pdf','drawings/p1/../source.pdf','/drawings/p1/source.pdf','drawings/p1/nested/source.pdf','drawings/p1/source\\evil.pdf']){
    const manifest=structuredClone(f.manifest);manifest.projects[0].source.path=unsafe;await f.save(manifest);await assert.rejects(prepareSchemeMaterials(f.options),/路径或摘要无效/);
  }
  await f.save();
  for(const options of [{output:path.join(f.input,'out')},{output:f.root},{keyFile:path.join(f.input,'vault.key')},{keyFile:path.join(f.output,'vault.key')}])await assert.rejects(prepareSchemeMaterials({...f.options,...options}),/彼此独立|密钥文件必须位于/);
  const linked=path.join(f.root,'linked-input');
  try{await symlink(f.input,linked,process.platform==='win32'?'junction':'dir');}
  catch(error){if(!['EPERM','EACCES','ENOTSUP'].includes(error.code))throw error;t.diagnostic('Local symlink creation is unavailable; remaining boundary cases still ran.');return;}
  await assert.rejects(prepareSchemeMaterials({...f.options,input:linked}),/不能包含符号链接/);
});

test('key creation is explicit and unregistered files or missing completed files cannot be packed silently',async t=>{
  const f=await fixture(t);await assert.rejects(prepareSchemeMaterials({...f.options,createKey:false}),/首次生成须显式指定/);await assert.rejects(readFile(f.keyFile),{code:'ENOENT'});
  await prepareSchemeMaterials(f.options);await writeFile(path.join(f.output,'unexpected.txt'),'not an approved preview');
  await assert.rejects(prepareSchemeMaterials(f.options),/未登记材料/);await rm(path.join(f.output,'unexpected.txt'));
  await rm(path.join(f.output,'drawings/p1/overview.png'));await assert.rejects(prepareSchemeMaterials(f.options),/文件集合发生变化/);
});
