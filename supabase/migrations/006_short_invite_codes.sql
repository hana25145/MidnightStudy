alter table public.admin_invites add column failed_attempts smallint not null default 0;
alter table public.admin_invites add column locked_until timestamptz;

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

create or replace function public.claim_admin(p_code text)
returns jsonb language plpgsql security definer set search_path = public,extensions
as $fn$
declare
  v_user_id uuid:=auth.uid();
  v_invite_id uuid;
  v_code_hash text;
  v_attempts smallint;
  v_locked_until timestamptz;
begin
  if v_user_id is null then raise exception '로그인이 필요합니다.'; end if;
  if not exists(select 1 from public.profiles where id=v_user_id and role='pending_admin') then raise exception '관리자 등록 대기 계정이 아닙니다.'; end if;

  select id,code_hash,failed_attempts,locked_until
  into v_invite_id,v_code_hash,v_attempts,v_locked_until
  from public.admin_invites where used_at is null order by created_at desc limit 1 for update;
  if v_invite_id is null then return jsonb_build_object('claimError','사용 가능한 관리자 초대 코드가 없습니다.'); end if;
  if v_locked_until is not null and v_locked_until>now() then
    return jsonb_build_object('claimError','입력 횟수를 초과했습니다. 15분 뒤 다시 시도해 주세요.');
  end if;
  if v_locked_until is not null and v_locked_until<=now() then v_attempts:=0; end if;

  if p_code is null or crypt(p_code,v_code_hash) is distinct from v_code_hash then
    v_attempts:=v_attempts+1;
    update public.admin_invites
    set failed_attempts=v_attempts,
        locked_until=case when v_attempts>=5 then now()+interval '15 minutes' else null end
    where id=v_invite_id;
    if v_attempts>=5 then
      return jsonb_build_object('claimError','입력 횟수를 초과했습니다. 15분 뒤 다시 시도해 주세요.');
    end if;
    return jsonb_build_object('claimError','관리자 초대 코드가 올바르지 않습니다.');
  end if;

  update public.profiles set role='admin' where id=v_user_id;
  update public.admin_invites set used_at=now(),used_by=v_user_id where id=v_invite_id;
  return public.get_dashboard(1);
end;
$fn$;

revoke all on function public.create_admin_invite() from public,anon;
revoke all on function public.claim_admin(text) from public,anon;
grant execute on function public.create_admin_invite() to authenticated;
grant execute on function public.claim_admin(text) to authenticated;

