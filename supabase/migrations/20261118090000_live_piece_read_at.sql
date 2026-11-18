-- When the engine wrote a live piece's words (18 November 2026). With created_at (the doctor's
-- browser registered the piece) and claimed_at (the engine took it), this shows where the live
-- transcript's delay goes on the hosted engine: waiting, or reading. No screen shows it.
alter table public.live_pieces add column read_at timestamptz;

create or replace function public.engine_live_piece_done(p_id uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_engine() then
    return private.refuse('NOT_AN_ENGINE');
  end if;
  update public.live_pieces
    set status = 'done', text = left(btrim(coalesce(p_text, '')), 4000), read_at = now()
    where id = p_id and engine_user_id = (select auth.uid()) and status = 'reading';
  if not found then
    return private.refuse('NOT_FOUND');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
