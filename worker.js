// Cloudflare Worker entry for bandrproduction.com (Workers Static Assets).
//
// Static files are served directly by the assets binding; this Worker is only
// invoked for requests that don't match a static asset — i.e. /api/quote.
//
// Required Cloudflare env var (Workers > Settings > Variables and Secrets):
//   RESEND_API_KEY  (secret)  — your Resend API key
// Optional (env vars override these defaults):
//   QUOTE_TO      — where leads are delivered (default sales@bandrproduction.com)
//   QUOTE_FROM    — verified Resend sender (default forms@bandrproduction.com)
//   QUOTE_CC      — extra CC recipient(s), comma-separated (default hello@aaron.chat)
//   LEAD_WEBHOOK  — optional URL to POST every lead to (Airtable/Zapier/Make/CRM)
//   DIGEST_TO     — where the weekly Monday digest goes (default hello@aaron.chat)
//
// Optional Cloudflare bindings (dashboard → Settings → Variables/Bindings):
//   LEADS_KV      — KV Namespace binding. When present, every submission is
//                   logged as key `lead:<epoch-ms>` for the weekly digest.
//                   Enable: Workers > KV > Create namespace, then bind to this
//                   Worker as `LEADS_KV`. No code change needed.
//
// Cron: Monday 13:00 UTC (~08:00 CT) → sends the past-7-days lead digest to
// DIGEST_TO. Configured in wrangler.jsonc under `triggers.crons`.
//
// NOTE: the QUOTE_FROM domain must be verified in Resend before delivery
// works. For a quick test before verifying bandrproduction.com, set
// QUOTE_FROM="B&R Productions <onboarding@resend.dev>" (Resend's shared
// sender only delivers to the Resend account owner's own address).

const PHONE = "936-291-7827";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function clean(v, max) {
  return (v == null ? "" : String(v)).trim().slice(0, max);
}

async function handleQuote(request, env, ctx) {
  try {
    const ct = request.headers.get("content-type") || "";
    let d = {};
    if (ct.includes("application/json")) {
      d = await request.json();
    } else {
      const form = await request.formData();
      for (const [k, v] of form.entries()) d[k] = v;
    }

    // Honeypot — silently accept (so bots think they succeeded)
    if (clean(d._gotcha, 100)) return json({ ok: true });

    const name = clean(d.name, 200);
    const email = clean(d.email, 200);
    const phone = clean(d.phone, 50);
    const company = clean(d.company, 200);
    const message = clean(d.message, 5000);
    const source = clean(d._source, 100) || "website";

    if (!name || !email || !message) {
      return json({ ok: false, error: "Please fill in your name, email, and project details." }, 400);
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ ok: false, error: "Please enter a valid email address." }, 400);
    }

    const lines = [
      `New submission from the ${source} form on bandrproduction.com`,
      "",
      `Name: ${name}`,
      `Email: ${email}`,
      phone ? `Phone: ${phone}` : null,
      company ? `Company: ${company}` : null,
      "",
      "Project details:",
      message,
    ].filter((l) => l !== null);

    if (!env.RESEND_API_KEY) {
      return json({ ok: false, error: "Email is not configured yet." }, 500);
    }

    // CC recipients — QUOTE_CC env var (comma-separated) overrides the default.
    const ccRaw = env.QUOTE_CC != null ? String(env.QUOTE_CC) : "hello@aaron.chat";
    const cc = clean(ccRaw, 500)
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);

    const payload = {
      from: env.QUOTE_FROM || "B&R Productions Website <forms@bandrproduction.com>",
      to: [env.QUOTE_TO || "sales@bandrproduction.com"],
      reply_to: email,
      subject: `New ${source} request: ${name}${company ? " (" + company + ")" : ""}`,
      text: lines.join("\n"),
    };
    if (cc.length) payload.cc = cc;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.log("Resend error", res.status, detail);
      return json({ ok: false, error: `We couldn't send your message. Please call ${PHONE}.` }, 502);
    }

    // Fire-and-forget: log to KV + POST to optional external webhook.
    // Both are opportunistic — a KV or webhook failure must not surface to the
    // visitor. ctx.waitUntil lets the Worker return to the browser immediately.
    const lead = { ts: Date.now(), name, email, phone, company, message, source };
    if (ctx && env.LEADS_KV) {
      const key = `lead:${lead.ts}:${Math.floor(Math.random() * 1e6).toString(36)}`;
      ctx.waitUntil(
        env.LEADS_KV.put(key, JSON.stringify(lead), { expirationTtl: 60 * 60 * 24 * 400 }).catch((e) =>
          console.log("KV put failed", e && e.message)
        )
      );
    }
    if (ctx && env.LEAD_WEBHOOK) {
      ctx.waitUntil(
        fetch(env.LEAD_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(lead),
        }).catch((e) => console.log("webhook failed", e && e.message))
      );
    }

    return json({ ok: true });
  } catch (err) {
    console.log("quote worker error", err && err.message);
    return json({ ok: false, error: `Something went wrong. Please call ${PHONE}.` }, 500);
  }
}

