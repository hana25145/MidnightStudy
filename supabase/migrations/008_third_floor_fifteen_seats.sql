create or replace function public.floor_seat_count(p_floor integer)
returns smallint language sql immutable strict set search_path = public
as $$ select (case when p_floor=3 or p_floor between 6 and 8 then 15 else 7 end)::smallint $$;

revoke all on function public.floor_seat_count(integer) from public,anon,authenticated;

create or replace function public.get_dashboard(p_session integer default 1)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_user_id uuid:=auth.uid(); v_profile public.profiles%rowtype;
  v_now timestamp:=timezone('Asia/Seoul',now()); v_date date:=v_now::date;
  v_open boolean:=v_now::time>=time '18:00' and v_now::time<time '23:50';
  v_seat_count smallint; v_settings public.system_settings%rowtype;
  v_mode text:='normal'; v_session_end text:='01:00'; v_blocked_until date;
  v_absence_count smallint; v_room_update_required boolean:=false;
begin
  if v_user_id is null then raise exception '로그인이 필요합니다.'; end if;
  select * into v_profile from public.profiles where id=v_user_id;
  if not found then raise exception '사용자 정보를 찾을 수 없습니다.'; end if;
  select * into v_settings from public.system_settings where id=1;
  if v_settings.exam_start is not null and v_date between v_settings.exam_start and v_settings.exam_end then v_mode:='exam';
  elsif v_settings.exam_start is not null and v_date between v_settings.exam_start-14 and v_settings.exam_start-1 then v_mode:='pre_exam'; end if;

  if v_profile.role in ('admin','super_admin') then
    return jsonb_build_object(
      'user',jsonb_build_object('id',v_profile.id,'name',v_profile.name,'role',v_profile.role),
      'admin',jsonb_build_object(
        'examStart',to_char(v_settings.exam_start,'YYYY-MM-DD'),'examEnd',to_char(v_settings.exam_end,'YYYY-MM-DD'),
        'preExamStart',to_char(v_settings.exam_start-14,'YYYY-MM-DD'),'semesterStart',to_char(v_settings.semester_start,'YYYY-MM-DD'),
        'currentMode',v_mode,'isSuperAdmin',v_profile.role='super_admin'));
  end if;
  if v_profile.role='pending_admin' then raise exception '관리자 초대 코드 인증이 필요합니다.'; end if;
  if v_profile.role='disabled' then raise exception '비활성화된 관리자 계정입니다.'; end if;
  if p_session not in (1,2) then raise exception '올바르지 않은 타임입니다.'; end if;
  if p_session=2 and v_mode<>'exam' then raise exception '심야 2타임은 고사기간에만 신청할 수 있습니다.'; end if;

  v_room_update_required:=v_settings.semester_start is not null and v_date>=v_settings.semester_start
    and v_profile.room_semester_start is distinct from v_settings.semester_start;
  if v_mode in ('pre_exam','exam') then v_session_end:='01:30'; end if;
  if p_session=2 then v_session_end:='02:30'; end if;
  v_seat_count:=public.floor_seat_count(v_profile.floor);
  v_blocked_until:=case when v_profile.banned_until>v_date then v_profile.banned_until else null end;
  v_absence_count:=case when v_profile.banned_until is not null and v_profile.banned_until<=v_date then 0 else v_profile.absence_count end;

  return jsonb_build_object(
    'user',jsonb_build_object('id',v_profile.id,'name',v_profile.name,'room',v_profile.room,'floor',v_profile.floor,'role',v_profile.role,
      'absenceCount',v_absence_count,'bannedUntil',to_char(v_blocked_until,'YYYY-MM-DD'),
      'roomUpdateRequired',v_room_update_required,'semesterStart',to_char(v_settings.semester_start,'YYYY-MM-DD')),
    'application',jsonb_build_object('date',to_char(v_date,'YYYY-MM-DD'),'open',v_open,
      'canApply',v_open and v_blocked_until is null and not v_room_update_required,
      'currentTime',to_char(v_now,'HH24:MI'),'opensAt','18:00','closesAt','23:50','mode',v_mode,
      'selectedSession',p_session,'sessionStart',case when p_session=1 then '23:50' else '01:30' end,
      'sessionEnd',v_session_end,'session2Available',v_mode='exam','blockedUntil',to_char(v_blocked_until,'YYYY-MM-DD')),
    'reservation',(select jsonb_build_object('floor',r.floor,'seat',r.seat,'session',r.session)
      from public.reservations r where r.user_id=v_user_id and r.study_date=v_date and r.session=p_session),
    'seats',(select jsonb_agg(jsonb_build_object('number',s.seat,'occupied',r.id is not null,'mine',r.user_id=v_user_id,
      'applicantName',p.name,'applicantRoom',p.room) order by s.seat)
      from generate_series(1,v_seat_count) s(seat)
      left join public.reservations r on r.study_date=v_date and r.session=p_session and r.floor=v_profile.floor and r.seat=s.seat
      left join public.profiles p on p.id=r.user_id));
