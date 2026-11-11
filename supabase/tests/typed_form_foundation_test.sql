begin;

select plan(23);

select is(
  (select schema_version from public.form_template_versions
   where template_key = 'massage_assessment_en_sk' and version_number = 1),
  2,
  'the bilingual massage form uses typed schema version two'
);

select is(
  (select jsonb_array_length(definition -> 'sections')
   from public.form_template_versions where template_key = 'massage_assessment_en_sk'),
  10,
  'the source form is represented by all ten sections'
);

select is(
  (select count(*)
   from public.form_template_versions v,
        jsonb_array_elements(v.definition -> 'sections') s,
        jsonb_array_elements(s -> 'fields') f
   where v.template_key = 'massage_assessment_en_sk'
     and f ->> 'value_type' = 'repeater'),
  2::bigint,
  'medications and symptom entries are typed repeaters'
);

select is(
  (select jsonb_array_length(definition -> 'approval_gates')
    from public.form_template_versions where template_key = 'massage_assessment_en_sk'),
  6,
  'safety, consent, and sign-off are explicit approval gates'
);

select ok(
  not private.valid_template(
    (select definition #- '{approval_gates,5,signer_role}'
     from public.form_template_versions
     where template_key = 'massage_assessment_en_sk')
  ),
  'signature approval gates declare the required signer role'
);

select ok(
  (select bool_and(
     private.valid_form_i18n(s -> 'title_i18n', 120)
     and not exists (
       select 1 from jsonb_array_elements(s -> 'fields') f
       where not private.valid_form_i18n(f -> 'label_i18n', 120)
     )
   )
   from public.form_template_versions v,
        jsonb_array_elements(v.definition -> 'sections') s
   where v.template_key = 'massage_assessment_en_sk'),
  'every section and field has English and Slovak labels'
);

select ok(
  private.valid_typed_answer_value(
    'single_choice', '"yes"'::jsonb,
    '{"options":[{"key":"yes"},{"key":"no"}]}'::jsonb
  ),
  'a declared choice key is valid'
);

select ok(
  not private.valid_typed_answer_value(
    'single_choice', '"invented"'::jsonb,
    '{"options":[{"key":"yes"},{"key":"no"}]}'::jsonb
  ),
  'an undeclared choice key is invalid'
);

select ok(
  private.valid_typed_answer_value(
    'repeater',
    '[{"item_id":"11111111-1111-4111-8111-111111111111","values":{"name":"A"}}]'::jsonb,
    '{"item_fields":[{"key":"name"}]}'::jsonb
  ),
  'a repeater value carries a stable item identifier and declared values'
);

select ok(
  not private.valid_typed_answer_value('signature', '"Robin"'::jsonb, '{}'::jsonb),
  'the engine can never manufacture a signature value'
);

select ok(
  private.valid_typed_answer_value('date', '"2026-12-01"'::jsonb, '{}'::jsonb),
  'a real ISO calendar date is valid'
);

select ok(
  not private.valid_typed_answer_value('date', '"2026-99-99"'::jsonb, '{}'::jsonb),
  'an impossible calendar date is invalid'
);

select has_column('public', 'forms', 'revision_number', 'forms carry immutable revision numbers');
select has_column('public', 'form_answers', 'machine_value', 'answers store typed machine values');

select ok(
  not has_table_privilege('authenticated', 'public.form_attestations', 'insert,update,delete'),
  'clients cannot write attestations directly'
);

select ok(
  not has_table_privilege('authenticated', 'public.form_signatures', 'insert,update,delete'),
  'clients cannot write signatures directly'
);

select has_view(
  'public', 'form_template_pin_backfill_review',
  'deployments have a PHI-minimal unresolved-pin review surface'
);

select has_column('public', 'form_jobs', 'revision_kind', 'jobs pin their revision purpose');
select has_column('public', 'engines', 'can_final_form', 'worker identities have separate final-form capability');
select has_table('public', 'provisional_form_coverage', 'live coverage is isolated from authoritative answers');
select has_table('public', 'form_reconciliation_conflicts', 'final reconciliation conflicts are explicit');
select ok(
  not has_table_privilege('authenticated', 'public.provisional_form_coverage', 'insert,update,delete'),
  'clients cannot promote or alter provisional coverage directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.form_reconciliation_conflicts', 'insert,update,delete'),
  'clients resolve conflicts only through the guarded RPC'
);

select * from finish();
rollback;
