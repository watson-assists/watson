// Saving a file the browser made (owner, 24 Oct: Excel exports).
import { allPatientsRows, formRows, type ConsultationRecord } from "./export";
import { asDayMonthYear } from "./dates";
import { workbook } from "./xlsx";

const EXCEL = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function save(name: string, bytes: Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** "27-10-2026": a date that fits in a file name. */
const fileDate = (at: Date) => asDayMonthYear(at).replaceAll("/", "-");
const safe = (name: string) => name.replace(/[\\/:*?"<>|]+/g, " ").trim();

/** One consultation: its form. Never the conversation, which stays in Watson (owner, 23 Nov). */
export function downloadConsultation(record: ConsultationRecord) {
  save(`${safe(record.patient)} ${fileDate(new Date(record.scheduledAt))}.xlsx`, workbook([
    { name: "Form", rows: formRows(record), widths: [24, 34, 70] },
  ]), EXCEL);
}

/** Every consultation, one row each. */
export function downloadAll(records: ConsultationRecord[]) {
  const rows = allPatientsRows(records);
  save(`All patients ${fileDate(new Date())}.xlsx`, workbook([
    { name: "All patients", rows, widths: rows[0].map((_, i) => (i < 5 ? 22 : 34)) },
  ]), EXCEL);
}
