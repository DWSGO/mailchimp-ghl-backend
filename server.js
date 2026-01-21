import "dotenv/config";
import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY || "";
const MAILCHIMP_AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID || "";
const MAILCHIMP_DC = process.env.MAILCHIMP_DC || ""; // e.g. us21
const PORT = Number(process.env.PORT || 8080);

// Health check
app.get("/", (req, res) => {
  res.status(200).send("OK - Mailchimp X GHL backend running");
});

// GHL -> Mailchimp webhook
app.post("/webhooks/ghl-to-mailchimp", async (req, res) => {
  try {
    const { email, firstName, lastName, tags } = req.body || {};
    if (!email) return res.status(400).json({ error: "email is required" });

    if (!MAILCHIMP_API_KEY || !MAILCHIMP_AUDIENCE_ID || !MAILCHIMP_DC) {
      return res.status(500).json({
        error:
          "Missing Mailchimp env vars: MAILCHIMP_API_KEY, MAILCHIMP_AUDIENCE_ID, MAILCHIMP_DC",
      });
    }

    // Mailchimp identifies contacts by MD5(email_lowercase)
    const subscriberHash = crypto
      .createHash("md5")
      .update(String(email).toLowerCase())
      .digest("hex");

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
          merge_fields: {
            FNAME: firstName || "",
            LNAME: lastName || "",
          },
        }),
      }
    );

    if (!upsertResp.ok) {
      const txt = await upsertResp.text();
      return res
        .status(400)
        .json({ error: "Mailchimp upsert failed", details: txt });
    }

    // 2) Add tags (if provided)
    const tagList = Array.isArray(tags)
      ? tags.filter(Boolean).map(String)
      : [];

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
        return res
          .status(400)
          .json({ error: "Mailchimp tag apply failed", details: txt });
      }
    }

    return res.json({ success: true });
  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ✅ THIS WAS MISSING — keeps server running
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
