create or replace function public.get_admin_seat_history(p_date date, p_session integer default 1)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user_id uuid := auth.uid();
  v_now timestamp := timezone('Asia/Seoul', now());
  v_current_date date;
  v_settings public.system_settings%rowtype;
  v_editable boolean;
  v_attendance_open boolean;
  v_session2_available boolean;
begin
  if not exists (
    select 1 from public.profiles
    where id = v_user_id and role in ('admin', 'super_admin')
  ) then
    raise exception '관리자 권한이 필요합니다.';
  end if;
  if p_date is null then raise exception '조회할 날짜를 선택해 주세요.'; end if;
  if p_session not in (1, 2) then raise exception '조회할 타임이 올바르지 않습니다.'; end if;

  v_current_date := case when v_now::time < time '03:00' then v_now::date - 1 else v_now::date end;
  if p_date > v_current_date then raise exception '미래 날짜의 신청 기록은 조회할 수 없습니다.'; end if;

  select * into v_settings from public.system_settings where id = 1;
  v_editable := p_date = v_current_date;
  v_attendance_open := v_editable and (v_now::time >= time '23:50' or v_now::time < time '01:00');
  v_session2_available := not v_editable or (
    v_settings.exam_start is not null and p_date between v_settings.exam_start and v_settings.exam_end
  );

  return jsonb_build_object(
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'currentDate', to_char(v_current_date, 'YYYY-MM-DD'),
    'session', p_session,
    'session2Available', v_session2_available,
    'attendanceOpen', v_attendance_open,
    'editable', v_editable,
    'floors', (
      select jsonb_agg(
        jsonb_build_object(
          'floor', f.floor,
          'gender', case when f.floor <= 4 then 'male' else 'female' end,
          'seats', (
            select jsonb_agg(
              jsonb_build_object(
                'number', s.seat,
                'occupied', r.id is not null,
                'reservationId', r.id,
                'applicantName', p.name,
                'applicantRoom', p.room,
                'attendanceStatus', a.status,
                'absenceCount', p.absence_count,
                'bannedUntil', to_char(case when p.banned_until > p_date then p.banned_until else null end, 'YYYY-MM-DD')
              ) order by s.seat
            )
            from generate_series(1, public.floor_seat_count(f.floor)) s(seat)
            left join public.reservations r
              on r.study_date = p_date and r.session = p_session and r.floor = f.floor and r.seat = s.seat
            left join public.profiles p on p.id = r.user_id
            left join public.attendance_records a on a.study_date = p_date and a.user_id = r.user_id
          )
        ) order by f.floor
      )
      from generate_series(1, 8) f(floor)
    )
  );
end;
$fn$;

revoke all on function public.get_admin_seat_history(date, integer) from public, anon;
grant execute on function public.get_admin_seat_history(date, integer) to authenticated;

