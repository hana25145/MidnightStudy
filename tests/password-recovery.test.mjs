import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = readFileSync(new URL('../supabase/functions/password-recovery/index.ts', import.meta.url), 'utf8');
// Exercise the actual handler without network access or production credentials.
const js = stripTypeScriptTypes(source.replace(/^import .*;\r?\n/, '').replace('Deno.serve(makeHandler());', ''));
const { makeHandler } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const token = 'a'.repeat(64);
function fixture(result = { ok: true, token, userId: 'fixture-user' }, updateError = null) {
  const calls = [];
  const handler = makeHandler(() => ({
    rpc: async (name, args) => { calls.push({ name, args }); return { data: result, error: null }; },
    auth: { admin: { updateUserById: async (...args) => { calls.push({ update: args }); return { error: updateError }; } } },
  }));
  const request = (body, origin = 'https://midnight-study.vercel.app') => handler(new Request('https://example.test', {
    method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { handler, calls, request };
}

test('code login returns a reset capability, never an application auth session', async () => {
  const { request, calls } = fixture();
  const response = await request({ action: 'login', name: ' 학생 ', code: '12345678' });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(await response.json()), ['token']);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(calls[0].args.p_name, '학생');
  assert.equal(calls.length, 1);
});
test('wrong, revoked, exhausted and reused codes receive the same generic error', async () => {
  const { request, calls } = fixture({ ok: false });
  const response = await request({ action: 'login', name: '학생', code: '00000000' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /5회 오류/);
  assert.equal(calls.length, 1);
});
test('malformed bounded codes reach SQL so they count toward the five-attempt limit', async () => {
  const { request, calls } = fixture({ ok: false });
  await request({ action: 'login', name: '학생', code: 'wrong' });
  assert.equal(calls[0].args.p_code, 'wrong');
});
test('valid reset consumes the grant before changing only the verified user password', async () => {
  const { request, calls } = fixture();
  assert.equal((await request({ action: 'reset', token, password: 'new-password' })).status, 200);
  assert.equal(calls[0].name, 'consume_password_reset_token');
  assert.deepEqual(calls[1].update, ['fixture-user', { password: 'new-password' }]);
});
test('replayed or revoked reset grant cannot change a password', async () => {
  const { request, calls } = fixture({ ok: false });
  const response = await request({ action: 'reset', token, password: 'new-password' });
  assert.equal((await response.json()).restart, true);
  assert.equal(calls.length, 1);
});
test('invalid password does not burn the reset grant', async () => {
  for (const password of ['short', '가'.repeat(25), null, 12345678]) {
    const { request, calls } = fixture();
    assert.equal((await request({ action: 'reset', token, password })).status, 400);
    assert.equal(calls.length, 0);
  }
});
test('malformed reset token never reaches the database', async () => {
  const { request, calls } = fixture();
  assert.equal((await request({ action: 'reset', token: '12345678', password: 'new-password' })).status, 400);
  assert.equal(calls.length, 0);
});
test('Auth update failure fails closed and requires a new code', async () => {
  const { request, calls } = fixture(undefined, { message: 'private backend error' });
  const response = await request({ action: 'reset', token, password: 'new-password' });
  const result = await response.json();
  assert.equal(result.restart, true);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(result.error, /private backend/);
});
test('disallowed origins, oversized bodies, malformed JSON and invalid methods fail safely', async () => {
  const { request, handler, calls } = fixture();
  assert.equal((await request({}, 'https://evil.test')).status, 403);
  assert.equal((await request({ data: 'x'.repeat(5000) })).status, 413);
  assert.equal((await handler(new Request('https://example.test', { method: 'POST', body: '{' }))).status, 400);
  assert.equal((await handler(new Request('https://example.test'))).status, 405);
  assert.equal((await handler(new Request('https://example.test', { method: 'OPTIONS' }))).status, 204);
  assert.equal(calls.length, 0);
});

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function appFixture(savedRecovery = null) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, textContent: '', style: {}, value: '',
      classList: { add: (c) => { if (c === 'hidden') get(id).hidden = true; }, remove: (c) => { if (c === 'hidden') get(id).hidden = false; }, toggle: (c, v) => { if (c === 'hidden') get(id).hidden = v; } },
      addEventListener() {}, setAttribute() {},
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { querySelector: get, querySelectorAll: () => [], addEventListener() {} },
    window: { SUPABASE_CONFIG: {} }, sessionStorage: { getItem: () => JSON.stringify(savedRecovery), removeItem() {}, setItem() {} },
    supabase: { createClient: () => ({ auth: { getSession: async () => ({ data: {} }), onAuthStateChange() {} } }) },
    setInterval() {}, setTimeout() {}, clearTimeout() {}, TextEncoder, Date, console,
  });
  vm.runInContext(appSource, context);
  return { context, get };
}
test('restricted recovery view hides all seat/admin/auth screens', () => {
  const { context, get } = appFixture();
  vm.runInContext("passwordRecovery = { token: 'test' }; state = {user:{role:'super_admin'}}; render();", context);
  for (const id of ['authView', 'adminView', 'dashboardView', 'roomUpdateView', 'logoutButton']) assert.equal(get(`#${id}`).hidden, true);
  assert.equal(get('#passwordResetView').hidden, false);
});
test('stored recovery survives reload without an expiry or despite a legacy past expiry', () => {
  for (const saved of [{ name: '학생', token }, { name: '학생', token, expiresAt: '2000-01-01T00:00:00Z' }]) {
    const { context, get } = appFixture(saved);
    assert.equal(vm.runInContext('passwordRecovery.token', context), token);
    vm.runInContext('render();', context);
    assert.equal(get('#passwordResetView').hidden, false);
  }
});
test('recovery tab does not accidentally show signup or admin registration', () => {
  const { context, get } = appFixture();
  vm.runInContext("switchTab('recovery');", context);
  assert.equal(get('#codeLoginForm').hidden, false);
  for (const id of ['loginForm', 'signupForm', 'adminSignupForm']) assert.equal(get(`#${id}`).hidden, true);
});
test('SQL keeps redemption server-only and row-locks both one-time operations', () => {
  const sql = readFileSync(new URL('../supabase/migrations/013_password_recovery.sql', import.meta.url), 'utf8');
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on function public.redeem_password_login_code\(text,text\) from public, anon, authenticated/);
  assert.match(sql, /revoke all on function public.consume_password_reset_token\(text\) from public, anon, authenticated/);
  assert.equal((sql.match(/for update of c/g) || []).length, 2);
  assert.match(sql, /failed_attempts>=5/);
  assert.match(sql, /v_byte<250/);
  assert.doesNotMatch(sql, /expires_at|expiresAt|10 minutes/);
  assert.doesNotMatch(appSource, /Date.parse\(saved.expiresAt\)/);
});

