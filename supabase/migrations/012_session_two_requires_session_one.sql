create or replace function public.enforce_reservation_session_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' and new.session = 2 then
    if not exists (
      select 1 from public.reservations
      where user_id = new.user_id and study_date = new.study_date and session = 1
    ) then
      raise exception '2타임은 같은 날 1타임을 먼저 신청해야 합니다.';
    end if;
  elsif tg_op = 'DELETE' and old.session = 1 then
    if exists (
      select 1 from public.reservations
      where user_id = old.user_id and study_date = old.study_date and session = 2
    ) then
      raise exception '2타임 신청을 먼저 취소한 뒤 1타임을 취소해 주세요.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$fn$;

revoke all on function public.enforce_reservation_session_order() from public, anon, authenticated;

drop trigger if exists reservations_enforce_session_order on public.reservations;
create trigger reservations_enforce_session_order
before insert or delete on public.reservations
for each row execute function public.enforce_reservation_session_order();

create or replace function public.get_dashboard(p_session integer default 1)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_user_id uuid:=auth.uid(); v_profile public.profiles%rowtype;
  v_now timestamp:=timezone('Asia/Seoul',now()); v_date date:=v_now::date;
  v_open boolean:=v_now::time>=time '18:00' and v_now::time<time '23:40';
  v_seat_count smallint; v_settings public.system_settings%rowtype;
  v_mode text:='normal'; v_session_end text:='01:00'; v_blocked_until date;
  v_absence_count smallint; v_room_update_required boolean:=false;
  v_has_session1 boolean:=false; v_has_session2 boolean:=false; v_session1_required boolean:=false;
begin
  if v_user_id is null then raise exception '로그인이 필요합니다.'; end if;
  select * into v_profile from public.profiles where id=v_user_id;
  if not found then raise exception '사용자 정보를 찾을 수 없습니다.'; end if;
  select * into v_settings from public.system_settings where id=1;
  v_mode:=public.study_mode_for_date(v_date,v_settings.exam_start,v_settings.exam_end);

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

  select exists(select 1 from public.reservations where user_id=v_user_id and study_date=v_date and session=1),
         exists(select 1 from public.reservations where user_id=v_user_id and study_date=v_date and session=2)
    into v_has_session1,v_has_session2;
  v_session1_required:=p_session=2 and not v_has_session1;
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
      'canApply',v_open and v_blocked_until is null and not v_room_update_required and not v_session1_required,
      'currentTime',to_char(v_now,'HH24:MI'),'opensAt','18:00','closesAt','23:40','mode',v_mode,
      'selectedSession',p_session,'sessionStart',case when p_session=1 then '23:50' else '01:30' end,
      'sessionEnd',v_session_end,'session2Available',v_mode='exam','session1Required',v_session1_required,
      'hasSession1Reservation',v_has_session1,'hasSession2Reservation',v_has_session2,
      'blockedUntil',to_char(v_blocked_until,'YYYY-MM-DD')),
    'reservation',(select jsonb_build_object('floor',r.floor,'seat',r.seat,'session',r.session)
      from public.reservations r where r.user_id=v_user_id and r.study_date=v_date and r.session=p_session),
    'seats',(select jsonb_agg(jsonb_build_object('number',s.seat,'occupied',r.id is not null,'mine',r.user_id=v_user_id,
      'applicantName',p.name,'applicantRoom',p.room) order by s.seat)
      from generate_series(1,v_seat_count) s(seat)
      left join public.reservations r on r.study_date=v_date and r.session=p_session and r.floor=v_profile.floor and r.seat=s.seat
      left join public.profiles p on p.id=r.user_id));
end;
$fn$;

