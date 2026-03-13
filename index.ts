// ============================================================
// Supabase Edge Function: process-submission
// Triggered after intake form submit
// - Generates PDF of form answers
// - Uploads PDF + files to firm's Google Drive folder
// - Sends email notifications via MailerSend
//
// Deploy: supabase functions deploy process-submission
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAILERSEND_API_KEY   = Deno.env.get("MAILERSEND_API_KEY")!;   // ← was RESEND_API_KEY
const GOOGLE_SA_EMAIL      = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const GOOGLE_SA_KEY        = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE);

// ── MAIN HANDLER ─────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const corsHeaders = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "content-type, authorization",
  };

  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();

    // ── Early exits: lightweight emails (no PDF, no Drive) ──
    if (body.type === "welcome") {
      await handleWelcome(body);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (body.type === "preparer_invite") {
      await handlePreparerInvite(body);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { submissionId, firmId } = body;
    if (!submissionId) return new Response("Missing submissionId", { status: 400 });

    // 1. Load submission
    const { data: sub, error: subErr } = await sb
      .from("submissions")
      .select("*")
      .eq("id", submissionId)
      .single();

    if (subErr || !sub) throw new Error("Submission not found");

    // 2. Load firm (for Drive folder ID, email, name)
    const { data: firm } = await sb
      .from("firms")
      .select("firm_name, drive_folder_id, owner_email, ghl_webhook")
      .eq("id", firmId || sub.firm_id)
      .single();

    // 3. Generate PDF
    const pdfBytes = await generatePDF(sub, firm);

    // 4. Upload to Supabase Storage as backup
    const pdfPath = `${sub.firm_id || "no-firm"}/${sub.id}/intake-summary.pdf`;
    await sb.storage.from("intake-files").upload(pdfPath, pdfBytes, {
      contentType: "application/pdf",
      upsert: true,
    });

    const { data: { publicUrl: pdfStorageUrl } } = sb.storage
      .from("intake-files")
      .getPublicUrl(pdfPath);

    let driveFolderUrl = null;

    // 5. Upload to Google Drive (if firm has folder ID configured)
    if (firm?.drive_folder_id && GOOGLE_SA_EMAIL && GOOGLE_SA_KEY) {
      try {
        const accessToken = await getGoogleAccessToken();

        // Create client subfolder: "LastName, FirstName — TaxYear"
        const clientFolderName = `${sub.last_name || "Client"}, ${sub.first_name || ""} — ${sub.tax_year || "2024"}`;
        const clientFolderId   = await createDriveFolder(accessToken, clientFolderName, firm.drive_folder_id);

        // Upload PDF to Drive
        const pdfFileName = `${sub.last_name}_${sub.first_name}_Intake_${sub.tax_year}.pdf`;
        await uploadFileToDrive(accessToken, pdfBytes, pdfFileName, "application/pdf", clientFolderId);

        // Upload client files from Supabase Storage to Drive
        if (sub.storage_path) {
          const { data: storageFiles } = await sb.storage
            .from("intake-files")
            .list(sub.storage_path, { limit: 100 });

          if (storageFiles && storageFiles.length > 0) {
            // Create "Uploaded Documents" subfolder
            const docsSubfolderId = await createDriveFolder(accessToken, "Uploaded Documents", clientFolderId);

            await Promise.allSettled(
              storageFiles.map(async (f) => {
                const { data: categoryFiles } = await sb.storage
                  .from("intake-files")
                  .list(`${sub.storage_path}/${f.name}`);

                if (categoryFiles) {
                  await Promise.allSettled(
                    categoryFiles.map(async (cf) => {
                      const { data: fileData } = await sb.storage
                        .from("intake-files")
                        .download(`${sub.storage_path}/${f.name}/${cf.name}`);
                      if (fileData) {
                        const fileBytes = await fileData.arrayBuffer();
                        await uploadFileToDrive(
                          accessToken,
                          fileBytes,
                          cf.name,
                          cf.metadata?.mimetype || "application/octet-stream",
                          docsSubfolderId
                        );
                      }
                    })
                  );
                }
              })
            );
          }
        }

        driveFolderUrl = `https://drive.google.com/drive/folders/${clientFolderId}`;

        // Update submission with Drive folder URL
        await sb.from("submissions").update({ drive_folder_url: driveFolderUrl, pdf_url: pdfStorageUrl }).eq("id", submissionId);

      } catch (driveErr) {
        console.error("Drive upload error:", driveErr);
        // Don't fail the whole function — Drive is best-effort
      }
    } else {
      await sb.from("submissions").update({ pdf_url: pdfStorageUrl }).eq("id", submissionId);
    }

    // 6. Send email notifications
    if (MAILERSEND_API_KEY) {                                          // ← was RESEND_API_KEY
      await sendEmails(sub, firm, driveFolderUrl, pdfStorageUrl);
    }

    return new Response(JSON.stringify({ success: true, submissionId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ── PDF GENERATION ────────────────────────────────────────────
// Identical to original — not changed
async function generatePDF(sub: any, firm: any): Promise<ArrayBuffer> {
  const firmName = firm?.firm_name || "Your Tax Firm";
  const today    = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const incomeTypes = [
    sub.form_data?.inc_w2          ? "W-2 Employment" : null,
    sub.form_data?.inc_1099nec     ? "1099-NEC"       : null,
    sub.is_trucker                 ? "Trucker/OTR"    : null,
    sub.form_data?.inc_rental      ? "Rental Income"  : null,
    sub.form_data?.inc_investments ? "Investments"    : null,
    sub.form_data?.inc_crypto      ? "Cryptocurrency" : null,
    sub.form_data?.inc_ss          ? "Social Security": null,
    sub.form_data?.inc_pension     ? "Pension/IRA"    : null,
  ].filter(Boolean).join(", ") || "Not specified";

  const depsHtml = (sub.dependents || []).map((d: any, i: number) => `
    <tr>
      <td>${i + 1}</td>
      <td>${d.firstName || ""} ${d.lastName || ""}</td>
      <td>${d.relationship || ""}</td>
      <td>${d.dob || ""}</td>
      <td>${d.ssn ? "***-**-" + String(d.ssn).slice(-4) : ""}</td>
    </tr>
  `).join("");

  const bizsHtml = (sub.businesses || []).map((b: any, i: number) => `
    <tr>
      <td>${i + 1}</td>
      <td>${b.businessName || ""}</td>
      <td>${b.entityType || ""}</td>
      <td>${b.ein || ""}</td>
      <td>$${b.grossIncome || "0"}</td>
    </tr>
  `).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 11px; color: #1a1a1a; padding: 40px; }
  .header { background: #0d1b2a; color: white; padding: 24px 28px; border-radius: 8px; margin-bottom: 24px; }
  .header h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  .header p  { font-size: 11px; color: rgba(255,255,255,0.6); }
  .header .gold { color: #c9a84c; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 8px; }
  .section { margin-bottom: 20px; border: 1px solid #e0e0e0; border-radius: 6px; overflow: hidden; }
  .section-title { background: #f5f4f1; padding: 8px 14px; font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #5c5650; border-bottom: 1px solid #e0e0e0; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  .field { padding: 10px 14px; border-bottom: 1px solid #f0eeea; }
  .field:nth-child(odd)  { border-right: 1px solid #f0eeea; }
  .field:last-child, .field:nth-last-child(2):nth-child(odd) { border-bottom: none; }
  .f-label { font-size: 9px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; color: #9b9488; margin-bottom: 3px; }
  .f-value { font-size: 12px; color: #1a1a1a; }
  .full { grid-column: 1 / -1; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { background: #f5f4f1; padding: 8px 12px; text-align: left; font-size: 9px; letter-spacing: 0.8px; text-transform: uppercase; color: #9b9488; border-bottom: 1px solid #e0e0e0; }
  td { padding: 9px 12px; border-bottom: 1px solid #f0eeea; }
  tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 9px; font-weight: 700; background: rgba(47,158,68,0.12); color: #2f9e44; }
  .footer { margin-top: 28px; padding-top: 14px; border-top: 1px solid #e0e0e0; font-size: 10px; color: #9b9488; display: flex; justify-content: space-between; }
</style>
</head>
<body>
<div class="header">
  <div class="gold">${firmName}</div>
  <h1>Tax Intake Summary</h1>
  <p>Tax Year ${sub.tax_year || "2024"} &nbsp;·&nbsp; Submitted: ${today} &nbsp;·&nbsp; Ref: ${sub.id?.slice(0,8).toUpperCase()}</p>
</div>

<div class="section">
  <div class="section-title">Personal Information</div>
  <div class="grid">
    <div class="field"><div class="f-label">Full Name</div><div class="f-value">${sub.first_name || ""} ${sub.last_name || ""}</div></div>
    <div class="field"><div class="f-label">Date of Birth</div><div class="f-value">${sub.dob || "—"}</div></div>
    <div class="field"><div class="f-label">Email</div><div class="f-value">${sub.email || "—"}</div></div>
    <div class="field"><div class="f-label">Phone</div><div class="f-value">${sub.phone || "—"}</div></div>
    <div class="field full"><div class="f-label">Address</div><div class="f-value">${sub.address || ""}, ${sub.city || ""}, ${sub.state || ""} ${sub.zip || ""}</div></div>
  </div>
</div>

<div class="section">
  <div class="section-title">Filing Information</div>
  <div class="grid">
    <div class="field"><div class="f-label">Tax Year</div><div class="f-value">${sub.tax_year || "—"}</div></div>
    <div class="field"><div class="f-label">Filing Status</div><div class="f-value">${(sub.filing_status || "").toUpperCase()}</div></div>
    <div class="field"><div class="f-label">Assigned Preparer</div><div class="f-value">${sub.preparer_name || "Unassigned"}</div></div>
    <div class="field"><div class="f-label">New Client</div><div class="f-value">${sub.is_new_client ? "Yes" : "Returning"}</div></div>
    <div class="field full"><div class="f-label">Income Sources</div><div class="f-value">${incomeTypes}</div></div>
  </div>
</div>

${(sub.dependents || []).length > 0 ? `
<div class="section">
  <div class="section-title">Dependents (${sub.dependents.length})</div>
  <table>
    <thead><tr><th>#</th><th>Name</th><th>Relationship</th><th>DOB</th><th>SSN</th></tr></thead>
    <tbody>${depsHtml}</tbody>
  </table>
</div>` : ""}

${(sub.businesses || []).length > 0 ? `
<div class="section">
  <div class="section-title">Businesses (${sub.businesses.length})</div>
  <table>
    <thead><tr><th>#</th><th>Business Name</th><th>Entity</th><th>EIN</th><th>Gross Income</th></tr></thead>
    <tbody>${bizsHtml}</tbody>
  </table>
</div>` : ""}

<div class="section">
  <div class="section-title">Flags</div>
  <div style="padding:14px;display:flex;gap:8px;flex-wrap:wrap;">
    ${sub.is_trucker      ? '<span class="badge">Trucker</span>'        : ""}
    ${sub.has_business    ? '<span class="badge">Business Owner</span>' : ""}
    ${sub.has_rental      ? '<span class="badge">Rental Income</span>'  : ""}
    ${sub.has_back_taxes  ? '<span class="badge">Back Taxes</span>'     : ""}
    ${sub.has_bookkeeping ? '<span class="badge">Bookkeeping</span>'    : ""}
    ${sub.is_itin         ? '<span class="badge">ITIN</span>'           : ""}
  </div>
</div>

${sub.form_data?.additionalNotes ? `
<div class="section">
  <div class="section-title">Additional Notes from Client</div>
  <div style="padding:14px;font-size:12px;color:#3a3530;line-height:1.6">${sub.form_data.additionalNotes}</div>
</div>` : ""}

<div class="footer">
  <span>Generated by TaxIntakeFlow · taxintakeflow.com</span>
  <span>Submission ID: ${sub.id}</span>
</div>
</body>
</html>`;

  const browserlessToken = Deno.env.get("BROWSERLESS_TOKEN");
  if (browserlessToken) {
    const resp = await fetch("https://chrome.browserless.io/pdf?token=" + browserlessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        html,
        options: { format: "Letter", margin: { top: "0", bottom: "0", left: "0", right: "0" } },
      }),
    });
    return await resp.arrayBuffer();
  } else {
    return new TextEncoder().encode(html).buffer;
  }
}

// ── GOOGLE DRIVE HELPERS ──────────────────────────────────────
// Identical to original — not changed
async function getGoogleAccessToken(): Promise<string> {
  const privateKey = GOOGLE_SA_KEY.replace(/\\n/g, "\n");
  const now        = Math.floor(Date.now() / 1000);
  const header     = { alg: "RS256", typ: "JWT" };
  const payload    = {
    iss:   GOOGLE_SA_EMAIL,
    scope: "https://www.googleapis.com/auth/drive.file",
    aud:   "https://oauth2.googleapis.com/token",
    iat:   now,
    exp:   now + 3600,
  };
  const encode  = (obj: object) => btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const toSign  = `${encode(header)}.${encode(payload)}`;
  const pemBody = privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, "");
  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const key     = await crypto.subtle.importKey(
    "pkcs8", keyData.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig    = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(toSign));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const jwt    = `${toSign}.${sigB64}`;
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenResp.json();
  return tokenData.access_token;
}

async function createDriveFolder(token: string, name: string, parentId: string): Promise<string> {
  const resp = await fetch("https://www.googleapis.com/drive/v3/files", {
    method:  "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body:    JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  const data = await resp.json();
  return data.id;
}

async function uploadFileToDrive(token: string, fileData: ArrayBuffer, fileName: string, mimeType: string, folderId: string): Promise<void> {
  const metadata  = JSON.stringify({ name: fileName, parents: [folderId] });
  const boundary  = "taxintakeflow_boundary";
  const body      = [
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  ];
  const bodyParts = body.map(s => new TextEncoder().encode(s));
  const end       = new TextEncoder().encode(`\r\n--${boundary}--`);
  const total     = bodyParts.reduce((s, p) => s + p.length, 0) + fileData.byteLength + end.length;
  const merged    = new Uint8Array(total);
  let offset = 0;
  for (const part of bodyParts) { merged.set(part, offset); offset += part.length; }
  merged.set(new Uint8Array(fileData), offset); offset += fileData.byteLength;
  merged.set(end, offset);
  await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body:    merged,
  });
}

// ── WELCOME EMAIL (new firm signup) ──────────────────────────
async function handleWelcome(body: Record<string, unknown>) {
  const { toEmail, firmName, firmId } = body as {
    toEmail:  string;
    firmName: string;
    firmId:   string;
  };
  if (!toEmail) return;

  const res = await fetch("https://api.mailersend.com/v1/email", {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${MAILERSEND_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      from:    { email: "notifications@taxintakeflow.com", name: "TaxIntakeFlow" },
      to:      [{ email: toEmail }],
      subject: `Welcome to TaxIntakeFlow, ${firmName}!`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <div style="background:#0d1b2a;color:white;padding:20px 24px;border-radius:8px;margin-bottom:20px">
            <div style="font-size:10px;letter-spacing:2px;color:#c9a84c;text-transform:uppercase;margin-bottom:6px">TaxIntakeFlow</div>
            <h2 style="margin:0;font-size:20px">Welcome aboard! 🎉</h2>
          </div>
          <p style="font-size:14px;color:#3a3530;line-height:1.7;margin-bottom:16px">
            Hi! Your firm <strong>${firmName}</strong> is now set up on TaxIntakeFlow.
          </p>
          <div style="background:#f5f4f1;border-radius:8px;padding:16px 20px;margin-bottom:20px;font-size:13px;color:#5c5650;line-height:1.8">
            <strong style="display:block;margin-bottom:8px;color:#1a1a1a">Your links:</strong>
            📋 Intake form:<br>
            <span style="font-family:monospace;font-size:12px">https://taxintakeflow.com/intake.html?firmId=${firmId}</span><br><br>
            ✍️ Engagement letter:<br>
            <span style="font-family:monospace;font-size:12px">https://taxintakeflow.com/engagement.html?firmId=${firmId}</span>
          </div>
          <a href="https://taxintakeflow.com/portal.html"
             style="display:inline-block;background:#c9a84c;color:#0d1b2a;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:14px">
            Go to My Portal →
          </a>
          <p style="font-size:11px;color:#9b9488;margin-top:24px">TaxIntakeFlow · taxintakeflow.com</p>
        </div>
      `,
    }),
  });
  if (!res.ok) console.error(`MailerSend welcome error ${res.status}:`, await res.text());
}

// ── PREPARER INVITATION EMAIL ─────────────────────────────────
async function handlePreparerInvite(body: Record<string, unknown>) {
  const { toEmail, preparerName, firmName, joinLink } = body as {
    toEmail:      string;
    preparerName: string;
    firmName:     string;
    joinLink:     string;
  };
  if (!toEmail) return;

  const res = await fetch("https://api.mailersend.com/v1/email", {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${MAILERSEND_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      from:    { email: "notifications@taxintakeflow.com", name: "TaxIntakeFlow" },
      to:      [{ email: toEmail }],
      subject: `You've been invited to join ${firmName} on TaxIntakeFlow`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#0d1b2a;padding:28px 32px;border-radius:12px 12px 0 0">
            <div style="font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#c9a84c">TaxIntakeFlow</div>
          </div>
          <div style="background:white;border:1px solid #e5e4e0;border-top:none;padding:32px;border-radius:0 0 12px 12px">
            <h2 style="color:#0d1b2a;margin:0 0 12px">You've been invited${preparerName ? `, ${preparerName.split(" ")[0]}` : ""}!</h2>
            <p style="color:#55534e;line-height:1.6;margin:0 0 24px">
              <strong>${firmName}</strong> has invited you to join their tax firm on TaxIntakeFlow.
              Click the button below to create your account and get your personal client intake link.
            </p>
            <a href="${joinLink}"
               style="display:inline-block;background:#c9a84c;color:#0d1b2a;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:15px">
              Create My Account →
            </a>
            <p style="color:#99948e;font-size:12px;margin:24px 0 0">
              Or copy this link:<br>
              <span style="font-family:monospace;font-size:11px">${joinLink}</span>
            </p>
          </div>
        </div>
      `,
    }),
  });
  if (!res.ok) console.error(`MailerSend invite error ${res.status}:`, await res.text());
}

// ── EMAIL NOTIFICATIONS (MailerSend) ─────────────────────────
// ONLY this function changed from original. Everything above is identical.
//
// Key differences vs Resend:
//   Endpoint : https://api.mailersend.com/v1/email
//   from     : { email: "...", name: "..." }  ← object, not "Name <email>" string
//   to       : [{ email: "..." }]             ← array of objects, not array of strings
async function sendEmails(sub: any, firm: any, driveFolderUrl: string | null, pdfUrl: string) {
  const firmName   = firm?.firm_name   || "Your Tax Firm";
  const ownerEmail = firm?.owner_email || null;
  const clientName = `${sub.first_name || ""} ${sub.last_name || ""}`.trim();
  const driveLink  = driveFolderUrl
    ? `<a href="${driveFolderUrl}" style="color:#3b5bdb">View in Google Drive →</a>`
    : "";

  async function msend(from: string, fromName: string, to: string, subject: string, html: string) {
    const res = await fetch("https://api.mailersend.com/v1/email", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${MAILERSEND_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        from:    { email: from, name: fromName },
        to:      [{ email: to }],
        subject,
        html,
      }),
    });
    if (!res.ok) console.error(`MailerSend error ${res.status}:`, await res.text());
  }

  const emails = [];

  // Email 1: alert to firm owner / preparer
  if (ownerEmail) {
    emails.push(msend(
      "notifications@taxintakeflow.com",
      "TaxIntakeFlow",
      ownerEmail,
      `New Intake: ${clientName} — Tax Year ${sub.tax_year}`,
      `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <div style="background:#0d1b2a;color:white;padding:20px 24px;border-radius:8px;margin-bottom:20px">
          <div style="font-size:10px;letter-spacing:2px;color:#c9a84c;text-transform:uppercase;margin-bottom:6px">${firmName}</div>
          <h2 style="margin:0;font-size:20px">New Client Intake Submitted</h2>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
          <tr style="background:#f5f4f1"><td style="padding:10px 14px;font-weight:700;width:40%">Client</td><td style="padding:10px 14px">${clientName}</td></tr>
          <tr><td style="padding:10px 14px;font-weight:700;border-top:1px solid #f0eeea">Email</td><td style="padding:10px 14px;border-top:1px solid #f0eeea">${sub.email || "—"}</td></tr>
          <tr style="background:#f5f4f1"><td style="padding:10px 14px;font-weight:700">Phone</td><td style="padding:10px 14px">${sub.phone || "—"}</td></tr>
          <tr><td style="padding:10px 14px;font-weight:700;border-top:1px solid #f0eeea">Tax Year</td><td style="padding:10px 14px;border-top:1px solid #f0eeea">${sub.tax_year || "—"}</td></tr>
          <tr style="background:#f5f4f1"><td style="padding:10px 14px;font-weight:700">Filing Status</td><td style="padding:10px 14px">${(sub.filing_status || "").toUpperCase()}</td></tr>
          <tr><td style="padding:10px 14px;font-weight:700;border-top:1px solid #f0eeea">Preparer</td><td style="padding:10px 14px;border-top:1px solid #f0eeea">${sub.preparer_name || "Unassigned"}</td></tr>
          <tr style="background:#f5f4f1"><td style="padding:10px 14px;font-weight:700">Files Uploaded</td><td style="padding:10px 14px">${sub.uploaded_files_count || 0}</td></tr>
        </table>
        ${driveLink ? `<div style="margin-bottom:16px">${driveLink}</div>` : ""}
        <a href="https://taxintakeflow.com/portal.html" style="display:inline-block;background:#3b5bdb;color:white;padding:12px 24px;border-radius:7px;text-decoration:none;font-weight:700;font-size:13px">View in Portal →</a>
        <p style="font-size:11px;color:#9b9488;margin-top:20px">TaxIntakeFlow · taxintakeflow.com</p>
      </div>
      `
    ));
  }

  // Email 2: confirmation to client
  if (sub.email) {
    emails.push(msend(
      "notifications@taxintakeflow.com",
      firmName,
      sub.email,
      `Your intake form has been received — Tax Year ${sub.tax_year}`,
      `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <div style="background:#0d1b2a;color:white;padding:20px 24px;border-radius:8px;margin-bottom:20px">
          <div style="font-size:10px;letter-spacing:2px;color:#c9a84c;text-transform:uppercase;margin-bottom:6px">${firmName}</div>
          <h2 style="margin:0;font-size:20px">Intake Form Received ✓</h2>
        </div>
        <p style="font-size:14px;color:#3a3530;margin-bottom:20px">Hi ${sub.first_name || "there"},</p>
        <p style="font-size:14px;color:#3a3530;line-height:1.7;margin-bottom:20px">
          We've received your Tax Year ${sub.tax_year} intake form. Your assigned preparer <strong>${sub.preparer_name || "from our team"}</strong> will review your information and be in touch shortly.
        </p>
        <div style="background:#f5f4f1;border-radius:8px;padding:16px 20px;margin-bottom:20px;font-size:13px;color:#5c5650;line-height:1.7">
          <strong style="display:block;margin-bottom:8px;color:#1a1a1a">What happens next:</strong>
          1. Sign your Engagement Letter (link below)<br>
          2. We'll contact you if any documents are missing<br>
          3. You'll receive a fee quote before we file<br>
          4. Review and sign Form 8879 — then you're done!
        </div>
        <a href="https://taxintakeflow.com/engagement.html?firmId=${sub.firm_id}&firstName=${encodeURIComponent(sub.first_name||"")}&lastName=${encodeURIComponent(sub.last_name||"")}&email=${encodeURIComponent(sub.email||"")}&taxYear=${sub.tax_year}&preparer=${encodeURIComponent(sub.preparer_name||"")}&filingStatus=${sub.filing_status||"single"}"
           style="display:inline-block;background:#0d1b2a;color:white;padding:12px 24px;border-radius:7px;text-decoration:none;font-weight:700;font-size:13px;margin-bottom:20px">
          ✍️ Sign Engagement Letter →
        </a>
        <p style="font-size:11px;color:#9b9488">Questions? Reply to this email or contact ${firmName} directly.</p>
        <p style="font-size:11px;color:#9b9488;margin-top:8px">Ref: ${sub.id?.slice(0,8).toUpperCase()}</p>
      </div>
      `
    ));
  }

  await Promise.allSettled(emails);
}
