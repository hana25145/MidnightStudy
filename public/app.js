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
let selectedSession = 1;
let adminSeatState = null;
let selectedAdminSession = 1;
let adminAccounts = [];

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
  $('#adminSignupForm').classList.toggle('hidden', tabName !== 'admin');
  setMessage($('#authMessage'), '');
}

function formatDate(date) {
  return new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' })
    .format(new Date(`${date}T12:00:00+09:00`));
}

function render() {
  const loggedIn = Boolean(state?.user);
  const isAdmin = ['admin', 'super_admin'].includes(state?.user?.role);
  const needsRoomUpdate = loggedIn && !isAdmin && Boolean(state?.user?.roomUpdateRequired);
  $('#authView').classList.toggle('hidden', loggedIn);
  $('#roomUpdateView').classList.toggle('hidden', !needsRoomUpdate);
  $('#dashboardView').classList.toggle('hidden', !loggedIn || isAdmin || needsRoomUpdate);
  $('#adminView').classList.toggle('hidden', !isAdmin);
  $('#logoutButton').classList.toggle('hidden', !loggedIn);
  if (!loggedIn) return;
  if (isAdmin) {
    renderAdmin();
    return;
  }
  if (needsRoomUpdate) {
    $('#roomUpdateHelp').textContent = `${state.user.semesterStart} 시작 학기의 새 기숙사 호실을 입력해 주세요.`;
    return;
  }

  const { user, application, reservation, seats } = state;
  $('#todayLabel').textContent = formatDate(application.date);
  $('#userName').textContent = user.name;
  $('#floorLabel').textContent = `${user.floor}층`;
  $('#profileName').textContent = user.name;
  $('#profileRoom').textContent = user.room;
  $('#profileFloor').textContent = `${user.floor}층`;
  $('#profilePeriod').textContent = ({ normal: '평상시', pre_exam: '고사 2주 전', exam: '고사기간' })[application.mode];
  $('#profileStudyTime').textContent = `${application.sessionStart}–${application.sessionEnd}`;
  $('#profileAbsences').textContent = `${user.absenceCount || 0}회`;
  $('#profileBan').textContent = user.bannedUntil ? `${user.bannedUntil}까지` : '없음';
  $('#avatar').textContent = user.name.slice(-1);

  $('#sessionTabs').classList.toggle('hidden', !application.session2Available);
  $$('.session-tab').forEach((tab) => {
    tab.classList.toggle('active', Number(tab.dataset.session) === selectedSession);
  });
  $('#reservationTitle').textContent = `오늘의 신청 · ${selectedSession}타임`;

  const badge = $('#applicationBadge');
  badge.classList.toggle('open', application.canApply);
  badge.querySelector('strong').textContent = application.blockedUntil
    ? `신청 제한 · ${application.blockedUntil}까지`
    : application.open ? `신청 가능 · ${application.closesAt} 마감` : `신청 마감 · ${application.opensAt} 오픈`;
  $('#seatHelp').textContent = application.blockedUntil
    ? '불참 2회 누적으로 신청이 제한되었습니다.'
    : application.open ? '좌석을 눌러 신청하세요.' : `신청 가능 시간은 ${application.opensAt}~${application.closesAt}입니다.`;

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

      const room = document.createElement('small');
      room.className = 'seat-room';
      room.textContent = seat.applicantRoom;
      button.append(room);
    }

    button.disabled = seat.occupied || !application.canApply || Boolean(reservation);
    button.setAttribute('aria-label', `${user.floor}층 ${seat.number}번 좌석${seat.occupied ? `, ${seat.applicantName} ${seat.applicantRoom} 신청 완료` : ', 선택 가능'}`);
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

