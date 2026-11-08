import type { ConsultationStatus } from "./status";

export type ConsultationTab = "booked" | "paid" | "completed" | "archived";

type TabbedConsultation = {
  status: ConsultationStatus;
  fee_cents: number | null;
  paid_at: string | null;
};

const COMPLETED: readonly ConsultationStatus[] = ["approved", "corrected", "consent_withdrawn"];

/** One exclusive shelf for a consultation, with terminal states taking precedence over payment. */
export function consultationTab(row: TabbedConsultation): ConsultationTab {
  if (row.status === "archived") return "archived";
  if (COMPLETED.includes(row.status)) return "completed";
  if (row.fee_cents !== null && row.paid_at !== null) return "paid";
  return "booked";
}
