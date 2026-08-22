create or replace function public.get_admin_seats(p_floor integer default 1, p_session integer default 1)
returns jsonb language plpgsql security definer set search_path = public
as $fn$
declare
  v_user_id uuid := auth.uid();
  v_date date := timezone('Asia/Seoul', now())::date;
  v_seat_count smallint;
  v_settings public.system_settings%rowtype;
  v_session2_available boolean := false;
begin
  if not exists(select 1 from public.profiles where id=v_user_id and role='admin') then raise exception '관리자 권한이 필요합니다.'; end if;
  if p_floor < 1 or p_floor > 8 then raise exception '조회할 층이 올바르지 않습니다.'; end if;
  if p_session not in (1, 2) then raise exception '조회할 타임이 올바르지 않습니다.'; end if;

  select * into v_settings from public.system_settings where id=1;
  v_session2_available := v_settings.exam_start is not null and v_date between v_settings.exam_start and v_settings.exam_end;
  v_seat_count := case when p_floor between 6 and 8 then 15 else 7 end;

  return jsonb_build_object(
    'date',to_char(v_date,'YYYY-MM-DD'),'floor',p_floor,'session',p_session,
    'session2Available',v_session2_available,
    'seats', (
      select jsonb_agg(jsonb_build_object(
        'number',s.seat,'occupied',r.id is not null,
        'applicantName',p.name,'applicantRoom',p.room
      ) order by s.seat)
      from generate_series(1,v_seat_count) as s(seat)
      left join public.reservations r on r.study_date=v_date and r.session=p_session and r.floor=p_floor and r.seat=s.seat
      left join public.profiles p on p.id=r.user_id
    )
  );
end;
$fn$;

revoke all on function public.get_admin_seats(integer, integer) from public, anon;
grant execute on function public.get_admin_seats(integer, integer) to authenticated;

