-- The live transcript's delay (owner, 25 November 2026). On the 21 November call pieces waited a
-- median 14 seconds: one worker reads them one at a time, and the speech model reads every piece,
-- however short, as a 30-second window. Now the engine, having claimed a piece, also takes the same
-- voice's next waiting pieces that start within 20 seconds of it, and reads them in one pass: no
-- piece is over 10 seconds, so together they fit one window. Measured on this laptop: 2.9 seconds
-- of reading per piece instead of 8.6.
create function public.engine_claim_next_live_pieces(p_after uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_engine uuid := (select auth.uid());
  v_first public.live_pieces;
  v_pieces jsonb;
begin
  if not private.is_engine() then return private.refuse('NOT_AN_ENGINE'); end if;
  select * into v_first from public.live_pieces
    where id = p_after and engine_user_id = v_engine and status = 'reading';
  if not found then return private.refuse('NOT_FOUND'); end if;
  with taken as (
    update public.live_pieces p set status = 'reading', claimed_at = now(), engine_user_id = v_engine
      where p.id in (
        select q.id from public.live_pieces q
          where q.consultation_id = v_first.consultation_id and q.speaker = v_first.speaker
            and q.status = 'waiting' and q.seq > v_first.seq
            and q.offset_seconds < v_first.offset_seconds + 20
          for update skip locked)
      returning p.id, p.storage_path, p.seq)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'storage_path', storage_path) order by seq), '[]'::jsonb)
    into v_pieces from taken;
  return jsonb_build_object('ok', true, 'pieces', v_pieces);
end;
$$;
revoke all on function public.engine_claim_next_live_pieces(uuid) from public, anon, service_role;
grant execute on function public.engine_claim_next_live_pieces(uuid) to authenticated;
