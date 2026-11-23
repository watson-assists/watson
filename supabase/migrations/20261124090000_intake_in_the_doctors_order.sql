-- The intake in the order of the doctor's own sheet (owner's test team, 23 November 2026: "make the
-- order to fit this form", Dr. Robin's Excel, and "add height and weight to the questionnaire").
--
-- About the patient (now with height and weight), the sheet's questionnaire in its own order with
-- Watson's extra questions beside their kin, health history, the present condition, then the
-- doctor's part: assessment, recommendation and the general instructions of the sheet's second page.
-- Every question of the earlier form is still asked, under the same key, so dated values and the
-- spellings learned carry over. Watson works out the BMI from height and weight on the page.
--
-- Two built-in forms: Watson's in English (version 2) and its Slovak and English twin. Consultations
-- already made keep the form they were made with; new ones get the new version.

create or replace function private.watson_form() returns jsonb
language sql immutable set search_path = ''
as $$
  select $form$
{"title": "Ayurvedic consultation", "sections": [
 {"title": "About the patient", "fields": [
  {"key": "age", "label": "Age", "hint": "Age in years, as the patient said it."},
  {"key": "height", "label": "Height", "hint": "The patient's height, as they said it, like 172 cm."},
  {"key": "weight", "label": "Weight", "hint": "The patient's weight, as they said it, like 68 kg."},
  {"key": "place_of_living", "label": "Place of living", "hint": "Town or city where the patient lives."},
  {"key": "work", "label": "Work", "hint": "What the patient does for a living, and how demanding it is: hours, shifts, sitting or physical work."}
 ]},
 {"title": "Questionnaire", "fields": [
  {"key": "diet", "label": "Diet", "hint": "What and when the patient eats now: meals, snacks, cravings, cold or raw food, eating late. Not the practitioner's advice."},
  {"key": "habits", "label": "Drinks, coffee, alcohol and smoking", "hint": "Water and other drinks, tea, coffee, alcohol and smoking: what and how much."},
  {"key": "digestion", "label": "Appetite and digestion", "hint": "Hunger, bloating, gas, acidity or heaviness after meals."},
  {"key": "bowel_movements", "label": "Bowel movements", "hint": "How often, and whether hard, loose or regular."},
  {"key": "sleep", "label": "Sleep", "hint": "Falling asleep, waking at night, hours slept, and how rested the patient feels in the morning."},
  {"key": "energy_mood", "label": "Energy, mood and stress", "hint": "Energy through the day, mood, worry, stress and how the patient copes."},
  {"key": "activity", "label": "Exercise and movement", "hint": "Walking, sport, yoga or other movement, and how often."},
  {"key": "menstrual_cycle", "label": "Menstrual cycle", "hint": "Regularity, pain, flow, or menopause, if the patient spoke about it."},
  {"key": "pregnancy_children", "label": "Pregnancy and children", "hint": "Pregnancy, breastfeeding, births and children, if the patient spoke about it."},
  {"key": "allergies", "label": "Allergies and intolerances", "hint": "Allergies, food intolerances and bad reactions to medicines or foods."},
  {"key": "operations", "label": "Operations and hospital stays", "hint": "Operations and stays in hospital, with years when said."}
 ]},
 {"title": "Health history", "fields": [
  {"key": "conditions", "label": "Diagnosed conditions", "hint": "Illnesses diagnosed by doctors, past and present."},
  {"key": "medicines", "label": "Medicines and supplements", "hint": "Every medicine, herb and supplement the patient takes, with dose and timing when said."},
  {"key": "family_history", "label": "Family history", "hint": "Illnesses of the patient's parents, brothers, sisters or children."}
 ]},
 {"title": "Present condition", "fields": [
  {"key": "main_concern", "label": "Main concern", "hint": "What the patient wants help with, in their own words."},
  {"key": "history_of_concern", "label": "Since when, and how it has changed", "hint": "When it began, how often it happens, and how it has developed."},
  {"key": "better_worse", "label": "What makes it better or worse", "hint": "Foods, times of day, seasons, stress or activities that ease or worsen it."},
  {"key": "tried_so_far", "label": "Tried so far", "hint": "Treatments, doctors, therapies or remedies the patient already tried for the main concern, and how they worked. Not medicines taken every day for other conditions."},
  {"key": "goals", "label": "What the patient hopes for", "hint": "What the patient wants to achieve with this treatment."}
 ]},
 {"title": "Assessment", "fields": [
  {"key": "assessment", "label": "Assessment", "mode": "suggest", "hint": "The practitioner's diagnosis of the present condition."},
  {"key": "constitution", "label": "Constitution (Prakriti)", "mode": "suggest", "hint": "The patient's lifelong balance of the doshas, from what the patient described."},
  {"key": "imbalance", "label": "Current imbalance (Vikriti)", "mode": "suggest", "hint": "Which dosha is out of balance now, and the signs of it in what the patient described."},
  {"key": "agni_ama", "label": "Digestive fire and toxins (Agni, Ama)", "mode": "suggest", "hint": "The state of digestion and any signs of ama, from what the patient described."},
  {"key": "safety", "label": "Safety notes", "mode": "suggest", "hint": "Warning signs that need a medical doctor, and herbs that may not suit the medicines, pregnancy or conditions named. Leave empty if there are none."}
 ]},
 {"title": "Recommendation", "fields": [
  {"key": "therapies", "label": "Therapies", "hint": "Therapies the practitioner recommended, such as Abhyanga or Shirodhara, with how often."},
  {"key": "programme", "label": "Individual programme", "hint": "Only if the practitioner named an individual programme: whether it was agreed, and for how many days. Not the review date."},
  {"key": "review", "label": "Review", "hint": "When the patient should come back, or the date of the next consultation."},
  {"key": "referral", "label": "Referral or tests", "hint": "A doctor, specialist or tests the practitioner suggested. Leave empty if none."}
 ]},
 {"title": "General instructions", "fields": [
  {"key": "daily_routine", "label": "Daily routine", "hint": "Morning rituals, drinking routine, bedtime and other daily habits the practitioner recommended."},
  {"key": "diet_plan", "label": "Food to favour and to avoid", "hint": "Foods, drinks and meal times the practitioner recommended or advised against."},
  {"key": "yoga_breathing", "label": "Yoga, breathing and meditation", "hint": "Yoga poses, pranayama or meditation the practitioner recommended."},
  {"key": "exercise", "label": "Exercise", "hint": "Exercise or movement the practitioner recommended."},
  {"key": "herbs", "label": "Herbs and supplements", "hint": "Each herb, remedy or supplement the practitioner recommended, with dose, timing and for how long."}
 ]},
 {"title": "For you only", "fields": [
  {"key": "private_notes", "label": "Private notes", "mode": "manual", "hint": "Your own notes. Watson never fills this in, and it is never shared with the patient."}
 ]}
]}
$form$::jsonb;
$$;
revoke all on function private.watson_form() from public, anon, authenticated, service_role;

