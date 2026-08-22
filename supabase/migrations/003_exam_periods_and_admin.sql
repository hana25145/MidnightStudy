create extension if not exists pgcrypto with schema extensions;

alter table public.profiles add column role text not null default 'student';
alter table public.profiles alter column room drop not null;
alter table public.profiles alter column floor drop not null;
alter table public.profiles drop constraint if exists profiles_room_check;
alter table public.profiles drop constraint if exists profiles_floor_check;
alter table public.profiles add constraint profiles_role_check check (role in ('student', 'pending_admin', 'admin'));
alter table public.profiles add constraint profiles_account_fields_check check (
  (role = 'student' and room ~ '^[AB][1-9][0-9]{2}$' and room !~ '^A9' and floor between 1 and 9)
  or (role in ('pending_admin', 'admin') and room is null and floor is null)
);

alter table public.reservations add column session smallint not null default 1;
alter table public.reservations add constraint reservations_session_check check (session in (1, 2));
alter table public.reservations drop constraint if exists reservations_study_date_floor_seat_key;
alter table public.reservations drop constraint if exists reservations_study_date_user_id_key;
alter table public.reservations add constraint reservations_study_date_session_floor_seat_key unique (study_date, session, floor, seat);
alter table public.reservations add constraint reservations_study_date_session_user_id_key unique (study_date, session, user_id);

create table public.system_settings (
  id smallint primary key default 1 check (id = 1),
  exam_start date,
  exam_end date,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id),
  check ((exam_start is null and exam_end is null) or (exam_start is not null and exam_end >= exam_start))
);
insert into public.system_settings (id) values (1);

create table public.admin_invites (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  used_by uuid references public.profiles(id)
);

alter table public.system_settings enable row level security;
alter table public.admin_invites enable row level security;
revoke all on public.system_settings from anon, authenticated;
revoke all on public.admin_invites from anon, authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $fn$
declare
  v_name text := btrim(new.raw_user_meta_data ->> 'name');
  v_account_type text := coalesce(new.raw_user_meta_data ->> 'account_type', 'student');
  v_room text := upper(regexp_replace(coalesce(new.raw_user_meta_data ->> 'room', ''), '\s+', '', 'g'));
  v_floor smallint;
begin
  if v_name is null or char_length(v_name) < 2 or char_length(v_name) > 20 then raise exception '이름은 2~20자로 입력해 주세요.'; end if;

  if v_account_type = 'admin' then
    insert into public.profiles (id, name, room, floor, role) values (new.id, v_name, null, null, 'pending_admin');
  else
    if v_room !~ '^[AB][1-9][0-9]{2}$' or v_room ~ '^A9' then raise exception '기숙사 방은 A303 또는 B206 형식으로 입력해 주세요.'; end if;
    v_floor := case
      when v_room ~ '^B5' then 4
      when v_room ~ '^B9' then 8
      else substring(v_room from 2 for 1)::smallint
    end;
    insert into public.profiles (id, name, room, floor, role) values (new.id, v_name, v_room, v_floor, 'student');
  end if;
  return new;
exception when unique_violation then
  raise exception '같은 이름으로 가입한 계정이 이미 있습니다.';
