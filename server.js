import "dotenv/config";
import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY || "";
const MAILCHIMP_AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID || "";
const MAILCHIMP_DC = process.env.MAILCHIMP_DC || ""; // e.g. us18
const PORT = Number(process.env.PORT || 8080);

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

// Accept tags as: ["newsletter"] OR "newsletter" OR "newsletter, GHL"
function normalizeTags(input) {
  if (Array.isArray(input)) {
    return input.map((t) => String(t).trim()).filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

app.get("/", (req, res) => {
  res.status(200).send("OK - Mailchimp X GHL backend running");
});

app.post("/webhooks/ghl-to-mailchimp", async (req, res) => {
  try {
    if (!MAILCHIMP_API_KEY || !MAILCHIMP_AUDIENCE_ID || !MAILCHIMP_DC) {
      return res.status(500).json({
        error:
          "Missing Mailchimp env vars: MAILCHIMP_API_KEY, MAILCHIMP_AUDIENCE_ID, MAILCHIMP_DC",
      });
    }

    // ✅ Support multiple field names coming from GHL
    const body = req.body || {};
    const email = normalizeEmail(body.email || body.Email || body.contact_email);

    // These two lines fix your issue (supports both naming styles)
    const firstName = pickFirst(body.firstName, body.firstname, body.FNAME, body.fname);
    const lastName = pickFirst(body.lastName, body.lastname, body.LNAME, body.lname);

    // ✅ Support both tags / tag, and string/array
    const tags = normalizeTags(body.tags ?? body.tag);

    if (!email) return res.status(400).json({ error: "email is required" });

    const subscriberHash = crypto.createHash("md5").update(email).digest("hex");

    // 1) Upsert member
    const upsertResp = await fetch(
      `https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists/${MAILCHIMP_AUDIENCE_ID}/members/${subscriberHash}`,
      {
        method: "PUT",
        headers: {
          Authorization: `apikey ${MAILCHIMP_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email_address: email,
          status_if_new: "subscribed",
          // Mailchimp merge fields must be FNAME/LNAME
          merge_fields: {
            FNAME: firstName || "",
            LNAME: lastName || "",
          },
        }),
      }
    );

    if (!upsertResp.ok) {
      const txt = await upsertResp.text();
      return res.status(400).json({ error: "Mailchimp upsert failed", details: txt });
    }

    // 2) Apply tags (optional)
    if (tags.length > 0) {
      const tagResp = await fetch(
        `https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists/${MAILCHIMP_AUDIENCE_ID}/members/${subscriberHash}/tags`,
        {
          method: "POST",
          headers: {
            Authorization: `apikey ${MAILCHIMP_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            tags: tags.map((t) => ({ name: String(t), status: "active" })),
          }),
        }
      );

      if (!tagResp.ok) {
        const txt = await tagResp.text();
        return res.status(400).json({ error: "Mailchimp tag apply failed", details: txt });
      }
    }

    return res.json({ success: true, email, firstName, lastName, tags });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
