import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const origins = new Set(['https://midnight-study.vercel.app', 'http://127.0.0.1:3000', 'http://localhost:3000']);
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const normalizeName = (value: string) => value.trim().normalize('NFC');
const normalizeRoom = (value: string) => value.trim().toUpperCase().replace(/\s+/g, '');

async function nameToEmail(name: string) {
  const normalized = normalizeName(name).toLocaleLowerCase('ko-KR');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return `student-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}@midnightstudy.local`;
}

export function makeHandler(create = createClient) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin') || '';
    const headers = {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin',
      'Access-Control-Allow-Origin': origins.has(origin) ? origin : 'https://midnight-study.vercel.app',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    const reply = (body: unknown, status=200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !origins.has(origin)) return reply({ error: '허용되지 않은 요청입니다.' }, 403);
    if (request.method==='OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method!=='POST') return reply({ error: 'POST 요청이 필요합니다.' }, 405);

    const authorization = request.headers.get('authorization') || '';
    const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) return reply({ error: '다시 로그인해 주세요.' }, 401);
    try {
      const reader = request.body?.getReader();
      if (!reader) return reply({ error: '잘못된 요청입니다.' }, 400);
      const chunks: Uint8Array[]=[];
      let size=0;
      while (true) {
        const { value, done }=await reader.read();
        if (done) break;
        size+=value.length;
        if (size>4096) { await reader.cancel(); return reply({ error: '요청이 너무 큽니다.' }, 413); }
        chunks.push(value);
      }
      const bytes=new Uint8Array(size);
      let offset=0;
      for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
      let body;
      try { body=JSON.parse(new TextDecoder().decode(bytes)); } catch { return reply({ error: '잘못된 요청입니다.' }, 400); }

      const url=Deno.env.get('SUPABASE_URL')!;
      const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const anonKey=Deno.env.get('SUPABASE_ANON_KEY')!;
      const admin=create(url,serviceKey,options);
      const { data: authData, error: authError }=await admin.auth.getUser(accessToken);
      const user=authData?.user;
      if (authError || !user) return reply({ error: '로그인 시간이 만료되었습니다. 다시 로그인해 주세요.' }, 401);
      const { data: profile, error: profileError }=await admin.from('profiles').select('name,room,role').eq('id',user.id).single();
      if (profileError || !profile || !['student','admin','super_admin'].includes(profile.role)) return reply({ error: '계정 정보를 찾을 수 없습니다.' }, 404);

      if (body?.action==='profile') {
        if (typeof body.name!=='string' || body.name.length>100 || typeof body.room!=='string' || body.room.length>30) return reply({ error: '입력 정보를 확인해 주세요.' }, 400);
        const name=normalizeName(body.name);
        const room=profile.role==='student' ? normalizeRoom(body.room) : '';
        if (name.length<2 || name.length>20) return reply({ error: '이름은 2~20자로 입력해 주세요.' }, 400);
        const { data: updated, error: updateError }=await admin.rpc('update_profile_by_service', {
          p_user_id:user.id,p_name:name,p_room:room,p_expected_name:profile.name,p_expected_room:profile.room,
        });
        if (updateError) return reply({ error:updateError.message }, 400);
        const metadata={ ...(user.user_metadata || {}), name, ...(profile.role==='student' ? { room } : {}) };
        const { error: authUpdateError }=await admin.auth.admin.updateUserById(user.id, {
          email:await nameToEmail(name),email_confirm:true,user_metadata:metadata,
        });
        if (authUpdateError) {
          // Best-effort rollback keeps the visible profile and name-derived Auth email aligned.
          const { error: rollbackError }=await admin.rpc('update_profile_by_service', {
            p_user_id:user.id,p_name:profile.name,p_room:profile.room || '',p_expected_name:name,p_expected_room:updated.room,
          });
          return reply({ error:rollbackError ? '계정 정보 동기화에 실패했습니다. 관리자에게 문의해 주세요.' : '이름을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, 409);
        }
        return reply({ ok:true, profile:updated });
      }

      if (body?.action==='password') {
        if (typeof body.currentPassword!=='string' || typeof body.newPassword!=='string') return reply({ error:'비밀번호를 입력해 주세요.' },400);
        if (body.newPassword.length<8 || new TextEncoder().encode(body.newPassword).length>72) return reply({ error:'새 비밀번호는 8자 이상, UTF-8 기준 72바이트 이하로 입력해 주세요.' },400);
        const verifier=create(url,anonKey,options);
        const { error: verifyError }=await verifier.auth.signInWithPassword({ email:user.email!,password:body.currentPassword });
        if (verifyError) return reply({ error:'현재 비밀번호가 올바르지 않습니다.' },400);
        const { error: passwordError }=await admin.auth.admin.updateUserById(user.id,{ password:body.newPassword });
        if (passwordError) return reply({ error:'비밀번호를 변경하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' },400);
        return reply({ ok:true });
      }
      return reply({ error:'잘못된 요청입니다.' },400);
    } catch {
      return reply({ error:'요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' },503);
    }
  };
}

Deno.serve(makeHandler());

