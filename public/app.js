const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
let state = null;
let stateTimer = null;
let refreshing = false;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
  return data;
}

function setMessage(target, message, success = false) {
  target.textContent = message;
  target.style.color = success ? '#387457' : '#ac433b';
}

function setBusy(form, busy) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = busy;
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
  $('#todayLabel').textContent = `${formatDate(application.date)} · NIGHT STUDY`;
  $('#userName').textContent = user.name;
  $('#floorLabel').textContent = `${user.floor}층`;
  $('#profileName').textContent = user.name;
  $('#profileRoom').textContent = user.room;
  $('#profileFloor').textContent = `${user.floor}층`;
  $('#avatar').textContent = user.name.slice(-1);

  const badge = $('#applicationBadge');
  badge.classList.toggle('open', application.open);
  badge.querySelector('strong').textContent = application.open ? `신청 가능 · ${application.closesAt} 마감` : `신청 마감 · ${application.opensAt} 오픈`;
  $('#seatHelp').textContent = application.open ? '초록색 좌석을 눌러 선택하세요.' : `신청 가능 시간은 ${application.opensAt}~${application.closesAt}입니다.`;

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
    $('#reservationFloor').textContent = `${reservation.floor}층 · 나의 좌석`;
    $('#reservationSeat').textContent = reservation.seat;
    $('#cancelButton').disabled = !application.open;
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api('/api/session');
    render();
    scheduleStateRefresh();
  } finally {
    refreshing = false;
  }
}

function scheduleStateRefresh() {
  clearTimeout(stateTimer);
  const changeTime = new Date(state.application.nextChangeAt).getTime();
  const delay = Math.max(500, Math.min(changeTime - Date.now() + 500, 2_147_000_000));
  stateTimer = setTimeout(() => refresh().catch(() => {}), delay);
}

async function reserve(seat) {
  if (!confirm(`${state.user.floor}층 ${seat}번 좌석을 신청할까요?`)) return;
  try {
    await api('/api/reservations', { method: 'POST', body: JSON.stringify({ seat }) });
    await refresh();
    setMessage($('#dashboardMessage'), `${seat}번 좌석 신청이 완료되었습니다.`, true);
  } catch (error) {
    setMessage($('#dashboardMessage'), error.message);
    await refresh();
  }
}

$$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setBusy(form, true);
  try {
    const values = Object.fromEntries(new FormData(form));
    await api('/api/login', { method: 'POST', body: JSON.stringify(values) });
    form.reset();
    await refresh();
  } catch (error) {
    setMessage($('#authMessage'), error.message);
  } finally { setBusy(form, false); }
});

$('#signupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setBusy(form, true);
  try {
    const values = Object.fromEntries(new FormData(form));
    await api('/api/signup', { method: 'POST', body: JSON.stringify(values) });
    form.reset();
    await refresh();
  } catch (error) {
    setMessage($('#authMessage'), error.message);
  } finally { setBusy(form, false); }
});

$('#logoutButton').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  await refresh();
});

$('#cancelButton').addEventListener('click', async () => {
  if (!confirm('오늘의 좌석 신청을 취소할까요?')) return;
  try {
    await api('/api/reservations/me', { method: 'DELETE' });
    await refresh();
    setMessage($('#dashboardMessage'), '좌석 신청을 취소했습니다.', true);
  } catch (error) { setMessage($('#dashboardMessage'), error.message); }
});

// 다른 학생의 신청과 신청 시간 전환을 새로고침 없이 반영합니다.
setInterval(() => refresh().catch(() => {}), 30_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh().catch(() => {});
});
refresh().catch(() => setMessage($('#authMessage'), '서버에 연결할 수 없습니다.'));

