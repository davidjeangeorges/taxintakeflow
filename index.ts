// ── TaxIntakeFlow — process-submission Edge Function ─────────────────────────
// Handles all email notifications via MailerSend.
// Triggered by intake.html after a client submits their intake form.
//
// Emails sent:
//   1. Preparer alert  → firm owner when a new intake is submitted
//   2. Welcome email   → new firm owner when they complete onboarding
//   3. Preparer invite → preparer when firm owner sends an invitation
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAILERSEND_API_KEY = Deno.env.get("MAILERSEND_API_KEY")!;
const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FROM_EMAIL         = "notifications@taxintakeflow.com";
const FROM_NAME          = "TaxIntakeFlow";

// ── Supabase client (service role — can read any row) ────────────────────────
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  // Allow CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  try {
    const body = await req.json();
    const { type } = body;

    // ── Route by notification type ──────────────────────────────────────────
    if (type === "intake_submitted") {
      await handleIntakeSubmitted(body);
    } else if (type === "welcome") {
      await handleWelcome(body);
    } else if (type === "preparer_invite") {
      await handlePreparerInvite(body);
    } else {
      // Legacy call from old intake.html — treat as intake_submitted
      await handleIntakeSubmitted(body);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });

  } catch (err) {
    console.error("process-submission error:", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
});

// ── 1. New intake submitted → notify firm owner ───────────────────────────────
async function handleIntakeSubmitted(body: Record<string, unknown>) {
  const { submissionId, firmId } = body as { submissionId: string; firmId: string };

  // Pull firm owner email + name
  const { data: firm, error: firmErr } = await sb
    .from("firms")
    .select("owner_email, email, firm_name")
    .eq("id", firmId)
    .single();

  if (firmErr || !firm) {
    console.warn("handleIntakeSubmitted: firm not found", firmErr);
    return;
  }

  const toEmail = firm.owner_email || firm.email;
  if (!toEmail) {
    console.warn("handleIntakeSubmitted: no owner email on firm", firmId);
    return;
  }

  // Pull submission details
  const { data: sub } = await sb
    .from("submissions")
    .select("first_name, last_name, email, phone, preparer_name, tax_year, filing_status, flags")
    .eq("id", submissionId)
    .maybeSingle();

  const clientName   = sub ? `${sub.first_name} ${sub.last_name}` : "A new client";
  const preparer     = sub?.preparer_name || "Not assigned";
  const taxYear      = sub?.tax_year      || "—";
  const filingStatus = sub?.filing_status || "—";
  const clientEmail  = sub?.email         || "—";
  const phone        = sub?.phone         || "—";
  const flags        = Array.isArray(sub?.flags) ? sub.flags.join(", ") : (sub?.flags || "None");

  await sendEmail({
    to:      toEmail,
    subject: `New intake: ${clientName} — ${firm.firm_name}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="color:#0d1b2a;margin-bottom:4px">New Client Intake Received</h2>
        <p style="color:#55534e;margin-top:0">A client just completed their intake form on TaxIntakeFlow.</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0">
          <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666;width:140px">Client</td><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600">${clientName}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666">Email</td><td style="padding:8px 0;border-bottom:1px solid #eee">${clientEmail}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666">Phone</td><td style="padding:8px 0;border-bottom:1px solid #eee">${phone}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666">Tax Year</td><td style="padding:8px 0;border-bottom:1px solid #eee">${taxYear}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666">Filing Status</td><td style="padding:8px 0;border-bottom:1px solid #eee">${filingStatus}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666">Preparer</td><td style="padding:8px 0;border-bottom:1px solid #eee">${preparer}</td></tr>
          <tr><td style="padding:8px 0;color:#666">Flags</td><td style="padding:8px 0">${flags}</td></tr>
        </table>
        <a href="https://taxintakeflow.com/portal.html"
           style="display:inline-block;background:#c9a84c;color:#0d1b2a;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700">
          View in Portal →
        </a>
        <p style="color:#aaa;font-size:12px;margin-top:32px">TaxIntakeFlow · taxintakeflow.com</p>
      </div>
    `,
  });
}

// ── 2. New firm signed up → send welcome email ────────────────────────────────
async function handleWelcome(body: Record<string, unknown>) {
  const { toEmail, firmName, firmId } = body as {
    toEmail: string;
    firmName: string;
    firmId: string;
  };

  if (!toEmail) return;

  await sendEmail({
    to:      toEmail,
    subject: `Welcome to TaxIntakeFlow, ${firmName}!`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="color:#0d1b2a">Welcome to TaxIntakeFlow! 🎉</h2>
        <p style="color:#55534e">Your firm <strong>${firmName}</strong> is now set up and ready to go.</p>
        <p style="color:#55534e">Your intake form is live at:</p>
        <p style="background:#f5f4f2;padding:12px;border-radius:6px;font-family:monospace;font-size:13px">
          https://taxintakeflow.com/intake.html?firmId=${firmId}
        </p>
        <p style="color:#55534e">Share that link with your clients and they can start submitting right away.</p>
        <a href="https://taxintakeflow.com/portal.html"
           style="display:inline-block;background:#c9a84c;color:#0d1b2a;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;margin-top:8px">
          Go to My Portal →
        </a>
        <p style="color:#aaa;font-size:12px;margin-top:32px">TaxIntakeFlow · taxintakeflow.com</p>
      </div>
    `,
  });
}

// ── 3. Firm owner invites a preparer ─────────────────────────────────────────
async function handlePreparerInvite(body: Record<string, unknown>) {
  const { toEmail, preparerName, firmName, joinLink } = body as {
    toEmail:      string;
    preparerName: string;
    firmName:     string;
    joinLink:     string;
  };

  if (!toEmail) return;

  await sendEmail({
    to:      toEmail,
    subject: `You've been invited to join ${firmName} on TaxIntakeFlow`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="color:#0d1b2a">You're Invited!</h2>
        <p style="color:#55534e">Hi ${preparerName || "there"},</p>
        <p style="color:#55534e"><strong>${firmName}</strong> has invited you to join their tax firm on TaxIntakeFlow. Click the button below to create your account and get your personal client intake link.</p>
        <a href="${joinLink}"
           style="display:inline-block;background:#c9a84c;color:#0d1b2a;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:15px;margin:16px 0">
          Create My Account →
        </a>
        <p style="color:#99948e;font-size:12px">Or copy this link:<br>
          <span style="font-family:monospace">${joinLink}</span>
        </p>
        <p style="color:#aaa;font-size:12px;margin-top:32px">TaxIntakeFlow · taxintakeflow.com</p>
      </div>
    `,
  });
}

// ── Core send function — calls MailerSend REST API ────────────────────────────
async function sendEmail({ to, subject, html }: { to: string; subject: string; html: string }) {
  const res = await fetch("https://api.mailersend.com/v1/email", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${MAILERSEND_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      from:    { email: FROM_EMAIL, name: FROM_NAME },
      to:      [{ email: to }],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MailerSend error ${res.status}: ${errText}`);
  }

  console.log(`Email sent to ${to} — subject: ${subject}`);
}
