-- The live worker (18 November 2026). During a call the words on the doctor's screen never wait
-- behind a transcript, a document or a form: live pieces wake a worker of their own on Modal, which
-- reads nothing else and stops a minute after the last piece. The main engine keeps the rest, and
-- still reads a live piece when it happens to be running. Both count in the one monthly allowance.

alter table public.engine_runs add column live boolean not null default false;

-- A piece of a call in progress, waiting to be read.
create function private.live_work_waiting() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.live_pieces p join public.consultations c on c.id = p.consultation_id
                 where p.status = 'waiting' and p.created_at > now() - interval '10 minutes' and c.status = 'ready_for_audio');
$$;

-- The main engine's work: transcripts, documents and forms.
create function private.main_work_waiting() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.transcription_jobs j
                 where j.status = 'queued' or (j.status = 'processing' and j.heartbeat_at < now() - interval '2 minutes'))
      or exists (select 1 from public.form_jobs j
                 where j.status = 'queued' or (j.status = 'processing' and j.heartbeat_at < now() - interval '2 minutes'))
      or exists (select 1 from public.patient_documents d
                 where (d.reading = 'waiting' and d.uploaded_at is not null)
                    or (d.reading = 'reading' and d.claimed_at < now() - interval '10 minutes'));
$$;

-- Any work at all, as before.
create or replace function private.engine_work_waiting() returns boolean
language sql stable security definer set search_path = ''
as $$ select private.live_work_waiting() or private.main_work_waiting(); $$;

-- Whether to wake the main engine, or with p_live the live worker, and if not, why.
drop function private.engine_wake_decision();
create function private.engine_wake_decision(p_live boolean default false) returns text
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('watson-cloud-engine'));
  if not exists (select 1 from public.engines where on_demand) then
    return 'no on-demand engine';
  end if;
  if exists (select 1 from public.engine_runs r join public.engines e on e.user_id = r.engine_user_id
             where e.on_demand and r.live = p_live and r.finished_at is null and r.started_at > now() - interval '70 minutes') then
    return 'running';
  end if;
  if not (case when p_live then private.live_work_waiting() else private.main_work_waiting() end) then
    return 'no work';
  end if;
  if private.engine_month_used() >= private.engine_month_allowance() then
    return 'allowance used';
  end if;
  return 'wake';
end;
$$;

-- Knocks on the engine's door on Modal, naming which worker to start.
drop function private.wake_engine();
create function private.wake_engine(p_live boolean default false) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'engine_wake_url');
  v_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'engine_wake_secret');
  v_decision text := private.engine_wake_decision(p_live);
begin
  if v_decision = 'allowance used' then
    perform private.notify_owner('engine-allowance-' || to_char(now(), 'YYYY-MM'),
      'Watson''s engine is paused for the rest of the month',
      'Watson has used this month''s allowance of engine time, so transcripts, documents and forms '
      || 'now wait until the 1st. Nothing is lost: they are done as soon as the engine may run again.'
      || E'\n\n' || 'To carry on now: add a card on Modal (modal.com, workspace watson-assists, signed in '
      || 'with Watson''s GitHub), which raises its free credit from $1 to $30 a month, and ask Claude '
      || 'to raise the allowance.');
    return;
  end if;
  if v_url is null or v_secret is null or v_decision <> 'wake' then
    return;
  end if;
  perform net.http_post(url := v_url, body := jsonb_build_object('live', p_live),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret));
end;
$$;

create function private.wake_live_engine_on_work() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.wake_engine(true);
  return null;
end;
$$;

drop trigger wake_engine on public.live_pieces;
create trigger wake_engine after insert on public.live_pieces
  for each row when (new.status = 'waiting') execute function private.wake_live_engine_on_work();

-- The engine, starting: its earlier runs of the same kind that never finished are over.
drop function public.engine_run_started();
create function public.engine_run_started(p_live boolean default false) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_engine uuid := (select auth.uid());
  v_run uuid;
begin
  if not private.is_engine() then
    return private.refuse('NOT_AN_ENGINE');
  end if;
  update public.engine_runs set finished_at = now()
    where engine_user_id = v_engine and live = p_live and finished_at is null;
  insert into public.engine_runs (engine_user_id, live) values (v_engine, p_live) returning id into v_run;
  update public.engines set last_seen_at = now() where user_id = v_engine;
  return jsonb_build_object('ok', true, 'run_id', v_run);
end;
$$;

-- The engine, about to stop: refused while its own kind of work waits.
create or replace function public.engine_run_finished(p_run_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_live boolean;
begin
  if not private.is_engine() then
    return private.refuse('NOT_AN_ENGINE');
  end if;
  perform pg_advisory_xact_lock(hashtext('watson-cloud-engine'));
  select r.live into v_live from public.engine_runs r where r.id = p_run_id and r.engine_user_id = (select auth.uid());
  if (case when coalesce(v_live, false) then private.live_work_waiting() else private.main_work_waiting() end) then
    return jsonb_build_object('ok', false, 'work_waiting', true);
  end if;
  update public.engine_runs set finished_at = now()
    where id = p_run_id and engine_user_id = (select auth.uid()) and finished_at is null;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function
  private.live_work_waiting(), private.main_work_waiting(), private.engine_work_waiting(),
  private.engine_wake_decision(boolean), private.wake_engine(boolean), private.wake_live_engine_on_work()
from public, anon, authenticated, service_role;
revoke all on function public.engine_run_started(boolean) from public, anon, service_role;
grant execute on function public.engine_run_started(boolean) to authenticated;