function renderAdmin() {
  const settings = state.admin;
  const modeLabel = ({ normal: '평상시', pre_exam: '고사 2주 전', exam: '고사기간' })[settings.currentMode];
  $('#adminModeBadge').classList.toggle('open', settings.currentMode !== 'normal');
  $('#adminModeBadge').querySelector('strong').textContent = modeLabel;
  $('#examStart').value = settings.examStart || '';
  $('#examEnd').value = settings.examEnd || '';
  $('#semesterStart').value = settings.semesterStart || '';
  $('#preExamStart').textContent = settings.preExamStart || '—';
  $('#superAdminCard').classList.toggle('hidden', !settings.isSuperAdmin);
  if (settings.isSuperAdmin) renderAdminAccounts();
  renderAdminSeats();
}

function renderAdminAccounts() {
  const select = $('#adminTransferSelect');
  select.replaceChildren(new Option('관리자 선택', ''));
  adminAccounts.forEach((account) => select.add(new Option(account.name, account.id)));
  $('#transferAdminButton').disabled = adminAccounts.length === 0;
}

function renderAdminSeats() {
  if (!adminSeatState) return;
  $('#adminSessionSelect').value = String(selectedAdminSession);
  $('#adminSessionSelect').querySelector('option[value="2"]').disabled = !adminSeatState.session2Available;
  $('#adminSeatDate').textContent = `${formatDate(adminSeatState.date)} · ${selectedAdminSession}타임`;
  $('#attendanceWindowLabel').textContent = adminSeatState.attendanceOpen
    ? '출석·불참은 처리 후에도 01:00까지 변경할 수 있습니다.'
    : '출석 처리는 23:50~01:00에 가능합니다.';

  const renderFloor = (floorData) => {
    const block = document.createElement('section');
    block.className = 'floor-seat-block';
    const heading = document.createElement('h4');
    heading.textContent = `${floorData.floor}층`;
    const grid = document.createElement('div');
    grid.className = 'seat-grid admin-seat-grid';
    floorData.seats.forEach((seat) => {
    const item = document.createElement('div');
    item.className = `seat${seat.occupied ? ' occupied' : ''}`;
    const number = document.createElement('span');
    number.className = 'seat-number';
    number.textContent = seat.number;
    item.append(number);
    if (seat.occupied) {
      const name = document.createElement('small');
      name.className = 'seat-name';
      name.textContent = seat.applicantName;
      const room = document.createElement('small');
      room.className = 'seat-room';
      room.textContent = seat.applicantRoom;
      const attendance = document.createElement('small');
      attendance.className = `attendance-status ${seat.attendanceStatus || ''}`;
      attendance.textContent = seat.attendanceStatus === 'present' ? '출석' : seat.attendanceStatus === 'absent' ? `불참 · 누적 ${seat.absenceCount}회` : '미처리';
      const actions = document.createElement('div');
      actions.className = 'admin-seat-actions';
      const present = document.createElement('button');
      present.type = 'button';
      present.textContent = '출석';
      present.disabled = !adminSeatState.attendanceOpen;
      present.classList.toggle('active', seat.attendanceStatus === 'present');
      present.addEventListener('click', () => markAttendance(seat.reservationId, 'present'));
      const absent = document.createElement('button');
      absent.type = 'button';
      absent.textContent = '불참';
      absent.className = 'absent';
      absent.disabled = !adminSeatState.attendanceOpen;
      absent.classList.toggle('active', seat.attendanceStatus === 'absent');
      absent.addEventListener('click', () => markAttendance(seat.reservationId, 'absent'));
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = '신청 취소';
      cancel.className = 'cancel';
      cancel.addEventListener('click', () => adminCancelReservation(seat));
      actions.append(present, absent, cancel);
      item.append(name, room, attendance, actions);
    }
      grid.append(item);
    });
    block.append(heading, grid);
    return block;
  };

  const male = $('#maleFloorSeats');
  const female = $('#femaleFloorSeats');
  male.replaceChildren();
  female.replaceChildren();
  adminSeatState.floors.forEach((floor) => {
    (floor.gender === 'male' ? male : female).append(renderFloor(floor));
  });
  const seats = adminSeatState.floors.flatMap((floor) => floor.seats);
  const occupied = seats.filter((seat) => seat.occupied).length;
  $('#adminSeatSummary').textContent = `전체 신청 ${occupied}명 / 전체 ${seats.length}석`;
}

