# Gate R — Real-patient release block

**State: CLOSED. Synthetic data only.** This repository has no real-patient mode. `scripts/check-data-mode.sh` rejects every value except `synthetic`; deployment calls it before release.

Opening Gate R requires a separately reviewed release. A named owner must attach dated evidence for every item below. A checkbox, environment variable, or developer assertion is not evidence.

## Owner decisions

- [ ] OD-1 fixes where clinical content is processed and stored.
- [ ] Contracted service and cost model replaces the free proof-of-concept rule.
- [ ] Named release owner signs the final evidence bundle.

## Legal and clinical

- [ ] Locked intended-purpose and EU medical-device qualification memo.
- [ ] EU AI Act and European Health Data Space applicability assessments.
- [ ] Lawful basis for special-category health data and record of processing.
- [ ] Controller/processor decisions, DPAs, and complete subprocessor list.
- [ ] DPIA, data-subject-rights procedure, and incident/breach procedure.
- [ ] Scope-of-practice and red-flag escalation review.
- [ ] Versioned consent per participant and per scope: call, recording, transcription, structuring, retention, and sharing.
- [ ] Approved retention and deletion schedule, including backup/export limits.

## Security and operations

- [ ] Reviewed threat model and security design.
- [ ] Application-level authenticated encryption with keys separate from data.
- [ ] Per-artifact keys and tested crypto-erasure behavior.
- [ ] HMAC-SHA-256 audit chain with externally anchored heads and encrypted logs.
- [ ] MFA enforced and tested for practitioners and operators.
- [ ] Engine capabilities, least privilege, credential rotation, and revocation tested.
- [ ] Automatic inactivity lock.
- [ ] Encrypted backups and a witnessed restore drill.
- [ ] Temporary-file, crash-recovery, and local-vault behavior tested if OD-1 chooses workstation storage.
- [ ] Monitoring, incident response, key compromise, and rollback runbooks exercised.

## Clinical AI release evidence

- [ ] Approved model, prompt, and schema version registry.
- [ ] Transcript/extraction hashes and evidence links preserved in exports.
- [ ] Synthetic safety evaluation includes urgent symptoms, contradictions, deletions, repeaters, and no-evidence cases.
- [ ] Mandatory practitioner approval and model/prompt rollback proven.
- [ ] No autonomous diagnosis or automatic patient publication.

## Exit record

Gate R opens only through a reviewed commit that links immutable evidence, identifies approvers, records the decision date, implements the chosen architecture, and replaces the unconditional real-mode refusal. Until then, real patient data is forbidden.
