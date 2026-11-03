import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import { createApp, environmentConfig } from '../server/app.mjs';
import { createAuth, createOriginCheck } from '../server/auth.mjs';
import { hashPassword } from '../server/password.mjs';

const old = 'https://127.0.0.1:8443';
const domain = 'https://planning.example.test';
const config = { ...environmentConfig({APP_ORIGIN:old, APP_ADDITIONAL_ORIGINS:domain, COOKIE_SECURE:'true', TRUST_PROXY:'1'}), authCodeSecret:'isolated-origin-test-secret', mailer:{configured:false} };
const password = 'AnonymousIsolation129';
const user = { user_id:'00000000-0000-0000-0000-000000000001', email:'anonymous@example.test', password_hash:await hashPassword(password), disabled:false, must_change_password:false };

function pool() {
  const sessions = new Set();
  const query = async (sql, args=[]) => {
    if(sql.includes('UPDATE app_private.sessions')) return {rows:sessions.has(args[0])?[user]:[]};
    if(sql.includes('FROM app_private.auth_users')) return {rows:[user]};
    if(sql.includes('INSERT INTO app_private.sessions')) sessions.add(args[0]);
    if(sql.includes('DELETE FROM app_private.sessions')) sessions.delete(args[0]);
    if(sql.includes('FROM public.profiles')) return {rows:[{user_id:user.user_id, role:'admin'}]};
    return {rows:[]};
  };
  return { query, connect:async()=>({query,release(){}}), sessions };
}
async function serve(t, app) {
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return `http://127.0.0.1:${server.address().port}`;
}
function post(base,path,origin,body={},cookie,more={}) {
  return fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{}),...(cookie?{cookie}:{}),...more},body:JSON.stringify(body)});
}

test('environment forwards only explicit additional origins and preserves old canonical origin',()=>{
  assert.equal(config.publicOrigin,old);assert.equal(config.additionalOrigins,domain);assert.equal(config.cookieSecure,true);
});
test('additional origin must be a complete HTTP(S) origin, never a path/wildcard/credential URL',()=>{
  for(const value of ['*','https://*.example.test','https://planning.example.test/','https://example.test/path','https://u:p@example.test','data:text/plain,x','https://example.test?q=1'])
    assert.throws(()=>createOriginCheck({publicOrigin:old,additionalOrigins:value}));
});
test('explicit origins reject foreign host, port, scheme and suffix matches',()=>{
  const allowed=createOriginCheck(config);
  const req=origin=>({headers:{origin},protocol:'https',get:()=> 'planning.example.test'});
  for(const origin of [old,domain])assert.equal(allowed(req(origin)),true);
  for(const origin of ['https://attacker.example',domain+':444','http://planning.example.test',domain+'.attacker.example']) assert.equal(allowed(req(origin)),false);
});
test('comma-separated extra origins are explicit and one invalid entry fails the complete configuration',()=>{
  const second='https://second.example.test';
  const allowed=createOriginCheck({publicOrigin:old,additionalOrigins:` ${domain}, , ${second} `});
  for(const origin of [old,domain,second])assert.equal(allowed({headers:{origin}}),true);
  assert.equal(allowed({headers:{origin:'https://other.example.test'}}),false);
  assert.throws(()=>createOriginCheck({publicOrigin:old,additionalOrigins:`${domain},https://example.test/path`}));
});
test('both real application entry origins login with isolated identities and keep secure host-only cookies',async t=>{
  const db=pool(),base=await serve(t,createApp({pool:db,config}));
  for(const origin of [old,domain]) {
    const login=await post(base,'/api/auth/login',origin,{email:user.email,password});
    assert.equal(login.status,200);const header=login.headers.get('set-cookie');
    assert.match(header,/HttpOnly/);assert.match(header,/Secure/);assert.match(header,/SameSite=Lax/);assert.doesNotMatch(header,/Domain=/i);
    const cookie=header.split(';')[0];const token=decodeURIComponent(cookie.split('=')[1]);
    assert.equal(db.sessions.has(createHash('sha256').update(token).digest('hex')),true);
    const session=await fetch(base+'/api/auth/session',{headers:{cookie}});assert.equal((await session.json()).data.session.user.id,user.user_id);
    const logout=await post(base,'/api/auth/logout',origin,{},cookie);assert.equal(logout.status,200);
    const ended=await fetch(base+'/api/auth/session',{headers:{cookie}});assert.equal((await ended.json()).data.session,null);
  }
});
test('real application rejects missing cookie origin and foreign or cross-site writes before DB use',async t=>{
  let queries=0;const db={query(){queries++;throw new Error('Unexpected DB use');}},base=await serve(t,createApp({pool:db,config}));
  for(const path of ['/api/auth/login','/api/db']) {
    assert.equal((await post(base,path,undefined,{},'zh_session=anonymous')).status,403);
    assert.equal((await post(base,path,'https://attacker.example',{},'zh_session=anonymous')).status,403);
    assert.equal((await post(base,path,domain,{},'zh_session=anonymous',{'sec-fetch-site':'cross-site'})).status,403);
  }
  assert.equal(queries,0);
});
test('original one-origin application still rejects unconfigured subdomain',async t=>{
  const base=await serve(t,createApp({pool:pool(),config:{...config,additionalOrigins:''}}));
  assert.equal((await post(base,'/api/auth/login',domain)).status,403);
  assert.equal((await post(base,'/api/auth/login',old)).status,400);
});
test('authentication router independently enforces both allowed origins and foreign rejection',async t=>{
  const app=express();app.use('/api/auth',createAuth({pool:pool(),config}).router);const base=await serve(t,app);
  for(const origin of [old,domain])assert.equal((await post(base,'/api/auth/login',origin)).status,400);
  assert.equal((await post(base,'/api/auth/login','https://attacker.example')).status,403);
});
test('non-cookie CLI authentication and default dynamic single-origin behavior remain supported',async t=>{
  const base=await serve(t,createApp({pool:pool(),config}));
  assert.equal((await post(base,'/api/auth/login',undefined,{email:user.email,password})).status,200);
  const dynamic=createOriginCheck();
  assert.equal(dynamic({headers:{origin:'http://localhost:3000'},protocol:'http',get:()=> 'localhost:3000'}),true);
  assert.equal(dynamic({headers:{origin:domain},protocol:'http',get:()=> 'localhost:3000'}),false);
});