async function loadAdminSeats() {
  let { data, error } = await client.rpc('get_admin_all_seats', { p_session: selectedAdminSession });
  if (error) throw error;
  if (selectedAdminSession === 2 && !data.session2Available) {
    selectedAdminSession = 1;
    ({ data, error } = await client.rpc('get_admin_all_seats', { p_session: 1 }));
    if (error) throw error;
  }
  adminSeatState = data;
}

async function loadAdminAccounts() {
  const { data, error } = await client.rpc('list_admin_accounts');
  if (error) throw error;
  adminAccounts = data || [];
}

async function markAttendance(reservationId, status) {
  try {
    const { data, error } = await client.rpc('mark_attendance', {
      p_reservation_id: reservationId,
      p_status: status,
    });
    if (error) throw error;
    await loadAdminSeats();
    renderAdminSeats();
    setMessage($('#adminMessage'), status === 'present' ? '출석으로 처리했습니다.' : '불참으로 처리했습니다.', true);
  } catch (error) {
    setMessage($('#adminMessage'), readableError(error));
  }
}

async function adminCancelReservation(seat) {
  if (!confirm(`${seat.applicantName} (${seat.applicantRoom}) 학생의 신청을 취소할까요?`)) return;
  try {
    const { data, error } = await client.rpc('admin_cancel_reservation', { p_reservation_id: seat.reservationId });
    if (error) throw error;
    await loadAdminSeats();
    renderAdminSeats();
    setMessage($('#adminMessage'), '학생의 신청을 취소했습니다.', true);
  } catch (error) {
    setMessage($('#adminMessage'), readableError(error));
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

    let { data, error } = await client.rpc('get_dashboard', { p_session: selectedSession });
    if (error && selectedSession === 2 && /2타임|고사기간/.test(error.message || '')) {
      selectedSession = 1;
      ({ data, error } = await client.rpc('get_dashboard', { p_session: 1 }));
    }
    if (error) throw error;
    state = data;
    if (['admin', 'super_admin'].includes(state?.user?.role)) {
      await loadAdminSeats();
      if (state.admin?.isSuperAdmin) await loadAdminAccounts();
    }
    render();
  } catch (error) {
    if (/jwt|session|로그인이 필요/i.test(error.message || '')) await client.auth.signOut();
    throw error;
  } finally {
    refreshing = false;
  }
}