end;
$fn$;

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
begin
  if v_user_id is null then raise exception '로그인이 필요합니다.'; end if;
  select * into v_profile from public.profiles where id = v_user_id;
  if not found then raise exception '사용자 정보를 찾을 수 없습니다.'; end if;
  select * into v_settings from public.system_settings where id = 1;

  if v_settings.exam_start is not null and v_date between v_settings.exam_start and v_settings.exam_end then
    v_mode := 'exam';
  elsif v_settings.exam_start is not null and v_date between v_settings.exam_start - 14 and v_settings.exam_start - 1 then
    v_mode := 'pre_exam';
  end if;

  if v_profile.role = 'admin' then
    return jsonb_build_object(
      'user', jsonb_build_object('id',v_profile.id,'name',v_profile.name,'role',v_profile.role),
      'admin', jsonb_build_object(
        'examStart',to_char(v_settings.exam_start,'YYYY-MM-DD'),
        'examEnd',to_char(v_settings.exam_end,'YYYY-MM-DD'),
        'preExamStart',to_char(v_settings.exam_start - 14,'YYYY-MM-DD'),
        'currentMode',v_mode
      )
    );
  end if;
  if v_profile.role = 'pending_admin' then raise exception '관리자 초대 코드 인증이 필요합니다.'; end if;
  if p_session not in (1, 2) then raise exception '올바르지 않은 타임입니다.'; end if;
  if p_session = 2 and v_mode <> 'exam' then raise exception '심야 2타임은 고사기간에만 신청할 수 있습니다.'; end if;

  if v_mode in ('pre_exam', 'exam') then v_session_end := '01:30'; end if;
  if p_session = 2 then v_session_end := '02:30'; end if;
  v_seat_count := case when v_profile.floor between 6 and 8 then 15 else 7 end;

  return jsonb_build_object(
    'user', jsonb_build_object('id',v_profile.id,'name',v_profile.name,'room',v_profile.room,'floor',v_profile.floor,'role',v_profile.role),
    'application', jsonb_build_object(
      'date',to_char(v_date,'YYYY-MM-DD'),'open',v_open,'currentTime',to_char(v_now,'HH24:MI'),
      'opensAt','18:00','closesAt','23:50','mode',v_mode,'selectedSession',p_session,
      'sessionStart',case when p_session = 1 then '23:50' else '01:30' end,
      'sessionEnd',v_session_end,'session2Available',v_mode = 'exam'
    ),
    'reservation', (
      select jsonb_build_object('floor',r.floor,'seat',r.seat,'session',r.session)
      from public.reservations r where r.user_id=v_user_id and r.study_date=v_date and r.session=p_session
    ),
    'seats', (
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
  if v_now::time < time '18:00' or v_now::time >= time '23:50' then raise exception '신청은 18:00부터 23:50까지 가능합니다.'; end if;
  select * into v_profile from public.profiles where id=v_user_id and role='student';
  if not found then raise exception '학생 계정에서만 신청할 수 있습니다.'; end if;
  select * into v_settings from public.system_settings where id=1;
  v_exam_mode := v_settings.exam_start is not null and v_date between v_settings.exam_start and v_settings.exam_end;
  if p_session not in (1, 2) or (p_session = 2 and not v_exam_mode) then raise exception '심야 2타임은 고사기간에만 신청할 수 있습니다.'; end if;
  v_seat_count := case when v_profile.floor between 6 and 8 then 15 else 7 end;
  if p_seat < 1 or p_seat > v_seat_count then raise exception '해당 층에서 선택할 수 없는 좌석입니다.'; end if;
  if exists(select 1 from public.reservations where study_date=v_date and session=p_session and user_id=v_user_id) then raise exception '이 타임에 이미 신청한 좌석이 있습니다.'; end if;
  if exists(select 1 from public.reservations where study_date=v_date and session=p_session and floor=v_profile.floor and seat=p_seat) then raise exception '이미 신청된 좌석입니다.'; end if;
  insert into public.reservations(user_id,study_date,session,floor,seat) values(v_user_id,v_date,p_session,v_profile.floor,p_seat);
  return public.get_dashboard(p_session);
exception when unique_violation then
  raise exception '방금 다른 학생이 이 좌석을 신청했습니다.';
end;
$fn$;

create or replace function public.cancel_today_reservation(p_session integer default 1)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_user_id uuid := auth.uid();
  v_now timestamp := timezone('Asia/Seoul', now());
begin
  if v_user_id is null then raise exception '로그인이 필요합니다.'; end if;
  if v_now::time < time '18:00' or v_now::time >= time '23:50' then raise exception '신청 시간에만 취소할 수 있습니다.'; end if;
  delete from public.reservations where user_id=v_user_id and study_date=v_now::date and session=p_session;
  if not found then raise exception '취소할 신청 내역이 없습니다.'; end if;
  return public.get_dashboard(p_session);
end;
$fn$;

create or replace function public.set_exam_period(p_start date, p_end date)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_user_id uuid := auth.uid();
begin
  if not exists(select 1 from public.profiles where id=v_user_id and role='admin') then raise exception '관리자 권한이 필요합니다.'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception '고사 시작일과 종료일을 올바르게 입력해 주세요.'; end if;
  if p_end - p_start > 30 then raise exception '고사기간은 31일 이내로 입력해 주세요.'; end if;
  update public.system_settings set exam_start=p_start, exam_end=p_end, updated_at=now(), updated_by=v_user_id where id=1;
  return public.get_dashboard(1);
end;
$fn$;

create or replace function public.clear_exam_period()
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_user_id uuid := auth.uid();
begin
  if not exists(select 1 from public.profiles where id=v_user_id and role='admin') then raise exception '관리자 권한이 필요합니다.'; end if;
  update public.system_settings set exam_start=null, exam_end=null, updated_at=now(), updated_by=v_user_id where id=1;
  return public.get_dashboard(1);
end;
$fn$;

create or replace function public.claim_admin(p_code text)
returns jsonb language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  v_user_id uuid := auth.uid();
  v_invite_id uuid;
begin
  if v_user_id is null then raise exception '로그인이 필요합니다.'; end if;
  if not exists(select 1 from public.profiles where id=v_user_id and role='pending_admin') then raise exception '관리자 등록 대기 계정이 아닙니다.'; end if;
  select id into v_invite_id from public.admin_invites
  where used_at is null and crypt(p_code, code_hash) = code_hash
  order by created_at limit 1 for update;
  if v_invite_id is null then raise exception '관리자 초대 코드가 올바르지 않거나 이미 사용되었습니다.'; end if;
  update public.profiles set role='admin' where id=v_user_id;
  update public.admin_invites set used_at=now(), used_by=v_user_id where id=v_invite_id;
  return public.get_dashboard(1);
end;
$fn$;

drop function if exists public.reserve_seat(integer);
drop function if exists public.cancel_today_reservation();
drop function if exists public.get_dashboard();

revoke all on function public.get_dashboard(integer) from public, anon;
revoke all on function public.reserve_seat(integer, integer) from public, anon;
revoke all on function public.cancel_today_reservation(integer) from public, anon;
revoke all on function public.set_exam_period(date, date) from public, anon;
revoke all on function public.clear_exam_period() from public, anon;
revoke all on function public.claim_admin(text) from public, anon;
grant execute on function public.get_dashboard(integer) to authenticated;
grant execute on function public.reserve_seat(integer, integer) to authenticated;
grant execute on function public.cancel_today_reservation(integer) to authenticated;
grant execute on function public.set_exam_period(date, date) to authenticated;
grant execute on function public.clear_exam_period() to authenticated;
grant execute on function public.claim_admin(text) to authenticated;

