-- Schema-v2 templates add bilingual labels and typed fields while preserving
-- every schema-v1 definition byte-for-byte. The immutable version row remains
-- the authority for which schema a consultation uses.

create function private.valid_form_i18n(p_value jsonb, p_max_length int) returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(p_value) = 'object'
    and jsonb_typeof(p_value -> 'en') = 'string'
    and jsonb_typeof(p_value -> 'sk') = 'string'
    and char_length(p_value ->> 'en') between 1 and p_max_length
    and char_length(p_value ->> 'sk') between 1 and p_max_length
    and not exists (
      select 1 from jsonb_object_keys(p_value) k where k not in ('en', 'sk')
    );
$$;

create function private.valid_form_option(p_option jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(p_option) = 'object'
    and coalesce(p_option ->> 'key', '') ~ '^[a-z][a-z0-9_]{0,39}$'
    and char_length(coalesce(p_option ->> 'label', '')) between 1 and 120
    and (
      not (p_option ? 'label_i18n')
      or private.valid_form_i18n(p_option -> 'label_i18n', 120)
    );
$$;

create function private.valid_form_item_field(p_field jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(p_field) = 'object'
    and coalesce(p_field ->> 'key', '') ~ '^[a-z][a-z0-9_]{0,39}$'
    and char_length(coalesce(p_field ->> 'label', '')) between 1 and 120
    and coalesce(p_field ->> 'value_type', '') in (
      'text', 'long_text', 'integer', 'decimal', 'date', 'boolean',
      'single_choice', 'multi_choice'
    )
    and (
      not (p_field ? 'label_i18n')
      or private.valid_form_i18n(p_field -> 'label_i18n', 120)
    )
    and (
      not (p_field ? 'required') or jsonb_typeof(p_field -> 'required') = 'boolean'
    )
    and (
      coalesce(p_field ->> 'value_type', '') not in ('single_choice', 'multi_choice')
      or (
        jsonb_typeof(p_field -> 'options') = 'array'
        and jsonb_array_length(p_field -> 'options') between 2 and 30
        and not exists (
          select 1 from jsonb_array_elements(p_field -> 'options') o
          where not private.valid_form_option(o)
        )
        and (
          select count(*) = count(distinct o ->> 'key')
          from jsonb_array_elements(p_field -> 'options') o
        )
      )
    );
$$;

create function private.valid_form_field(p_field jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(p_field) = 'object'
    and coalesce(p_field ->> 'key', '') ~ '^[a-z][a-z0-9_]{0,39}$'
    and char_length(coalesce(p_field ->> 'label', '')) between 1 and 120
    and coalesce(p_field ->> 'mode', 'extract') in ('extract', 'suggest', 'manual')
    and char_length(coalesce(p_field ->> 'hint', '')) <= 300
    and coalesce(p_field ->> 'value_type', 'text') in (
      'text', 'long_text', 'integer', 'decimal', 'date', 'boolean',
      'single_choice', 'multi_choice', 'repeater', 'attestation',
      'signature', 'attachment_reference'
    )
    and (
      not (p_field ? 'label_i18n')
      or private.valid_form_i18n(p_field -> 'label_i18n', 120)
    )
    and (
      not (p_field ? 'required') or jsonb_typeof(p_field -> 'required') = 'boolean'
    )
    and (
      not (p_field ? 'clinician_confirmation')
      or jsonb_typeof(p_field -> 'clinician_confirmation') = 'boolean'
    )
    and (
      coalesce(p_field ->> 'value_type', 'text') not in ('single_choice', 'multi_choice')
      or (
        jsonb_typeof(p_field -> 'options') = 'array'
        and jsonb_array_length(p_field -> 'options') between 2 and 30
        and not exists (
          select 1 from jsonb_array_elements(p_field -> 'options') o
          where not private.valid_form_option(o)
        )
        and (
          select count(*) = count(distinct o ->> 'key')
          from jsonb_array_elements(p_field -> 'options') o
        )
      )
    )
    and (
      coalesce(p_field ->> 'value_type', 'text') <> 'repeater'
      or (
        jsonb_typeof(p_field -> 'item_fields') = 'array'
        and jsonb_array_length(p_field -> 'item_fields') between 1 and 20
        and not exists (
          select 1 from jsonb_array_elements(p_field -> 'item_fields') i
          where not private.valid_form_item_field(i)
        )
        and (
          select count(*) = count(distinct i ->> 'key')
          from jsonb_array_elements(p_field -> 'item_fields') i
        )
      )
    )
    and (
      coalesce(p_field ->> 'value_type', 'text') not in ('attestation', 'signature')
      or coalesce(p_field ->> 'mode', 'extract') = 'manual'
    );
$$;

create or replace function private.valid_template(p jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
    and jsonb_typeof(p -> 'title') = 'string'
    and char_length(p ->> 'title') between 1 and 120
    and (
      not (p ? 'title_i18n') or private.valid_form_i18n(p -> 'title_i18n', 120)
    )
    and jsonb_typeof(p -> 'sections') = 'array'
    and jsonb_array_length(p -> 'sections') between 1 and 20
    and not exists (
      select 1 from jsonb_array_elements(p -> 'sections') s
      where jsonb_typeof(s -> 'title') is distinct from 'string'
         or char_length(s ->> 'title') not between 1 and 120
         or ((s ? 'key') and coalesce(s ->> 'key', '') !~ '^[a-z][a-z0-9_]{0,39}$')
         or ((s ? 'title_i18n') and not private.valid_form_i18n(s -> 'title_i18n', 120))
         or jsonb_typeof(s -> 'fields') is distinct from 'array'
         or jsonb_array_length(s -> 'fields') not between 1 and 40
    )
    and not exists (
      select 1
      from jsonb_array_elements(p -> 'sections') s,
           jsonb_array_elements(s -> 'fields') f
      where not private.valid_form_field(f)
    )
    and (
      select count(*) = count(distinct f ->> 'key')
      from jsonb_array_elements(p -> 'sections') s,
           jsonb_array_elements(s -> 'fields') f
    )
    and (
      not (p ? 'approval_gates')
      or (
        jsonb_typeof(p -> 'approval_gates') = 'array'
        and jsonb_array_length(p -> 'approval_gates') between 1 and 20
        and not exists (
          select 1 from jsonb_array_elements(p -> 'approval_gates') g
          where coalesce(g ->> 'key', '') !~ '^[a-z][a-z0-9_]{0,39}$'
             or coalesce(g ->> 'type', '') not in ('attestation', 'signature')
             or (
               g ->> 'type' = 'signature'
               and coalesce(g ->> 'signer_role', '') not in ('patient', 'practitioner')
             )
             or (g ->> 'type' = 'attestation' and g ? 'signer_role')
             or not exists (
               select 1
               from jsonb_array_elements(p -> 'sections') s,
                    jsonb_array_elements(s -> 'fields') f
               where f ->> 'key' = g ->> 'field_key'
                 and f ->> 'value_type' = g ->> 'type'
             )
        )
        and (
          select count(*) = count(distinct g ->> 'key')
          from jsonb_array_elements(p -> 'approval_gates') g
        )
      )
    );
$$;

create function private.massage_assessment_en_sk_form() returns jsonb
language sql immutable set search_path = ''
as $$
  select $form$
{
  "title": "Ayurvedic health & massage therapy assessment / Ajurvédske posúdenie a masážna terapia",
  "title_i18n": {
    "en": "Ayurvedic health & massage therapy assessment",
    "sk": "Ajurvédske posúdenie zdravotného stavu a masážna terapia"
  },
  "sections": [
    {
      "key": "patient_appointment",
      "title": "Patient & appointment / Pacient a konzultácia",
      "title_i18n": {"en": "Patient & appointment", "sk": "Pacient a konzultácia"},
      "fields": [
        {"key": "date_of_birth", "label": "Date of birth / Dátum narodenia", "label_i18n": {"en": "Date of birth", "sk": "Dátum narodenia"}, "value_type": "date"},
        {"key": "age", "label": "Age / Vek", "label_i18n": {"en": "Age", "sk": "Vek"}, "value_type": "integer"},
        {"key": "contact", "label": "Contact / Kontakt", "label_i18n": {"en": "Contact", "sk": "Kontakt"}, "value_type": "text"},
        {"key": "residence", "label": "Residence / Bydlisko", "label_i18n": {"en": "Residence", "sk": "Bydlisko"}, "value_type": "text"},
        {"key": "work", "label": "Work / Zamestnanie", "label_i18n": {"en": "Work", "sk": "Zamestnanie"}, "value_type": "long_text"},
        {"key": "consultation_mode", "label": "Consultation / Konzultácia", "label_i18n": {"en": "Consultation", "sk": "Konzultácia"}, "value_type": "single_choice", "options": [
          {"key": "online", "label": "Online / Online", "label_i18n": {"en": "Online", "sk": "Online"}},
          {"key": "in_person", "label": "In person / Osobne", "label_i18n": {"en": "In person", "sk": "Osobne"}}
        ]},
        {"key": "is_follow_up", "label": "Follow-up / Kontrola", "label_i18n": {"en": "Follow-up", "sk": "Kontrola"}, "value_type": "boolean"},
        {"key": "emergency_contact", "label": "Emergency contact / Núdzový kontakt", "label_i18n": {"en": "Emergency contact", "sk": "Núdzový kontakt"}, "value_type": "text"}
      ]
    },
    {
      "key": "reason_for_visit",
      "title": "Reason for visit / Dôvod návštevy",
      "title_i18n": {"en": "Reason for visit", "sk": "Dôvod návštevy"},
      "fields": [
        {"key": "main_concern", "label": "Main concern / Hlavný problém", "label_i18n": {"en": "Main concern", "sk": "Hlavný problém"}, "value_type": "long_text", "required": true},
        {"key": "patient_goals", "label": "Patient goals / Ciele pacienta", "label_i18n": {"en": "Patient goals", "sk": "Ciele pacienta"}, "value_type": "long_text"},
        {"key": "onset_course", "label": "Onset & course / Začiatok a priebeh", "label_i18n": {"en": "Onset & course", "sk": "Začiatok a priebeh"}, "value_type": "long_text"},
        {"key": "symptoms_triggers_relief", "label": "Symptoms, triggers, relief / Príznaky, zhoršenie, úľava", "label_i18n": {"en": "Symptoms, triggers, relief", "sk": "Príznaky, zhoršenie, úľava"}, "value_type": "long_text"},
        {"key": "daily_life_impact", "label": "Impact on daily life / Vplyv na bežný život", "label_i18n": {"en": "Impact on daily life", "sk": "Vplyv na bežný život"}, "value_type": "long_text"},
        {"key": "previous_assessment", "label": "Previous assessment or treatment / Predošlé vyšetrenia a liečba", "label_i18n": {"en": "Previous assessment or treatment", "sk": "Predošlé vyšetrenia a liečba"}, "value_type": "long_text"}
      ]
    },
    {
      "key": "medical_safety",
      "title": "Medical history & safety / Zdravotná anamnéza a bezpečnosť",
      "title_i18n": {"en": "Medical history & safety", "sk": "Zdravotná anamnéza a bezpečnosť"},
      "fields": [
        {"key": "diagnoses", "label": "Known diagnoses / Známe diagnózy", "label_i18n": {"en": "Known diagnoses and chronic conditions", "sk": "Známe diagnózy a chronické ochorenia"}, "value_type": "long_text"},
        {"key": "medications", "label": "Medication / Lieky", "label_i18n": {"en": "Medication", "sk": "Lieky"}, "value_type": "repeater", "item_fields": [
          {"key": "name", "label": "Name / Názov", "label_i18n": {"en": "Name", "sk": "Názov"}, "value_type": "text", "required": true},
          {"key": "dose", "label": "Dose / Dávka", "label_i18n": {"en": "Dose", "sk": "Dávka"}, "value_type": "text"},
          {"key": "timing", "label": "Timing / Časovanie", "label_i18n": {"en": "Timing", "sk": "Časovanie"}, "value_type": "text"}
        ]},
        {"key": "supplements", "label": "Herbs, supplements and self-treatment / Byliny, doplnky a samoliečba", "label_i18n": {"en": "Herbs, supplements and self-treatment", "sk": "Byliny, doplnky a samoliečba"}, "value_type": "long_text"},
        {"key": "allergies", "label": "Allergies / Alergie", "label_i18n": {"en": "Allergies to food, medicines, oils or herbs", "sk": "Alergie na potraviny, lieky, oleje alebo byliny"}, "value_type": "long_text"},
        {"key": "surgery_injury_hospital", "label": "Surgery, injury, hospitalization / Operácie, úrazy, hospitalizácie", "label_i18n": {"en": "Surgery, injury, hospitalization", "sk": "Operácie, úrazy, hospitalizácie"}, "value_type": "long_text"},
        {"key": "pregnancy", "label": "Pregnancy / Tehotenstvo", "label_i18n": {"en": "Pregnancy", "sk": "Tehotenstvo"}, "value_type": "single_choice", "options": [
          {"key": "yes", "label": "Yes / Áno", "label_i18n": {"en": "Yes", "sk": "Áno"}},
          {"key": "no", "label": "No / Nie", "label_i18n": {"en": "No", "sk": "Nie"}},
          {"key": "not_applicable", "label": "Not applicable / Netýka sa", "label_i18n": {"en": "Not applicable", "sk": "Netýka sa"}}
        ]},
        {"key": "acute_conditions", "label": "Recent fever, infection, skin lesions or wounds / Horúčka, infekcia, kožné lézie alebo rany", "label_i18n": {"en": "Recent fever, infection, skin lesions or wounds", "sk": "Horúčka, infekcia, kožné lézie alebo rany"}, "value_type": "long_text"},
        {"key": "bleeding_thrombosis", "label": "Thrombosis, bleeding disorder or anticoagulants / Trombóza, krvácanie alebo antikoagulanciá", "label_i18n": {"en": "Thrombosis, bleeding disorder or anticoagulants", "sk": "Trombóza, porucha krvácania alebo antikoagulanciá"}, "value_type": "long_text"},
        {"key": "other_conditions", "label": "Other relevant conditions / Iné relevantné ochorenia", "label_i18n": {"en": "Other relevant conditions", "sk": "Iné relevantné ochorenia"}, "value_type": "long_text"},
        {"key": "red_flag_result", "label": "Red-flag screen / Varovné príznaky", "label_i18n": {"en": "Red-flag screen result", "sk": "Výsledok kontroly varovných príznakov"}, "mode": "manual", "value_type": "single_choice", "required": true, "clinician_confirmation": true, "options": [
          {"key": "no_concern", "label": "No concern / Bez obáv", "label_i18n": {"en": "No concern", "sk": "Bez obáv"}},
          {"key": "concern", "label": "Concern / Obavy", "label_i18n": {"en": "Concern", "sk": "Obavy"}}
        ]},
        {"key": "red_flag_action", "label": "Action / Postup", "label_i18n": {"en": "Action", "sk": "Postup"}, "mode": "manual", "value_type": "single_choice", "required": true, "clinician_confirmation": true, "options": [
          {"key": "proceed", "label": "Proceed / Pokračovať", "label_i18n": {"en": "Proceed", "sk": "Pokračovať"}},
          {"key": "defer", "label": "Defer therapy / Odložiť terapiu", "label_i18n": {"en": "Defer therapy", "sk": "Odložiť terapiu"}},
          {"key": "refer", "label": "Refer / Odoslať", "label_i18n": {"en": "Refer", "sk": "Odoslať"}}
        ]},
        {"key": "referral_details", "label": "Referral reason and date / Dôvod a dátum odporúčania", "label_i18n": {"en": "Referral reason and date", "sk": "Dôvod a dátum odporúčania"}, "mode": "manual", "value_type": "long_text"},
        {"key": "red_flag_screen_confirmed", "label": "Clinician red-flag review / Kontrola varovných príznakov lekárom", "label_i18n": {"en": "I reviewed the red-flag screen and disposition", "sk": "Skontroloval/a som varovné príznaky a zvolený postup"}, "mode": "manual", "value_type": "attestation", "required": true}
      ]
    },
    {
      "key": "lifestyle",
      "title": "Lifestyle questionnaire / Dotazník životného štýlu",
      "title_i18n": {"en": "Lifestyle questionnaire", "sk": "Dotazník životného štýlu"},
      "fields": [
        {"key": "diet_meal_pattern", "label": "Diet and meal pattern / Strava a pravidelnosť jedál", "label_i18n": {"en": "Diet and meal pattern", "sk": "Strava a pravidelnosť jedál"}, "value_type": "long_text"},
        {"key": "digestion", "label": "Appetite and digestion / Chuť do jedla a trávenie", "label_i18n": {"en": "Appetite, digestion, reflux and bloating", "sk": "Chuť do jedla, trávenie, reflux a nadúvanie"}, "value_type": "long_text"},
        {"key": "bowel_movements", "label": "Bowel movements / Vyprázdňovanie", "label_i18n": {"en": "Bowel movements and stool form", "sk": "Vyprázdňovanie a typ stolice"}, "value_type": "long_text"},
        {"key": "hydration", "label": "Hydration / Pitný režim", "label_i18n": {"en": "Hydration", "sk": "Pitný režim"}, "value_type": "long_text"},
        {"key": "sleep", "label": "Sleep / Spánok", "label_i18n": {"en": "Sleep duration and quality", "sk": "Dĺžka a kvalita spánku"}, "value_type": "long_text"},
        {"key": "energy_stress_mood", "label": "Energy, stress and mood / Energia, stres a nálada", "label_i18n": {"en": "Energy, stress and mood", "sk": "Energia, stres a nálada"}, "value_type": "long_text"},
        {"key": "activity_mobility", "label": "Physical activity and mobility / Pohyb a mobilita", "label_i18n": {"en": "Physical activity and mobility", "sk": "Pohyb a mobilita"}, "value_type": "long_text"},
        {"key": "menstrual_cycle", "label": "Menstrual cycle / Menštruačný cyklus", "label_i18n": {"en": "Menstrual cycle, if relevant", "sk": "Menštruačný cyklus, ak relevantné"}, "value_type": "long_text"},
        {"key": "children_history", "label": "Children / Deti", "label_i18n": {"en": "Children, relevant history only", "sk": "Deti, iba relevantná anamnéza"}, "value_type": "long_text"},
        {"key": "routine_work_demands", "label": "Daily routine and work demands / Denný režim a pracovná záťaž", "label_i18n": {"en": "Daily routine and work demands", "sk": "Denný režim a pracovná záťaž"}, "value_type": "long_text"}
      ]
    },
    {
      "key": "symptom_function",
      "title": "Symptom map & functional assessment / Mapa príznakov a funkčné posúdenie",
      "title_i18n": {"en": "Symptom map & functional assessment", "sk": "Mapa príznakov a funkčné posúdenie"},
      "fields": [
        {"key": "body_chart", "label": "Annotated body chart / Označená mapa tela", "label_i18n": {"en": "Annotated body chart", "sk": "Označená mapa tela"}, "mode": "manual", "value_type": "attachment_reference"},
        {"key": "symptom_entries", "label": "Symptoms / Príznaky", "label_i18n": {"en": "Symptoms", "sk": "Príznaky"}, "value_type": "repeater", "item_fields": [
          {"key": "location", "label": "Location / Lokalizácia", "label_i18n": {"en": "Location", "sk": "Lokalizácia"}, "value_type": "text", "required": true},
          {"key": "side", "label": "Side / Strana", "label_i18n": {"en": "Side", "sk": "Strana"}, "value_type": "single_choice", "options": [
            {"key": "left", "label": "Left / Ľavá", "label_i18n": {"en": "Left", "sk": "Ľavá"}},
            {"key": "right", "label": "Right / Pravá", "label_i18n": {"en": "Right", "sk": "Pravá"}},
            {"key": "both", "label": "Both / Obe", "label_i18n": {"en": "Both", "sk": "Obe"}}
          ]},
          {"key": "symptom_type", "label": "Symptom type / Typ príznaku", "label_i18n": {"en": "Symptom type", "sk": "Typ príznaku"}, "value_type": "multi_choice", "options": [
            {"key": "pain", "label": "Pain / Bolesť", "label_i18n": {"en": "Pain", "sk": "Bolesť"}},
            {"key": "stiffness", "label": "Stiffness / Stuhnutosť", "label_i18n": {"en": "Stiffness", "sk": "Stuhnutosť"}},
            {"key": "tingling", "label": "Tingling / Mravčenie", "label_i18n": {"en": "Tingling", "sk": "Mravčenie"}},
            {"key": "swelling", "label": "Swelling / Opuch", "label_i18n": {"en": "Swelling", "sk": "Opuch"}},
            {"key": "other", "label": "Other / Iné", "label_i18n": {"en": "Other", "sk": "Iné"}}
          ]},
          {"key": "intensity", "label": "Intensity 0–10 / Intenzita 0–10", "label_i18n": {"en": "Intensity 0–10", "sk": "Intenzita 0–10"}, "value_type": "integer"},
          {"key": "frequency", "label": "Frequency / Frekvencia", "label_i18n": {"en": "Frequency", "sk": "Frekvencia"}, "value_type": "text"},
          {"key": "duration", "label": "Duration / Trvanie", "label_i18n": {"en": "Duration", "sk": "Trvanie"}, "value_type": "text"},
          {"key": "functional_limit", "label": "Functional limitation / Funkčné obmedzenie", "label_i18n": {"en": "Functional limitation", "sk": "Funkčné obmedzenie"}, "value_type": "long_text"},
          {"key": "baseline_goal", "label": "Baseline goal / Východiskový cieľ", "label_i18n": {"en": "Baseline goal", "sk": "Východiskový cieľ"}, "value_type": "long_text"}
        ]}
      ]
    },
    {
      "key": "ayurvedic_assessment",
      "title": "Traditional Ayurvedic assessment / Tradičné ajurvédske posúdenie",
      "title_i18n": {"en": "Traditional Ayurvedic assessment", "sk": "Tradičné ajurvédske posúdenie"},
      "fields": [
        {"key": "prakriti", "label": "Prakriti / Prakriti", "label_i18n": {"en": "Prakriti", "sk": "Prakriti"}, "mode": "suggest", "value_type": "single_choice", "clinician_confirmation": true, "options": [
          {"key": "vata", "label": "Vata", "label_i18n": {"en": "Vata", "sk": "Vata"}},
          {"key": "pitta", "label": "Pitta", "label_i18n": {"en": "Pitta", "sk": "Pitta"}},
          {"key": "kapha", "label": "Kapha", "label_i18n": {"en": "Kapha", "sk": "Kapha"}},
          {"key": "mixed", "label": "Mixed / Zmiešaná", "label_i18n": {"en": "Mixed", "sk": "Zmiešaná"}},
          {"key": "undetermined", "label": "Undetermined / Neurčená", "label_i18n": {"en": "Undetermined", "sk": "Neurčená"}}
        ]},
        {"key": "vikriti", "label": "Vikriti / Vikriti", "label_i18n": {"en": "Vikriti", "sk": "Vikriti"}, "mode": "suggest", "value_type": "long_text", "clinician_confirmation": true},
        {"key": "agni", "label": "Agni / Agni", "label_i18n": {"en": "Agni", "sk": "Agni"}, "mode": "suggest", "value_type": "single_choice", "clinician_confirmation": true, "options": [
          {"key": "sama", "label": "Sama", "label_i18n": {"en": "Sama", "sk": "Sama"}},
          {"key": "vishama", "label": "Vishama", "label_i18n": {"en": "Vishama", "sk": "Vishama"}},
          {"key": "tikshna", "label": "Tikshna", "label_i18n": {"en": "Tikshna", "sk": "Tikshna"}},
          {"key": "manda", "label": "Manda", "label_i18n": {"en": "Manda", "sk": "Manda"}},
          {"key": "undetermined", "label": "Undetermined / Neurčený", "label_i18n": {"en": "Undetermined", "sk": "Neurčený"}}
        ]},
        {"key": "koshta", "label": "Koshta / Kóštha", "label_i18n": {"en": "Koshta", "sk": "Kóštha"}, "mode": "suggest", "value_type": "single_choice", "clinician_confirmation": true, "options": [
          {"key": "mridu", "label": "Mridu", "label_i18n": {"en": "Mridu", "sk": "Mridu"}},
          {"key": "madhyama", "label": "Madhyama", "label_i18n": {"en": "Madhyama", "sk": "Madhyama"}},
          {"key": "krura", "label": "Krura", "label_i18n": {"en": "Krura", "sk": "Krura"}},
          {"key": "undetermined", "label": "Undetermined / Neurčená", "label_i18n": {"en": "Undetermined", "sk": "Neurčená"}}
        ]},
        {"key": "ama_indicators", "label": "Ama indicators / Znaky ámy", "label_i18n": {"en": "Ama indicators", "sk": "Znaky ámy"}, "mode": "suggest", "value_type": "long_text", "clinician_confirmation": true},
        {"key": "tongue", "label": "Tongue / Jazyk", "label_i18n": {"en": "Tongue, if visually assessed", "sk": "Jazyk, ak bol vizuálne posúdený"}, "mode": "manual", "value_type": "long_text"},
        {"key": "other_observations", "label": "Other observations / Ďalšie pozorovania", "label_i18n": {"en": "Other observations", "sk": "Ďalšie pozorovania"}, "mode": "manual", "value_type": "long_text"},
        {"key": "assessment_basis", "label": "Assessment basis / Podklad posúdenia", "label_i18n": {"en": "Assessment basis", "sk": "Podklad posúdenia"}, "mode": "manual", "value_type": "multi_choice", "options": [
          {"key": "patient_report", "label": "Patient report / Údaje pacienta", "label_i18n": {"en": "Patient report", "sk": "Údaje pacienta"}},
          {"key": "video", "label": "Video observation / Pozorovanie cez video", "label_i18n": {"en": "Video observation", "sk": "Pozorovanie cez video"}},
          {"key": "in_person", "label": "In person / Osobne", "label_i18n": {"en": "In person", "sk": "Osobne"}}
        ]}
      ]
    },
    {
      "key": "massage_session",
      "title": "Massage therapy suitability & session / Vhodnosť masáže a záznam terapie",
      "title_i18n": {"en": "Massage therapy suitability & session", "sk": "Vhodnosť masáže a záznam terapie"},
      "fields": [
        {"key": "treatment_suitability", "label": "Treatment suitability / Vhodnosť terapie", "label_i18n": {"en": "Treatment suitability", "sk": "Vhodnosť terapie"}, "mode": "manual", "value_type": "single_choice", "required": true, "clinician_confirmation": true, "options": [
          {"key": "suitable", "label": "Suitable / Vhodná", "label_i18n": {"en": "Suitable", "sk": "Vhodná"}},
          {"key": "modified", "label": "Modified / Upravená", "label_i18n": {"en": "Modified", "sk": "Upravená"}},
          {"key": "deferred", "label": "Deferred / Odložená", "label_i18n": {"en": "Deferred", "sk": "Odložená"}}
        ]},
        {"key": "contraindications", "label": "Contraindications and precautions / Kontraindikácie a opatrenia", "label_i18n": {"en": "Contraindications and precautions", "sk": "Kontraindikácie a opatrenia"}, "mode": "manual", "value_type": "long_text"},
        {"key": "areas_to_avoid", "label": "Areas to avoid / Oblasti, ktorým sa vyhnúť", "label_i18n": {"en": "Areas to avoid", "sk": "Oblasti, ktorým sa vyhnúť"}, "mode": "manual", "value_type": "long_text"},
        {"key": "treatment", "label": "Treatment / Terapia", "label_i18n": {"en": "Treatment", "sk": "Terapia"}, "mode": "manual", "value_type": "multi_choice", "options": [
          {"key": "abhyanga", "label": "Abhyanga", "label_i18n": {"en": "Abhyanga", "sk": "Abhyanga"}},
          {"key": "local_massage", "label": "Local massage / Lokálna masáž", "label_i18n": {"en": "Local massage", "sk": "Lokálna masáž"}},
          {"key": "other", "label": "Other / Iná", "label_i18n": {"en": "Other", "sk": "Iná"}}
        ]},
        {"key": "oil_product", "label": "Oil, product and ingredients / Olej, produkt a zloženie", "label_i18n": {"en": "Oil, product and ingredients", "sk": "Olej, produkt a zloženie"}, "mode": "manual", "value_type": "long_text"},
        {"key": "areas_technique", "label": "Areas and technique / Oblasti a technika", "label_i18n": {"en": "Areas and technique", "sk": "Oblasti a technika"}, "mode": "manual", "value_type": "long_text"},
        {"key": "pressure", "label": "Pressure / Tlak", "label_i18n": {"en": "Pressure", "sk": "Tlak"}, "mode": "manual", "value_type": "single_choice", "options": [
          {"key": "light", "label": "Light / Jemný", "label_i18n": {"en": "Light", "sk": "Jemný"}},
          {"key": "moderate", "label": "Moderate / Stredný", "label_i18n": {"en": "Moderate", "sk": "Stredný"}},
          {"key": "not_applicable", "label": "Not applicable / Netýka sa", "label_i18n": {"en": "Not applicable", "sk": "Netýka sa"}}
        ]},
        {"key": "duration_minutes", "label": "Duration in minutes / Trvanie v minútach", "label_i18n": {"en": "Duration in minutes", "sk": "Trvanie v minútach"}, "mode": "manual", "value_type": "integer"},
        {"key": "pain_before", "label": "Pain before 0–10 / Bolesť pred 0–10", "label_i18n": {"en": "Pain before 0–10", "sk": "Bolesť pred 0–10"}, "mode": "manual", "value_type": "integer"},
        {"key": "pain_after", "label": "Pain after 0–10 / Bolesť po 0–10", "label_i18n": {"en": "Pain after 0–10", "sk": "Bolesť po 0–10"}, "mode": "manual", "value_type": "integer"},
        {"key": "tolerance_adverse", "label": "Tolerance and adverse effects / Tolerancia a nežiaduce účinky", "label_i18n": {"en": "Tolerance and adverse effects", "sk": "Tolerancia a nežiaduce účinky"}, "mode": "manual", "value_type": "long_text"},
        {"key": "suitability_confirmed", "label": "Clinician suitability confirmation / Potvrdenie vhodnosti terapie", "label_i18n": {"en": "I confirmed treatment suitability and precautions", "sk": "Potvrdil/a som vhodnosť terapie a opatrenia"}, "mode": "manual", "value_type": "attestation", "required": true}
      ]
    },
    {
      "key": "care_plan",
      "title": "Individual care plan / Individuálny plán starostlivosti",
      "title_i18n": {"en": "Individual care plan", "sk": "Individuálny plán starostlivosti"},
      "fields": [
        {"key": "recommended_therapies", "label": "Recommended therapies / Odporúčané terapie", "label_i18n": {"en": "Recommended therapies", "sk": "Odporúčané terapie"}, "value_type": "long_text"},
        {"key": "individual_programme", "label": "Individual programme / Individuálny program", "label_i18n": {"en": "Individual programme", "sk": "Individuálny program"}, "value_type": "long_text"},
        {"key": "morning_rituals", "label": "Morning rituals / Ranné rituály", "label_i18n": {"en": "Morning rituals", "sk": "Ranné rituály"}, "value_type": "long_text"},
        {"key": "drinking_routine", "label": "Drinking routine / Pitný režim", "label_i18n": {"en": "Drinking routine", "sk": "Pitný režim"}, "value_type": "long_text"},
        {"key": "general_recommendations", "label": "General recommendations / Všeobecné odporúčania", "label_i18n": {"en": "General recommendations", "sk": "Všeobecné odporúčania"}, "value_type": "long_text"},
        {"key": "dietary_advice", "label": "Dietary advice and restrictions / Stravovacie odporúčania a obmedzenia", "label_i18n": {"en": "Dietary advice and restrictions", "sk": "Stravovacie odporúčania a obmedzenia"}, "value_type": "long_text"},
        {"key": "yoga_recommendations", "label": "Yoga recommendations / Odporúčania na jogu", "label_i18n": {"en": "Yoga recommendations", "sk": "Odporúčania na jogu"}, "value_type": "long_text"},
        {"key": "exercise_activity", "label": "Exercise and activity / Cvičenie a pohyb", "label_i18n": {"en": "Exercise and activity", "sk": "Cvičenie a pohyb"}, "value_type": "long_text"},
        {"key": "herbal_products", "label": "Herbal products / Bylinné prípravky", "label_i18n": {"en": "Herbal products, dose, cautions and interactions", "sk": "Bylinné prípravky, dávka, upozornenia a interakcie"}, "value_type": "long_text"},
        {"key": "other_plan", "label": "Other / Ostatné", "label_i18n": {"en": "Other", "sk": "Ostatné"}, "value_type": "long_text"},
        {"key": "programme_days", "label": "Programme duration in days / Trvanie programu v dňoch", "label_i18n": {"en": "Programme duration in days", "sk": "Trvanie programu v dňoch"}, "value_type": "integer"},
        {"key": "agreed_goals", "label": "Agreed patient goals / Dohodnuté ciele", "label_i18n": {"en": "Agreed patient goals", "sk": "Dohodnuté ciele"}, "value_type": "long_text"},
        {"key": "safety_advice", "label": "Safety advice / Bezpečnostné odporúčania", "label_i18n": {"en": "Safety advice", "sk": "Bezpečnostné odporúčania"}, "value_type": "long_text", "clinician_confirmation": true},
        {"key": "review_date", "label": "Review date / Termín kontroly", "label_i18n": {"en": "Review date", "sk": "Termín kontroly"}, "value_type": "date"}
      ]
    },
    {
      "key": "follow_up",
      "title": "Follow-up / Kontrolné vyšetrenie",
      "title_i18n": {"en": "Follow-up", "sk": "Kontrolné vyšetrenie"},
      "fields": [
        {"key": "follow_up_date", "label": "Follow-up date / Dátum kontroly", "label_i18n": {"en": "Follow-up date", "sk": "Dátum kontroly"}, "value_type": "date"},
        {"key": "baseline_score", "label": "Baseline symptom score / Východiskové skóre príznaku", "label_i18n": {"en": "Baseline symptom score", "sk": "Východiskové skóre príznaku"}, "value_type": "integer"},
        {"key": "current_score", "label": "Current symptom score / Aktuálne skóre príznaku", "label_i18n": {"en": "Current symptom score", "sk": "Aktuálne skóre príznaku"}, "value_type": "integer"},
        {"key": "function_sleep", "label": "Function and sleep / Funkčnosť a spánok", "label_i18n": {"en": "Function and sleep", "sk": "Funkčnosť a spánok"}, "value_type": "long_text"},
        {"key": "adherence", "label": "Adherence / Dodržiavanie odporúčaní", "label_i18n": {"en": "Adherence", "sk": "Dodržiavanie odporúčaní"}, "value_type": "long_text"},
        {"key": "benefit_adverse", "label": "Benefit and adverse reactions / Prínos a nežiaduce reakcie", "label_i18n": {"en": "Benefit and adverse reactions", "sk": "Prínos a nežiaduce reakcie"}, "value_type": "long_text"},
        {"key": "updated_plan", "label": "Updated plan / Upravený plán", "label_i18n": {"en": "Updated plan", "sk": "Upravený plán"}, "value_type": "long_text"},
        {"key": "next_review", "label": "Next review / Ďalšia kontrola", "label_i18n": {"en": "Next review", "sk": "Ďalšia kontrola"}, "value_type": "date"}
      ]
    },
    {
      "key": "consent_signoff",
      "title": "Consent, privacy & sign-off / Súhlas, súkromie a podpis",
      "title_i18n": {"en": "Consent, privacy & sign-off", "sk": "Súhlas, súkromie a podpis"},
      "fields": [
        {"key": "wellness_limits_confirmed", "label": "Ayurvedic wellness limitations understood / Obmedzenia ajurvédskeho poradenstva boli pochopené", "label_i18n": {"en": "Patient understands the nature and limitations of Ayurvedic wellness advice and remote assessment", "sk": "Pacient rozumie povahe a obmedzeniam ajurvédskeho poradenstva a online posúdenia"}, "mode": "manual", "value_type": "attestation", "required": true},
        {"key": "massage_consent_confirmed", "label": "Massage consent discussed / Súhlas s masážou bol prediskutovaný", "label_i18n": {"en": "Massage procedure, risks, alternatives and permission were discussed", "sk": "Postup masáže, riziká, alternatívy a súhlas boli prediskutované"}, "mode": "manual", "value_type": "attestation", "required": true},
        {"key": "privacy_confirmed", "label": "Privacy notice provided / Informácie o ochrane osobných údajov boli poskytnuté", "label_i18n": {"en": "Privacy notice and health-data handling information were provided", "sk": "Informácie o ochrane osobných údajov a spracovaní zdravotných údajov boli poskytnuté"}, "mode": "manual", "value_type": "attestation", "required": true},
        {"key": "patient_confirmation", "label": "Patient confirmation / Potvrdenie pacienta", "label_i18n": {"en": "Patient confirmation", "sk": "Potvrdenie pacienta"}, "mode": "manual", "value_type": "signature"},
        {"key": "professional_role", "label": "Professional role / Profesijná rola", "label_i18n": {"en": "Professional role", "sk": "Profesijná rola"}, "mode": "manual", "value_type": "text", "required": true},
        {"key": "practitioner_signoff", "label": "Practitioner signature / Podpis poskytovateľa", "label_i18n": {"en": "Practitioner signature", "sk": "Podpis poskytovateľa"}, "mode": "manual", "value_type": "signature", "required": true}
      ]
    }
  ],
  "approval_gates": [
    {"key": "red_flag_review", "type": "attestation", "field_key": "red_flag_screen_confirmed"},
    {"key": "suitability_review", "type": "attestation", "field_key": "suitability_confirmed"},
    {"key": "wellness_limits", "type": "attestation", "field_key": "wellness_limits_confirmed"},
    {"key": "massage_consent", "type": "attestation", "field_key": "massage_consent_confirmed"},
    {"key": "privacy_notice", "type": "attestation", "field_key": "privacy_confirmed"},
    {"key": "practitioner_signature", "type": "signature", "field_key": "practitioner_signoff", "signer_role": "practitioner"}
  ]
}
$form$::jsonb;
$$;

insert into public.form_template_versions (
  template_key, version_number, schema_version, definition, is_built_in, origin
) values (
  'massage_assessment_en_sk', 1, 2,
  private.massage_assessment_en_sk_form(), true, 'built_in'
);

revoke all on function
  private.valid_form_i18n(jsonb, int),
  private.valid_form_option(jsonb),
  private.valid_form_item_field(jsonb),
  private.valid_form_field(jsonb),
  private.massage_assessment_en_sk_form()
from public, anon, authenticated, service_role;
