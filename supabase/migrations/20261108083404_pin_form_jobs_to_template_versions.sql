-- Every new form records and consumes the consultation's immutable template
-- version. Legacy forms retain their embedded template and gain its hash.
alter table public.forms
  add column form_template_version_id uuid
    references public.form_template_versions(id) on delete restrict,
  add column template_hash text generated always as (
    private.form_template_definition_hash(template)
  ) stored;

alter table public.forms alter column template_hash set not null;

create function private.apply_default_form_template_version() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.form_template_version_id is null then
    select d.form_template_version_id into new.form_template_version_id
    from public.form_template_defaults d
    where d.practitioner_id = new.practitioner_id;
  end if;
  return new;
end;
$$;

create trigger consultations_apply_default_form_template_version
  before insert on public.consultations
  for each row execute function private.apply_default_form_template_version();

create function private.audit_initial_form_template_pin() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.form_template_version_id is not null then
    perform private.log_event(
      new.id,
      'form_template.pinned',
      new.practitioner_id::text,
      'practitioner',
      'form_template_version',
      new.form_template_version_id,
      'success',
      '{}'::jsonb
    );
  end if;
  return null;
end;
$$;

create trigger consultations_audit_initial_form_template_pin
  after insert on public.consultations
  for each row execute function private.audit_initial_form_template_pin();

create function private.pin_unstarted_consultations_to_default(
  p_practitioner_id uuid
) returns void
language sql security definer set search_path = ''
as $$
  update public.consultations c
  set form_template_version_id = d.form_template_version_id,
      updated_at = now()
  from public.form_template_defaults d
  where d.practitioner_id = p_practitioner_id
    and c.practitioner_id = p_practitioner_id
    and c.form_template_version_id is null
    and (
      (
        c.status in ('consent_pending', 'ready_for_audio')
        and not exists (
          select 1 from public.audio_tracks a where a.consultation_id = c.id
        )
        and not exists (
          select 1 from public.live_pieces p where p.consultation_id = c.id
        )
      )
      or c.status in (
        'transcript_ready', 'transcript_under_review',
        'transcript_reviewed', 'extraction_failed'
      )
    )
    and not exists (
      select 1 from public.form_jobs j where j.consultation_id = c.id
    );

  update public.consultations c
  set form_template_version_id = d.form_template_version_id,
      updated_at = now()
  from public.form_template_defaults d
  join public.form_template_versions v on v.id = d.form_template_version_id
  where d.practitioner_id = p_practitioner_id
    and c.practitioner_id = p_practitioner_id
    and c.form_template_version_id is null
    and exists (
      select 1 from public.forms f
      where f.consultation_id = c.id
        and f.status <> 'superseded'
        and f.template = v.definition
    );

  update public.forms f
  set form_template_version_id = c.form_template_version_id
  from public.consultations c
  join public.form_template_versions v on v.id = c.form_template_version_id
  where c.practitioner_id = p_practitioner_id
    and f.consultation_id = c.id
    and f.form_template_version_id is null
    and f.template = v.definition;
$$;

