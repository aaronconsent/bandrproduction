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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/quote") {
      if (request.method === "POST") return handleQuote(request, env, ctx);
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    // Fallback: serve static assets (normally handled before the Worker runs).
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendWeeklyDigest(env));
  },
};
