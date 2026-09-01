import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source=readFileSync(new URL('../supabase/functions/profile-settings/index.ts',import.meta.url),'utf8');
const js=stripTypeScriptTypes(source.replace(/^import .*;\r?\n/,'').replace('Deno.serve(makeHandler());',''));
globalThis.Deno={ env:{ get:(key)=>({ SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'service',SUPABASE_ANON_KEY:'anon' })[key] } };
const { makeHandler }=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

function fixture({ verifyError=null, authUpdateError=null, rpcError=null }={}) {
  const calls=[];
  const admin={
    auth:{
      getUser:async (token)=>{ calls.push(['getUser',token]); return { data:{ user:{ id:'user-1',email:'old@example.test',user_metadata:{ name:'기존' } } },error:null }; },
      admin:{ updateUserById:async (...args)=>{ calls.push(['updateUserById',...args]); return { error:authUpdateError }; } },
    },
    from:()=>({ select:()=>({ eq:()=>({ single:async()=>({ data:{ name:'기존',room:'A303',role:'student' },error:null }) }) }) }),
    rpc:async (name,args)=>{ calls.push(['rpc',name,args]); return { data:{ name:args.p_name,room:args.p_room,floor:3,role:'student' },error:rpcError }; },
  };
  const verifier={ auth:{ signInWithPassword:async (args)=>{ calls.push(['verifyPassword',args]); return { error:verifyError }; } } };
  const handler=makeHandler((_url,key)=>key==='service'?admin:verifier);
  const request=(body,authorization='Bearer valid-jwt')=>handler(new Request('https://fixture.test',{ method:'POST',headers:{ origin:'https://midnight-study.vercel.app',authorization,'content-type':'application/json' },body:JSON.stringify(body) }));
  return { calls,request };
}

test('profile update synchronizes public profile, name-derived Auth email and metadata',async()=>{
  const { calls,request }=fixture();
  const response=await request({ action:'profile',name:' 새이름 ',room:' a304 ' });
  assert.equal(response.status,200);
  const rpc=calls.find((call)=>call[0]==='rpc');
  assert.equal(rpc[2].p_name,'새이름');
  assert.equal(rpc[2].p_room,'A304');
  const authUpdate=calls.find((call)=>call[0]==='updateUserById');
  assert.equal(authUpdate[1],'user-1');
  assert.match(authUpdate[2].email,/^student-[0-9a-f]{64}@midnightstudy\.local$/);
  assert.equal(authUpdate[2].email_confirm,true);
  assert.deepEqual(authUpdate[2].user_metadata,{ name:'새이름',room:'A304' });
});

test('password change verifies current password before admin update',async()=>{
  const { calls,request }=fixture();
  assert.equal((await request({ action:'password',currentPassword:'old-password',newPassword:'new-password' })).status,200);
  const verifyIndex=calls.findIndex((call)=>call[0]==='verifyPassword');
  const updateIndex=calls.findIndex((call)=>call[0]==='updateUserById');
  assert.ok(verifyIndex>=0 && updateIndex>verifyIndex);
  assert.deepEqual(calls[verifyIndex][1],{ email:'old@example.test',password:'old-password' });
  assert.deepEqual(calls[updateIndex].slice(1),['user-1',{ password:'new-password' }]);
});

test('wrong current password never changes Auth password',async()=>{
  const { calls,request }=fixture({ verifyError:{ message:'invalid' } });
  const response=await request({ action:'password',currentPassword:'wrong-password',newPassword:'new-password' });
  assert.equal(response.status,400);
  assert.match((await response.json()).error,/현재 비밀번호/);
  assert.equal(calls.some((call)=>call[0]==='updateUserById'),false);
});

test('malformed requests and missing authentication fail before data changes',async()=>{
  const { calls,request }=fixture();
  assert.equal((await request({ action:'password',currentPassword:'old-password',newPassword:'short' })).status,400);
  assert.equal((await request({ action:'profile',name:'가',room:'A303' })).status,400);
  assert.equal((await request({ action:'profile',name:'학생',room:'A303' },'')).status,401);
  assert.equal(calls.some((call)=>call[0]==='rpc'||call[0]==='updateUserById'),false);
});

test('SQL endpoint is service-role only and prevents floor changes with an active reservation',()=>{
  const sql=readFileSync(new URL('../supabase/migrations/014_self_profile_settings.sql',import.meta.url),'utf8');
  assert.match(sql,/revoke all on function public\.update_profile_by_service\([^)]+\) from public, anon, authenticated/);
  assert.match(sql,/grant execute on function public\.update_profile_by_service\([^)]+\) to service_role/);
  assert.match(sql,/study_date>=timezone\('Asia\/Seoul',now\(\)\)::date/);
  assert.match(sql,/for update/);
});

