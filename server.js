import "dotenv/config";
import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY || "";
const MAILCHIMP_AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID || "";
const MAILCHIMP_DC = process.env.MAILCHIMP_DC || ""; // e.g. us21
const PORT = Number(process.env.PORT || 8080);

// Optional: restrict which tags can ever be applied
// Example: ALLOWED_TAGS=newsletter
const ALLOWED_TAGS = (process.env.ALLOWED_TAGS || "")
  .split(",")
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean);

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing ENV: ${name}`);
}

function parseTags(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(String).map(s => s.trim()).filter(Boolean);
  return String(input)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function filterAllowedTags(tags) {
  if (ALLOWED_TAGS.length === 0) return tags;
  return tags.filter((t) => ALLOWED_TAGS.includes(String(t).toLowerCase()));
}

async function mailchimpFetch(url, { method, body }) {
  const auth = Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString("base64");

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  return { ok: resp.ok, status: resp.status, text, json };
}

// Health check
app.get("/", (req, res) =>
  res.status(200).send("OK - Mailchimp X GHL backend running")
);

// DEBUG: shows exactly what GHL is sending
app.post("/debug/echo", (req, res) => {
  return res.json({
    received: req.body,
    keys: Object.keys(req.body || {}),
  });
});

function pickFirstName(body) {
  // GHL standard payload usually uses first_name / last_name (snake_case)
  return (
    body.first_name ||
    body.firstName ||
    body.FNAME ||
    body.fname ||
    body.contact?.first_name ||
    body.contact?.firstName ||
    ""
  );
}

function pickLastName(body) {
  return (
    body.last_name ||
    body.lastName ||
    body.LNAME ||
    body.lname ||
    body.contact?.last_name ||
    body.contact?.lastName ||
    ""
  );
}

function pickEmail(body) {
  return body.email || body.Email || body.contact?.email || "";
}

app.post("/webhooks/ghl-to-mailchimp", async (req, res) => {
  try {
    requireEnv("MAILCHIMP_API_KEY", MAILCHIMP_API_KEY);
    requireEnv("MAILCHIMP_AUDIENCE_ID", MAILCHIMP_AUDIENCE_ID);
    requireEnv("MAILCHIMP_DC", MAILCHIMP_DC);

    const body = req.body || {};

    const email = pickEmail(body);
    if (!email) return res.status(400).json({ error: "email is required" });

    // Prefer custom keys you control (apply_tags) instead of GHL standard tags
    // so you don’t accidentally apply all contact tags.
    const rawTags =
      body.apply_tags ??
      body.applyTags ??
      body.tags ??
      body.tag ??
      body.contact?.tags ??
      "";

    let firstName = String(pickFirstName(body) || "").trim();
    let lastName = String(pickLastName(body) || "").trim();

    // If names are missing but full_name exists, try splitting
    if ((!firstName || !lastName) && body.full_name) {
      const parts = String(body.full_name).trim().split(/\s+/);
      if (!firstName && parts.length) firstName = parts[0];
      if (!lastName && parts.length > 1) lastName = parts.slice(1).join(" ");
    }

    const subscriberHash = crypto
      .createHash("md5")
      .update(String(email).toLowerCase())
      .digest("hex");

    // 1) Upsert member (merge fields)
    const upsertUrl = `https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists/${MAILCHIMP_AUDIENCE_ID}/members/${subscriberHash}`;

    const upsert = await mailchimpFetch(upsertUrl, {
      method: "PUT",
      body: {
        email_address: String(email),
        status_if_new: "subscribed",
        merge_fields: {
          FNAME: firstName,
          LNAME: lastName,
        },
      },
    });

    if (!upsert.ok) {
      return res.status(400).json({
        error: "Mailchimp upsert failed",
        status: upsert.status,
        details: upsert.json || upsert.text,
      });
    }

    // 2) Tags (filtered)
    let tagList = parseTags(rawTags);
    tagList = filterAllowedTags(tagList);

    if (tagList.length > 0) {
      const tagUrl = `https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists/${MAILCHIMP_AUDIENCE_ID}/members/${subscriberHash}/tags`;

      const tagResp = await mailchimpFetch(tagUrl, {
        method: "POST",
        body: { tags: tagList.map((t) => ({ name: String(t), status: "active" })) },
      });

      if (!tagResp.ok) {
        return res.status(400).json({
          error: "Mailchimp tag apply failed",
          status: tagResp.status,
          details: tagResp.json || tagResp.text,
        });
      }
    }

    return res.json({
      success: true,
      email,
      firstName,
      lastName,
      appliedTags: tagList,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
