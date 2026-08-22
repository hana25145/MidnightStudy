const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const OPEN_HOUR = Number(process.env.OPEN_HOUR ?? 18);
const CLOSE_HOUR = Number(process.env.CLOSE_HOUR ?? 23);
const CLOSE_MINUTE = Number(process.env.CLOSE_MINUTE ?? 50);
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const sessions = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });

function emptyDb() {
  return { users: [], reservations: [] };
}

function readDb() {
  if (!fs.existsSync(DB_PATH)) return emptyDb();
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      reservations: Array.isArray(parsed.reservations) ? parsed.reservations : [],
    };
  } catch (error) {
    console.error('데이터 파일을 읽지 못했습니다.', error);
    return emptyDb();
  }
}

function writeDb(db) {
  const tempPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tempPath, DB_PATH);
}

function koreanNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function applicationState() {
  const now = koreanNow();
  const minutes = Number(now.hour) * 60 + Number(now.minute);
  const opens = OPEN_HOUR * 60;
  const closes = CLOSE_HOUR * 60 + CLOSE_MINUTE;
  const date = `${now.year}-${now.month}-${now.day}`;
  let nextDate = date;
  let nextHour = OPEN_HOUR;
  let nextMinute = 0;
  if (minutes >= opens && minutes < closes) {
    nextHour = CLOSE_HOUR;
    nextMinute = CLOSE_MINUTE;
  } else if (minutes >= closes) {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const tomorrowParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(tomorrow);
    const values = Object.fromEntries(tomorrowParts.map(({ type, value }) => [type, value]));
    nextDate = `${values.year}-${values.month}-${values.day}`;
  }
  return {
    date,
    open: minutes >= opens && minutes < closes,
    currentTime: `${now.hour}:${now.minute}`,
    opensAt: `${String(OPEN_HOUR).padStart(2, '0')}:00`,
    closesAt: `${String(CLOSE_HOUR).padStart(2, '0')}:${String(CLOSE_MINUTE).padStart(2, '0')}`,
    nextChangeAt: `${nextDate}T${String(nextHour).padStart(2, '0')}:${String(nextMinute).padStart(2, '0')}:00+09:00`,
  };
}

function normalizeRoom(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function floorFromRoom(room) {
  const match = normalizeRoom(room).match(/^[AB](\d)\d{2}$/);
  return match ? Number(match[1]) : null;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, saved] = String(stored).split(':');
  if (!salt || !saved) return false;
  const calculated = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(saved, 'hex');
  return calculated.length === expected.length && crypto.timingSafeEqual(calculated, expected);
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((entry) => entry.trim().split('='))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function getUser(req) {
  const token = parseCookies(req).session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return readDb().users.find((user) => user.id === session.userId) || null;
}

function publicUser(user) {
  return user ? { id: user.id, name: user.name, room: user.room, floor: user.floor } : null;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function error(res, status, message) {
  json(res, status, { error: message });
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) throw new Error('요청이 너무 큽니다.');
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new Error('올바른 JSON 요청이 아닙니다.');
  }
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function sessionCookie(token, maxAge = 604800) {
  return `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function seatsFor(user, db, date) {
  const reservations = db.reservations.filter((item) => item.date === date && item.floor === user.floor);
  return Array.from({ length: 7 }, (_, index) => {
    const seat = index + 1;
    const reservation = reservations.find((item) => item.seat === seat);
    const applicant = reservation && db.users.find((item) => item.id === reservation.userId);
    return {
      number: seat,
      occupied: Boolean(reservation),
      mine: reservation?.userId === user.id,
      applicantName: applicant?.name || null,
    };
  });
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/session') {
    const user = getUser(req);
    const state = applicationState();
    if (!user) return json(res, 200, { user: null, application: state });
    const db = readDb();
    const reservation = db.reservations.find((item) => item.userId === user.id && item.date === state.date) || null;
    return json(res, 200, {
      user: publicUser(user),
      application: state,
      reservation: reservation ? { floor: reservation.floor, seat: reservation.seat } : null,
      seats: seatsFor(user, db, state.date),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/signup') {
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const room = normalizeRoom(body.room);
    const password = String(body.password || '');
    const floor = floorFromRoom(room);
    if (name.length < 2 || name.length > 20) return error(res, 400, '이름은 2~20자로 입력해 주세요.');
    if (!floor) return error(res, 400, '기숙사 방은 A303 또는 B206 형식으로 입력해 주세요.');
    if (password.length < 8 || password.length > 72) return error(res, 400, '비밀번호는 8~72자로 입력해 주세요.');
    const db = readDb();
    if (db.users.some((user) => user.name.toLowerCase() === name.toLowerCase())) {
      return error(res, 409, '같은 이름으로 가입한 계정이 이미 있습니다.');
    }
    const user = {
      id: crypto.randomUUID(), name, room, floor,
      passwordHash: hashPassword(password), createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    writeDb(db);
    const token = createSession(user.id);
    return json(res, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token) });
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    const user = readDb().users.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!user || !verifyPassword(password, user.passwordHash)) return error(res, 401, '이름 또는 비밀번호가 올바르지 않습니다.');
    const token = createSession(user.id);
    return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token) });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const token = parseCookies(req).session;
    if (token) sessions.delete(token);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (req.method === 'POST' && url.pathname === '/api/reservations') {
    const user = getUser(req);
    if (!user) return error(res, 401, '로그인이 필요합니다.');
    const state = applicationState();
    if (!state.open) return error(res, 403, `신청은 ${state.opensAt}부터 ${state.closesAt}까지 가능합니다.`);
    const body = await readJson(req);
    const seat = Number(body.seat);
    if (!Number.isInteger(seat) || seat < 1 || seat > 7) return error(res, 400, '좌석은 1~7번 중에서 선택해 주세요.');
    const db = readDb();
    if (db.reservations.some((item) => item.date === state.date && item.userId === user.id)) {
      return error(res, 409, '오늘 이미 신청한 좌석이 있습니다. 먼저 취소해 주세요.');
    }
    if (db.reservations.some((item) => item.date === state.date && item.floor === user.floor && item.seat === seat)) {
      return error(res, 409, '방금 다른 학생이 이 좌석을 신청했습니다. 다른 좌석을 선택해 주세요.');
    }
    db.reservations.push({
      id: crypto.randomUUID(), userId: user.id, date: state.date,
      floor: user.floor, seat, createdAt: new Date().toISOString(),
    });
    writeDb(db);
    return json(res, 201, { reservation: { floor: user.floor, seat } });
  }

  if (req.method === 'DELETE' && url.pathname === '/api/reservations/me') {
    const user = getUser(req);
    if (!user) return error(res, 401, '로그인이 필요합니다.');
    const state = applicationState();
    if (!state.open) return error(res, 403, '신청 시간에만 취소할 수 있습니다.');
    const db = readDb();
    const before = db.reservations.length;
    db.reservations = db.reservations.filter((item) => !(item.date === state.date && item.userId === user.id));
    if (db.reservations.length === before) return error(res, 404, '취소할 신청 내역이 없습니다.');
    writeDb(db);
    return json(res, 200, { ok: true });
  }

  return error(res, 404, '요청한 API를 찾을 수 없습니다.');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
};

function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('페이지를 찾을 수 없습니다.');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return error(res, 405, '허용되지 않은 요청입니다.');
    return serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    return error(res, 500, err.message === '요청이 너무 큽니다.' ? err.message : '서버 오류가 발생했습니다.');
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`심야 자습 신청 서비스: http://${HOST}:${PORT}`);
  });
}

module.exports = { floorFromRoom, applicationState, server };

