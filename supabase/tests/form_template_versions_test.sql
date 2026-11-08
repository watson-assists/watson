begin;

select plan(33);

insert into auth.users (id, email)
values
  ('11111111-1111-1111-1111-111111111111', 'forms-owner@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'forms-other@example.test');

insert into private.user_roles (user_id, role)
values
  ('11111111-1111-1111-1111-111111111111', 'practitioner'),
  ('22222222-2222-2222-2222-222222222222', 'practitioner');

create temporary table test_form_version_state (
  key text primary key,
  id uuid,
  payload jsonb
);
grant select, insert, update, delete on test_form_version_state to authenticated;

insert into test_form_version_state (key, id)
select 'built_in', id
from public.form_template_versions
where is_built_in;

select is(
  (select count(*) from test_form_version_state where key = 'built_in'),
  1::bigint,
  'the built-in form is represented by one immutable version'
);

select results_eq(
  $$select template_key from public.form_template_versions where is_built_in$$,
  array['watson_standard'],
  'the existing built-in has a stable product key'
);

select results_eq(
  $$select schema_version from public.form_template_versions where is_built_in$$,
  array[1],
  'the existing built-in records its definition schema version'
);

select ok(
  (select definition_hash ~ '^[0-9a-f]{64}$'
     and definition_hash = private.form_template_definition_hash(definition)
   from public.form_template_versions where is_built_in),
  'the built-in stores a canonical definition hash'
);

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select results_eq(
  $$select count(*) from public.form_template_versions where is_built_in$$,
  array[1::bigint],
  'a practitioner can read the built-in version'
);

insert into test_form_version_state (key, id, payload)
select 'owner_version', (result ->> 'version_id')::uuid, result
from (
  select public.create_form_template_version(
    '{"title":"Version one","sections":[{"title":"Summary","fields":[{"key":"summary","label":"Summary","mode":"extract"}]}]}'::jsonb
  ) as result
) created;

select ok(
  (select (payload ->> 'ok')::boolean from test_form_version_state where key = 'owner_version'),
  'a practitioner can create an immutable version'
);

select results_eq(
  $$select version_number from public.form_template_versions
    where id = (select id from test_form_version_state where key = 'owner_version')$$,
  array[1],
  'practitioner versions receive a stable sequence number'
);

select results_eq(
  $$select template_key, schema_version from public.form_template_versions
    where id = (select id from test_form_version_state where key = 'owner_version')$$,
  $$values ('custom'::text, 1)$$,
  'custom versions use a stable lineage key and schema version'
);

insert into test_form_version_state (key, id, payload)
select 'owner_version_two', (result ->> 'version_id')::uuid, result
from (
  select public.create_form_template_version(
    '{"title":"Version two","sections":[{"title":"Summary","fields":[{"key":"summary","label":"Summary","mode":"extract"}]}]}'::jsonb
  ) as result
) created;

select results_eq(
  $$select template_key, version_number from public.form_template_versions
    where id = (select id from test_form_version_state where key = 'owner_version_two')$$,
  $$values ('custom'::text, 2)$$,
  'new custom versions advance only their stable lineage sequence'
);

select ok(
  (select public.set_default_form_template_version(id) ->> 'ok' = 'true'
   from test_form_version_state where key = 'owner_version'),
  'a practitioner can store an accessible version as their default'
);

insert into test_form_version_state (key, id, payload)
select 'consultation_one', (result ->> 'consultation_id')::uuid, result
from (
  select public.create_consultation(
    p_scheduled_at => now() + interval '1 day',
    p_language => 'en'::public.consultation_language,
    p_consent_recorded => false
  ) as result
) created;

select ok(
  (select public.pin_consultation_form_template(id) ->> 'ok' = 'true'
   from test_form_version_state where key = 'consultation_one'),
  'a consultation can pin the practitioner default'
);

select results_eq(
  $$select form_template_version_id from public.consultations
    where id = (select id from test_form_version_state where key = 'consultation_one')$$,
  $$select id from test_form_version_state where key = 'owner_version'$$,
  'the consultation stores the chosen immutable version'
);

select ok(
  (select public.set_default_form_template_version(id) ->> 'ok' = 'true'
   from test_form_version_state where key = 'built_in'),
  'the built-in version can become the practitioner default'
);

select results_eq(
  $$select form_template_version_id from public.consultations
    where id = (select id from test_form_version_state where key = 'consultation_one')$$,
  $$select id from test_form_version_state where key = 'owner_version'$$,
  'changing the default does not change an already pinned consultation'
);

insert into test_form_version_state (key, id, payload)
select 'consultation_two', (result ->> 'consultation_id')::uuid, result
from (
  select public.create_consultation(
    p_scheduled_at => now() + interval '2 days',
    p_language => 'en'::public.consultation_language,
    p_consent_recorded => false
  ) as result
) created;

select ok(
  (select public.pin_consultation_form_template(c.id, v.id) ->> 'ok' = 'true'
   from test_form_version_state c
   cross join test_form_version_state v
   where c.key = 'consultation_two' and v.key = 'built_in'),
  'a consultation can explicitly pin an accessible built-in version'
);

insert into test_form_version_state (key, id, payload)
select 'consultation_three', (result ->> 'consultation_id')::uuid, result
from (
  select public.create_consultation(
    p_scheduled_at => now() + interval '3 days',
    p_language => 'en'::public.consultation_language,
    p_consent_recorded => false
  ) as result
) created;

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

insert into test_form_version_state (key, id, payload)
select 'other_version', (result ->> 'version_id')::uuid, result
from (
  select public.create_form_template_version(
    '{"title":"Other version","sections":[{"title":"Other","fields":[{"key":"other","label":"Other","mode":"manual"}]}]}'::jsonb
  ) as result
) created;

insert into test_form_version_state (key, id, payload)
select 'other_consultation', (result ->> 'consultation_id')::uuid, result
from (
  select public.create_consultation(
    p_scheduled_at => now() + interval '4 days',
    p_language => 'en'::public.consultation_language,
    p_consent_recorded => false
  ) as result
) created;

select is_empty(
  $$select id from public.form_template_versions
    where id = (select id from test_form_version_state where key = 'owner_version')$$,
  'RLS hides another practitioner''s custom versions'
);

select is_empty(
  $$select * from public.form_template_defaults$$,
  'RLS hides another practitioner''s default'
);

set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select is(
  (select public.pin_consultation_form_template(c.id, v.id) ->> 'error_category'
   from test_form_version_state c
   cross join test_form_version_state v
   where c.key = 'consultation_three' and v.key = 'other_version'),
  'FORM_TEMPLATE_VERSION_NOT_FOUND',
  'a practitioner cannot pin another practitioner''s version'
);

select is(
  (select public.pin_consultation_form_template(c.id, v.id) ->> 'error_category'
   from test_form_version_state c
   cross join test_form_version_state v
   where c.key = 'other_consultation' and v.key = 'built_in'),
  'NOT_FOUND',
  'a practitioner cannot pin another practitioner''s consultation'
);

select is(
  (select public.set_default_form_template_version(id) ->> 'error_category'
   from test_form_version_state where key = 'other_version'),
  'FORM_TEMPLATE_VERSION_NOT_FOUND',
  'a practitioner cannot make another practitioner''s version their default'
);

select is(
  (select public.pin_consultation_form_template(c.id, v.id) ->> 'error_category'
   from test_form_version_state c
   cross join test_form_version_state v
   where c.key = 'consultation_one' and v.key = 'built_in'),
  'FORM_TEMPLATE_ALREADY_PINNED',
  'a pinned consultation cannot be repinned to another version'
);

reset role;
update public.consultations
set status = 'audio_imported'
where id = (select id from test_form_version_state where key = 'consultation_three');
set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select is(
  (select public.pin_consultation_form_template(c.id, v.id) ->> 'error_category'
   from test_form_version_state c
   cross join test_form_version_state v
   where c.key = 'consultation_three' and v.key = 'built_in'),
  'FORM_TEMPLATE_PIN_TOO_LATE',
  'template pinning is rejected after audio processing starts'
);

select results_eq(
  $$select resource_id from public.audit_events
    where consultation_id = (select id from test_form_version_state where key = 'consultation_one')
      and event_type = 'form_template.pinned'$$,
  $$select id from test_form_version_state where key = 'owner_version'$$,
  'pinning records only the non-clinical version identifier in the audit event'
);

select results_eq(
  $$select metadata_without_clinical_content from public.audit_events
    where consultation_id = (select id from test_form_version_state where key = 'consultation_one')
      and event_type = 'form_template.pinned'$$,
  array['{}'::jsonb],
  'pinning audit metadata contains no form or clinical content'
);

select ok(
  not has_table_privilege('authenticated', 'public.form_template_versions', 'insert,update,delete')
  and not has_table_privilege('authenticated', 'public.form_template_defaults', 'insert,update,delete'),
  'clients have no direct write grants on versioning tables'
);

reset role;

select throws_ok(
  format(
    'update public.consultations set form_template_version_id = %L::uuid where id = %L::uuid',
    (select id from test_form_version_state where key = 'built_in'),
    (select id from test_form_version_state where key = 'consultation_three')
  ),
  '55000',
  'a consultation form template version can only be pinned before processing',
  'the database trigger also rejects privileged late pinning'
);

select lives_ok(
  $$insert into public.form_template_versions (
      template_key, version_number, schema_version, definition, is_built_in, origin
    ) values (
      'massage_assessment_en_sk', 1, 2,
      private.watson_form(), true, 'built_in'
    )$$,
  'another built-in template key can start at version one'
);

select throws_ok(
  $$insert into public.form_template_versions (
      template_key, version_number, schema_version, definition, is_built_in, origin
    ) values (
      'massage_assessment_en_sk', 1, 2,
      private.watson_form(), true, 'built_in'
    )$$,
  '23505',
  null,
  'the same template key and version cannot be published twice'
);

select throws_ok(
  format(
    'update public.form_template_versions set definition = %L::jsonb where id = %L::uuid',
    '{"title":"Mutated","sections":[]}',
    (select id from test_form_version_state where key = 'owner_version')
  ),
  '55000',
  'form template versions are immutable',
  'even privileged updates cannot mutate a version'
);

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select ok(
  public.set_form_template(
    '{"title":"Legacy current","sections":[{"title":"Current","fields":[{"key":"current","label":"Current","mode":"suggest"}]}]}'::jsonb
  ) ->> 'ok' = 'true',
  'the existing mutable form_templates RPC remains compatible'
);

select results_eq(
  $$select definition ->> 'title' from public.form_templates
    where practitioner_id = '11111111-1111-1111-1111-111111111111'::uuid$$,
  array['Legacy current'],
  'legacy form_templates still stores the current mutable template'
);

select results_eq(
  $$select definition ->> 'title' from public.form_template_versions
    where id = (select id from test_form_version_state where key = 'owner_version')$$,
  array['Version one'],
  'legacy current-template changes cannot mutate an immutable version'
);

reset role;

select ok(
  not has_table_privilege('anon', 'public.form_template_versions', 'select')
  and not has_table_privilege('anon', 'public.form_template_defaults', 'select'),
  'anonymous clients have no access to versioning tables'
);

select * from finish();
rollback;
