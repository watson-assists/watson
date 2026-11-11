type Revision = { approved_at: string | null; revision_number: number };

/** An approved revision remains authoritative while a newer candidate is reviewed. */
export function currentFormRevision<T extends Revision>(forms: T[]): T | undefined {
  return forms.reduce<T | undefined>((current, candidate) => {
    if (!current) return candidate;
    const currentApproved = current.approved_at !== null;
    const candidateApproved = candidate.approved_at !== null;
    if (currentApproved !== candidateApproved) return candidateApproved ? candidate : current;
    return candidate.revision_number > current.revision_number ? candidate : current;
  }, undefined);
}
