begin;

-- Called only by the profile-settings Edge Function after it has verified the Auth user.
create function public.update_profile_by_service(
  p_user_id uuid,
  p_name text,
  p_room text,
  p_expected_name text,
  p_expected_room text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_profile public.profiles%rowtype;
  v_name text:=btrim(p_name);
  v_room text:=upper(regexp_replace(coalesce(p_room,''),'\s+','','g'));
  v_floor smallint;
begin
  select * into v_profile from public.profiles where id=p_user_id for update;
  if v_profile.id is null or v_profile.role not in ('student','admin','super_admin') then
    raise exception '수정할 수 있는 계정이 아닙니다.';
  end if;
  if v_profile.name is distinct from p_expected_name or v_profile.room is distinct from p_expected_room then
    raise exception '계정 정보가 방금 변경되었습니다. 새로고침 후 다시 시도해 주세요.';
  end if;
  if v_name is null or char_length(v_name)<2 or char_length(v_name)>20 then
    raise exception '이름은 2~20자로 입력해 주세요.';
  end if;

  if v_profile.role='student' then
    if v_room !~ '^[AB][1-9][0-9]{2}$' or v_room ~ '^A9' then
      raise exception '기숙사 방은 A303 또는 B206 형식으로 입력해 주세요.';
    end if;
    v_floor:=case when v_room~'^B5' then 4 when v_room~'^B9' then 8 else substring(v_room from 2 for 1)::smallint end;
    if v_floor is distinct from v_profile.floor and exists(
      select 1 from public.reservations
      where user_id=p_user_id and study_date>=timezone('Asia/Seoul',now())::date
    ) then
      raise exception '이용 층이 바뀌는 호실은 오늘 신청을 먼저 취소한 뒤 수정해 주세요.';
    end if;
    update public.profiles set name=v_name,room=v_room,floor=v_floor where id=p_user_id;
  else
    update public.profiles set name=v_name where id=p_user_id;
    v_room:=null;
    v_floor:=null;
  end if;
  return jsonb_build_object('name',v_name,'room',v_room,'floor',v_floor,'role',v_profile.role);
exception when unique_violation then
  raise exception '같은 이름으로 가입한 계정이 이미 있습니다.';
end;
$fn$;

revoke all on function public.update_profile_by_service(uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.update_profile_by_service(uuid,text,text,text,text) to service_role;

commit;

