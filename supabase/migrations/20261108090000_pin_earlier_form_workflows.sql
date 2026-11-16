-- Forms filled in before form versions existed (owner, 16 November 2026).
--
-- 20261108083404 pins a consultation that already has a form only when that form was made with the
-- practitioner's current template. A consultation whose form was made with an earlier template
-- stays without a version, and 20261108165148 then refuses to run, because every form job must
-- carry its consultation's version. On Watson's hosted data that was 7 of 14 form jobs, two of
-- them approved forms.
--
-- Here each of those consultations is pinned to an immutable copy of the definition its own form
-- embeds, so an approved form stays tied to exactly what was approved and nothing drifts to a
-- newer template. This runs before 20261108103553 makes approved forms immutable, as the pinning
-- in 20261108083404 does.

-- Where such a copy came from: an earlier template of the practitioner, never chosen for new work.
alter table public.form_template_versions
  drop constraint form_template_versions_origin_check,
  drop constraint form_template_versions_check;
alter table public.form_template_versions
  add constraint form_template_versions_origin_check
    check (origin in ('built_in', 'legacy_current', 'legacy_earlier', 'custom')),
  add constraint form_template_versions_check check (
    (is_built_in and practitioner_id is null and created_by is null and origin = 'built_in')
    or
    (not is_built_in and practitioner_id is not null
      and created_by = practitioner_id and origin in ('legacy_current', 'legacy_earlier', 'custom'))
  );

-- One copy for each earlier definition a practitioner's current forms still rest on, unless a
-- version the practitioner can use already holds that exact definition. Oldest first.
insert into public.form_template_versions (
  practitioner_id, template_key, version_number, schema_version,
  definition, origin, created_by, created_at
)
select
  earlier.practitioner_id, 'legacy_earlier',
  row_number() over (
    partition by earlier.practitioner_id
    order by earlier.first_used, private.form_template_definition_hash(earlier.template)
  ),
  1, earlier.template, 'legacy_earlier', earlier.practitioner_id, earlier.first_used
from (
  select c.practitioner_id, f.template, min(f.created_at) as first_used
  from public.consultations c
  join public.forms f on f.consultation_id = c.id and f.status <> 'superseded'
  where c.form_template_version_id is null
    and not exists (
      select 1 from public.form_template_versions v
      where (v.is_built_in or v.practitioner_id = c.practitioner_id)
        and v.definition = f.template
    )
  group by c.practitioner_id, f.template
) earlier;

-- The consultation takes the version that holds its current form's definition. The guard on
-- consultations allows exactly this: a form that embeds the same definition.
update public.consultations c
set form_template_version_id = (
  select v.id from public.form_template_versions v
  where (v.is_built_in or v.practitioner_id = c.practitioner_id)
    and v.definition = f.template
  order by v.is_built_in desc, v.created_at desc, v.id
  limit 1
)
from public.forms f
where f.consultation_id = c.id
  and f.status <> 'superseded'
  and c.form_template_version_id is null;

-- Its forms made with that definition record the version too, as in 20261108083404.
update public.forms f
set form_template_version_id = c.form_template_version_id
from public.consultations c
join public.form_template_versions v on v.id = c.form_template_version_id
where f.consultation_id = c.id
  and f.form_template_version_id is null
  and f.template = v.definition;

-- What is left has form jobs and no current form: the job failed, is still waiting, or its form
-- was set aside. No form rests on a definition, so nothing can drift: the consultation takes the
-- practitioner's usual version, as a new consultation does. The guard refuses a pin once a form
-- job exists, so it is switched off for this one statement.
alter table public.consultations
  disable trigger consultations_require_accessible_form_template_version;
update public.consultations c
set form_template_version_id = coalesce(
  (select d.form_template_version_id
   from public.form_template_defaults d
   where d.practitioner_id = c.practitioner_id),
  (select v.id
   from public.form_template_versions v
   where v.is_built_in and v.template_key = 'watson_standard'
   order by v.version_number desc
   limit 1)
)
where c.form_template_version_id is null
  and exists (select 1 from public.form_jobs j where j.consultation_id = c.id);
alter table public.consultations
  enable trigger consultations_require_accessible_form_template_version;

-- The check this change exists for, said here in plain words instead of two files later.
do $$
begin
  if exists (
    select 1 from public.form_jobs j
    join public.consultations c on c.id = j.consultation_id
    where c.form_template_version_id is null
  ) then
    raise exception 'a consultation with a form job is still without a form version';
  end if;
end;
$$;
