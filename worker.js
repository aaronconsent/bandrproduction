// Cloudflare Worker entry for bandrproduction.com (Workers Static Assets).
//
// Static files are served directly by the assets binding; this Worker is only
// invoked for requests that don't match a static asset — i.e. /api/quote.
//
// Required Cloudflare env var (Workers > Settings > Variables and Secrets):
//   RESEND_API_KEY  (secret)  — your Resend API key
// Optional (env vars override these defaults):
//   QUOTE_TO    — where leads are delivered (default sales@bandrproduction.com)
//   QUOTE_FROM  — verified Resend sender (default forms@bandrproduction.com)
//   QUOTE_CC    — extra CC recipient(s), comma-separated (default hello@aaron.chat)
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

async function handleQuote(request, env) {
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

    return json({ ok: true });
  } catch (err) {
    console.log("quote worker error", err && err.message);
    return json({ ok: false, error: `Something went wrong. Please call ${PHONE}.` }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/quote") {
      if (request.method === "POST") return handleQuote(request, env);
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    // Fallback: serve static assets (normally handled before the Worker runs).
    return env.ASSETS.fetch(request);
  },
};
