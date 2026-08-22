create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 20),
  room text not null check (room ~ '^[AB][1-9][0-9]{2}$' and room !~ '^A9'),
  floor smallint not null check (floor between 1 and 9),
  created_at timestamptz not null default now()
);

create unique index profiles_name_unique on public.profiles (lower(btrim(name)));

create table public.reservations (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  study_date date not null,
  floor smallint not null check (floor between 1 and 9),
  seat smallint not null check (seat between 1 and 15),
  created_at timestamptz not null default now(),
  unique (study_date, floor, seat),
  unique (study_date, user_id)
);

alter table public.profiles enable row level security;
alter table public.reservations enable row level security;
revoke all on public.profiles from anon, authenticated;
revoke all on public.reservations from anon, authenticated;
revoke all on sequence public.reservations_id_seq from anon, authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $fn$
declare
  v_name text := btrim(new.raw_user_meta_data ->> 'name');
  v_room text := upper(regexp_replace(coalesce(new.raw_user_meta_data ->> 'room', ''), '\s+', '', 'g'));
  v_floor smallint;
begin
  if v_name is null or char_length(v_name) < 2 or char_length(v_name) > 20 then raise exception '이름은 2~20자로 입력해 주세요.'; end if;
  if v_room !~ '^[AB][1-9][0-9]{2}$' or v_room ~ '^A9' then raise exception '기숙사 방은 A303 또는 B206 형식으로 입력해 주세요.'; end if;
  v_floor := case
    when v_room ~ '^B5' then 4
    when v_room ~ '^B9' then 8
    else substring(v_room from 2 for 1)::smallint
  end;
  insert into public.profiles (id, name, room, floor) values (new.id, v_name, v_room, v_floor);
  return new;
exception when unique_violation then
  raise exception '같은 이름으로 가입한 계정이 이미 있습니다.';
end;
$fn$;

create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.get_dashboard()
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_now timestamp := timezone('Asia/Seoul', now());
  v_date date;
  v_open boolean;
  v_seat_count smallint;
begin
  if v_user_id is null then raise exception '로그인이 필요합니다.'; end if;
  select * into v_profile from public.profiles where id = v_user_id;
  if not found then raise exception '사용자 정보를 찾을 수 없습니다.'; end if;
  v_date := v_now::date;
  v_open := v_now::time >= time '18:00' and v_now::time < time '23:50';
  v_seat_count := case when v_profile.floor between 6 and 8 then 15 else 7 end;
  return jsonb_build_object(
    'user', jsonb_build_object('id',v_profile.id,'name',v_profile.name,'room',v_profile.room,'floor',v_profile.floor),
    'application', jsonb_build_object('date',to_char(v_date,'YYYY-MM-DD'),'open',v_open,'currentTime',to_char(v_now,'HH24:MI'),'opensAt','18:00','closesAt','23:50'),
    'reservation', (select jsonb_build_object('floor',r.floor,'seat',r.seat) from public.reservations r where r.user_id=v_user_id and r.study_date=v_date),
    'seats', (
      select jsonb_agg(jsonb_build_object('number',s.seat,'occupied',r.id is not null,'mine',r.user_id=v_user_id,'applicantName',p.name,'applicantRoom',p.room) order by s.seat)
      from generate_series(1,v_seat_count) as s(seat)
      left join public.reservations r on r.study_date=v_date and r.floor=v_profile.floor and r.seat=s.seat
      left join public.profiles p on p.id=r.user_id
    )
  );
end;
$fn$;

create or replace function public.reserve_seat(p_seat integer)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_now timestamp := timezone('Asia/Seoul', now());
  v_date date := v_now::date;
begin
  if v_user_id is null then raise exception '로그인이 필요합니다.'; end if;
  if v_now::time < time '18:00' or v_now::time >= time '23:50' then raise exception '신청은 18:00부터 23:50까지 가능합니다.'; end if;
  select * into v_profile from public.profiles where id=v_user_id;
  if not found then raise exception '사용자 정보를 찾을 수 없습니다.'; end if;
  if p_seat < 1 or p_seat > case when v_profile.floor between 6 and 8 then 15 else 7 end then raise exception '해당 층에서 선택할 수 없는 좌석입니다.'; end if;
  if exists(select 1 from public.reservations where study_date=v_date and user_id=v_user_id) then raise exception '오늘 이미 신청한 좌석이 있습니다.'; end if;
  if exists(select 1 from public.reservations where study_date=v_date and floor=v_profile.floor and seat=p_seat) then raise exception '이미 신청된 좌석입니다.'; end if;
  insert into public.reservations(user_id,study_date,floor,seat) values(v_user_id,v_date,v_profile.floor,p_seat);
  return public.get_dashboard();
exception when unique_violation then
  raise exception '방금 다른 학생이 이 좌석을 신청했습니다.';
end;
$fn$;

create or replace function public.cancel_today_reservation()
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_user_id uuid := auth.uid();
  v_now timestamp := timezone('Asia/Seoul', now());
begin
  if v_user_id is null then raise exception '로그인이 필요합니다.'; end if;
  if v_now::time < time '18:00' or v_now::time >= time '23:50' then raise exception '신청 시간에만 취소할 수 있습니다.'; end if;
  delete from public.reservations where user_id=v_user_id and study_date=v_now::date;
  if not found then raise exception '취소할 신청 내역이 없습니다.'; end if;
  return public.get_dashboard();
end;
$fn$;

revoke all on function public.get_dashboard() from public, anon;
revoke all on function public.reserve_seat(integer) from public, anon;
revoke all on function public.cancel_today_reservation() from public, anon;
grant execute on function public.get_dashboard() to authenticated;
grant execute on function public.reserve_seat(integer) to authenticated;
grant execute on function public.cancel_today_reservation() to authenticated;

