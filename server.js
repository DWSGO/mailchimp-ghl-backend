import "dotenv/config";
import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY || "";
const MAILCHIMP_AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID || "";
const MAILCHIMP_DC = process.env.MAILCHIMP_DC || ""; // e.g. us18
const PORT = Number(process.env.PORT || 8080);

// Health check
app.get("/", (req, res) => res.status(200).send("OK - Mailchimp X GHL backend running"));

function md5SubscriberHash(email) {
  return crypto
    .createHash("md5")
    .update(String(email).trim().toLowerCase())
    .digest("hex");
}

function parseTags(tags) {
  // Accept: ["a","b"] OR "a,b" OR "a"
  let list = [];
  if (Array.isArray(tags)) list = tags;
  else if (typeof tags === "string") {
    list = tags.split(",").map((t) => t.trim()).filter(Boolean);
  }
  // unique + max safety trimming
  return Array.from(new Set(list.map((t) => String(t).trim()).filter(Boolean)));
}

// GHL -> Mailchimp webhook
app.post("/webhooks/ghl-to-mailchimp", async (req, res) => {
  try {
    const body = req.body || {};

    // ✅ Support both styles if you ever accidentally send FNAME/LNAME
    const email = body.email;
    const firstName = body.firstName ?? body.FNAME ?? "";
    const lastName = body.lastName ?? body.LNAME ?? "";
    const tags = body.tags;

    if (!email) return res.status(400).json({ error: "email is required" });

    if (!MAILCHIMP_API_KEY || !MAILCHIMP_AUDIENCE_ID || !MAILCHIMP_DC) {
      return res.status(500).json({
        error:
          "Missing Mailchimp env vars: MAILCHIMP_API_KEY, MAILCHIMP_AUDIENCE_ID, MAILCHIMP_DC",
      });
    }

    const subscriberHash = md5SubscriberHash(email);

    // 1) Upsert member (create/update)
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
          merge_fields: {
            FNAME: String(firstName || ""),
            LNAME: String(lastName || ""),
          },
        }),
      }
    );

    if (!upsertResp.ok) {
      const txt = await upsertResp.text();
      return res.status(400).json({ error: "Mailchimp upsert failed", details: txt });
    }

    // 2) Apply tags (you want only newsletter — send "newsletter" from GHL)
    const tagList = parseTags(tags);

    if (tagList.length > 0) {
      const tagResp = await fetch(
        `https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists/${MAILCHIMP_AUDIENCE_ID}/members/${subscriberHash}/tags`,
        {
          method: "POST",
          headers: {
            Authorization: `apikey ${MAILCHIMP_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            tags: tagList.map((t) => ({ name: t, status: "active" })),
          }),
        }
      );

      if (!tagResp.ok) {
        const txt = await tagResp.text();
        return res.status(400).json({ error: "Mailchimp tag apply failed", details: txt });
      }
    }

    return res.json({ success: true, appliedTags: tagList });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