insert into public.form_template_versions (template_key, version_number, schema_version, definition, is_built_in, origin)
values ('watson_standard', 2, 1, private.watson_form(), true, 'built_in'),
       ('watson_standard_sk_en', 1, 1, $form$
{"title": "Ajurvédska konzultácia / Ayurvedic consultation", "title_i18n": {"en": "Ayurvedic consultation", "sk": "Ajurvédska konzultácia"}, "sections": [
 {"title": "O pacientovi / About the patient", "fields": [
  {"key": "age", "label": "Vek / Age", "hint": "Age in years, as the patient said it."},
  {"key": "height", "label": "Výška / Height", "hint": "The patient's height, as they said it, like 172 cm."},
  {"key": "weight", "label": "Hmotnosť / Weight", "hint": "The patient's weight, as they said it, like 68 kg."},
  {"key": "place_of_living", "label": "Bydlisko / Place of living", "hint": "Town or city where the patient lives."},
  {"key": "work", "label": "Zamestnanie / Work", "hint": "What the patient does for a living, and how demanding it is: hours, shifts, sitting or physical work."}
 ]},
 {"title": "Dotazník / Questionnaire", "fields": [
  {"key": "diet", "label": "Strava / Diet", "hint": "What and when the patient eats now: meals, snacks, cravings, cold or raw food, eating late. Not the practitioner's advice."},
  {"key": "habits", "label": "Nápoje, káva, alkohol a fajčenie / Drinks, coffee, alcohol and smoking", "hint": "Water and other drinks, tea, coffee, alcohol and smoking: what and how much."},
  {"key": "digestion", "label": "Chuť do jedla a trávenie / Appetite and digestion", "hint": "Hunger, bloating, gas, acidity or heaviness after meals."},
  {"key": "bowel_movements", "label": "Vyprázdňovanie / Bowel movements", "hint": "How often, and whether hard, loose or regular."},
  {"key": "sleep", "label": "Spánok / Sleep", "hint": "Falling asleep, waking at night, hours slept, and how rested the patient feels in the morning."},
  {"key": "energy_mood", "label": "Energia, nálada a stres / Energy, mood and stress", "hint": "Energy through the day, mood, worry, stress and how the patient copes."},
  {"key": "activity", "label": "Pohyb a cvičenie / Exercise and movement", "hint": "Walking, sport, yoga or other movement, and how often."},
  {"key": "menstrual_cycle", "label": "Menštruačný cyklus / Menstrual cycle", "hint": "Regularity, pain, flow, or menopause, if the patient spoke about it."},
  {"key": "pregnancy_children", "label": "Tehotenstvo a deti / Pregnancy and children", "hint": "Pregnancy, breastfeeding, births and children, if the patient spoke about it."},
  {"key": "allergies", "label": "Alergie a intolerancie / Allergies and intolerances", "hint": "Allergies, food intolerances and bad reactions to medicines or foods."},
  {"key": "operations", "label": "Zdravotné operácie a hospitalizácie / Operations and hospital stays", "hint": "Operations and stays in hospital, with years when said."}
 ]},
 {"title": "Zdravotná anamnéza / Health history", "fields": [
  {"key": "conditions", "label": "Diagnostikované ochorenia / Diagnosed conditions", "hint": "Illnesses diagnosed by doctors, past and present."},
  {"key": "medicines", "label": "Lieky a doplnky výživy / Medicines and supplements", "hint": "Every medicine, herb and supplement the patient takes, with dose and timing when said."},
  {"key": "family_history", "label": "Rodinná anamnéza / Family history", "hint": "Illnesses of the patient's parents, brothers, sisters or children."}
 ]},
 {"title": "Aktuálny zdravotný stav / Present condition", "fields": [
  {"key": "main_concern", "label": "Hlavný problém / Main concern", "hint": "What the patient wants help with, in their own words."},
  {"key": "history_of_concern", "label": "Odkedy a ako sa vyvíja / Since when, and how it has changed", "hint": "When it began, how often it happens, and how it has developed."},
  {"key": "better_worse", "label": "Čo pomáha a čo zhoršuje / What makes it better or worse", "hint": "Foods, times of day, seasons, stress or activities that ease or worsen it."},
  {"key": "tried_so_far", "label": "Doteraz vyskúšané / Tried so far", "hint": "Treatments, doctors, therapies or remedies the patient already tried for the main concern, and how they worked. Not medicines taken every day for other conditions."},
  {"key": "goals", "label": "Čo pacient očakáva / What the patient hopes for", "hint": "What the patient wants to achieve with this treatment."}
 ]},
 {"title": "Zhodnotenie / Assessment", "fields": [
  {"key": "assessment", "label": "Diagnóza – aktuálny zdravotný stav / Assessment", "mode": "suggest", "hint": "The practitioner's diagnosis of the present condition."},
  {"key": "constitution", "label": "Konštitúcia (Prakriti) / Constitution (Prakriti)", "mode": "suggest", "hint": "The patient's lifelong balance of the doshas, from what the patient described."},
  {"key": "imbalance", "label": "Aktuálna nerovnováha (Vikriti) / Current imbalance (Vikriti)", "mode": "suggest", "hint": "Which dosha is out of balance now, and the signs of it in what the patient described."},
  {"key": "agni_ama", "label": "Tráviaci oheň a toxíny (Agni, Ama) / Digestive fire and toxins (Agni, Ama)", "mode": "suggest", "hint": "The state of digestion and any signs of ama, from what the patient described."},
  {"key": "safety", "label": "Bezpečnostné upozornenia / Safety notes", "mode": "suggest", "hint": "Warning signs that need a medical doctor, and herbs that may not suit the medicines, pregnancy or conditions named. Leave empty if there are none."}
 ]},
 {"title": "Odporúčanie / Recommendation", "fields": [
  {"key": "therapies", "label": "Odporúčané terapie / Therapies", "hint": "Therapies the practitioner recommended, such as Abhyanga or Shirodhara, with how often."},
  {"key": "programme", "label": "Individuálny program / Individual programme", "hint": "Only if the practitioner named an individual programme: whether it was agreed, and for how many days. Not the review date."},
  {"key": "review", "label": "Termín kontrolného vyšetrenia / Review", "hint": "When the patient should come back, or the date of the next consultation."},
  {"key": "referral", "label": "Odporúčanie k lekárovi alebo vyšetrenia / Referral or tests", "hint": "A doctor, specialist or tests the practitioner suggested. Leave empty if none."}
 ]},
 {"title": "Všeobecné odporúčania / General instructions", "fields": [
  {"key": "daily_routine", "label": "Denný režim: ranné rituály, pitný režim / Daily routine", "hint": "Morning rituals, drinking routine, bedtime and other daily habits the practitioner recommended."},
  {"key": "diet_plan", "label": "Vhodná a nevhodná strava / Food to favour and to avoid", "hint": "Foods, drinks and meal times the practitioner recommended or advised against."},
  {"key": "yoga_breathing", "label": "Jóga, dýchanie a meditácia / Yoga, breathing and meditation", "hint": "Yoga poses, pranayama or meditation the practitioner recommended."},
  {"key": "exercise", "label": "Cvičenie / Exercise", "hint": "Exercise or movement the practitioner recommended."},
  {"key": "herbs", "label": "Byliny a doplnky / Herbs and supplements", "hint": "Each herb, remedy or supplement the practitioner recommended, with dose, timing and for how long."}
 ]},
 {"title": "Len pre vás / For you only", "fields": [
  {"key": "private_notes", "label": "Súkromné poznámky / Private notes", "mode": "manual", "hint": "Your own notes. Watson never fills this in, and it is never shared with the patient."}
 ]}
]}
$form$::jsonb, true, 'built_in');

-- Practitioners on Watson's English form move to its new version; those on their own copy of the
-- Slovak and English form (Robin and the test accounts) move to the built-in twin of the new one.
update public.form_template_defaults d set form_template_version_id = (
    select id from public.form_template_versions where is_built_in and template_key = 'watson_standard' and version_number = 2)
  from public.form_template_versions v
  where v.id = d.form_template_version_id and v.is_built_in and v.template_key = 'watson_standard' and v.version_number = 1;

update public.form_template_defaults d set form_template_version_id = (
    select id from public.form_template_versions where is_built_in and template_key = 'watson_standard_sk_en' and version_number = 1)
  from public.form_template_versions v
  where v.id = d.form_template_version_id and not v.is_built_in and v.template_key = 'legacy_current'
    and v.definition ->> 'title' = 'Ajurvédska konzultácia / Ayurvedic consultation';
