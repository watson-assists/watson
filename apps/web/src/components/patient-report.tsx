"use client";

import { Lock } from "lucide-react";
import { useState } from "react";
import { Notice } from "@/components/status";
import { answerText, translated, type FormAnswer, type FormTemplate, type OutputLanguage } from "@/lib/export";
import { euros } from "@/lib/fee";
import { payment } from "@/lib/payment";
import { lines, photoUrl, type OrderLine, type Prescribed } from "@/lib/shop";
import { dateTime } from "@/lib/status";

export type Report = {
  approved_at: string; language: string; practitioner: string | null;
  template: FormTemplate; answers: FormAnswer[]; prescriptions: Prescribed[];
  orders: { id: string; status: "paid" | "sent"; total_cents: number; paid_at: string; sent_at: string | null; items: OrderLine[] }[];
};

/**
 * The patient's own page, once their practitioner approved the form (owner, 23 Nov): the report (their
 * complaints, the diagnosis, the treatment and the review) and the prescriptions (the general
 * instructions, and the products to buy). The database sends nothing else of the form.
 */
export function PatientReport({ token, report, cancelled }: { token: string; report: Report; cancelled: boolean }) {
  const language: OutputLanguage = report.language === "sk" || report.language === "en" ? report.language : "both";
  const answers = new Map(report.answers.map((answer) => [answer.field_key, answer]));
  const available = report.prescriptions.filter((item) => item.available);
  const [buying, setBuying] = useState<string[]>(() => available.map((item) => item.id));
  const [paying, setPaying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const total = available.filter((item) => buying.includes(item.id)).reduce((sum, item) => sum + item.quantity * item.price_cents, 0);
  const sections = report.template.sections.map((section) => ({
    section, fields: section.fields.filter((field) => answerText(answers.get(field.key), field, language)),
  })).filter(({ fields }) => fields.length > 0);

  async function buy() {
    setPaying(true);
    setProblem(null);
    const answer = await payment({ token, items: buying });
    if (answer?.url) return window.location.assign(answer.url);
    setPaying(false);
    setProblem("Buying is not available right now. Try again in a moment.");
  }

  return (
    <>
      <section className="wa-panel" aria-labelledby="report-title">
        <h2 className="wa-heading" id="report-title">Your report</h2>
        <p className="wa-meta">From {report.practitioner ?? "your practitioner"}, {dateTime(report.approved_at)}.</p>
        {sections.map(({ section, fields }) => (
          <div key={section.title} style={{ display: "grid", gap: 8 }}>
            <h3 className="wa-label">{translated(section.title, section.title_i18n, language)}</h3>
            <dl className="wa-printed__answers">
              {fields.map((field) => (
                <div key={field.key}>
                  {/* "Assessment" under "Assessment" says it twice */}
                  {field.label !== section.title && <dt>{translated(field.label, field.label_i18n, language)}</dt>}
                  <dd style={{ whiteSpace: "pre-wrap" }}>{answerText(answers.get(field.key), field, language)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </section>
      {report.prescriptions.length > 0 && (
        <section className="wa-panel" aria-labelledby="medicines-title">
          <h2 className="wa-heading" id="medicines-title">Your medicines</h2>
          {cancelled && <Notice title="The payment was not completed">Nothing was charged. You can try again.</Notice>}
          {report.orders.map((order) => (
            <Notice key={order.id} title={order.status === "sent" ? `Sent ${dateTime(order.sent_at!)}` : `Paid ${dateTime(order.paid_at)}. Thank you.`}>
              {lines(order.items)}, {euros(order.total_cents)}. {order.status === "sent" ? "It is on its way to you." : `${report.practitioner ?? "Your practitioner"} sends it to you. Stripe emails you a receipt.`}
            </Notice>
          ))}
          <ul className="wa-shop">
            {report.prescriptions.map((item) => (
              <li key={item.id} className="wa-shop__item">
                {/* eslint-disable-next-line @next/next/no-img-element -- a static site: no image server for next/image */}
                {item.photo_path ? <img className="wa-shop__photo" src={photoUrl(item.photo_path)!} alt="" /> : <span className="wa-shop__photo" aria-hidden />}
                <div className="wa-shop__text">
                  <p className="wa-shop__name">{item.quantity > 1 ? `${item.quantity} × ` : ""}{item.name}</p>
                  {item.instructions && <p className="wa-text">{item.instructions}</p>}
                  {item.description && <p className="wa-meta">{item.description}</p>}
                  <p className="wa-meta">{item.available ? `${euros(item.price_cents)} each` : "No longer available from your practitioner."}</p>
                </div>
                {item.available && (
                  <label className="wa-check">
                    <input type="checkbox" checked={buying.includes(item.id)}
                      onChange={(event) => setBuying((now) => event.target.checked ? [...now, item.id] : now.filter((id) => id !== item.id))} />
                    Buy
                  </label>
                )}
              </li>
            ))}
          </ul>
          {available.length > 0 && (
            <>
              <div className="wa-actions">
                <button type="button" className="wa-button wa-button--primary" disabled={paying || total === 0} aria-busy={paying || undefined} onClick={() => void buy()}>
                  <Lock aria-hidden className="wa-icon" />{paying ? "Opening Stripe…" : `Buy for ${euros(total)}`}
                </button>
              </div>
              <p className="wa-hint">You pay on Stripe&apos;s secure page and give the address to send it to. Watson never sees your card.</p>
            </>
          )}
          {problem && <Notice tone="failed" title="Could not start the payment">{problem}</Notice>}
        </section>
      )}
    </>
  );
}