end;
$fn$;

create or replace function public.reserve_seat(p_seat integer,p_session integer default 1)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_user_id uuid:=auth.uid(); v_profile public.profiles%rowtype;
  v_now timestamp:=timezone('Asia/Seoul',now()); v_date date:=v_now::date;
  v_seat_count smallint; v_settings public.system_settings%rowtype; v_exam_mode boolean;
begin
  if v_user_id is null then raise exception '로그인이 필요합니다.'; end if;
  if v_now::time<time '18:00' or v_now::time>=time '23:50' then raise exception '신청은 18:00부터 23:50까지 가능합니다.'; end if;
  select * into v_profile from public.profiles where id=v_user_id and role='student' for update;
  if not found then raise exception '학생 계정에서만 신청할 수 있습니다.'; end if;
  select * into v_settings from public.system_settings where id=1;
  if v_settings.semester_start is not null and v_date>=v_settings.semester_start
     and v_profile.room_semester_start is distinct from v_settings.semester_start then
    raise exception '새 학기 기숙사 호실을 먼저 입력해 주세요.';
  end if;
  if v_profile.banned_until is not null and v_profile.banned_until>v_date then
    raise exception '불참 누적으로 %까지 신청할 수 없습니다.',to_char(v_profile.banned_until,'YYYY-MM-DD');
  elsif v_profile.banned_until is not null then
    update public.profiles set absence_count=0,banned_until=null where id=v_user_id;
  end if;
  v_exam_mode:=v_settings.exam_start is not null and v_date between v_settings.exam_start and v_settings.exam_end;
  if p_session not in (1,2) or (p_session=2 and not v_exam_mode) then raise exception '심야 2타임은 고사기간에만 신청할 수 있습니다.'; end if;
  v_seat_count:=public.floor_seat_count(v_profile.floor);
  if p_seat<1 or p_seat>v_seat_count then raise exception '해당 층에서 선택할 수 없는 좌석입니다.'; end if;
  if exists(select 1 from public.reservations where study_date=v_date and session=p_session and user_id=v_user_id) then raise exception '이 타임에 이미 신청한 좌석이 있습니다.'; end if;
  if exists(select 1 from public.reservations where study_date=v_date and session=p_session and floor=v_profile.floor and seat=p_seat) then raise exception '이미 신청된 좌석입니다.'; end if;
  insert into public.reservations(user_id,study_date,session,floor,seat) values(v_user_id,v_date,p_session,v_profile.floor,p_seat);
  return public.get_dashboard(p_session);
exception when unique_violation then raise exception '방금 다른 학생이 이 좌석을 신청했습니다.';
end;
$fn$;

create or replace function public.get_admin_seats(p_floor integer default 1,p_session integer default 1)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_user_id uuid:=auth.uid(); v_now timestamp:=timezone('Asia/Seoul',now()); v_date date;
  v_seat_count smallint; v_settings public.system_settings%rowtype;
  v_session2_available boolean:=false; v_attendance_open boolean;
