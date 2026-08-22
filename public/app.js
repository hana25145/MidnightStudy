const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

const client = supabase.createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.publishableKey,
  { auth: { persistSession: true, autoRefreshToken: true } }
);

let state = null;
let refreshing = false;
let boundaryTimer = null;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function millisecondsUntilNextBoundary(now = new Date()) {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const boundaries = [
    Date.UTC(year, month, day, 18, 0) - KST_OFFSET_MS,
    Date.UTC(year, month, day, 23, 50) - KST_OFFSET_MS,
    Date.UTC(year, month, day + 1, 0, 0) - KST_OFFSET_MS,
    Date.UTC(year, month, day + 1, 18, 0) - KST_OFFSET_MS,
  ];
  return Math.min(...boundaries.filter((time) => time > now.getTime())) - now.getTime();
}

function scheduleBoundaryRefresh() {
  clearTimeout(boundaryTimer);
  boundaryTimer = setTimeout(async () => {
    await refresh().catch(() => {});
    scheduleBoundaryRefresh();
  }, millisecondsUntilNextBoundary() + 100);
}

function setMessage(target, message, success = false) {
  target.textContent = message;
  target.style.color = success ? '#387457' : '#ac433b';
}

function setBusy(form, busy) {
  form.querySelector('button[type="submit"]').disabled = busy;
}

function readableError(error) {
  const message = error?.message || '요청을 처리하지 못했습니다.';
  if (/invalid login credentials/i.test(message)) return '이름 또는 비밀번호가 올바르지 않습니다.';
  if (/user already registered/i.test(message)) return '같은 이름으로 가입한 계정이 이미 있습니다.';
  if (/database error saving new user/i.test(message)) return '같은 이름으로 가입한 계정이 있거나 입력 정보가 올바르지 않습니다.';
  if (/password should be/i.test(message)) return '비밀번호는 8자 이상 입력해 주세요.';
  return message;
}

async function nameToEmail(name) {
  const normalized = name.trim().normalize('NFC').toLocaleLowerCase('ko-KR');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `student-${hash}@midnightstudy.local`;
}

function switchTab(tabName) {
  $$('.tab').forEach((tab) => {
    const active = tab.dataset.tab === tabName;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active);
  });
  $('#loginForm').classList.toggle('hidden', tabName !== 'login');
  $('#signupForm').classList.toggle('hidden', tabName !== 'signup');
  setMessage($('#authMessage'), '');
}

function formatDate(date) {
  return new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' })
    .format(new Date(`${date}T12:00:00+09:00`));
}

function render() {
  const loggedIn = Boolean(state?.user);
  $('#authView').classList.toggle('hidden', loggedIn);
  $('#dashboardView').classList.toggle('hidden', !loggedIn);
  $('#logoutButton').classList.toggle('hidden', !loggedIn);
  if (!loggedIn) return;

  const { user, application, reservation, seats } = state;
  $('#todayLabel').textContent = formatDate(application.date);
  $('#userName').textContent = user.name;
  $('#floorLabel').textContent = `${user.floor}층`;
  $('#profileName').textContent = user.name;
  $('#profileRoom').textContent = user.room;
  $('#profileFloor').textContent = `${user.floor}층`;
  $('#avatar').textContent = user.name.slice(-1);

  const badge = $('#applicationBadge');
  badge.classList.toggle('open', application.open);
  badge.querySelector('strong').textContent = application.open
    ? `신청 가능 · ${application.closesAt} 마감`
    : `신청 마감 · ${application.opensAt} 오픈`;
  $('#seatHelp').textContent = application.open
    ? '좌석을 눌러 신청하세요.'
    : `신청 가능 시간은 ${application.opensAt}~${application.closesAt}입니다.`;

  const grid = $('#seatGrid');
  grid.replaceChildren();
  seats.forEach((seat) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `seat${seat.occupied ? ' occupied' : ''}${seat.mine ? ' mine' : ''}`;

    const number = document.createElement('span');
    number.className = 'seat-number';
    number.textContent = seat.number;
    button.append(number);

    if (seat.applicantName) {
      const name = document.createElement('small');
      name.className = 'seat-name';
      name.textContent = seat.applicantName;
      button.append(name);
    }

    button.disabled = seat.occupied || !application.open || Boolean(reservation);
    button.setAttribute('aria-label', `${user.floor}층 ${seat.number}번 좌석${seat.occupied ? `, ${seat.applicantName} 신청 완료` : ', 선택 가능'}`);
    button.addEventListener('click', () => reserve(seat.number));
    grid.append(button);
  });

  $('#emptyReservation').classList.toggle('hidden', Boolean(reservation));
  $('#activeReservation').classList.toggle('hidden', !reservation);
  if (reservation) {
    $('#reservationFloor').textContent = `${reservation.floor}층`;
    $('#reservationSeat').textContent = reservation.seat;
    $('#cancelButton').disabled = !application.open;
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const { data: sessionData } = await client.auth.getSession();
    if (!sessionData.session) {
      state = { user: null };
      render();
      return;
    }

    const { data, error } = await client.rpc('get_dashboard');
    if (error) throw error;
    state = data;
    render();
  } catch (error) {
    if (/jwt|session|로그인이 필요/i.test(error.message || '')) await client.auth.signOut();
    throw error;
  } finally {
    refreshing = false;
  }
}

async function reserve(seat) {
  if (!confirm(`${state.user.floor}층 ${seat}번 좌석을 신청할까요?`)) return;
  try {
    const { data, error } = await client.rpc('reserve_seat', { p_seat: seat });
    if (error) throw error;
    state = data;
    render();
    setMessage($('#dashboardMessage'), `${seat}번 좌석 신청이 완료되었습니다.`, true);
  } catch (error) {
    setMessage($('#dashboardMessage'), readableError(error));
    await refresh().catch(() => {});
  }
}

$$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setBusy(form, true);
  try {
    const values = Object.fromEntries(new FormData(form));
    const email = await nameToEmail(values.name);
    const { error } = await client.auth.signInWithPassword({ email, password: values.password });
    if (error) throw error;
    form.reset();
    await refresh();
  } catch (error) {
    setMessage($('#authMessage'), readableError(error));
  } finally {
    setBusy(form, false);
  }
});

$('#signupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setBusy(form, true);
  try {
    const values = Object.fromEntries(new FormData(form));
    const name = values.name.trim();
    const room = values.room.trim().toUpperCase().replace(/\s+/g, '');
    const email = await nameToEmail(name);
    const { error } = await client.auth.signUp({
      email,
      password: values.password,
      options: { data: { name, room } },
    });
    if (error) throw error;
    form.reset();
    await refresh();
  } catch (error) {
    setMessage($('#authMessage'), readableError(error));
  } finally {
    setBusy(form, false);
  }
});

$('#logoutButton').addEventListener('click', async () => {
  await client.auth.signOut();
  state = { user: null };
  render();
});

$('#cancelButton').addEventListener('click', async () => {
  if (!confirm('오늘의 좌석 신청을 취소할까요?')) return;
  try {
    const { data, error } = await client.rpc('cancel_today_reservation');
    if (error) throw error;
    state = data;
    render();
    setMessage($('#dashboardMessage'), '좌석 신청을 취소했습니다.', true);
  } catch (error) {
    setMessage($('#dashboardMessage'), readableError(error));
  }
});

setInterval(() => refresh().catch(() => {}), 30_000);
scheduleBoundaryRefresh();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh().catch(() => {});
});

client.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    state = { user: null };
    render();
  }
});

refresh().catch((error) => setMessage($('#authMessage'), readableError(error)));

