"use client";

import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "@/lib/zod";
import { Notice } from "@/components/status";
import { loginEmail, useSession } from "@/lib/session";
import { supabase } from "@/lib/supabase";

const schema = z.object({
  name: z.string().trim().min(1, "Enter your name."),
  password: z.string().min(1, "Enter your password."),
});
type Values = z.infer<typeof schema>;

export default function SignIn() {
  const session = useSession();
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (session.status !== "signed-in" || session.roles === null) return;
    router.replace(session.roles.includes("practitioner") ? "/consultations/" : "/patient/");
  }, [session, router]);

  async function signIn(values: Values) {
    setFailure(null);
    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail(values.name), password: values.password });
    if (!error) return; // the session listener redirects
    // The same message whether or not the name exists.
    setFailure(
      error.status === 400
        ? "That name and password do not match an account."
        : "Sign-in is not available right now. Try again in a moment.",
    );
  }

  return (
    <main className="wa-night">
      <div className="wa-door">
        <header className="wa-door__head">
          <Link href="/" className="wa-wordmark" aria-label="Watson home">Watson</Link>
          <h1 className="wa-door__title">Every doctor deserves a&nbsp;Watson.</h1>
          <p className="wa-door__lead">You see the patient. Watson does the paperwork.</p>
        </header>

        <section className="wa-panel wa-door__card" aria-labelledby="sign-in">
          <h2 id="sign-in" className="wa-heading">Sign in</h2>
          <p className="wa-hint">Accounts are made by the project owner. There is no public sign-up.</p>
          <form onSubmit={handleSubmit(signIn)} noValidate className="wa-form" style={{ gap: 16 }}>
            <div className="wa-field">
              <label className="wa-label" htmlFor="name">Name</label>
              <input id="name" autoComplete="username" autoCapitalize="none" spellCheck={false} className="wa-input"
                aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? "name-error" : undefined}
                {...register("name")} />
              {errors.name && <p id="name-error" className="wa-error"><CircleAlert aria-hidden className="wa-icon" />{errors.name.message}</p>}
            </div>
            <div className="wa-field">
              <label className="wa-label" htmlFor="password">Password</label>
              <input id="password" type="password" autoComplete="current-password" className="wa-input"
                aria-invalid={Boolean(errors.password)} aria-describedby={errors.password ? "password-error" : undefined}
                {...register("password")} />
              {errors.password && <p id="password-error" className="wa-error"><CircleAlert aria-hidden className="wa-icon" />{errors.password.message}</p>}
            </div>
            {failure && <Notice tone="failed" title="Not signed in">{failure}</Notice>}
            <button type="submit" className="wa-button wa-button--primary" disabled={isSubmitting} aria-busy={isSubmitting || undefined}>
              {isSubmitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </section>

        <figure className="wa-notebook">
          <figcaption className="wa-notebook__title">From Watson&apos;s notebook</figcaption>
          <ol>
            <li><time>08:12</time><span>Booked for 09:30 and paid, €40.00</span></li>
            <li><time>09:30</time><span>Video call with the patient, 32 minutes</span></li>
            <li><time>10:03</time><span>Notes written: every word, both voices</span></li>
            <li><time>10:06</time><span>Your form filled in: 18 of 21 answers, each with its quote</span></li>
            <li className="is-now"><time>Now</time><span>Waiting for you to check and approve</span></li>
          </ol>
        </figure>
      </div>
    </main>
  );
}