begin
  if not exists(select 1 from public.profiles where id=v_user_id and role in ('admin','super_admin')) then raise exception '관리자 권한이 필요합니다.'; end if;
  if p_floor<1 or p_floor>8 then raise exception '조회할 층이 올바르지 않습니다.'; end if;
  if p_session not in (1,2) then raise exception '조회할 타임이 올바르지 않습니다.'; end if;
  v_date:=case when v_now::time<time '03:00' then v_now::date-1 else v_now::date end;
  v_attendance_open:=v_now::time>=time '23:50' or v_now::time<time '01:00';
  select * into v_settings from public.system_settings where id=1;
  v_session2_available:=v_settings.exam_start is not null and v_date between v_settings.exam_start and v_settings.exam_end;
  v_seat_count:=public.floor_seat_count(p_floor);
  return jsonb_build_object('date',to_char(v_date,'YYYY-MM-DD'),'floor',p_floor,'session',p_session,
    'session2Available',v_session2_available,'attendanceOpen',v_attendance_open,
    'seats',(select jsonb_agg(jsonb_build_object('number',s.seat,'occupied',r.id is not null,'reservationId',r.id,
      'applicantName',p.name,'applicantRoom',p.room,'attendanceStatus',a.status,'absenceCount',p.absence_count,
      'bannedUntil',to_char(case when p.banned_until>v_date then p.banned_until else null end,'YYYY-MM-DD')) order by s.seat)
      from generate_series(1,v_seat_count) s(seat)
      left join public.reservations r on r.study_date=v_date and r.session=p_session and r.floor=p_floor and r.seat=s.seat
      left join public.profiles p on p.id=r.user_id
      left join public.attendance_records a on a.study_date=v_date and a.user_id=r.user_id));
end;
$fn$;

create or replace function public.get_admin_all_seats(p_session integer default 1)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_user_id uuid:=auth.uid(); v_now timestamp:=timezone('Asia/Seoul',now()); v_date date;
  v_settings public.system_settings%rowtype; v_session2_available boolean:=false; v_attendance_open boolean;
begin
  if not exists(select 1 from public.profiles where id=v_user_id and role in ('admin','super_admin')) then raise exception '관리자 권한이 필요합니다.'; end if;
  if p_session not in (1,2) then raise exception '조회할 타임이 올바르지 않습니다.'; end if;
  v_date:=case when v_now::time<time '03:00' then v_now::date-1 else v_now::date end;
  v_attendance_open:=v_now::time>=time '23:50' or v_now::time<time '01:00';
  select * into v_settings from public.system_settings where id=1;
  v_session2_available:=v_settings.exam_start is not null and v_date between v_settings.exam_start and v_settings.exam_end;
  return jsonb_build_object('date',to_char(v_date,'YYYY-MM-DD'),'session',p_session,
    'session2Available',v_session2_available,'attendanceOpen',v_attendance_open,
    'floors',(select jsonb_agg(jsonb_build_object('floor',f.floor,'gender',case when f.floor<=4 then 'male' else 'female' end,
      'seats',(select jsonb_agg(jsonb_build_object('number',s.seat,'occupied',r.id is not null,'reservationId',r.id,
        'applicantName',p.name,'applicantRoom',p.room,'attendanceStatus',a.status,'absenceCount',p.absence_count,
        'bannedUntil',to_char(case when p.banned_until>v_date then p.banned_until else null end,'YYYY-MM-DD')) order by s.seat)
        from generate_series(1,public.floor_seat_count(f.floor)) s(seat)
        left join public.reservations r on r.study_date=v_date and r.session=p_session and r.floor=f.floor and r.seat=s.seat
        left join public.profiles p on p.id=r.user_id
        left join public.attendance_records a on a.study_date=v_date and a.user_id=r.user_id)) order by f.floor)
      from generate_series(1,8) f(floor)));
end;
$fn$;

