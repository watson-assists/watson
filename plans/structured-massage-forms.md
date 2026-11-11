# Structured EN/SK Massage Forms

## Objective

Add the bilingual Ayurvedic massage assessment as a selectable, immutable clinical record without changing the existing Watson form or allowing provisional/live output to become authoritative.

## Non-negotiable invariants

- Every consultation pins one immutable template version before processing.
- Approved records are append-only. Corrections and conversions create linked revisions.
- Historical values remain dated context; they never become current silently.
- Live extraction uses separate provisional storage. Final extraction reads only the final transcript and documents.
- Safety, suitability, consent, and signatures require an explicit human action.
- Tenant ownership and confirmed-patient identity are checked in database functions, not only UI code.
- No real patient data until Gate R passes. Tests and fixtures remain synthetic.

## Delivery sequence

### 1. Typed schema and immutable record foundation

Context: current templates and answers are text-only. The source form needs choices, explicit none/unknown states, repeaters, attestations, signatures, bilingual labels, and safety gates.

Tasks:

- Extend template validation without changing schema-v1 behavior.
- Publish built-in `massage_assessment_en_sk` version 1 with schema version 2.
- Add typed values, answer states, revision lineage, and approval-gate storage alongside legacy columns.
- Protect approved forms and their answers from mutation.
- Add a deterministic backfill for safe pins and a PHI-minimal unresolved-pin review surface.
- Teach the worker to parse schema-v2 fields while preserving schema-v1 payloads.

Verification: fresh database reset, pgTAP contracts, worker unit tests, existing template-pinning integration test.

Rollback: additive migration only. Keep `watson_standard` default and do not expose the second template in UI until this step passes.

### 2. Practice default and consultation selectors

Depends on: 1.

Tasks:

- Add Practice default selector over accessible immutable versions.
- Add new-consultation selector, initialized from the Practice default.
- Pin the selected version in consultation creation atomically.
- Show stable name, version, and language; never expose raw template JSON.

Verification: component tests, RPC ownership tests, keyboard/screen-reader checks, Chromium E2E.

### 3. Previous-appointment selector

Depends on: 2.

Tasks:

- Resolve selected patient to a confirmed patient record before listing history.
- List only eligible earlier consultations for that patient.
- Link/unlink through the guarded RPC; show date and record state.
- Render previous approved values as dated read-only context.

Verification: cross-patient, cross-owner, chronology, cycle, and stale-selection tests.

### 4. Immutable revisions and historical conversion

Depends on: 1, 2.

Tasks:

- Create candidate revisions from retained final transcripts against a chosen template version.
- Keep an approved revision current while a candidate is reviewed.
- Preserve source transcript, template hash, parent revision, origin, and actor.
- Approving a correction adds a new approved revision; it never edits the prior approval.

Verification: conversion of synthetic legacy records, concurrent candidates, rejected candidate, immutable prior approval.

### 5. Typed review, repeaters, and safety gates

Depends on: 1, 4.

Tasks:

- Render each schema-v2 type with explicit unknown/none/not-applicable controls.
- Add repeatable medication, symptom-map, and treatment entries with stable item IDs.
- Require clinician confirmation for red-flag disposition, treatment suitability, consent, and practitioner sign-off.
- Block approval when required values or gates are unresolved.

Verification: pure gate tests, database enforcement tests, accessible form interaction tests.

### 6. Split live and final compute paths

Depends on: 1.

Tasks:

- Separate caption, provisional-form, and final/batch worker capabilities and leases.
- Store provisional values outside authoritative form answers with expiry and provenance.
- Ensure final job input excludes provisional values.

Verification: worker-capability isolation, lease recovery, and proof that provisional rows cannot reach approval.

### 7. Live provisional filling and final reconciliation

Depends on: 5, 6.

Tasks:

- Extract coverage/provisional values from live captions.
- Mark all live content provisional and show source timing.
- Re-run against the final transcript, compare typed values, and create explicit conflicts.
- Require review of every conflict; never auto-promote a live value.

Verification: late transcript correction, contradiction, deletion, repeater merge, and no-evidence cases.

### 8. EN/SK print/export and signatures

Depends on: 5.

Tasks:

- Add English, Slovak, and bilingual rendering from template labels.
- Produce deterministic print/PDF output with revision, template hash, approval, and signature metadata.
- Support wet-ink-on-print acknowledgement first; add cryptographic digital signatures only after policy and key-management review.
- Keep patient and practitioner signatures distinct.

Verification: print snapshots, page-break checks, bilingual completeness, signature audit tests.

### 9. Gate R release controls

Depends on: all clinical-data steps.

Tasks:

- Complete consent wording/versioning, retention/deletion, encryption and key ownership, keyed audit integrity, MFA, backup/restore, incident response, legal basis, DPA/subprocessor, and scope-of-practice review.
- Add deployment checks that fail closed when required controls or policy versions are absent.
- Run synthetic end-to-end safety evaluation and restore drill.

Exit: named owner signs the Gate R checklist. Until then, product remains synthetic-data only.

## Open product decisions

- Body chart: attachment upload first versus in-browser drawing.
- Patient signature: wet ink on printed form versus authenticated digital confirmation.
- Output language: consultation language, practitioner choice, or bilingual default.
- Live mode: coverage-only versus provisional answer text.

Safe defaults until decided: attachment reference, wet ink on print, bilingual export, and coverage-only live UI.
