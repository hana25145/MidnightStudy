alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles drop constraint if exists profiles_account_fields_check;
alter table public.profiles add constraint profiles_role_check check (role in ('student', 'pending_admin', 'admin', 'super_admin', 'disabled'));
alter table public.profiles add constraint profiles_account_fields_check check (
  (role = 'student' and room ~ '^[AB][1-9][0-9]{2}$' and room !~ '^A9' and floor between 1 and 9)
  or (role in ('pending_admin', 'admin', 'super_admin', 'disabled') and room is null and floor is null)
);
alter table public.profiles add column absence_count smallint not null default 0 check (absence_count >= 0);
alter table public.profiles add column banned_until date;

create table public.attendance_records (
  id bigint generated always as identity primary key,
  study_date date not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('present', 'absent')),
  marked_by uuid not null references public.profiles(id),
  marked_at timestamptz not null default now(),
  unique (study_date, user_id)
);
alter table public.attendance_records enable row level security;
revoke all on public.attendance_records from anon, authenticated;
revoke all on sequence public.attendance_records_id_seq from anon, authenticated;

update public.profiles set role='super_admin'
where id = (select id from public.profiles where role='admin' order by created_at limit 1)
  and not exists (select 1 from public.profiles where role='super_admin');
create unique index profiles_single_super_admin on public.profiles ((role)) where role='super_admin';

create or replace function public.get_dashboard(p_session integer default 1)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_now timestamp := timezone('Asia/Seoul', now());
  v_date date := v_now::date;
  v_open boolean := v_now::time >= time '18:00' and v_now::time < time '23:50';
  v_seat_count smallint;
  v_settings public.system_settings%rowtype;
  v_mode text := 'normal';
  v_session_end text := '01:00';
  v_blocked_until date;
  v_absence_count smallint;
begin
  if v_user_id is null then raise exception '로그인이 필요합니다.'; end if;
  select * into v_profile from public.profiles where id=v_user_id;
  if not found then raise exception '사용자 정보를 찾을 수 없습니다.'; end if;
  select * into v_settings from public.system_settings where id=1;

  if v_settings.exam_start is not null and v_date between v_settings.exam_start and v_settings.exam_end then
    v_mode := 'exam';
  elsif v_settings.exam_start is not null and v_date between v_settings.exam_start - 14 and v_settings.exam_start - 1 then
    v_mode := 'pre_exam';
  end if;

  if v_profile.role in ('admin', 'super_admin') then
    return jsonb_build_object(
      'user',jsonb_build_object('id',v_profile.id,'name',v_profile.name,'role',v_profile.role),
      'admin',jsonb_build_object(
        'examStart',to_char(v_settings.exam_start,'YYYY-MM-DD'),'examEnd',to_char(v_settings.exam_end,'YYYY-MM-DD'),
        'preExamStart',to_char(v_settings.exam_start - 14,'YYYY-MM-DD'),'currentMode',v_mode,
        'isSuperAdmin',v_profile.role='super_admin'
      )
    );
  end if;
  if v_profile.role='pending_admin' then raise exception '관리자 초대 코드 인증이 필요합니다.'; end if;
  if v_profile.role='disabled' then raise exception '비활성화된 관리자 계정입니다.'; end if;
  if p_session not in (1,2) then raise exception '올바르지 않은 타임입니다.'; end if;
  if p_session=2 and v_mode<>'exam' then raise exception '심야 2타임은 고사기간에만 신청할 수 있습니다.'; end if;

  if v_mode in ('pre_exam','exam') then v_session_end:='01:30'; end if;
  if p_session=2 then v_session_end:='02:30'; end if;
  v_seat_count := case when v_profile.floor between 6 and 8 then 15 else 7 end;
  v_blocked_until := case when v_profile.banned_until>v_date then v_profile.banned_until else null end;
  v_absence_count := case when v_profile.banned_until is not null and v_profile.banned_until<=v_date then 0 else v_profile.absence_count end;

  return jsonb_build_object(
    'user',jsonb_build_object(
      'id',v_profile.id,'name',v_profile.name,'room',v_profile.room,'floor',v_profile.floor,'role',v_profile.role,
      'absenceCount',v_absence_count,'bannedUntil',to_char(v_blocked_until,'YYYY-MM-DD')
    ),
    'application',jsonb_build_object(
      'date',to_char(v_date,'YYYY-MM-DD'),'open',v_open,'canApply',v_open and v_blocked_until is null,
      'currentTime',to_char(v_now,'HH24:MI'),'opensAt','18:00','closesAt','23:50','mode',v_mode,
      'selectedSession',p_session,'sessionStart',case when p_session=1 then '23:50' else '01:30' end,
      'sessionEnd',v_session_end,'session2Available',v_mode='exam','blockedUntil',to_char(v_blocked_until,'YYYY-MM-DD')
    ),
    'reservation',(
      select jsonb_build_object('floor',r.floor,'seat',r.seat,'session',r.session)
      from public.reservations r where r.user_id=v_user_id and r.study_date=v_date and r.session=p_session
    ),
    'seats',(
      select jsonb_agg(jsonb_build_object(
        'number',s.seat,'occupied',r.id is not null,'mine',r.user_id=v_user_id,
        'applicantName',p.name,'applicantRoom',p.room
      ) order by s.seat)
      from generate_series(1,v_seat_count) as s(seat)
      left join public.reservations r on r.study_date=v_date and r.session=p_session and r.floor=v_profile.floor and r.seat=s.seat
      left join public.profiles p on p.id=r.user_id
    )
  );