// ---------------------------------------------------------------------------
// Monday digest — pulls the last 7 days of leads from KV and emails a summary
// to DIGEST_TO. Runs on the cron schedule defined in wrangler.jsonc.
// If LEADS_KV isn't bound yet, sends a "no data yet" note so we notice.
// ---------------------------------------------------------------------------
async function sendWeeklyDigest(env) {
  if (!env.RESEND_API_KEY) {
    console.log("digest skipped: no RESEND_API_KEY");
    return;
  }
  const to = env.DIGEST_TO || "hello@aaron.chat";
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const leads = [];
  let kvWarning = "";

  if (env.LEADS_KV) {
    let cursor = undefined;
    do {
      const list = await env.LEADS_KV.list({ prefix: "lead:", cursor, limit: 1000 });
      for (const k of list.keys) {
        const ts = parseInt(k.name.split(":")[1] || "0", 10);
        if (ts < cutoff) continue;
        const raw = await env.LEADS_KV.get(k.name);
        if (raw) {
          try { leads.push(JSON.parse(raw)); } catch (_) {}
        }
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
    leads.sort((a, b) => a.ts - b.ts);
  } else {
    kvWarning = "\nNote: LEADS_KV isn't bound to this Worker yet — bind it in Cloudflare Dashboard (Workers > bandrproduction > Settings > Bindings > KV Namespace) as `LEADS_KV` to start capturing weekly lead history.";
  }

  const lines = [
    `B&R Productions — weekly lead digest (${new Date().toISOString().slice(0, 10)})`,
    `Window: last 7 days.`,
    "",
    `Leads captured: ${leads.length}`,
  ];
  if (leads.length) {
    lines.push("");
    for (const l of leads) {
      const when = new Date(l.ts).toISOString().replace("T", " ").slice(0, 16);
      lines.push(
        `- [${when} UTC] ${l.name || "(no name)"} <${l.email || "(no email)"}>`
        + (l.company ? ` @ ${l.company}` : "")
        + (l.source ? `  (source: ${l.source})` : "")
      );
      if (l.message) {
        lines.push(`    ${String(l.message).replace(/\s+/g, " ").slice(0, 220)}`);
      }
    }
  } else {
    lines.push("");
    lines.push("No new quote-form submissions this week.");
  }
  if (kvWarning) lines.push(kvWarning);
  lines.push("");
  lines.push("Full site: https://bandrproduction.com");
  lines.push("Quote form: https://bandrproduction.com/about-us/get-a-quote/");

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.QUOTE_FROM || "B&R Productions Website <forms@bandrproduction.com>",
      to: [to],
      subject: `B&R weekly lead digest — ${leads.length} lead${leads.length === 1 ? "" : "s"}`,
      text: lines.join("\n"),
    }),
  }).catch((e) => console.log("digest send failed", e && e.message));
}

