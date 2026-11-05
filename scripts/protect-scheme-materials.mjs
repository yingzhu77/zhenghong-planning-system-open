import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,mkdir,readFile,readdir,realpath,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {loadSchemeKey,sealSchemeFile,verifySealedSchemeFile} from '../server/scheme-vault.mjs';

const REGISTRY='scheme-protection/registry.json', RECEIPT='scheme-protection/preparation.json';
const SHA=/^[a-f0-9]{64}$/, ID=/^[A-Za-z0-9_-]{1,200}$/;
function fail(message){throw new Error(message);}
function inside(parent,child){const relative=path.relative(parent,child);return !relative || !path.isAbsolute(relative) && relative!=='..' && !relative.startsWith('..'+path.sep);}
async function exists(filename){try{await lstat(filename);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function noSymlinks(filename){
  const absolute=path.resolve(filename),root=path.parse(absolute).root;let current=root;
  for(const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,segment);
    try{if((await lstat(current)).isSymbolicLink())fail('材料路径不能包含符号链接');}
    catch(error){if(error.code==='ENOENT')break;throw error;}
  }
}
async function hashFile(filename){const hash=createHash('sha256');for await(const chunk of createReadStream(filename))hash.update(chunk);return hash.digest('hex');}
function hashBytes(value){return createHash('sha256').update(value).digest('hex');}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
function json(value){return JSON.stringify(canonical(value));}
function keys(value,allowed){return value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(key=>allowed.includes(key));}
function original(value,pid){
  if(!keys(value,['path','sha256']) || !SHA.test(value.sha256 || '') || typeof value.path!=='string'
    || !new RegExp('^drawings/'+pid+'/[A-Za-z0-9_-][A-Za-z0-9_.-]*$').test(value.path) || value.path.length>400)fail('原件路径或摘要无效，不能跨项目或越界');
  return {path:value.path,sha256:value.sha256};
}
function rectangle(value,width,height,label){
  if(!keys(value,['left','top','width','height']) || !['left','top','width','height'].every(key=>Number.isSafeInteger(value[key]))
    || value.left<0 || value.top<0 || value.width<1 || value.height<1 || value.left+value.width>width || value.top+value.height>height)fail(label+'必须为源图范围内的整数像素框');
  return {left:value.left,top:value.top,width:value.width,height:value.height};
}
export function validateSchemeManifest(value){
  if(!keys(value,['version','projects']) || value.version!==1 || !Array.isArray(value.projects) || !value.projects.length)fail('材料清单格式不正确');
  const ids=new Set(),paths=new Set();
  const projects=value.projects.map(row=>{
    if(!keys(row,['project_id','source','preview']) || typeof row.project_id!=='string' || !ID.test(row.project_id) || ids.has(row.project_id))fail('项目标识无效或重复');
    ids.add(row.project_id);const source=original(row.source,row.project_id),preview=row.preview;
    if(!/\.pdf$/i.test(source.path) || !keys(preview,['path','sha256','width','height','source_page','crop','masks']))fail('每个项目须提供PDF原件和明确的关键摘图');
    const reference=original({path:preview.path,sha256:preview.sha256},row.project_id);
    if(!/\.(?:png|jpe?g|webp)$/i.test(reference.path) || !Number.isSafeInteger(preview.width) || !Number.isSafeInteger(preview.height)
      || preview.width<1 || preview.height<1 || preview.width*preview.height>64*1024*1024 || !Number.isSafeInteger(preview.source_page) || preview.source_page<1)fail('预览尺寸或来源页码不正确');
    const crop=rectangle(preview.crop,preview.width,preview.height,'裁剪区域');
    if(crop.width===preview.width && crop.height===preview.height)fail('关键摘图必须裁剪，不能回退整页');
    if(preview.masks!==undefined && !Array.isArray(preview.masks))fail('遮盖区域格式不正确');
    const masks=(preview.masks || []).map(mask=>{
      const result=rectangle(mask,preview.width,preview.height,'遮盖区域');
      if(result.left<crop.left || result.top<crop.top || result.left+result.width>crop.left+crop.width || result.top+result.height>crop.top+crop.height)fail('遮盖区域必须位于裁剪区域内');
      return result;
    });
    for(const item of [source,reference]){if(paths.has(item.path))fail('原件路径重复');paths.add(item.path);}
    return {project_id:row.project_id,source,preview:{...reference,width:preview.width,height:preview.height,source_page:preview.source_page,crop,masks}};
  });
  return {version:1,projects:projects.sort((a,b)=>a.project_id.localeCompare(b.project_id))};
}
async function sourceFile(root,name){
  const filename=path.resolve(root,...name.split('/'));await noSymlinks(filename);
  if(!inside(root,filename) || !(await stat(filename)).isFile() || !inside(root,await realpath(filename)))fail('输入材料必须为目录内的普通文件');
  return filename;
}
async function outputFiles(root,prefix=''){
  const result=[];
  for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})){
    const relative=prefix?prefix+'/'+entry.name:entry.name;
    if(entry.isSymbolicLink())fail('输出材料不能包含符号链接');
    if(entry.isDirectory())result.push(...await outputFiles(root,relative));
    else if(entry.isFile())result.push(relative);else fail('输出材料只能包含普通文件');
  }
  return result.sort();
}
async function croppedPreview(filename,preview){
  const image=sharp(filename,{limitInputPixels:64*1024*1024}),metadata=await image.metadata();
  if(metadata.width!==preview.width || metadata.height!==preview.height || !['jpeg','png','webp'].includes(metadata.format)
    || metadata.pages>1 || metadata.orientation && metadata.orientation!==1)fail('源预览尺寸、格式或方向已变化，不能套用裁剪框');
  const masks=await Promise.all(preview.masks.map(async mask=>({
    input:await sharp({create:{width:mask.width,height:mask.height,channels:3,background:'#ffffff'}}).png().toBuffer(),
    left:mask.left-preview.crop.left,top:mask.top-preview.crop.top
  })));
  // Only the selected pixels are encoded. Original metadata and hidden alpha
  // values never enter the derived image; no resize or upsampling occurs.
  return image.extract(preview.crop).flatten({background:'#ffffff'}).composite(masks).webp({lossless:true,effort:4}).toBuffer();
}
export async function prepareSchemeMaterials({input,manifest:manifestFile,output,keyFile,createKey=false}){
  if(![input,manifestFile,output,keyFile].every(value=>typeof value==='string' && value))fail('须指定输入、清单、独立输出目录和独立密钥文件');
  for(const filename of [input,manifestFile,output,keyFile])await noSymlinks(filename);
  const inputRoot=await realpath(input),outputRoot=path.resolve(output),keyPath=path.resolve(keyFile);
  if(!(await stat(inputRoot)).isDirectory() || inside(inputRoot,outputRoot) || inside(outputRoot,inputRoot))fail('输入和输出目录必须彼此独立，不能互相包含');
  if(inside(inputRoot,keyPath) || inside(outputRoot,keyPath))fail('密钥文件必须位于输入和输出材料树之外');
  const manifestStat=await stat(manifestFile);
  if(!manifestStat.isFile() || manifestStat.size>2*1024*1024)fail('材料清单须为不超过2MiB的普通JSON文件');
  const manifest=validateSchemeManifest(JSON.parse(await readFile(manifestFile,'utf8'))),manifestSha=hashBytes(json(manifest)),prepared=[];
  // Validate every source before creating keys or output. Keep the input SHA
  // checks independent from the later encryption receipt to detect replacement.
  for(const project of manifest.projects){
    const originals=[];
    for(const reference of [project.source,project.preview]){
      const filename=await sourceFile(inputRoot,reference.path);
      if(await hashFile(filename)!==reference.sha256)fail('输入材料摘要与清单不一致');
      originals.push({reference,filename});
    }
    const derived=await croppedPreview(originals[1].filename,project.preview),sha256=hashBytes(derived);
    prepared.push({project,originals,derived,preview:{path:'scheme-previews/'+project.project_id+'/'+sha256+'.webp',sha256,width:project.preview.crop.width,height:project.preview.crop.height,source_page:project.preview.source_page}});
  }
  const registry={version:1,projects:prepared.map(row=>({project_id:row.project.project_id,protected_paths:row.originals.map(item=>item.reference.path),preview:row.preview}))};
  const expectedPaths=[REGISTRY,RECEIPT,...prepared.flatMap(row=>[row.preview.path,...row.originals.map(item=>item.reference.path)])].sort();
  if(await exists(outputRoot)){
    if(!(await stat(outputRoot)).isDirectory())fail('输出位置须为独立目录');
    const found=await outputFiles(outputRoot);
    if(found.length){
      if(!found.includes(RECEIPT))fail('已有输出缺少准备记录，请使用新的独立目录');
      const receipt=JSON.parse(await readFile(path.join(outputRoot,RECEIPT),'utf8'));
      if(receipt.version!==1 || receipt.manifest_sha256!==manifestSha)fail('输出目录属于不同材料或裁剪清单，不能覆盖');
      if(found.some(name=>!expectedPaths.includes(name)))fail('输出目录含有未登记材料，不能混用或覆盖');
      if(found.includes(REGISTRY)){
        if(json(JSON.parse(await readFile(path.join(outputRoot,REGISTRY),'utf8')))!==json(registry) || json(found)!==json(expectedPaths))fail('已完成输出登记或文件集合发生变化');
      }
    }
  }
  const key=await loadSchemeKey(keyPath,{create:createKey});
  // Authenticate all existing ciphertext before making any new output writes.
  const existingSealed=new Map();
  for(const row of prepared)for(const item of row.originals){
    const destination=path.join(outputRoot,...item.reference.path.split('/'));
    if(await exists(destination))existingSealed.set(destination,await verifySealedSchemeFile({input:destination,key,context:row.project.project_id+':'+item.reference.path,expectedSha256:item.reference.sha256}));
  }
  for(const row of prepared){
    const destination=path.join(outputRoot,...row.preview.path.split('/'));
    if(await exists(destination) && await hashFile(destination)!==row.preview.sha256)fail('已有关键摘图摘要不一致，不能覆盖');
  }
  await mkdir(path.join(outputRoot,'scheme-protection'),{recursive:true,mode:0o700});
  if(!await exists(path.join(outputRoot,RECEIPT)))await writeFile(path.join(outputRoot,RECEIPT),JSON.stringify({version:1,manifest_sha256:manifestSha},null,2)+'\n',{flag:'wx',mode:0o600});
  const sealed=[];
  for(const row of prepared){
    for(const item of row.originals){
      const destination=path.join(outputRoot,...item.reference.path.split('/'));
      const result=existingSealed.get(destination) || await sealSchemeFile({input:item.filename,output:destination,key,context:row.project.project_id+':'+item.reference.path});
      if(result.plaintext_sha256!==item.reference.sha256)fail('加密回执与原始清单不一致，输入材料可能已被替换');
      sealed.push({project_id:row.project.project_id,path:item.reference.path,...result});
    }
    const destination=path.join(outputRoot,...row.preview.path.split('/'));
    await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
    if(!await exists(destination))await writeFile(destination,row.derived,{flag:'wx',mode:0o600});
    if(await hashFile(destination)!==row.preview.sha256)fail('生成的关键摘图摘要不一致');
  }
  const registryBytes=JSON.stringify(registry,null,2)+'\n';
  if(!await exists(path.join(outputRoot,REGISTRY)))await writeFile(path.join(outputRoot,REGISTRY),registryBytes,{flag:'wx',mode:0o600});
  if(json(JSON.parse(await readFile(path.join(outputRoot,REGISTRY),'utf8')))!==json(registry))fail('输出登记不一致');
  return {status:'prepared',projects:prepared.length,protected_files:sealed.length,previews:prepared.length,manifest_sha256:manifestSha,registry_sha256:await hashFile(path.join(outputRoot,REGISTRY)),sealed,registry};
}

async function main(){
  const {values}=parseArgs({options:{input:{type:'string'},manifest:{type:'string'},output:{type:'string'},'key-file':{type:'string'},'create-key':{type:'boolean',default:false},help:{type:'boolean',default:false}},strict:true,allowPositionals:false});
  if(values.help){console.log('Usage: node scripts/protect-scheme-materials.mjs --input MATERIAL_DIRECTORY --manifest PRIVATE_MANIFEST.json --output NEW_PROTECTED_DIRECTORY --key-file SEPARATE_KEY_FILE [--create-key]\nPrepares encrypted originals and fixed cropped WebP previews offline. Never changes source material or contacts a service. The key must remain outside both material directories.');return;}
  const result=await prepareSchemeMaterials({input:values.input,manifest:values.manifest,output:values.output,keyFile:values['key-file'],createKey:values['create-key']});
  console.log(JSON.stringify({status:result.status,projects:result.projects,protected_files:result.protected_files,previews:result.previews,registry_sha256:result.registry_sha256}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error('方案材料准备失败：'+error.message);process.exitCode=1;});
