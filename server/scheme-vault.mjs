import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {appendFile,link,mkdir,open,readFile,stat,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

export const SCHEME_VAULT_MAGIC=Buffer.from('ZHSCM001');
const HEADER_BYTES=20,TAG_BYTES=16,MAX_BYTES=512*1024*1024;
function issue(message,code){return Object.assign(new Error(message),{code});}
function secret(key){if(!Buffer.isBuffer(key)||key.length!==32)throw issue('方案加密密钥必须为32字节','scheme_key_invalid');return key;}
function associated(context){
  if(typeof context!=='string'||!context||context.length>600||/[\u0000-\u001f]/.test(context))throw issue('方案加密范围不正确','scheme_context_invalid');
  return Buffer.from('scheme-material-v1:'+context,'utf8');
}
export async function loadSchemeKey(filename,{create=false}={}){
  if(typeof filename!=='string'||!filename)throw issue('请指定独立的方案密钥文件','scheme_key_missing');
  if(create){
    await mkdir(path.dirname(filename),{recursive:true,mode:0o700});
    try{await writeFile(filename,randomBytes(32).toString('base64')+'\n',{flag:'wx',mode:0o600});}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
  let text;
  try{text=(await readFile(filename,'utf8')).trim();}
  catch(error){if(error.code==='ENOENT')throw issue('方案密钥文件不存在；首次生成须显式指定创建选项','scheme_key_missing');throw error;}
  if(!/^[A-Za-z0-9+/]{43}=$/.test(text))throw issue('方案密钥文件格式不正确','scheme_key_invalid');
  const key=Buffer.from(text,'base64');secret(key);
  if(key.toString('base64')!==text)throw issue('方案密钥文件格式不正确','scheme_key_invalid');
  return key;
}
async function digestFile(filename){
  const digest=createHash('sha256');
  for await(const part of createReadStream(filename))digest.update(part);
  return digest.digest('hex');
}
// This function authenticates and hashes plaintext without writing or returning it.
// Neither HTTP serving nor preview generation needs to decrypt a sealed source.
export async function verifySealedSchemeFile({input,key,context,expectedSha256}){
  secret(key);const aad=associated(context),size=(await stat(input)).size;
  if(size<HEADER_BYTES+TAG_BYTES||size>MAX_BYTES+HEADER_BYTES+TAG_BYTES)throw issue('方案密文大小不正确','scheme_vault_invalid');
  if(expectedSha256!==undefined&&!/^[a-f0-9]{64}$/.test(expectedSha256))throw issue('方案原文摘要不正确','scheme_digest_invalid');
  const handle=await open(input,'r'),header=Buffer.alloc(HEADER_BYTES),tag=Buffer.alloc(TAG_BYTES);
  try{await handle.read(header,0,HEADER_BYTES,0);await handle.read(tag,0,TAG_BYTES,size-TAG_BYTES);}finally{await handle.close();}
  if(!header.subarray(0,8).equals(SCHEME_VAULT_MAGIC))throw issue('文件不是受控方案密文','scheme_vault_invalid');
  const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(8));decipher.setAAD(aad);decipher.setAuthTag(tag);
  const digest=createHash('sha256');let bytes=0;
  const sink=new Writable({write(chunk,_encoding,callback){bytes+=chunk.length;digest.update(chunk);callback();}});
  try{await pipeline(createReadStream(input,{start:HEADER_BYTES,end:size-TAG_BYTES-1}),decipher,sink);}
  catch{throw issue('方案密文认证失败，密钥、范围或文件已变化','scheme_vault_auth');}
  const plaintextSha=digest.digest('hex');
  if(expectedSha256&&plaintextSha!==expectedSha256)throw issue('方案密文与原文摘要不一致','scheme_vault_digest');
  return {plaintext_sha256:plaintextSha,encrypted_sha256:await digestFile(input),plain_bytes:bytes,encrypted_bytes:size};
}
export async function sealSchemeFile({input,output,key,context}){
  secret(key);const aad=associated(context),size=(await stat(input)).size;
  if(size<1||size>MAX_BYTES)throw issue('单份方案须为1字节至512MiB','scheme_source_size');
  if(path.resolve(input)===path.resolve(output))throw issue('加密输出必须与输入文件分离','scheme_source_overwrite');
  await mkdir(path.dirname(output),{recursive:true,mode:0o700});
  const temporary=output+'.'+randomBytes(12).toString('hex')+'.tmp',nonce=randomBytes(12),header=Buffer.concat([SCHEME_VAULT_MAGIC,nonce]);
  const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);
  const plainHash=createHash('sha256');let bytes=0;
  const hashing=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;plainHash.update(chunk);callback(null,chunk);}});
  try{
    await writeFile(temporary,header,{flag:'wx',mode:0o600});
    await pipeline(createReadStream(input),hashing,cipher,createWriteStream(temporary,{flags:'a',mode:0o600}));
    if(bytes!==size)throw issue('加密期间方案源文件发生变化','scheme_source_changed');
    await appendFile(temporary,cipher.getAuthTag());
    const expectedSha256=plainHash.digest('hex');
    const result=await verifySealedSchemeFile({input:temporary,key,context,expectedSha256});
    try{await link(temporary,output);}catch(error){
      if(error.code!=='EEXIST')throw error;
      return await verifySealedSchemeFile({input:output,key,context,expectedSha256});
    }
    return result;
  }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
