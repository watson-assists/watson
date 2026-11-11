-- Append-only revision candidates, isolated live coverage, and final reconciliation.
-- Approved form rows never change; the highest revision is the current record.

alter table public.form_jobs
  add column form_template_version_id uuid references public.form_template_versions(id) on delete restrict,
  add column revision_kind text not null default 'generated'
    check (revision_kind in ('generated', 'refill', 'historical_conversion', 'correction', 'final_reconciliation')),
  add column parent_form_id uuid references public.forms(id) on delete restrict;

update public.form_jobs j
set form_template_version_id = c.form_template_version_id
from public.consultations c
where c.id = j.consultation_id and j.form_template_version_id is null;
alter table public.form_jobs alter column form_template_version_id set not null;

create function private.pin_form_job_template() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.form_template_version_id is null then
    select c.form_template_version_id into new.form_template_version_id
    from public.consultations c where c.id = new.consultation_id;
  end if;
  return new;
end;
$$;
create trigger form_jobs_pin_template
  before insert on public.form_jobs
  for each row execute function private.pin_form_job_template();
revoke all on function private.pin_form_job_template()
  from public, anon, authenticated, service_role;

drop index public.one_current_form_per_consultation;
create unique index one_draft_form_per_consultation
  on public.forms (consultation_id) where status = 'draft';

alter table public.engines
  add column can_caption boolean not null default true,
  add column can_provisional_form boolean not null default true,
  add column can_final_form boolean not null default true;

