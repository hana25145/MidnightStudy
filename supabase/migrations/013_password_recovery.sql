begin;

-- No plaintext codes, reset tokens or passwords are stored here.
create table public.password_recovery_codes (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  issued_by uuid references public.profiles(id) on delete set null,
  target_role text not null,
  code_hash text not null,
  password_fingerprint text not null,
  issued_at timestamptz not null default now(),
  failed_attempts integer not null default 0,
  used_at timestamptz,
  token_hash text,
  token_used_at timestamptz
);
alter table public.password_recovery_codes enable row level security;
revoke all on public.password_recovery_codes from public, anon, authenticated;

create function public.issue_password_login_code(p_name text)
returns jsonb language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_code text := '';
  v_byte integer;
  v_fingerprint text;
begin
  select * into v_actor from public.profiles where id=auth.uid();
  if v_actor.id is null or v_actor.role not in ('admin','super_admin') then
    raise exception '관리자 권한이 필요합니다.';
  end if;
  select * into v_target from public.profiles where lower(trim(name))=lower(trim(p_name)) for update;
  if v_target.id is null or not (v_target.role='student' or (v_target.role='admin' and v_actor.role='super_admin')) then
    raise exception '발급 가능한 계정이 아닙니다. 학생 이름을 확인해 주세요. 관리자 코드는 총관리자만 발급할 수 있습니다.';
  end if;
  if exists(select 1 from public.password_recovery_codes where user_id=v_target.id and issued_at>now()-interval '1 minute') then
    raise exception '같은 계정의 코드는 1분 뒤 다시 발급할 수 있습니다.';
  end if;
  -- Rejection sampling gives uniformly distributed decimal digits.
  while length(v_code)<8 loop
    v_byte:=get_byte(extensions.gen_random_bytes(1),0);
    if v_byte<250 then v_code:=v_code || (v_byte%10)::text; end if;
  end loop;
  select encode(extensions.digest(encrypted_password,'sha256'),'hex') into v_fingerprint from auth.users where id=v_target.id;
  insert into public.password_recovery_codes(user_id,issued_by,target_role,code_hash,password_fingerprint)
  values(v_target.id,v_actor.id,v_target.role,extensions.crypt(v_code,extensions.gen_salt('bf')),v_fingerprint)
  on conflict(user_id) do update set issued_by=excluded.issued_by,target_role=excluded.target_role,
    code_hash=excluded.code_hash,password_fingerprint=excluded.password_fingerprint,issued_at=now(),
    failed_attempts=0,used_at=null,token_hash=null,token_used_at=null;
  return jsonb_build_object('code',v_code,'name',v_target.name,'room',v_target.room);
end;
$fn$;

-- These two RPCs are callable ONLY by the Edge Function's service role.
create function public.redeem_password_login_code(p_name text,p_code text)
returns jsonb language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  v_row public.password_recovery_codes%rowtype;
  v_token text;
begin
  select c.* into v_row from public.password_recovery_codes c
    join public.profiles p on p.id=c.user_id
    join public.profiles a on a.id=c.issued_by
    join auth.users u on u.id=c.user_id
    where lower(trim(p.name))=lower(trim(p_name)) and p.role=c.target_role
      and (p.role='student' and a.role in ('admin','super_admin') or p.role='admin' and a.role='super_admin')
      and c.password_fingerprint=encode(extensions.digest(u.encrypted_password,'sha256'),'hex')
    for update of c;
  if v_row.user_id is null or v_row.used_at is not null or v_row.failed_attempts>=5 then
    return jsonb_build_object('ok',false);
  end if;
  if p_code is null or p_code !~ '^[0-9]{8}$' or extensions.crypt(p_code,v_row.code_hash) is distinct from v_row.code_hash then
    update public.password_recovery_codes set failed_attempts=failed_attempts+1 where user_id=v_row.user_id;
    -- Return, don't raise: the failed-attempt counter must commit.
    return jsonb_build_object('ok',false);
  end if;
  v_token:=encode(extensions.gen_random_bytes(32),'hex');
  update public.password_recovery_codes set used_at=clock_timestamp(),
    token_hash=encode(extensions.digest(v_token,'sha256'),'hex')
    where user_id=v_row.user_id;
  return jsonb_build_object('ok',true,'token',v_token);
end;
$fn$;

create function public.consume_password_reset_token(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions
as $fn$
declare v_row public.password_recovery_codes%rowtype;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok',false); end if;
  select c.* into v_row from public.password_recovery_codes c
    join public.profiles p on p.id=c.user_id
    join public.profiles a on a.id=c.issued_by
    join auth.users u on u.id=c.user_id
    where c.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and p.role=c.target_role
      and (p.role='student' and a.role in ('admin','super_admin') or p.role='admin' and a.role='super_admin')
      and c.password_fingerprint=encode(extensions.digest(u.encrypted_password,'sha256'),'hex')
    for update of c;
  if v_row.user_id is null or v_row.used_at is null or v_row.token_used_at is not null then
    return jsonb_build_object('ok',false);
  end if;
  update public.password_recovery_codes set token_used_at=clock_timestamp() where user_id=v_row.user_id;
  return jsonb_build_object('ok',true,'userId',v_row.user_id);
end;
$fn$;

revoke all on function public.issue_password_login_code(text) from public, anon;
grant execute on function public.issue_password_login_code(text) to authenticated;
revoke all on function public.redeem_password_login_code(text,text) from public, anon, authenticated;
revoke all on function public.consume_password_reset_token(text) from public, anon, authenticated;
grant execute on function public.redeem_password_login_code(text,text) to service_role;
grant execute on function public.consume_password_reset_token(text) to service_role;
commit;

