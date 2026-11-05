import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {loadSchemeKey,sealSchemeFile,verifySealedSchemeFile,SCHEME_VAULT_MAGIC} from '../server/scheme-vault.mjs';

async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'scheme-vault-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('scheme sources are authenticated at rest, remain recoverable by hash, and do not modify the incoming material',async t=>{
 const dir=await fixture(t),input=path.join(dir,'input.pdf'),output=path.join(dir,'sealed.pdf'),key=await loadSchemeKey(path.join(dir,'secrets','scheme-key'),{create:true});
 const body=Buffer.concat([Buffer.from('%PDF-1.7\nanonymous private original\n'),randomBytes(1024*1024)]);await writeFile(input,body);
 const context='anonymous-project:drawings/anonymous-project/source.pdf',result=await sealSchemeFile({input,output,key,context});
 const encrypted=await readFile(output);assert.ok(encrypted.subarray(0,8).equals(SCHEME_VAULT_MAGIC));assert.equal(encrypted.includes(Buffer.from('%PDF-')),false);assert.equal(encrypted.includes(Buffer.from('anonymous private original')),false);
 assert.equal(result.plaintext_sha256,createHash('sha256').update(body).digest('hex'));assert.equal(result.encrypted_bytes,body.length+36);assert.deepEqual(await readFile(input),body);
 assert.deepEqual(await verifySealedSchemeFile({input:output,key,context,expectedSha256:result.plaintext_sha256}),result);
 const repeated=await sealSchemeFile({input,output,key,context});assert.deepEqual(repeated,result);assert.deepEqual(await readFile(output),encrypted);assert.equal((await readdir(dir)).some(name=>name.endsWith('.tmp')),false);
});
test('tampering, another project, a wrong key and conflicting reruns never replace a sealed original',async t=>{
 const dir=await fixture(t),input=path.join(dir,'input.pdf'),output=path.join(dir,'sealed.pdf'),key=randomBytes(32),context='p1:drawings/p1/source.pdf';await writeFile(input,'%PDF-1.7\nanonymous source');
 const result=await sealSchemeFile({input,output,key,context}),before=await readFile(output);
 for(const request of [{key:randomBytes(32),context},{key,context:'p2:drawings/p2/source.pdf'}])await assert.rejects(verifySealedSchemeFile({input:output,...request}),{code:'scheme_vault_auth'});
 await assert.rejects(verifySealedSchemeFile({input:output,key,context,expectedSha256:'0'.repeat(64)}),{code:'scheme_vault_digest'});
 const changed=Buffer.from(before);changed[21]^=1;await writeFile(path.join(dir,'tampered'),changed);await assert.rejects(verifySealedSchemeFile({input:path.join(dir,'tampered'),key,context}),{code:'scheme_vault_auth'});
 await writeFile(input,'%PDF-1.7\nanother anonymous source');await assert.rejects(sealSchemeFile({input,output,key,context}),{code:'scheme_vault_digest'});assert.deepEqual(await readFile(output),before);
 assert.equal(result.plain_bytes,Buffer.byteLength('%PDF-1.7\nanonymous source'));await assert.rejects(sealSchemeFile({input,output:input,key,context}),{code:'scheme_source_overwrite'});
});
test('key creation is explicit, stable and independent of the prepared material',async t=>{
 const dir=await fixture(t),filename=path.join(dir,'secrets','key');await assert.rejects(loadSchemeKey(filename),{code:'scheme_key_missing'});
 const key=await loadSchemeKey(filename,{create:true});assert.equal(key.length,32);assert.deepEqual(await loadSchemeKey(filename,{create:true}),key);
 await writeFile(filename,'invalid');await assert.rejects(loadSchemeKey(filename),{code:'scheme_key_invalid'});
});