create or replace function public.set_form_template(p_definition jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_version_id uuid;
  v_version_number int;
begin
  if v_user is null then return private.refuse('NOT_SIGNED_IN'); end if;
  if not private.is_practitioner() or private.is_engine() then
    return private.refuse('NOT_A_PRACTITIONER');
  end if;
  if not coalesce(private.valid_template(p_definition), false) then
    return private.refuse('VALIDATION', 'definition');
  end if;

  insert into public.form_templates (practitioner_id, definition)
  values (v_user, p_definition)
  on conflict (practitioner_id) do update
    set definition = excluded.definition, updated_at = now();

  select v.id into v_version_id
  from public.form_template_versions v
  where v.practitioner_id = v_user
    and v.template_key = 'custom'
    and v.definition = p_definition
  order by v.version_number desc
  limit 1;

  if v_version_id is null then
    perform pg_advisory_xact_lock(hashtextextended('form-template:' || v_user::text, 44));
    select coalesce(max(v.version_number), 0) + 1 into v_version_number
    from public.form_template_versions v
    where v.practitioner_id = v_user and v.template_key = 'custom';
    insert into public.form_template_versions (
      practitioner_id, template_key, version_number, schema_version,
      definition, origin, created_by
    ) values (
      v_user, 'custom', v_version_number, 1, p_definition, 'custom', v_user
    ) returning id into v_version_id;
  end if;

  insert into public.form_template_defaults (
    practitioner_id, form_template_version_id, updated_by
  ) values (v_user, v_version_id, v_user)
  on conflict (practitioner_id) do update
    set form_template_version_id = excluded.form_template_version_id,
        updated_by = excluded.updated_by,
        updated_at = now();
  perform private.pin_unstarted_consultations_to_default(v_user);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.use_watson_form() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_version_id uuid;
begin
  if v_user is null then return private.refuse('NOT_SIGNED_IN'); end if;
  if not private.is_practitioner() or private.is_engine() then
    return private.refuse('NOT_A_PRACTITIONER');
  end if;
  insert into public.form_templates (practitioner_id, definition)
  values (v_user, private.watson_form())
  on conflict (practitioner_id) do nothing;

  select d.form_template_version_id into v_version_id
  from public.form_template_defaults d
  where d.practitioner_id = v_user;
  if v_version_id is null then
    select v.id into v_version_id
    from public.form_template_versions v
    where v.is_built_in and v.template_key = 'watson_standard'
    order by v.version_number desc
    limit 1;
    insert into public.form_template_defaults (
      practitioner_id, form_template_version_id, updated_by
    ) values (v_user, v_version_id, v_user);
  end if;
  perform private.pin_unstarted_consultations_to_default(v_user);
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function private.pin_unstarted_consultations_to_default(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.apply_default_form_template_version()
  from public, anon, authenticated, service_role;
revoke all on function private.audit_initial_form_template_pin()
  from public, anon, authenticated, service_role;

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
begin
  select t.id into v_transcript
  from public.transcripts t
  join public.consultations c on c.id = t.consultation_id
  join public.form_template_versions v on v.id = c.form_template_version_id
  where t.consultation_id = p_consultation_id
    and t.review_status <> 'superseded';
  if v_transcript is null then
    return null;
  end if;
  insert into public.form_jobs (consultation_id, transcript_id)
  values (p_consultation_id, v_transcript)
  returning id into v_job;
  update public.consultations
  set status = 'extraction_processing', updated_at = now()
  where id = p_consultation_id;
  perform private.log_event(
    p_consultation_id,
    'form.queued',
    p_actor::text,
    'practitioner',
    'form_job',
    v_job,
    'success',
    jsonb_build_object(
      'job_id', v_job,
      'from_status', p_from,
      'to_status', 'extraction_processing'
    )
  );
  return v_job;
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
    'job_id', v_job.id, 'attempt', v_job.attempt, 'consultation_id', v_consultation.id,
    'language', coalesce(nullif(v_consultation.language::text, 'auto'),
      (select tr.tracks -> 0 ->> 'language' from public.transcripts tr where tr.id = v_job.transcript_id)),
    'template_version_id', v_consultation.form_template_version_id,
    'template_hash', (select definition_hash from public.form_template_versions
                      where id = v_consultation.form_template_version_id),
    'template', (select definition from public.form_template_versions
                 where id = v_consultation.form_template_version_id),
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

-- Latest historical definition includes fill-again preservation. Only the
-- document quote ownership predicate changes: consultation, never patient row.
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
  perform 1 from public.consultations
    where id = (select consultation_id from public.form_jobs where id = p_job_id) for update;
  select * into v_job from public.form_jobs
    where id = p_job_id and attempt = p_attempt and status = 'processing' and engine_user_id = v_engine
    for update;
  if not found then return private.refuse('JOB_NOT_YOURS'); end if;
  select v.definition into v_template
  from public.consultations c
  join public.form_template_versions v on v.id = c.form_template_version_id
  where c.id = v_job.consultation_id;

  begin
    if jsonb_typeof(p_answers) is distinct from 'array'
       or (select array_agg(a ->> 'key' order by a ->> 'key') from jsonb_array_elements(p_answers) a)
          is distinct from (select array_agg(f ->> 'key' order by f ->> 'key')
                            from jsonb_array_elements(v_template -> 'sections') s,
                                 jsonb_array_elements(s -> 'fields') f)
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
    where consultation_id = v_job.consultation_id and status <> 'superseded';
    update public.forms set status = 'superseded' where id = v_previous;
    insert into public.forms (
      consultation_id, job_id, transcript_id, template, form_template_version_id
    )
    select v_job.consultation_id, v_job.id, v_job.transcript_id,
      v.definition, v.id
    from public.consultations c
    join public.form_template_versions v on v.id = c.form_template_version_id
    where c.id = v_job.consultation_id
    returning id into v_form_id;
    insert into public.form_answers (
      form_id, field_key, position, machine_text, evidence, document_quotes
    )
    select v_form_id, f.field ->> 'key', f.position - 1,
      nullif(btrim(a ->> 'text'), ''),
      coalesce(array(select distinct e::int
                     from jsonb_array_elements_text(a -> 'evidence') e order by 1), '{}'),
      coalesce((select jsonb_agg(jsonb_build_object(
        'document_id', q ->> 'document_id', 'page', (q ->> 'page')::int, 'text', q ->> 'text'))
        from jsonb_array_elements(coalesce(a -> 'documents', '[]')) q), '[]'::jsonb)
    from (select field, row_number() over (order by si, fi) as position
          from jsonb_array_elements(v_template -> 'sections') with ordinality s(section, si),
               jsonb_array_elements(s.section -> 'fields') with ordinality x(field, fi)) f
    join jsonb_array_elements(p_answers) a on a ->> 'key' = f.field ->> 'key';
    update public.form_answers n set machine_text = o.machine_text, evidence = o.evidence,
      document_quotes = o.document_quotes, practitioner_text = o.practitioner_text, review = o.review
    from public.form_answers o
    where n.form_id = v_form_id and o.form_id = v_previous
      and o.field_key = n.field_key and o.review <> 'unreviewed';
    select count(*) into v_answered from public.form_answers
    where form_id = v_form_id and machine_text is not null;
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
  perform private.log_event(v_job.consultation_id, 'form.completed', v_engine::text, 'engine',
    'form', v_form_id, 'success', jsonb_build_object('job_id', v_job.id, 'attempt', v_job.attempt,
      'segment_count', v_answered, 'from_status', 'extraction_processing', 'to_status', v_status));
  return jsonb_build_object('ok', true, 'form_id', v_form_id);
end;
$$;