async function reserve(seat) {
  if (!confirm(`${selectedSession}타임 ${state.user.floor}층 ${seat}번 좌석을 신청할까요?`)) return;
  try {
    const { data, error } = await client.rpc('reserve_seat', { p_seat: seat, p_session: selectedSession });
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

$('#roomUpdateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setBusy(form, true);
  try {
    const values = Object.fromEntries(new FormData(form));
    const room = values.room.trim().toUpperCase().replace(/\s+/g, '');
    const { data, error } = await client.rpc('update_room', { p_room: room });
    if (error) throw error;
    state = data;
    form.reset();
    render();
    setMessage($('#dashboardMessage'), '새 학기 호실을 저장했습니다.', true);
  } catch (error) {
    setMessage($('#roomUpdateMessage'), readableError(error));
  } finally {
    setBusy(form, false);
  }
});

$('#adminSignupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setBusy(form, true);
  try {
    const values = Object.fromEntries(new FormData(form));
    const { data: sessionData } = await client.auth.getSession();
    if (!sessionData.session) {
      const name = values.name.trim();
      const email = await nameToEmail(name);
      const { error: signupError } = await client.auth.signUp({
        email,
        password: values.password,
        options: { data: { name, account_type: 'admin' } },
      });
      if (signupError) throw signupError;
    }
    const { data, error } = await client.rpc('claim_admin', { p_code: values.inviteCode.trim() });
    if (error) throw error;
    if (data?.claimError) throw new Error(data.claimError);
    state = data;
    await loadAdminSeats();
    form.reset();
    render();
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

$$('.session-tab').forEach((tab) => tab.addEventListener('click', async () => {
  selectedSession = Number(tab.dataset.session);
  await refresh().catch((error) => setMessage($('#dashboardMessage'), readableError(error)));
}));

$('#cancelButton').addEventListener('click', async () => {
  if (!confirm('오늘의 좌석 신청을 취소할까요?')) return;
  try {
    const { data, error } = await client.rpc('cancel_today_reservation', { p_session: selectedSession });
    if (error) throw error;
    state = data;
    render();
    setMessage($('#dashboardMessage'), '좌석 신청을 취소했습니다.', true);
  } catch (error) {
    setMessage($('#dashboardMessage'), readableError(error));
  }
});

$('#examPeriodForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setBusy(form, true);
  try {
    const values = Object.fromEntries(new FormData(form));
    const { data, error } = await client.rpc('set_exam_period', { p_start: values.start, p_end: values.end });
    if (error) throw error;
    state = data;
    await loadAdminSeats();
    render();
    setMessage($('#adminMessage'), '고사 일정을 저장했습니다.', true);
  } catch (error) {
    setMessage($('#adminMessage'), readableError(error));
  } finally {
    setBusy(form, false);
  }
});

$('#clearExamButton').addEventListener('click', async () => {
  if (!confirm('등록된 고사 일정을 삭제할까요?')) return;
  try {
    const { data, error } = await client.rpc('clear_exam_period');
    if (error) throw error;
    state = data;
    await loadAdminSeats();
    render();
    setMessage($('#adminMessage'), '고사 일정을 삭제했습니다.', true);
  } catch (error) {
    setMessage($('#adminMessage'), readableError(error));
  }
});

$('#semesterStartForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  if (!confirm(`${values.start}부터 학생들이 새 호실을 입력해야 신청할 수 있도록 설정할까요?`)) return;
  setBusy(form, true);
  try {
    const { data, error } = await client.rpc('set_semester_start', { p_start: values.start });
    if (error) throw error;
    state = data;
    render();
    setMessage($('#semesterMessage'), '학기 시작일을 저장했습니다.', true);
  } catch (error) {
    setMessage($('#semesterMessage'), readableError(error));
  } finally {
    setBusy(form, false);
  }
});

$('#createInviteButton').addEventListener('click', async () => {
  try {
    const { data, error } = await client.rpc('create_admin_invite');
    if (error) throw error;
    $('#inviteCodeOutput').textContent = data.code;
    $('#inviteCodeOutput').classList.remove('hidden');
    setMessage($('#superAdminMessage'), '새 코드를 발급했습니다. 선생님께 안전하게 전달하세요.', true);
  } catch (error) {
    setMessage($('#superAdminMessage'), readableError(error));
  }
});

$('#transferAdminButton').addEventListener('click', async () => {
  const target = $('#adminTransferSelect').value;
  const targetName = $('#adminTransferSelect').selectedOptions[0]?.textContent;
  if (!target) return;
  if (!confirm(`${targetName} 계정으로 총관리자 권한을 이전할까요? 현재 계정은 일반 관리자로 계속 이용할 수 있습니다.`)) return;
  try {
    const { error } = await client.rpc('transfer_super_admin', { p_target: target });
    if (error) throw error;
    alert('총관리자 권한을 이전했습니다. 현재 계정은 일반 관리자로 유지됩니다.');
    await refresh();
  } catch (error) {
    setMessage($('#superAdminMessage'), readableError(error));
  }
});

$('#adminSessionSelect').addEventListener('change', async (event) => {
  selectedAdminSession = Number(event.target.value);
  try {
    await loadAdminSeats();
    renderAdminSeats();
  } catch (error) {
    setMessage($('#adminMessage'), readableError(error));
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

