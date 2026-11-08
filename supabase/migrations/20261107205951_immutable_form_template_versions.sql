-- Immutable form-template versions are additive to the existing mutable
-- form_templates row. The worker keeps using form_templates until it is moved
-- deliberately; consultations can already pin a stable version meanwhile.

create function private.form_template_definition_hash(p_definition jsonb) returns text
language sql immutable set search_path = ''
as $$
  select encode(sha256(convert_to(p_definition::text, 'UTF8')), 'hex');
$$;

create table public.form_template_versions (
  id uuid primary key default gen_random_uuid(),
  practitioner_id uuid references auth.users (id) on delete restrict,
  template_key text not null check (template_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  version_number int not null check (version_number > 0),
  schema_version int not null check (schema_version > 0),
  definition jsonb not null check (private.valid_template(definition)),
  definition_hash text generated always as (
    private.form_template_definition_hash(definition)
  ) stored,
  is_built_in boolean not null default false,
  origin text not null check (origin in ('built_in', 'legacy_current', 'custom')),
  created_by uuid references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique nulls not distinct (practitioner_id, template_key, version_number),
  check (
    (is_built_in and practitioner_id is null and created_by is null and origin = 'built_in')
    or
    (not is_built_in and practitioner_id is not null
      and created_by = practitioner_id and origin in ('legacy_current', 'custom'))
  )
);

alter table public.form_template_versions enable row level security;
revoke all on public.form_template_versions from public, anon, authenticated, service_role;
grant select on public.form_template_versions to authenticated, service_role;

create policy "Practitioners read accessible form template versions"
  on public.form_template_versions for select to authenticated
  using (
    private.is_practitioner()
    and (is_built_in or practitioner_id = (select auth.uid()))
  );

create function private.prevent_form_template_version_mutation() returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'form template versions are immutable';
end;
$$;

create trigger form_template_versions_are_immutable
  before update or delete on public.form_template_versions
  for each row execute function private.prevent_form_template_version_mutation();

create table public.form_template_defaults (
  practitioner_id uuid primary key references auth.users (id) on delete cascade,
  form_template_version_id uuid not null references public.form_template_versions (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  updated_at timestamptz not null default now(),
  check (updated_by = practitioner_id)
);

alter table public.form_template_defaults enable row level security;
revoke all on public.form_template_defaults from public, anon, authenticated, service_role;
grant select on public.form_template_defaults to authenticated, service_role;

create policy "Practitioners read their own form template default"
  on public.form_template_defaults for select to authenticated
  using (private.is_practitioner() and practitioner_id = (select auth.uid()));

alter table public.consultations
  add column form_template_version_id uuid
    references public.form_template_versions (id) on delete restrict;

create index consultations_form_template_version_idx
  on public.consultations (form_template_version_id)
  where form_template_version_id is not null;

create function private.form_template_version_accessible(
  p_practitioner_id uuid,
  p_version_id uuid
) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.form_template_versions v
    where v.id = p_version_id
      and (v.is_built_in or v.practitioner_id = p_practitioner_id)
  );
$$;

create function private.require_accessible_form_template_version() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_version_id uuid;
begin
  if tg_table_name = 'consultations' then
    v_version_id := new.form_template_version_id;
    if tg_op = 'UPDATE'
       and old.form_template_version_id is not null
       and new.form_template_version_id is distinct from old.form_template_version_id then
      raise exception using
        errcode = '55000',
        message = 'a consultation form template version is immutable once pinned';
    end if;
    if v_version_id is not null
       and (tg_op = 'INSERT' or old.form_template_version_id is null)
       and new.status not in ('consent_pending', 'ready_for_audio') then
      raise exception using
        errcode = '55000',
        message = 'a consultation form template version can only be pinned before processing';
    end if;
  else
    v_version_id := new.form_template_version_id;
  end if;

  if v_version_id is not null and not private.form_template_version_accessible(
    new.practitioner_id,
    v_version_id
  ) then
    raise exception using
      errcode = '23503',
      message = 'form template version is not accessible to the practitioner';
  end if;
  return new;
end;
$$;

create trigger form_template_defaults_require_accessible_version
  before insert or update on public.form_template_defaults
  for each row execute function private.require_accessible_form_template_version();

create trigger consultations_require_accessible_form_template_version
  before insert or update of form_template_version_id on public.consultations
  for each row execute function private.require_accessible_form_template_version();

-- One canonical built-in version. Existing mutable templates are then mapped
-- either to it or to an owner-only immutable snapshot.
insert into public.form_template_versions (
  template_key, version_number, schema_version, definition, is_built_in, origin
) values (
  'watson_standard', 1, 1, private.watson_form(), true, 'built_in'
);

insert into public.form_template_versions (
  practitioner_id, template_key, version_number, schema_version,
  definition, is_built_in, origin, created_by, created_at
)
select
  t.practitioner_id, 'legacy_current', 1, 1,
  t.definition, false, 'legacy_current',
  t.practitioner_id, t.updated_at
from public.form_templates t
where t.definition is distinct from private.watson_form();

insert into public.form_template_defaults (
  practitioner_id, form_template_version_id, updated_by, updated_at
)
select
  t.practitioner_id,
  coalesce(owned.id, built_in.id),
  t.practitioner_id,
  t.updated_at
from public.form_templates t
cross join public.form_template_versions built_in
left join public.form_template_versions owned
  on owned.practitioner_id = t.practitioner_id
  and owned.origin = 'legacy_current'
where built_in.is_built_in;

create function public.create_form_template_version(p_definition jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_version_id uuid;
  v_version_number int;
begin
  if v_user is null then
    return private.refuse('NOT_SIGNED_IN');
  end if;
  if not private.is_practitioner() or private.is_engine() then
    return private.refuse('NOT_A_PRACTITIONER');
  end if;
  if not coalesce(private.valid_template(p_definition), false) then
    return private.refuse('VALIDATION', 'definition');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('form-template:' || v_user::text, 44));
  select coalesce(max(v.version_number), 0) + 1
    into v_version_number
    from public.form_template_versions v
    where v.practitioner_id = v_user
      and v.template_key = 'custom';

  insert into public.form_template_versions (
    practitioner_id, template_key, version_number, schema_version,
    definition, origin, created_by
  ) values (
    v_user, 'custom', v_version_number, 1,
    p_definition, 'custom', v_user
  ) returning id into v_version_id;

  return jsonb_build_object(
    'ok', true,
    'version_id', v_version_id,
    'template_key', 'custom',
    'version_number', v_version_number,
    'schema_version', 1,
    'definition_hash', private.form_template_definition_hash(p_definition)
  );
end;
$$;

create function public.set_default_form_template_version(p_version_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    return private.refuse('NOT_SIGNED_IN');
  end if;
  if not private.is_practitioner() or private.is_engine() then
    return private.refuse('NOT_A_PRACTITIONER');
  end if;
  if not private.form_template_version_accessible(v_user, p_version_id) then
    return private.refuse('FORM_TEMPLATE_VERSION_NOT_FOUND');
  end if;

  insert into public.form_template_defaults (
    practitioner_id, form_template_version_id, updated_by
  ) values (
    v_user, p_version_id, v_user
  )
  on conflict (practitioner_id) do update
    set form_template_version_id = excluded.form_template_version_id,
        updated_by = excluded.updated_by,
        updated_at = now();

  return jsonb_build_object('ok', true, 'version_id', p_version_id);
end;
$$;

create function public.pin_consultation_form_template(
  p_consultation_id uuid,
  p_version_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_consultation public.consultations;
  v_version_id uuid;
begin
  if v_user is null then
    return private.refuse('NOT_SIGNED_IN');
  end if;
  if not private.is_practitioner() or private.is_engine() then
    return private.refuse('NOT_A_PRACTITIONER');
  end if;

  select * into v_consultation
    from public.consultations
    where id = p_consultation_id and practitioner_id = v_user
    for update;
  if not found then
    return private.refuse('NOT_FOUND');
  end if;

  if p_version_id is not null
     and not private.form_template_version_accessible(v_user, p_version_id) then
    return private.refuse('FORM_TEMPLATE_VERSION_NOT_FOUND');
  end if;

  if v_consultation.form_template_version_id is not null then
    if p_version_id is null
       or p_version_id = v_consultation.form_template_version_id then
      return jsonb_build_object(
        'ok', true,
        'version_id', v_consultation.form_template_version_id
      );
    end if;
    return private.refuse('FORM_TEMPLATE_ALREADY_PINNED');
  end if;

  if v_consultation.status not in ('consent_pending', 'ready_for_audio') then
    return private.refuse('FORM_TEMPLATE_PIN_TOO_LATE');
  end if;

  v_version_id := p_version_id;
  if v_version_id is null then
    select d.form_template_version_id into v_version_id
      from public.form_template_defaults d
      where d.practitioner_id = v_user;
  end if;
  if v_version_id is null then
    return private.refuse('FORM_TEMPLATE_DEFAULT_MISSING');
  end if;
  if not private.form_template_version_accessible(v_user, v_version_id) then
    return private.refuse('FORM_TEMPLATE_VERSION_NOT_FOUND');
  end if;

  update public.consultations
    set form_template_version_id = v_version_id, updated_at = now()
    where id = p_consultation_id;

  perform private.log_event(
    p_consultation_id,
    'form_template.pinned',
    v_user::text,
    'practitioner',
    'form_template_version',
    v_version_id,
    'success',
    '{}'::jsonb
  );

  return jsonb_build_object('ok', true, 'version_id', v_version_id);
end;
$$;

revoke all on function
  public.create_form_template_version(jsonb),
  public.set_default_form_template_version(uuid),
  public.pin_consultation_form_template(uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.create_form_template_version(jsonb),
  public.set_default_form_template_version(uuid),
  public.pin_consultation_form_template(uuid, uuid)
to authenticated;

revoke all on function
  private.form_template_definition_hash(jsonb),
  private.prevent_form_template_version_mutation(),
  private.form_template_version_accessible(uuid, uuid),
  private.require_accessible_form_template_version()
from public, anon, authenticated, service_role;