// ---------------------------------------------------------------------------
// Outreach — Aaron-in-the-loop personal email tool.
// Not a cold-email campaign: each send is per-click, one recipient at a time,
// from a real inbox, plain text, no tracking. The Worker's job is to draft, log,
// and remind Aaron to follow up. See /outreach/ UI.
// ---------------------------------------------------------------------------

const OUTREACH_COOKIE = "br_out";
const TOUCH_INTERVAL_MS = 5 * 24 * 60 * 60 * 1000;

function outreachAuth(request, env) {
  if (!env.OUTREACH_TOKEN) return { ok: false, code: 503, msg: "outreach not configured — set OUTREACH_TOKEN in Cloudflare" };
  const url = new URL(request.url);
  const tokenParam = url.searchParams.get("token");
  const cookieRaw = request.headers.get("cookie") || "";
  const cookieMatch = cookieRaw.split(/;\s*/).find((c) => c.startsWith(OUTREACH_COOKIE + "="));
  const cookieToken = cookieMatch ? cookieMatch.split("=", 2)[1] : "";
  if (tokenParam && tokenParam === env.OUTREACH_TOKEN) return { ok: true, setCookie: true };
  if (cookieToken && cookieToken === env.OUTREACH_TOKEN) return { ok: true, setCookie: false };
  return { ok: false, code: 401, msg: "unauthorized" };
}

function draftEmail({ firstName, name, company, context }) {
  const first = (firstName || (name || "").split(" ")[0] || "there").trim();
  const co = (company || "your team").trim();
  const ctx = (context || "").trim();
  const ctxLine = ctx ? `Quick context — ${ctx}.\n\n` : "";
  const subject = ctx.length > 12
    ? `quick question, ${co}`
    : `quick question about ${co}`;
  const body = `Hey ${first},

${ctxLine}We're a New Waverly, TX shop that runs Inconel and duplex weekly — frac pump internals, wellhead components, downhole tool bodies — and I'm not sure whether we'd be useful at ${co} or not.

Rather than pitch: is CNC vendor sourcing something you handle, or is there someone else at ${co} I should be talking to?

— Aaron
B&R Productions
(936) 291-7827`;
  return { subject, body };
}

function draftFollowup(prospect, n) {
  const first = (prospect.firstName || (prospect.name || "").split(" ")[0] || "there").trim();
  const co = (prospect.company || "your team").trim();
  if (n === 2) {
    return {
      subject: `re: ${prospect.touches[0]?.subject || "quick question"}`,
      body: `Hey ${first},

Bumping this in case my note got buried.

If someone else at ${co} handles vendor sourcing, happy to be pointed their way. If it's the wrong fit entirely, no worries — I'll stop bothering you.

— Aaron`,
    };
  }
  return {
    subject: `closing the loop`,
    body: `Hey ${first},

Last one — will stop after this.

If a rig-down or emergency exotic-alloy job ever lands on your desk, my direct is (936) 291-7827. Otherwise, wish you well.

— Aaron
B&R Productions`,
  };
}

async function outreachSend(request, env, ctx) {
  const auth = outreachAuth(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.msg }, auth.code);
  if (!env.RESEND_API_KEY) return json({ ok: false, error: "RESEND_API_KEY not set" }, 500);
  let d;
  try { d = await request.json(); } catch { return json({ ok: false, error: "bad JSON" }, 400); }
  const { email, name, firstName, company, subject, body, touch = 1, prospectId } = d;
  if (!email || !subject || !body) return json({ ok: false, error: "email/subject/body required" }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: "invalid email" }, 400);

  const from = env.OUTREACH_FROM || "Aaron @ B&R Productions <aaron@bandrproduction.com>";
  const replyTo = from.match(/<([^>]+)>/)?.[1] || from;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [email], reply_to: replyTo, subject, text: body }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.log("outreach send failed", res.status, detail);
    return json({ ok: false, error: `send failed (${res.status})` }, 502);
  }

  const now = Date.now();
  const pid = prospectId || `outreach:${now}:${email}`;
  let entry = { email, name, firstName, company, touches: [], status: "active", createdAt: now };
  if (env.LEADS_KV) {
    const existing = await env.LEADS_KV.get(pid);
    if (existing) { try { entry = JSON.parse(existing); } catch (_) {} }
  }
  entry.touches = entry.touches || [];
  entry.touches.push({ n: touch, sent_at: now, subject });
  entry.lastTouchAt = now;
  entry.nextTouchN = touch < 3 ? touch + 1 : null;
  entry.next_touch_at = entry.nextTouchN ? now + TOUCH_INTERVAL_MS : null;
  entry.status = entry.nextTouchN ? "active" : "done";
  if (env.LEADS_KV) ctx.waitUntil(env.LEADS_KV.put(pid, JSON.stringify(entry)));
  return json({ ok: true, prospectId: pid, nextTouchN: entry.nextTouchN, nextTouchAt: entry.next_touch_at });
}