end;
$fn$;

create or replace function public.reserve_seat(p_seat integer, p_session integer default 1)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_now timestamp := timezone('Asia/Seoul', now());
  v_date date := v_now::date;
  v_seat_count smallint;
  v_settings public.system_settings%rowtype;
  v_exam_mode boolean;
begin
  if v_user_id is null then raise exception '로그인이 필요합니다.'; end if;
  if v_now::time<time '18:00' or v_now::time>=time '23:50' then raise exception '신청은 18:00부터 23:50까지 가능합니다.'; end if;
  select * into v_profile from public.profiles where id=v_user_id and role='student' for update;
  if not found then raise exception '학생 계정에서만 신청할 수 있습니다.'; end if;
  if v_profile.banned_until is not null and v_profile.banned_until>v_date then
    raise exception '불참 누적으로 %까지 신청할 수 없습니다.',to_char(v_profile.banned_until,'YYYY-MM-DD');
  elsif v_profile.banned_until is not null then
    update public.profiles set absence_count=0,banned_until=null where id=v_user_id;
  end if;
  select * into v_settings from public.system_settings where id=1;
  v_exam_mode := v_settings.exam_start is not null and v_date between v_settings.exam_start and v_settings.exam_end;
  if p_session not in (1,2) or (p_session=2 and not v_exam_mode) then raise exception '심야 2타임은 고사기간에만 신청할 수 있습니다.'; end if;
  v_seat_count := case when v_profile.floor between 6 and 8 then 15 else 7 end;
  if p_seat<1 or p_seat>v_seat_count then raise exception '해당 층에서 선택할 수 없는 좌석입니다.'; end if;
  if exists(select 1 from public.reservations where study_date=v_date and session=p_session and user_id=v_user_id) then raise exception '이 타임에 이미 신청한 좌석이 있습니다.'; end if;
  if exists(select 1 from public.reservations where study_date=v_date and session=p_session and floor=v_profile.floor and seat=p_seat) then raise exception '이미 신청된 좌석입니다.'; end if;
  insert into public.reservations(user_id,study_date,session,floor,seat) values(v_user_id,v_date,p_session,v_profile.floor,p_seat);
  return public.get_dashboard(p_session);
exception when unique_violation then
  raise exception '방금 다른 학생이 이 좌석을 신청했습니다.';
end;
$fn$;

create or replace function public.set_exam_period(p_start date,p_end date)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare v_user_id uuid:=auth.uid();
begin
  if not exists(select 1 from public.profiles where id=v_user_id and role in ('admin','super_admin')) then raise exception '관리자 권한이 필요합니다.'; end if;
  if p_start is null or p_end is null or p_end<p_start then raise exception '고사 시작일과 종료일을 올바르게 입력해 주세요.'; end if;
  if p_end-p_start>30 then raise exception '고사기간은 31일 이내로 입력해 주세요.'; end if;
  update public.system_settings set exam_start=p_start,exam_end=p_end,updated_at=now(),updated_by=v_user_id where id=1;
  return public.get_dashboard(1);
