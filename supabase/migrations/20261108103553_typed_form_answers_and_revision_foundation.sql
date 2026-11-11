-- Typed answer and revision foundation. Existing text columns remain as a
-- compatibility projection until every schema-v1 screen and export is moved.

alter table public.forms
  add column revision_number int,
  add column revision_kind text not null default 'generated'
    check (revision_kind in (
      'generated', 'refill', 'historical_conversion', 'correction', 'final_reconciliation'
    )),
  add column parent_form_id uuid references public.forms(id) on delete restrict;

with numbered as (
  select id, row_number() over (
    partition by consultation_id order by created_at, id
  )::int as revision_number
  from public.forms
)
update public.forms f
set revision_number = n.revision_number
from numbered n
where n.id = f.id;

alter table public.forms alter column revision_number set not null;
alter table public.forms add constraint forms_consultation_revision_unique
  unique (consultation_id, revision_number);

create function private.assign_form_revision() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('form-revision:' || new.consultation_id::text, 45));
  if new.revision_number is null then
    select coalesce(max(f.revision_number), 0) + 1
      into new.revision_number
    from public.forms f
    where f.consultation_id = new.consultation_id;
  end if;
  if new.parent_form_id is null then
    select f.id into new.parent_form_id
    from public.forms f
    where f.consultation_id = new.consultation_id
    order by f.revision_number desc
    limit 1;
  end if;
  return new;
end;
$$;

create trigger forms_assign_revision
  before insert on public.forms
  for each row execute function private.assign_form_revision();

alter table public.form_answers
  add column value_type text not null default 'text'
    check (value_type in (
      'text', 'long_text', 'integer', 'decimal', 'date', 'boolean',
      'single_choice', 'multi_choice', 'repeater', 'attestation',
      'signature', 'attachment_reference'
    )),
  add column answer_state text not null default 'unanswered'
    check (answer_state in (
      'unanswered', 'known', 'explicit_none', 'unknown', 'not_applicable'
    )),
  add column machine_state text not null default 'unanswered'
    check (machine_state in (
      'unanswered', 'known', 'explicit_none', 'unknown', 'not_applicable'
    )),
  add column machine_value jsonb,
  add column practitioner_value jsonb;

update public.form_answers a
set value_type = coalesce(field.definition ->> 'value_type', 'text'),
    answer_state = case
      when a.practitioner_text is not null or a.machine_text is not null then 'known'
      else 'unanswered'
    end,
    machine_state = case when a.machine_text is not null then 'known' else 'unanswered' end,
    machine_value = case when a.machine_text is not null then to_jsonb(a.machine_text) end,
    practitioner_value = case when a.practitioner_text is not null then to_jsonb(a.practitioner_text) end
from public.forms f,
     lateral jsonb_array_elements(f.template -> 'sections') section,
     lateral jsonb_array_elements(section -> 'fields') field(definition)
where f.id = a.form_id
  and field.definition ->> 'key' = a.field_key;

alter table public.form_answers add constraint form_answers_state_value_consistent check (
  (
    (machine_state = 'known' and machine_value is not null)
    or (machine_state <> 'known' and machine_value is null)
  )
  and (
    (answer_state = 'known' and (machine_value is not null or practitioner_value is not null))
    or (answer_state <> 'known' and practitioner_value is null)
  )
);

create function private.valid_iso_date(p_value text) returns boolean
language plpgsql immutable set search_path = ''
as $$
begin
  return p_value ~ '^\d{4}-\d{2}-\d{2}$'
    and to_char(p_value::date, 'YYYY-MM-DD') = p_value;
exception when others then
  return false;
end;
$$;

