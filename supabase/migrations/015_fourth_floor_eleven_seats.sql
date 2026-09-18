create or replace function public.floor_seat_count(p_floor integer)
returns smallint language sql immutable strict set search_path = public
as $$ select (case when p_floor=3 or p_floor between 6 and 8 then 15 when p_floor=4 then 11 else 7 end)::smallint $$;