end;
$fn$;

create or replace function public.clear_exam_period()
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare v_user_id uuid:=auth.uid();
begin
  if not exists(select 1 from public.profiles where id=v_user_id and role in ('admin','super_admin')) then raise exception '관리자 권한이 필요합니다.'; end if;
  update public.system_settings set exam_start=null,exam_end=null,updated_at=now(),updated_by=v_user_id where id=1;
  return public.get_dashboard(1);
end;
$fn$;

create or replace function public.get_admin_seats(p_floor integer default 1,p_session integer default 1)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_user_id uuid:=auth.uid();
  v_now timestamp:=timezone('Asia/Seoul',now());
  v_date date;
  v_seat_count smallint;
  v_settings public.system_settings%rowtype;
  v_session2_available boolean:=false;
  v_attendance_open boolean;
begin
  if not exists(select 1 from public.profiles where id=v_user_id and role in ('admin','super_admin')) then raise exception '관리자 권한이 필요합니다.'; end if;
  if p_floor<1 or p_floor>8 then raise exception '조회할 층이 올바르지 않습니다.'; end if;
  if p_session not in (1,2) then raise exception '조회할 타임이 올바르지 않습니다.'; end if;
  v_date := case when v_now::time<time '03:00' then v_now::date-1 else v_now::date end;
  v_attendance_open := v_now::time>=time '23:50' or v_now::time<time '01:00';
  select * into v_settings from public.system_settings where id=1;
  v_session2_available := v_settings.exam_start is not null and v_date between v_settings.exam_start and v_settings.exam_end;
  v_seat_count := case when p_floor between 6 and 8 then 15 else 7 end;
  return jsonb_build_object(
    'date',to_char(v_date,'YYYY-MM-DD'),'floor',p_floor,'session',p_session,
    'session2Available',v_session2_available,'attendanceOpen',v_attendance_open,
    'seats',(
      select jsonb_agg(jsonb_build_object(
        'number',s.seat,'occupied',r.id is not null,'reservationId',r.id,
        'applicantName',p.name,'applicantRoom',p.room,'attendanceStatus',a.status,
        'absenceCount',p.absence_count,
        'bannedUntil',to_char(case when p.banned_until>v_date then p.banned_until else null end,'YYYY-MM-DD')
      ) order by s.seat)
      from generate_series(1,v_seat_count) as s(seat)
      left join public.reservations r on r.study_date=v_date and r.session=p_session and r.floor=p_floor and r.seat=s.seat
      left join public.profiles p on p.id=r.user_id
      left join public.attendance_records a on a.study_date=v_date and a.user_id=r.user_id
    )
  );
end;
$fn$;

create or replace function public.mark_attendance(p_reservation_id bigint,p_status text)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_admin_id uuid:=auth.uid();
  v_now timestamp:=timezone('Asia/Seoul',now());
  v_study_date date;
  v_reservation public.reservations%rowtype;
  v_old_status text;
  v_delta integer:=0;
  v_new_count integer;
begin
  if not exists(select 1 from public.profiles where id=v_admin_id and role in ('admin','super_admin')) then raise exception '관리자 권한이 필요합니다.'; end if;
  if not (v_now::time>=time '23:50' or v_now::time<time '01:00') then raise exception '출석 처리는 23:50부터 01:00까지 가능합니다.'; end if;
  if p_status not in ('present','absent') then raise exception '출석 상태가 올바르지 않습니다.'; end if;
  v_study_date:=case when v_now::time<time '01:00' then v_now::date-1 else v_now::date end;
  select * into v_reservation from public.reservations where id=p_reservation_id and study_date=v_study_date;
  if not found then raise exception '오늘의 신청 내역을 찾을 수 없습니다.'; end if;
  select status into v_old_status from public.attendance_records where study_date=v_study_date and user_id=v_reservation.user_id for update;
  if not found then
    insert into public.attendance_records(study_date,user_id,status,marked_by) values(v_study_date,v_reservation.user_id,p_status,v_admin_id);
    if p_status='absent' then v_delta:=1; end if;
  elsif v_old_status<>p_status then
    update public.attendance_records set status=p_status,marked_by=v_admin_id,marked_at=now() where study_date=v_study_date and user_id=v_reservation.user_id;
    v_delta:=case when p_status='absent' then 1 else -1 end;
  end if;
  if v_delta<>0 then
    update public.profiles set absence_count=greatest(0,absence_count+v_delta) where id=v_reservation.user_id returning absence_count into v_new_count;
    if v_new_count>=2 then
      update public.profiles set banned_until=(v_study_date+interval '1 month')::date where id=v_reservation.user_id;
    else
      update public.profiles set banned_until=null where id=v_reservation.user_id;
    end if;
  end if;
  return public.get_admin_seats(v_reservation.floor,v_reservation.session);