create table public.provisional_form_coverage (
  consultation_id uuid not null references public.consultations(id) on delete cascade,
  field_key text not null check (field_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  source_piece_ids uuid[] not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  primary key (consultation_id, field_key)
);
alter table public.provisional_form_coverage enable row level security;
revoke all on public.provisional_form_coverage from public, anon, authenticated, service_role;
grant select on public.provisional_form_coverage to authenticated;
create policy "Practitioners read isolated provisional coverage"
  on public.provisional_form_coverage for select to authenticated
  using (exists (
    select 1 from public.consultations c
    where c.id = provisional_form_coverage.consultation_id
      and c.practitioner_id = (select auth.uid())
  ));

create table public.form_reconciliation_conflicts (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.forms(id) on delete cascade,
  field_key text not null,
  kind text not null check (kind in ('live_covered_final_unanswered')),
  status text not null default 'pending' check (status in ('pending', 'resolved')),
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (form_id, field_key, kind)
);
alter table public.form_reconciliation_conflicts enable row level security;
revoke all on public.form_reconciliation_conflicts from public, anon, authenticated, service_role;
grant select on public.form_reconciliation_conflicts to authenticated;
create policy "Practitioners read final reconciliation conflicts"
  on public.form_reconciliation_conflicts for select to authenticated
  using (exists (
    select 1 from public.forms f join public.consultations c on c.id = f.consultation_id
    where f.id = form_reconciliation_conflicts.form_id
      and c.practitioner_id = (select auth.uid())
  ));

create or replace function private.queue_form(
  p_consultation_id uuid,
  p_actor uuid,
  p_from public.consultation_status
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_transcript uuid;
  v_job uuid;
  v_template uuid;
  v_parent uuid;
begin
  select t.id, c.form_template_version_id into v_transcript, v_template
  from public.transcripts t
  join public.consultations c on c.id = t.consultation_id
  join public.form_template_versions v on v.id = c.form_template_version_id
  where t.consultation_id = p_consultation_id and t.review_status <> 'superseded';
  if v_transcript is null then return null; end if;
  select f.id into v_parent from public.forms f
    where f.consultation_id = p_consultation_id and f.status <> 'superseded'
    order by f.revision_number desc limit 1;
  insert into public.form_jobs (
    consultation_id, transcript_id, form_template_version_id, revision_kind, parent_form_id
  ) values (
    p_consultation_id, v_transcript, v_template,
    case when v_parent is null then 'generated' else 'refill' end, v_parent
  ) returning id into v_job;
  update public.consultations set status = 'extraction_processing', updated_at = now()
    where id = p_consultation_id;
  perform private.log_event(p_consultation_id, 'form.queued', p_actor::text,
    'practitioner', 'form_job', v_job, 'success',
    jsonb_build_object('job_id', v_job, 'from_status', p_from,
      'to_status', 'extraction_processing'));
  return v_job;
end;
$$;

create function public.queue_form_revision(
  p_consultation_id uuid,
  p_form_template_version_id uuid,
  p_revision_kind text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_consultation public.consultations;
  v_transcript uuid;
  v_parent uuid;
  v_job uuid;
begin
  select * into v_consultation from public.consultations
    where id = p_consultation_id and practitioner_id = v_user for update;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if v_consultation.status <> 'approved' then
    return private.reject_transition(
      p_consultation_id, 'queue_form_revision', v_consultation.status
    );
  end if;
  if p_revision_kind not in ('historical_conversion', 'correction') then
    return private.refuse('VALIDATION', 'revision_kind');
  end if;
  if not private.form_template_version_accessible(v_user, p_form_template_version_id) then
    return private.refuse('FORM_TEMPLATE_VERSION_NOT_FOUND');
  end if;
  if exists (select 1 from public.form_jobs where consultation_id = p_consultation_id
             and status in ('queued', 'processing')) then
    return private.refuse('FORM_JOB_ACTIVE');
  end if;
  select id into v_transcript from public.transcripts
    where consultation_id = p_consultation_id and review_status <> 'superseded'
    order by created_at desc limit 1;
  if v_transcript is null then return private.refuse('TRANSCRIPT_NOT_READY'); end if;
  select id into v_parent from public.forms
    where consultation_id = p_consultation_id and status = 'approved'
    order by revision_number desc limit 1;
  if p_revision_kind = 'correction' and v_parent is null then
    return private.refuse('FORM_NOT_FOUND');
  end if;
  insert into public.form_jobs (
    consultation_id, transcript_id, form_template_version_id, revision_kind, parent_form_id
  ) values (
    p_consultation_id, v_transcript, p_form_template_version_id, p_revision_kind, v_parent
  ) returning id into v_job;
  update public.consultations set status = 'extraction_processing', updated_at = now()
    where id = p_consultation_id;
  perform private.log_event(p_consultation_id, 'form.queued', v_user::text,
    'practitioner', 'form_job', v_job, 'success',
    jsonb_build_object('job_id', v_job, 'from_status', v_consultation.status,
      'to_status', 'extraction_processing'));
  return jsonb_build_object('ok', true, 'job_id', v_job);
end;
$$;

create function public.reject_form_revision(p_form_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_form public.forms;
  v_previous public.forms;
begin
  select f.* into v_form from public.forms f
  join public.consultations c on c.id = f.consultation_id
  where f.id = p_form_id and c.practitioner_id = v_user for update of f;
  if not found then return private.refuse('NOT_FOUND'); end if;
  if v_form.status <> 'draft' or v_form.revision_number = 1 then
    return private.refuse('FORM_IMMUTABLE');
  end if;
  update public.forms set status = 'superseded' where id = p_form_id;
  select * into v_previous from public.forms
    where consultation_id = v_form.consultation_id and status = 'approved'
    order by revision_number desc limit 1;
  update public.consultations
    set status = case when v_previous.id is null
      then 'transcript_reviewed'::public.consultation_status
      else 'approved'::public.consultation_status end,
        updated_at = now()
    where id = v_form.consultation_id;
  return jsonb_build_object('ok', true);
end;
$$;

create function public.resolve_form_reconciliation(p_conflict_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  update public.form_reconciliation_conflicts r
    set status = 'resolved', resolved_by = v_user, resolved_at = now()
  from public.forms f join public.consultations c on c.id = f.consultation_id
  where r.id = p_conflict_id and f.id = r.form_id
    and c.practitioner_id = v_user and f.status = 'draft' and r.status = 'pending';
  if not found then return private.refuse('NOT_FOUND'); end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.engine_claim_live_piece() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_engine uuid := (select auth.uid());
  v_piece public.live_pieces;
  v_remove jsonb;
begin
  if not private.is_engine() then return private.refuse('NOT_AN_ENGINE'); end if;
  if not exists (
    select 1 from public.engines where user_id = v_engine and can_caption
  ) then return private.refuse('ENGINE_CAPABILITY_MISSING'); end if;
  update public.engines set last_seen_at = now() where user_id = v_engine;
  with set_aside as (
    update public.live_pieces p set status = 'failed', engine_user_id = v_engine
      where p.status in ('waiting', 'reading')
        and (p.created_at < now() - interval '10 minutes'
          or not exists (select 1 from public.consultations c
                         where c.id = p.consultation_id and c.status = 'ready_for_audio'))
      returning p.storage_path)
  select coalesce(jsonb_agg(storage_path), '[]'::jsonb) into v_remove from set_aside;
  select * into v_piece from public.live_pieces p
    where p.status = 'waiting' or (p.status = 'reading' and p.claimed_at < now() - interval '1 minute')
    order by p.created_at limit 1 for update skip locked;
  if not found then return jsonb_build_object('ok', true, 'piece', null, 'remove', v_remove); end if;
  update public.live_pieces set status = 'reading', claimed_at = now(), engine_user_id = v_engine
    where id = v_piece.id;
  return jsonb_build_object('ok', true, 'remove', v_remove, 'piece', jsonb_build_object(
    'id', v_piece.id, 'consultation_id', v_piece.consultation_id,
    'storage_path', v_piece.storage_path, 'speaker', v_piece.speaker,
    'provisional_enabled', (select can_provisional_form from public.engines where user_id = v_engine),
    'language', (select nullif(c.language::text, 'auto') from public.consultations c where c.id = v_piece.consultation_id),
    'template', (select v.definition from public.consultations c
      join public.form_template_versions v on v.id = c.form_template_version_id
      where c.id = v_piece.consultation_id)));
end;
$$;

create function public.engine_record_provisional_coverage(
  p_piece_id uuid, p_field_keys text[]
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_engine uuid := (select auth.uid());
  v_piece public.live_pieces;
  v_template jsonb;
begin
  if not private.is_engine() then return private.refuse('NOT_AN_ENGINE'); end if;
  if not exists (
    select 1 from public.engines where user_id = v_engine and can_provisional_form
  ) then return private.refuse('ENGINE_CAPABILITY_MISSING'); end if;
  select * into v_piece from public.live_pieces
    where id = p_piece_id and engine_user_id = v_engine and status = 'done';
  if not found then return private.refuse('NOT_FOUND'); end if;
  select v.definition into v_template from public.consultations c
    join public.form_template_versions v on v.id = c.form_template_version_id
    where c.id = v_piece.consultation_id;
  if exists (
    select 1 from unnest(coalesce(p_field_keys, '{}')) key
    where not exists (
      select 1 from jsonb_array_elements(v_template -> 'sections') section,
        jsonb_array_elements(section -> 'fields') field
      where field ->> 'key' = key and coalesce(field ->> 'mode', 'extract') <> 'manual'
    )
  ) then return private.refuse('VALIDATION', 'field_keys'); end if;
  insert into public.provisional_form_coverage (
    consultation_id, field_key, source_piece_ids
  ) select v_piece.consultation_id, key, array[p_piece_id]
    from (select distinct unnest(coalesce(p_field_keys, '{}')) key) keys
  on conflict (consultation_id, field_key) do update
    set source_piece_ids = case
          when p_piece_id = any(public.provisional_form_coverage.source_piece_ids)
            then public.provisional_form_coverage.source_piece_ids
          else public.provisional_form_coverage.source_piece_ids || p_piece_id end,
        last_seen_at = now(), expires_at = now() + interval '24 hours';
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.engine_claim_form_job() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_engine uuid := (select auth.uid());
  v_job public.form_jobs;
  v_consultation public.consultations;
begin
  if not private.is_engine() then return private.refuse('NOT_AN_ENGINE'); end if;
  if not exists (
    select 1 from public.engines where user_id = v_engine and can_final_form
  ) then return private.refuse('ENGINE_CAPABILITY_MISSING'); end if;
  update public.engines set last_seen_at = now() where user_id = v_engine;
  for v_job in
    select j.* from public.form_jobs j join public.consultations c on c.id = j.consultation_id
    where j.status = 'processing' and j.heartbeat_at < now() - interval '2 minutes'
    for update of c, j skip locked
  loop
    if v_job.attempt >= 3 then
      perform private.fail_form_job(v_job, 'ENGINE_STALLED', v_engine::text);
    else
      update public.form_jobs set status = 'queued', attempt = attempt + 1,
        claimed_at = null, heartbeat_at = null, engine_user_id = null where id = v_job.id;
    end if;
  end loop;
  select j.* into v_job from public.form_jobs j
    join public.consultations c on c.id = j.consultation_id
    where j.status = 'queued' order by j.queued_at limit 1
    for update of c, j skip locked;
  if not found then return jsonb_build_object('ok', true, 'job', null); end if;
  select * into v_consultation from public.consultations where id = v_job.consultation_id;
  update public.form_jobs set status = 'processing', claimed_at = now(), heartbeat_at = now(),
    engine_user_id = v_engine where id = v_job.id returning * into v_job;
  perform private.log_event(v_job.consultation_id, 'form.started', v_engine::text, 'engine',
    'form_job', v_job.id, 'success', jsonb_build_object('job_id', v_job.id, 'attempt', v_job.attempt));
  return jsonb_build_object('ok', true, 'job', jsonb_build_object(
    'job_id', v_job.id, 'attempt', v_job.attempt,
    'consultation_id', v_consultation.id, 'revision_kind', v_job.revision_kind,
    'language', coalesce(nullif(v_consultation.language::text, 'auto'),
      (select tr.tracks -> 0 ->> 'language' from public.transcripts tr where tr.id = v_job.transcript_id)),
    'template_version_id', v_job.form_template_version_id,
    'template_hash', (select definition_hash from public.form_template_versions
                      where id = v_job.form_template_version_id),
    'template', (select definition from public.form_template_versions
                 where id = v_job.form_template_version_id),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object(
        'position', s.position, 'speaker', s.speaker,
        'text', coalesce(s.reviewed_text, s.machine_text)) order by s.position), '[]'::jsonb)
      from public.transcript_segments s
      where s.transcript_id = v_job.transcript_id and not s.possibly_not_speech),
    'documents', (select coalesce(jsonb_agg(jsonb_build_object(
        'document_id', d.id, 'file_name', d.file_name, 'sent_at', d.uploaded_at,
        'pages', to_jsonb(d.page_texts)) order by d.uploaded_at desc), '[]'::jsonb)
      from (select * from public.patient_documents
            where consultation_id = v_consultation.id and removed_at is null and reading = 'read'
            order by uploaded_at desc limit 10) d)));
end;
$$;

create or replace function public.engine_complete_form_job(
  p_job_id uuid, p_attempt int, p_answers jsonb, p_metrics jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_engine uuid := (select auth.uid());
  v_job public.form_jobs;
  v_template jsonb;
  v_form_id uuid;
  v_previous uuid;
  v_answered int;
  v_status public.consultation_status;
begin
  if not private.is_engine() then return private.refuse('NOT_AN_ENGINE'); end if;
  if not exists (
    select 1 from public.engines where user_id = v_engine and can_final_form
  ) then return private.refuse('ENGINE_CAPABILITY_MISSING'); end if;
  perform 1 from public.consultations
    where id = (select consultation_id from public.form_jobs where id = p_job_id) for update;
  select * into v_job from public.form_jobs
    where id = p_job_id and attempt = p_attempt and status = 'processing'
      and engine_user_id = v_engine for update;
  if not found then return private.refuse('JOB_NOT_YOURS'); end if;
  select definition into v_template from public.form_template_versions
    where id = v_job.form_template_version_id;

  begin
    if jsonb_typeof(p_answers) is distinct from 'array'
       or (select array_agg(a ->> 'key' order by a ->> 'key') from jsonb_array_elements(p_answers) a)
          is distinct from (select array_agg(f ->> 'key' order by f ->> 'key')
                            from jsonb_array_elements(v_template -> 'sections') s,
                                 jsonb_array_elements(s -> 'fields') f)
       or exists (
         select 1 from jsonb_array_elements(p_answers) a
         join lateral (
           select f from jsonb_array_elements(v_template -> 'sections') s,
             jsonb_array_elements(s -> 'fields') f where f ->> 'key' = a ->> 'key'
         ) expected on true
         where not private.valid_engine_form_answer(expected.f, a)
       )
       or exists (select 1 from jsonb_array_elements(p_answers) a,
                           jsonb_array_elements_text(coalesce(a -> 'evidence', '[]')) e
                  where not exists (select 1 from public.transcript_segments s
                    where s.transcript_id = v_job.transcript_id and s.position = e::int))
       or exists (select 1 from jsonb_array_elements(p_answers) a,
                           jsonb_array_elements(coalesce(a -> 'documents', '[]')) q
                  where jsonb_typeof(q -> 'text') is distinct from 'string'
                     or char_length(q ->> 'text') not between 1 and 400
                     or not exists (select 1 from public.patient_documents d
                       where d.id = (q ->> 'document_id')::uuid
                         and d.consultation_id = v_job.consultation_id
                         and d.removed_at is null and d.reading = 'read'
                         and (q ->> 'page')::int between 1 and cardinality(d.page_texts)))
    then return private.refuse('VALIDATION', 'answers'); end if;

    select id into v_previous from public.forms
      where consultation_id = v_job.consultation_id
      order by revision_number desc limit 1;
    update public.forms set status = 'superseded'
      where id = v_previous and status = 'draft';
    insert into public.forms (
      consultation_id, job_id, transcript_id, template, form_template_version_id,
      revision_kind, parent_form_id
    ) values (
      v_job.consultation_id, v_job.id, v_job.transcript_id, v_template,
      v_job.form_template_version_id, v_job.revision_kind,
      coalesce(v_job.parent_form_id, v_previous)
    ) returning id into v_form_id;
    insert into public.form_answers (
      form_id, field_key, position, machine_text, evidence, document_quotes,
      value_type, answer_state, machine_state, machine_value
    )
    select v_form_id, f.field ->> 'key', f.position - 1,
      nullif(btrim(a ->> 'text'), ''),
      coalesce(array(select distinct e::int
                     from jsonb_array_elements_text(a -> 'evidence') e order by 1), '{}'),
      coalesce((select jsonb_agg(jsonb_build_object(
        'document_id', q ->> 'document_id', 'page', (q ->> 'page')::int, 'text', q ->> 'text'))
        from jsonb_array_elements(coalesce(a -> 'documents', '[]')) q), '[]'::jsonb),
      coalesce(f.field ->> 'value_type', 'text'),
      case when f.field ? 'value_type' then a ->> 'state'
           when nullif(btrim(a ->> 'text'), '') is not null then 'known' else 'unanswered' end,
      case when f.field ? 'value_type' then a ->> 'state'
           when nullif(btrim(a ->> 'text'), '') is not null then 'known' else 'unanswered' end,
      case when f.field ? 'value_type' and a ->> 'state' = 'known' then a -> 'value'
           when not (f.field ? 'value_type') and nullif(btrim(a ->> 'text'), '') is not null
             then to_jsonb(nullif(btrim(a ->> 'text'), '')) end
    from (select field, row_number() over (order by si, fi) as position
          from jsonb_array_elements(v_template -> 'sections') with ordinality s(section, si),
               jsonb_array_elements(s.section -> 'fields') with ordinality x(field, fi)) f
    join jsonb_array_elements(p_answers) a on a ->> 'key' = f.field ->> 'key';

    if v_job.revision_kind in ('refill', 'correction') then
      update public.form_answers n
        set machine_text = o.machine_text, evidence = o.evidence,
            document_quotes = o.document_quotes, practitioner_text = o.practitioner_text,
            review = o.review, value_type = o.value_type, answer_state = o.answer_state,
            machine_state = o.machine_state, machine_value = o.machine_value,
            practitioner_value = o.practitioner_value
      from public.form_answers o, public.forms old
      where n.form_id = v_form_id and o.form_id = coalesce(v_job.parent_form_id, v_previous)
        and old.id = o.form_id and old.form_template_version_id = v_job.form_template_version_id
        and o.field_key = n.field_key and o.review <> 'unreviewed';
    end if;

    insert into public.form_reconciliation_conflicts (form_id, field_key, kind)
    select v_form_id, coverage.field_key, 'live_covered_final_unanswered'
    from public.provisional_form_coverage coverage
    join public.form_answers answer
      on answer.form_id = v_form_id and answer.field_key = coverage.field_key
    where coverage.consultation_id = v_job.consultation_id
      and coverage.expires_at > now() and answer.machine_state = 'unanswered'
    on conflict do nothing;
    select count(*) into v_answered from public.form_answers
      where form_id = v_form_id and answer_state <> 'unanswered';
  exception when others then
    return private.refuse('VALIDATION', 'answers');
  end;

  update public.form_jobs set status = 'completed', finished_at = now(),
    metrics = private.clean_metrics(p_metrics) where id = v_job.id;
  v_status := case when exists (select 1 from public.form_answers
                    where form_id = v_form_id and review <> 'unreviewed')
                   then 'under_review'::public.consultation_status
                   else 'draft_ready'::public.consultation_status end;
  update public.consultations set status = v_status, updated_at = now()
    where id = v_job.consultation_id;
  perform private.log_event(v_job.consultation_id, 'form.completed', v_engine::text,
    'engine', 'form', v_form_id, 'success',
    jsonb_build_object('job_id', v_job.id, 'attempt', v_job.attempt,
      'segment_count', v_answered, 'from_status', 'extraction_processing',
      'to_status', v_status));
  return jsonb_build_object('ok', true, 'form_id', v_form_id);
end;
$$;

create or replace function public.approve_form(p_form_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_form public.forms;
  v_status public.consultation_status;
begin
  select f.* into v_form from public.forms f
  join public.consultations c on c.id = f.consultation_id
  where f.id = p_form_id and c.practitioner_id = v_user;
  if not found then return private.refuse('NOT_FOUND'); end if;
  select status into v_status from public.consultations
    where id = v_form.consultation_id for update;
  if v_form.status <> 'draft' or v_status not in ('draft_ready', 'under_review') then
    return private.reject_transition(v_form.consultation_id, 'approve_form', v_status);
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_form.template -> 'sections') section,
         jsonb_array_elements(section -> 'fields') field
    where field ? 'value_type'
  ) then
    if exists (
      select 1
      from jsonb_array_elements(v_form.template -> 'sections') s,
           jsonb_array_elements(s -> 'fields') field
      left join public.form_answers a
        on a.form_id = p_form_id and a.field_key = field ->> 'key'
      where coalesce((field ->> 'required')::boolean, false)
        and field ->> 'value_type' not in ('attestation', 'signature')
        and (a.field_key is null or a.answer_state = 'unanswered' or a.review = 'rejected'
          or (a.machine_state <> 'unanswered' and a.review = 'unreviewed'))
    ) then return private.refuse('FORM_REQUIRED_FIELDS_MISSING'); end if;
    if exists (
      select 1 from public.form_answers a where a.form_id = p_form_id
        and a.machine_state <> 'unanswered' and a.review = 'unreviewed'
    ) then return private.refuse('FORM_NOT_REVIEWED'); end if;
    if exists (
      select 1 from public.form_reconciliation_conflicts r
      where r.form_id = p_form_id and r.status = 'pending'
    ) then return private.refuse('FORM_RECONCILIATION_REQUIRED'); end if;
    if exists (
      select 1 from jsonb_array_elements(v_form.template -> 'approval_gates') gate
      where gate ->> 'type' = 'attestation' and not exists (
        select 1 from public.form_attestations a
        where a.form_id = p_form_id and a.field_key = gate ->> 'field_key'
          and a.decision = 'confirmed'
      )
    ) then return private.refuse('FORM_ATTESTATIONS_MISSING'); end if;
    if exists (
      select 1 from jsonb_array_elements(v_form.template -> 'approval_gates') gate
      where gate ->> 'type' = 'signature' and not exists (
        select 1 from public.form_signatures s
        where s.form_id = p_form_id and s.field_key = gate ->> 'field_key'
          and s.signer_role = gate ->> 'signer_role'
      )
    ) then return private.refuse('FORM_SIGNATURE_MISSING'); end if;
  else
    if exists (select 1 from public.form_answers where form_id = p_form_id
               and review = 'unreviewed' and machine_text is not null) then
      return private.refuse('FORM_NOT_REVIEWED');
    end if;
  end if;
  update public.forms set status = 'approved', approved_at = now(), approved_by = v_user
    where id = p_form_id;
  update public.consultations set status = 'approved', updated_at = now()
    where id = v_form.consultation_id;
  perform private.log_event(v_form.consultation_id, 'form.approved', v_user::text,
    'practitioner', 'form', p_form_id, 'success',
    jsonb_build_object('from_status', v_status, 'to_status', 'approved'));
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function
  public.queue_form_revision(uuid, uuid, text),
  public.reject_form_revision(uuid),
  public.resolve_form_reconciliation(uuid),
  public.engine_record_provisional_coverage(uuid, text[])
from public, anon, authenticated, service_role;
grant execute on function
  public.queue_form_revision(uuid, uuid, text),
  public.reject_form_revision(uuid),
  public.resolve_form_reconciliation(uuid),
  public.engine_record_provisional_coverage(uuid, text[])
to authenticated;