create function private.valid_typed_answer_value(
  p_value_type text,
  p_value jsonb,
  p_field jsonb
) returns boolean
language sql immutable set search_path = ''
as $$
  select case p_value_type
    when 'text' then jsonb_typeof(p_value) = 'string' and char_length(p_value #>> '{}') <= 4000
    when 'long_text' then jsonb_typeof(p_value) = 'string' and char_length(p_value #>> '{}') <= 4000
    when 'integer' then jsonb_typeof(p_value) = 'number' and (p_value #>> '{}') ~ '^-?[0-9]+$'
    when 'decimal' then jsonb_typeof(p_value) = 'number'
    when 'date' then jsonb_typeof(p_value) = 'string'
      and private.valid_iso_date(p_value #>> '{}')
    when 'boolean' then jsonb_typeof(p_value) = 'boolean'
    when 'attestation' then jsonb_typeof(p_value) = 'boolean'
    when 'attachment_reference' then jsonb_typeof(p_value) = 'string'
      and (p_value #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    when 'single_choice' then jsonb_typeof(p_value) = 'string' and exists (
      select 1 from jsonb_array_elements(coalesce(p_field -> 'options', '[]'::jsonb)) o
      where o ->> 'key' = p_value #>> '{}'
    )
    when 'multi_choice' then jsonb_typeof(p_value) = 'array'
      and jsonb_array_length(p_value) between 1 and 30
      and not exists (
        select 1 from jsonb_array_elements_text(p_value) selected
        where not exists (
          select 1 from jsonb_array_elements(coalesce(p_field -> 'options', '[]'::jsonb)) o
          where o ->> 'key' = selected
        )
      )
      and (
        select count(*) = count(distinct selected)
        from jsonb_array_elements_text(p_value) selected
      )
    when 'repeater' then jsonb_typeof(p_value) = 'array'
      and jsonb_array_length(p_value) between 1 and 50
      and (
        select count(*) = count(distinct item ->> 'item_id')
        from jsonb_array_elements(p_value) item
      )
      and not exists (
        select 1 from jsonb_array_elements(p_value) item
        where jsonb_typeof(item) <> 'object'
           or coalesce(item ->> 'item_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           or jsonb_typeof(item -> 'values') <> 'object'
           or exists (
             select 1 from jsonb_object_keys(item -> 'values') k
             where not exists (
               select 1 from jsonb_array_elements(coalesce(p_field -> 'item_fields', '[]'::jsonb)) i
                where i ->> 'key' = k
              )
            )
           or exists (
             select 1
             from jsonb_array_elements(coalesce(p_field -> 'item_fields', '[]'::jsonb)) i
             where not ((item -> 'values') ? (i ->> 'key'))
                or (
                  (item -> 'values' -> (i ->> 'key')) <> 'null'::jsonb
                  and not private.valid_typed_answer_value(
                    coalesce(i ->> 'value_type', 'text'),
                    item -> 'values' -> (i ->> 'key'),
                    i
                  )
                )
           )
      )
    when 'signature' then false
    else false
  end;
$$;

create function private.valid_engine_form_answer(p_field jsonb, p_answer jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when not (p_field ? 'value_type') then true
    when p_answer ->> 'value_type' is distinct from p_field ->> 'value_type' then false
    when coalesce(p_field ->> 'mode', 'extract') = 'manual' then
      p_answer ->> 'state' = 'unanswered' and (p_answer -> 'value') = 'null'::jsonb
    when p_answer ->> 'state' not in (
      'unanswered', 'known', 'explicit_none', 'unknown', 'not_applicable'
    ) then false
    when p_answer ->> 'state' = 'known' then
      private.valid_typed_answer_value(p_field ->> 'value_type', p_answer -> 'value', p_field)
    else (p_answer -> 'value') = 'null'::jsonb
  end;
$$;

create table public.form_attestations (
  form_id uuid not null references public.forms(id) on delete restrict,
  field_key text not null check (field_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  decision text not null check (decision in ('confirmed', 'declined', 'not_applicable')),
  attested_by uuid not null references auth.users(id) on delete restrict,
  attested_at timestamptz not null default now(),
  primary key (form_id, field_key)
);

create table public.form_signatures (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.forms(id) on delete restrict,
  field_key text not null check (field_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  signer_role text not null check (signer_role in ('patient', 'practitioner')),
  method text not null check (method in ('wet_ink_on_print', 'typed_confirmation', 'digital')),
  signed_name text not null check (char_length(btrim(signed_name)) between 1 and 120),
  signed_at timestamptz not null,
  recorded_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (form_id, field_key, signer_role)
);

alter table public.form_attestations enable row level security;
alter table public.form_signatures enable row level security;
revoke all on public.form_attestations, public.form_signatures
  from public, anon, authenticated, service_role;
grant select on public.form_attestations, public.form_signatures
  to authenticated, service_role;

create policy "Practitioners read attestations of their own forms"
  on public.form_attestations for select to authenticated
  using (exists (
    select 1 from public.forms f
    join public.consultations c on c.id = f.consultation_id
    where f.id = form_attestations.form_id and c.practitioner_id = (select auth.uid())
  ));

create policy "Practitioners read signatures of their own forms"
  on public.form_signatures for select to authenticated
  using (exists (
    select 1 from public.forms f
    join public.consultations c on c.id = f.consultation_id
    where f.id = form_signatures.form_id and c.practitioner_id = (select auth.uid())
  ));

create function private.prevent_approved_form_mutation() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_form_id uuid;
begin
  if tg_table_name = 'forms' then
    if old.status = 'approved' then
      raise exception using errcode = '55000', message = 'approved form revisions are immutable';
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  v_form_id := case when tg_op = 'DELETE' then old.form_id else new.form_id end;
  if exists (select 1 from public.forms f where f.id = v_form_id and f.status = 'approved') then
    raise exception using errcode = '55000', message = 'approved form revisions are immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- Safe deployment backfill: pin only consultations that have not begun, or
-- whose existing form byte-for-byte matches one accessible immutable version.
do $$
declare
  r record;
begin
  for r in
    select c.id as consultation_id, c.practitioner_id, d.form_template_version_id as version_id
    from public.consultations c
    join public.form_template_defaults d on d.practitioner_id = c.practitioner_id
    where c.form_template_version_id is null
      and (
        (
          c.status in ('consent_pending', 'ready_for_audio')
          and not exists (select 1 from public.audio_tracks a where a.consultation_id = c.id)
          and not exists (select 1 from public.live_pieces p where p.consultation_id = c.id)
        )
        or (
          c.status in (
            'transcript_ready', 'transcript_under_review',
            'transcript_reviewed', 'extraction_failed'
          )
          and not exists (select 1 from public.form_jobs j where j.consultation_id = c.id)
        )
      )
  loop
    update public.consultations
      set form_template_version_id = r.version_id, updated_at = now()
      where id = r.consultation_id;
    perform private.log_event(
      r.consultation_id, 'form_template.backfilled', r.practitioner_id::text,
      'practitioner', 'form_template_version', r.version_id, 'success', '{}'::jsonb
    );
  end loop;

  for r in
    with matches as (
      select c.id as consultation_id, c.practitioner_id,
             (array_agg(v.id order by v.id))[1] as version_id,
             count(distinct v.id) as match_count
      from public.consultations c
      join public.forms f on f.consultation_id = c.id and f.status <> 'superseded'
      join public.form_template_versions v on v.definition = f.template
        and (v.is_built_in or v.practitioner_id = c.practitioner_id)
      where c.form_template_version_id is null
      group by c.id, c.practitioner_id
    )
    select * from matches where match_count = 1
  loop
    update public.consultations
      set form_template_version_id = r.version_id, updated_at = now()
      where id = r.consultation_id;
    update public.forms
      set form_template_version_id = r.version_id
      where consultation_id = r.consultation_id
        and form_template_version_id is null
        and template = (select definition from public.form_template_versions where id = r.version_id);
    perform private.log_event(
      r.consultation_id, 'form_template.backfilled', r.practitioner_id::text,
      'practitioner', 'form_template_version', r.version_id, 'success', '{}'::jsonb
    );
  end loop;
end;
$$;

-- Install immutability only after the one-time provenance backfill above.
create trigger approved_forms_are_immutable
  before update or delete on public.forms
  for each row execute function private.prevent_approved_form_mutation();
create trigger approved_form_answers_are_immutable
  before insert or update or delete on public.form_answers
  for each row execute function private.prevent_approved_form_mutation();
create trigger approved_form_attestations_are_immutable
  before insert or update or delete on public.form_attestations
  for each row execute function private.prevent_approved_form_mutation();
create trigger approved_form_signatures_are_immutable
  before insert or update or delete on public.form_signatures
  for each row execute function private.prevent_approved_form_mutation();

create view public.form_template_pin_backfill_review
with (security_invoker = true)
as
select
  c.id as consultation_id,
  c.status,
  c.scheduled_at,
  case
    when d.form_template_version_id is null then 'missing_practice_default'
    when exists (select 1 from public.form_jobs j where j.consultation_id = c.id)
      then 'processing_started_without_pin'
    when exists (
      select 1 from public.forms f where f.consultation_id = c.id and f.status <> 'superseded'
    ) then 'existing_form_has_no_unique_template_match'
    when exists (select 1 from public.audio_tracks a where a.consultation_id = c.id)
      or exists (select 1 from public.live_pieces p where p.consultation_id = c.id)
      then 'audio_started_without_pin'
    else 'manual_review_required'
  end as review_reason
from public.consultations c
left join public.form_template_defaults d on d.practitioner_id = c.practitioner_id
where c.form_template_version_id is null;

revoke all on public.form_template_pin_backfill_review from public, anon, service_role;
grant select on public.form_template_pin_backfill_review to authenticated;

-- The schema-v1 textarea RPC must not write a lossy text projection into a
-- schema-v2 choice, repeater, attestation, or signature value.
create or replace function public.review_form_answer(
  p_form_id uuid, p_field_key text, p_decision text, p_text text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_form public.forms;
  v_status public.consultation_status;
  v_answer public.form_answers;
begin
  select f.* into v_form from public.forms f
  join public.consultations c on c.id = f.consultation_id
  where f.id = p_form_id and c.practitioner_id = v_user;
  if not found then return private.refuse('NOT_FOUND'); end if;
  select status into v_status from public.consultations
    where id = v_form.consultation_id for update;
  if v_form.status <> 'draft' or v_status not in ('draft_ready', 'under_review') then
    return private.reject_transition(v_form.consultation_id, 'review_form_answer', v_status);
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_form.template -> 'sections') section,
         jsonb_array_elements(section -> 'fields') field
    where field ? 'value_type'
  ) then
    return private.refuse('FORM_TYPED_REVIEW_REQUIRED');
  end if;
  select * into v_answer from public.form_answers
    where form_id = p_form_id and field_key = p_field_key for update;
  if not found then return private.refuse('NOT_FOUND', 'field_key'); end if;
  if p_decision = 'edit' then
    if p_text is null or char_length(btrim(p_text)) not between 1 and 4000 then
      return private.refuse('VALIDATION', 'text');
    end if;
    update public.form_answers set review = 'edited', practitioner_text = btrim(p_text)
      where form_id = p_form_id and field_key = p_field_key;
  elsif p_decision in ('accept', 'reject') then
    if p_decision = 'accept' and v_answer.machine_text is null then
      return private.refuse('VALIDATION', 'decision');
    end if;
    update public.form_answers
      set review = case p_decision when 'accept' then 'accepted' else 'rejected' end,
          practitioner_text = null
      where form_id = p_form_id and field_key = p_field_key;
  elsif p_decision = 'undo' then
    update public.form_answers set review = 'unreviewed', practitioner_text = null
      where form_id = p_form_id and field_key = p_field_key;
  else
    return private.refuse('VALIDATION', 'decision');
  end if;
  if v_status = 'draft_ready' then
    update public.consultations set status = 'under_review', updated_at = now()
      where id = v_form.consultation_id;
    perform private.log_event(v_form.consultation_id, 'form.review_started', v_user::text,
      'practitioner', 'form', p_form_id, 'success',
      jsonb_build_object('from_status', 'draft_ready', 'to_status', 'under_review'));
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- Schema-v2 records fail closed until the typed review RPCs implement every
-- approval gate. The legacy approval path remains unchanged.
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
  if v_form.template ? 'approval_gates' then
    return private.refuse('FORM_SAFETY_REVIEW_REQUIRED');
  end if;
  if exists (select 1 from public.form_answers
             where form_id = p_form_id and review = 'unreviewed' and machine_text is not null) then
    return private.refuse('FORM_NOT_REVIEWED');
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

-- Latest job completion contract, now storing typed values as well as the
-- legacy text projection. Provisional/live values are deliberately absent.
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
    where id = p_job_id and attempt = p_attempt and status = 'processing'
      and engine_user_id = v_engine
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
       or exists (
         select 1
         from jsonb_array_elements(p_answers) a
         join lateral (
           select f
           from jsonb_array_elements(v_template -> 'sections') s,
                jsonb_array_elements(s -> 'fields') f
           where f ->> 'key' = a ->> 'key'
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
      where consultation_id = v_job.consultation_id and status <> 'superseded';
    update public.forms set status = 'superseded' where id = v_previous;
    insert into public.forms (
      consultation_id, job_id, transcript_id, template, form_template_version_id,
      revision_kind, parent_form_id
    )
    select v_job.consultation_id, v_job.id, v_job.transcript_id,
      v.definition, v.id,
      case when v_previous is null then 'generated' else 'refill' end,
      v_previous
    from public.consultations c
    join public.form_template_versions v on v.id = c.form_template_version_id
    where c.id = v_job.consultation_id
    returning id into v_form_id;
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
      case
        when f.field ? 'value_type' then a ->> 'state'
        when nullif(btrim(a ->> 'text'), '') is not null then 'known'
        else 'unanswered'
      end,
      case
        when f.field ? 'value_type' then a ->> 'state'
        when nullif(btrim(a ->> 'text'), '') is not null then 'known'
        else 'unanswered'
      end,
      case
        when f.field ? 'value_type' and a ->> 'state' = 'known' then a -> 'value'
        when not (f.field ? 'value_type') and nullif(btrim(a ->> 'text'), '') is not null
          then to_jsonb(nullif(btrim(a ->> 'text'), ''))
      end
    from (select field, row_number() over (order by si, fi) as position
          from jsonb_array_elements(v_template -> 'sections') with ordinality s(section, si),
               jsonb_array_elements(s.section -> 'fields') with ordinality x(field, fi)) f
    join jsonb_array_elements(p_answers) a on a ->> 'key' = f.field ->> 'key';
    update public.form_answers n
      set machine_text = o.machine_text,
          evidence = o.evidence,
          document_quotes = o.document_quotes,
          practitioner_text = o.practitioner_text,
          review = o.review,
          value_type = o.value_type,
          answer_state = o.answer_state,
          machine_state = o.machine_state,
          machine_value = o.machine_value,
          practitioner_value = o.practitioner_value
    from public.form_answers o
    where n.form_id = v_form_id and o.form_id = v_previous
      and o.field_key = n.field_key and o.review <> 'unreviewed';
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

revoke all on function
  private.assign_form_revision(),
  private.valid_iso_date(text),
  private.valid_typed_answer_value(text, jsonb, jsonb),
  private.valid_engine_form_answer(jsonb, jsonb),
  private.prevent_approved_form_mutation()
from public, anon, authenticated, service_role;