async function outreachMark(request, env, ctx) {
  const auth = outreachAuth(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.msg }, auth.code);
  if (!env.LEADS_KV) return json({ ok: false, error: "LEADS_KV not bound" }, 500);
  const d = await request.json().catch(() => ({}));
  const { prospectId, status } = d;
  if (!prospectId || !["replied", "skip", "closed"].includes(status)) {
    return json({ ok: false, error: "prospectId + status ∈ {replied,skip,closed}" }, 400);
  }
  const raw = await env.LEADS_KV.get(prospectId);
  if (!raw) return json({ ok: false, error: "not found" }, 404);
  let entry;
  try { entry = JSON.parse(raw); } catch { return json({ ok: false, error: "corrupt entry" }, 500); }
  entry.status = status;
  if (status !== "active") { entry.next_touch_at = null; entry.nextTouchN = null; }
  ctx.waitUntil(env.LEADS_KV.put(prospectId, JSON.stringify(entry)));
  return json({ ok: true });
}

async function outreachList(request, env) {
  const auth = outreachAuth(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.msg }, auth.code);
  if (!env.LEADS_KV) return json({ ok: false, prospects: [], warning: "LEADS_KV not bound" });
  const now = Date.now();
  const items = [];
  let cursor = undefined;
  do {
    const list = await env.LEADS_KV.list({ prefix: "outreach:", cursor, limit: 1000 });
    for (const k of list.keys) {
      const raw = await env.LEADS_KV.get(k.name);
      if (!raw) continue;
      try { items.push({ id: k.name, ...JSON.parse(raw) }); } catch (_) {}
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  items.sort((a, b) => (b.lastTouchAt || b.createdAt || 0) - (a.lastTouchAt || a.createdAt || 0));
  const due = items.filter((p) => p.status === "active" && p.next_touch_at && p.next_touch_at <= now);
  return json({ ok: true, total: items.length, due: due.length, prospects: items });
}

function outreachUI(request, env) {
  const auth = outreachAuth(request, env);
  if (!auth.ok) {
    return new Response(
      "<h1>Outreach</h1><p>" + (auth.msg || "unauthorized") + "</p><p>Visit <code>/outreach/?token=YOUR_TOKEN</code> to sign in.</p>",
      { status: auth.code, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
  const html = OUTREACH_HTML;
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
  if (auth.setCookie) {
    headers["Set-Cookie"] = `${OUTREACH_COOKIE}=${env.OUTREACH_TOKEN}; Path=/outreach; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
  }
  return new Response(html, { headers });
}

async function outreachDraft(request, env) {
  const auth = outreachAuth(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.msg }, auth.code);
  const d = await request.json().catch(() => ({}));
  const { firstName, name, email, company, context, touch = 1, prior } = d;
  if (!email || !company) return json({ ok: false, error: "email + company required" }, 400);
  const draft = touch === 1 ? draftEmail({ firstName, name, company, context })
    : draftFollowup({ firstName, name, company, touches: prior?.touches || [] }, touch);
  return json({ ok: true, ...draft });
}

// Extends the weekly digest to also flag outreach follow-ups due today.
async function sendOutreachReminder(env) {
  if (!env.RESEND_API_KEY || !env.LEADS_KV) return;
  const to = env.DIGEST_TO || "hello@aaron.chat";
  const now = Date.now();
  const due = [];
  let cursor = undefined;
  do {
    const list = await env.LEADS_KV.list({ prefix: "outreach:", cursor, limit: 1000 });
    for (const k of list.keys) {
      const raw = await env.LEADS_KV.get(k.name);
      if (!raw) continue;
      try {
        const p = JSON.parse(raw);
        if (p.status === "active" && p.next_touch_at && p.next_touch_at <= now) {
          due.push({ id: k.name, ...p });
        }
      } catch (_) {}
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  if (!due.length) return;  // no reminder email if nothing due
  const lines = [
    `B&R Outreach — ${due.length} follow-up${due.length === 1 ? "" : "s"} due`,
    "",
    "Open /outreach/ to send or skip each:",
    "",
  ];
  for (const p of due.slice(0, 20)) {
    const daysAgo = Math.round((now - (p.lastTouchAt || p.createdAt)) / (24 * 60 * 60 * 1000));
    lines.push(`- ${p.name || p.email} @ ${p.company || "—"}  (touch ${p.nextTouchN}, last sent ${daysAgo}d ago)`);
  }
  if (due.length > 20) lines.push(`... and ${due.length - 20} more`);
  lines.push("", "https://bandrproduction.com/outreach/");
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.QUOTE_FROM || "B&R Productions <forms@bandrproduction.com>",
      to: [to],
      subject: `Outreach — ${due.length} follow-up${due.length === 1 ? "" : "s"} due`,
      text: lines.join("\n"),
    }),
  }).catch((e) => console.log("outreach reminder send failed", e && e.message));
}

// Inline HTML for the /outreach/ UI. Kept dependency-free — vanilla JS, fetch,
// no bundler. Password-token is set via cookie on first visit with ?token=.
const OUTREACH_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Outreach — B&R Productions</title>
<meta name="robots" content="noindex,nofollow"/>
<style>
:root{--brand:#0C74C0;--ink:#0f1e3a;--muted:#4a5568;--bg:#F4F5F6;--card:#fff;--border:#DDE0E4;--green:#1b7a3a;--red:#b00020}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);line-height:1.5}
.top{background:#0d0d0d;color:#fff;padding:14px 20px;font-weight:700}
.top a{color:#fff;text-decoration:none;font-size:14px;margin-left:12px;opacity:.75}
.wrap{max-width:900px;margin:24px auto;padding:0 20px}
h1{font-size:24px;margin:0 0 6px}
p.sub{color:var(--muted);margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:22px;margin-bottom:22px}
.card h2{margin:0 0 14px;font-size:18px;color:var(--brand)}
label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin:12px 0 5px;text-transform:uppercase;letter-spacing:.03em}
input,textarea{width:100%;padding:10px 12px;font-size:15px;font-family:inherit;border:1px solid var(--border);border-radius:6px;background:#fff;color:var(--ink)}
textarea{resize:vertical}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
button{padding:10px 20px;border:0;border-radius:6px;font-weight:600;font-size:15px;cursor:pointer;font-family:inherit}
button.primary{background:var(--brand);color:#fff}
button.primary:hover{background:#0a5f9c}
button.ghost{background:transparent;color:var(--brand);border:1px solid var(--brand)}
button.danger{background:transparent;color:var(--red);border:1px solid var(--red)}
.status{margin-top:14px;padding:10px 12px;border-radius:6px;font-size:14px}
.status.ok{background:#e6f4ea;color:var(--green)}
.status.err{background:#fdecea;color:var(--red)}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.03em}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600}
.badge.active{background:#e6f0fb;color:var(--brand)}
.badge.due{background:#fef2e6;color:#b56100}
.badge.done{background:#eee;color:#666}
.badge.replied{background:#e6f4ea;color:var(--green)}
small{color:var(--muted)}
</style>
</head>
<body>
<div class="top">B&R Outreach <a href="/">← site</a></div>
<div class="wrap">
  <h1>Send a personal note</h1>
  <p class="sub">One prospect at a time. Draft, edit, send. Follow-ups scheduled every 5 days. Max 3 touches. Reply-to is Aaron's inbox.</p>

  <div class="card">
    <h2>Compose</h2>
    <div class="row">
      <div><label>First name</label><input id="firstName" placeholder="e.g., Sarah"/></div>
      <div><label>Company</label><input id="company" placeholder="e.g., Acme Frac Pumps"/></div>
    </div>
    <label>Email</label><input id="email" type="email" placeholder="prospect@company.com"/>
    <label>Context (one line, in your own words)</label>
    <input id="context" placeholder="saw them post on LinkedIn about needing frac pump work"/>
    <div class="btns">
      <button class="ghost" onclick="doDraft()">Draft →</button>
    </div>

    <div id="draftbox" style="display:none;margin-top:22px;border-top:1px solid var(--border);padding-top:18px">
      <label>Subject</label><input id="subject"/>
      <label>Body</label><textarea id="body" rows="12"></textarea>
      <div class="btns">
        <button class="primary" onclick="doSend()">Send</button>
        <button class="ghost" onclick="doDraft()">Redraft</button>
      </div>
      <div id="sendStatus" class="status" style="display:none"></div>
    </div>
  </div>

  <div class="card">
    <h2>Pending follow-ups</h2>
    <div id="pending"></div>
  </div>

  <div class="card">
    <h2>Recent (last 20)</h2>
    <div id="recent"></div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
function showStatus(el, ok, msg){ el.style.display='block'; el.className='status '+(ok?'ok':'err'); el.textContent=msg; }
async function post(path, body){
  const r = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {status:r.status, json: await r.json().catch(()=>({}))};
}
async function get(path){
  const r = await fetch(path);
  return {status:r.status, json: await r.json().catch(()=>({}))};
}
async function doDraft(){
  const body = {firstName:$('firstName').value, email:$('email').value, company:$('company').value, context:$('context').value, touch:1};
  const r = await post('/outreach/api/draft', body);
  if(!r.json.ok){ alert(r.json.error || 'draft failed'); return; }
  $('subject').value = r.json.subject;
  $('body').value = r.json.body;
  $('draftbox').style.display = 'block';
  $('sendStatus').style.display = 'none';
}
async function doSend(){
  const body = {
    firstName:$('firstName').value, email:$('email').value, company:$('company').value,
    subject:$('subject').value, body:$('body').value, touch:1
  };
  const r = await post('/outreach/api/send', body);
  const st = $('sendStatus');
  if(r.json.ok){
    showStatus(st, true, 'Sent. Follow-up scheduled in 5 days.');
    ['firstName','email','company','context','subject','body'].forEach(id=>$(id).value='');
    $('draftbox').style.display = 'none';
    setTimeout(loadList, 600);
  } else {
    showStatus(st, false, 'Failed: ' + (r.json.error || 'unknown'));
  }
}
async function doFollowup(id, prospect){
  const draft = await post('/outreach/api/draft', {
    firstName: prospect.firstName || prospect.name, company: prospect.company,
    touch: prospect.nextTouchN, prior: prospect
  });
  if(!draft.json.ok){ alert('draft failed'); return; }
  const body = prompt('Editing touch ' + prospect.nextTouchN + '. Subject: ' + draft.json.subject + '\\n\\nBody (edit or paste OK, then submit):', draft.json.body);
  if(body === null) return;
  const r = await post('/outreach/api/send', {
    firstName: prospect.firstName || prospect.name, email: prospect.email, company: prospect.company,
    subject: draft.json.subject, body, touch: prospect.nextTouchN, prospectId: id
  });
  if(r.json.ok){ alert('Sent.'); loadList(); } else { alert('Failed: ' + r.json.error); }
}
async function doMark(id, status){
  if(!confirm('Mark ' + status + '?')) return;
  const r = await post('/outreach/api/mark', {prospectId:id, status});
  if(r.json.ok) loadList(); else alert(r.json.error || 'failed');
}
function fmtRel(ts){
  if(!ts) return '—';
  const d = Math.round((Date.now()-ts)/(24*3600*1000));
  return d < 1 ? 'today' : d + 'd ago';
}
function badge(p){
  const now = Date.now();
  if(p.status==='replied') return '<span class="badge replied">replied</span>';
  if(p.status==='closed' || p.status==='done') return '<span class="badge done">done</span>';
  if(p.status==='skip') return '<span class="badge done">skipped</span>';
  if(p.next_touch_at && p.next_touch_at <= now) return '<span class="badge due">due</span>';
  return '<span class="badge active">active</span>';
}
async function loadList(){
  const r = await get('/outreach/api/list');
  if(!r.json.ok){ $('recent').innerHTML = '<small>' + (r.json.warning || r.json.error || 'list failed') + '</small>'; return; }
  const items = r.json.prospects || [];
  const now = Date.now();
  const due = items.filter(p => p.status==='active' && p.next_touch_at && p.next_touch_at <= now);
  const recent = items.slice(0, 20);
  function row(p, showFollowup){
    const co = (p.company||'').replace(/</g,'&lt;');
    const nm = (p.name||p.firstName||p.email||'').replace(/</g,'&lt;');
    const em = (p.email||'').replace(/</g,'&lt;');
    const nextTouch = p.nextTouchN ? ('touch '+p.nextTouchN) : '—';
    const btns = showFollowup
      ? '<button class="primary" onclick=\\'doFollowup("'+p.id+'",'+JSON.stringify(p).replace(/"/g,'&quot;')+')\\'>Send follow-up</button> '+
        '<button class="ghost" onclick=\\'doMark("'+p.id+'","replied")\\'>Mark replied</button> '+
        '<button class="danger" onclick=\\'doMark("'+p.id+'","skip")\\'>Skip</button>'
      : '<button class="ghost" onclick=\\'doMark("'+p.id+'","replied")\\'>Mark replied</button>';
    return '<tr><td><strong>'+nm+'</strong><br><small>'+em+'</small></td>'+
           '<td>'+co+'</td>'+
           '<td>'+badge(p)+'<br><small>'+nextTouch+'</small></td>'+
           '<td><small>last '+fmtRel(p.lastTouchAt||p.createdAt)+'</small></td>'+
           '<td>'+btns+'</td></tr>';
  }
  const tbl = (rows, empty) => rows.length
    ? '<table><thead><tr><th>Contact</th><th>Company</th><th>Status</th><th>Timing</th><th>Actions</th></tr></thead><tbody>'+rows.join('')+'</tbody></table>'
    : '<small>' + empty + '</small>';
  $('pending').innerHTML = tbl(due.map(p=>row(p,true)), 'No follow-ups due right now.');
  $('recent').innerHTML  = tbl(recent.map(p=>row(p,false)), 'No prospects yet — draft your first one above.');
}
loadList();
</script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    // Quote form endpoint
    if (p === "/api/quote") {
      if (request.method === "POST") return handleQuote(request, env, ctx);
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    // Outreach UI + API
    if (p === "/outreach" || p === "/outreach/") return outreachUI(request, env);
    if (p === "/outreach/api/draft"  && request.method === "POST") return outreachDraft(request, env);
    if (p === "/outreach/api/send"   && request.method === "POST") return outreachSend(request, env, ctx);
    if (p === "/outreach/api/mark"   && request.method === "POST") return outreachMark(request, env, ctx);
    if (p === "/outreach/api/list"   && request.method === "GET")  return outreachList(request, env);
    // Fallback: serve static assets (normally handled before the Worker runs).
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    // Monday: full leads digest. Every day: outreach follow-up reminder if any due.
    const dow = new Date(event.scheduledTime || Date.now()).getUTCDay(); // 1 = Monday UTC
    if (dow === 1) ctx.waitUntil(sendWeeklyDigest(env));
    ctx.waitUntil(sendOutreachReminder(env));
  },
};
