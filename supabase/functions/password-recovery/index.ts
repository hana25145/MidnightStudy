import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const origins = new Set(['https://midnight-study.vercel.app', 'http://127.0.0.1:3000', 'http://localhost:3000']);
const invalidCode = '이름 또는 코드가 올바르지 않거나 사용할 수 없는 코드입니다. 5회 오류 시 새 코드를 발급받아야 합니다.';
const invalidToken = '이미 사용했거나 무효화된 재설정 요청입니다. 선생님께 새 코드를 발급받아 주세요.';

// No regular login session is issued until the new password is saved.
// Never log request bodies, codes, reset tokens, passwords or service keys.
export function makeHandler(createAdmin = () => createClient(
  Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin') || '';
    const headers = {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin',
      'Access-Control-Allow-Origin': origins.has(origin) ? origin : 'https://midnight-study.vercel.app',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !origins.has(origin)) return reply({ error: '허용되지 않은 요청입니다.' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return reply({ error: 'POST 요청이 필요합니다.' }, 405);
    try {
      // Bound the streamed body as well as Content-Length (which may be absent).
      const reader = request.body?.getReader();
      if (!reader) return reply({ error: '잘못된 요청입니다.' }, 400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4096) { await reader.cancel(); return reply({ error: '요청이 너무 큽니다.' }, 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let body;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return reply({ error: '잘못된 요청입니다.' }, 400); }
      if (!body || typeof body !== 'object') return reply({ error: '잘못된 요청입니다.' }, 400);
      if (body.action === 'login') {
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 || typeof body.code !== 'string' || body.code.length > 64) {
          return reply({ error: invalidCode }, 400);
        }
        const { data, error } = await createAdmin().rpc('redeem_password_login_code', {
          p_name: body.name.trim().normalize('NFC'), p_code: body.code.trim(),
        });
        if (error) return reply({ error: '일시적인 오류입니다. 잠시 뒤 다시 시도해 주세요.' }, 503);
        if (!data?.ok) return reply({ error: invalidCode }, 400);
        return reply({ token: data.token });
      }
      if (body.action === 'reset') {
        if (typeof body.password !== 'string' || body.password.length < 8 || new TextEncoder().encode(body.password).length > 72) {
          return reply({ error: '비밀번호는 8자 이상, UTF-8 기준 72바이트 이하로 입력해 주세요.' }, 400);
        }
        if (typeof body.token !== 'string' || !/^[0-9a-f]{64}$/.test(body.token)) return reply({ error: invalidToken }, 400);
        const admin = createAdmin();
        const { data, error } = await admin.rpc('consume_password_reset_token', { p_token: body.token });
        if (error) return reply({ error: '일시적인 오류입니다. 잠시 뒤 다시 시도해 주세요.' }, 503);
        if (!data?.ok) return reply({ error: invalidToken, restart: true }, 400);
        const { error: updateError } = await admin.auth.admin.updateUserById(data.userId, { password: body.password });
        // A consumed grant is NEVER restored; a lost response must not permit replay.
        if (updateError) return reply({ error: '비밀번호를 저장하지 못했습니다. 새 코드를 발급받아 다시 시도해 주세요.', restart: true }, 400);
        return reply({ ok: true });
      }
      return reply({ error: '잘못된 요청입니다.' }, 400);
    } catch {
      return reply({ error: '처리 결과를 확인할 수 없습니다. 새 비밀번호로 로그인을 시도하고, 안 되면 새 코드를 발급받아 주세요.' }, 503);
    }
  };
}

Deno.serve(makeHandler());