end;
$fn$;

create or replace function public.admin_cancel_reservation(p_reservation_id bigint)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_admin_id uuid:=auth.uid();
  v_reservation public.reservations%rowtype;
  v_attendance_status text;
  v_new_count integer;
begin
  if not exists(select 1 from public.profiles where id=v_admin_id and role in ('admin','super_admin')) then raise exception '관리자 권한이 필요합니다.'; end if;
  select * into v_reservation from public.reservations where id=p_reservation_id for update;
  if not found then raise exception '신청 내역을 찾을 수 없습니다.'; end if;
  delete from public.reservations where id=p_reservation_id;
  if not exists(select 1 from public.reservations where study_date=v_reservation.study_date and user_id=v_reservation.user_id) then
    select status into v_attendance_status from public.attendance_records where study_date=v_reservation.study_date and user_id=v_reservation.user_id;
    delete from public.attendance_records where study_date=v_reservation.study_date and user_id=v_reservation.user_id;
    if v_attendance_status='absent' then
      update public.profiles set absence_count=greatest(0,absence_count-1) where id=v_reservation.user_id returning absence_count into v_new_count;
      if v_new_count<2 then update public.profiles set banned_until=null where id=v_reservation.user_id; end if;
    end if;
  end if;
  return public.get_admin_seats(v_reservation.floor,v_reservation.session);
end;
$fn$;

create or replace function public.create_admin_invite()
returns jsonb language plpgsql security definer set search_path = public,extensions
as $fn$
declare
  v_user_id uuid:=auth.uid();
  v_code text;
begin
  if not exists(select 1 from public.profiles where id=v_user_id and role='super_admin') then raise exception '총관리자 권한이 필요합니다.'; end if;
  v_code:=lpad(floor(random()*100000000)::bigint::text,8,'0');
  delete from public.admin_invites where used_at is null;
  insert into public.admin_invites(code_hash) values(crypt(v_code,gen_salt('bf')));
  return jsonb_build_object('code',v_code);
end;
$fn$;

create or replace function public.list_admin_accounts()
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare v_user_id uuid:=auth.uid();
begin
  if not exists(select 1 from public.profiles where id=v_user_id and role='super_admin') then raise exception '총관리자 권한이 필요합니다.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by created_at) from public.profiles where role='admin'),'[]'::jsonb);
end;
$fn$;

create or replace function public.transfer_super_admin(p_target uuid)
returns void language plpgsql security definer set search_path = public
as $fn$
declare v_user_id uuid:=auth.uid();
begin
  if not exists(select 1 from public.profiles where id=v_user_id and role='super_admin') then raise exception '총관리자 권한이 필요합니다.'; end if;
  if not exists(select 1 from public.profiles where id=p_target and role='admin') then raise exception '이전할 관리자 계정을 찾을 수 없습니다.'; end if;
  update public.profiles set role='disabled' where id=v_user_id;
  update public.profiles set role='super_admin' where id=p_target;
end;
$fn$;

revoke all on function public.mark_attendance(bigint,text) from public,anon;
revoke all on function public.admin_cancel_reservation(bigint) from public,anon;
revoke all on function public.create_admin_invite() from public,anon;
revoke all on function public.list_admin_accounts() from public,anon;
revoke all on function public.transfer_super_admin(uuid) from public,anon;
grant execute on function public.mark_attendance(bigint,text) to authenticated;
grant execute on function public.admin_cancel_reservation(bigint) to authenticated;
grant execute on function public.create_admin_invite() to authenticated;
grant execute on function public.list_admin_accounts() to authenticated;
grant execute on function public.transfer_super_admin(uuid) to authenticated;

