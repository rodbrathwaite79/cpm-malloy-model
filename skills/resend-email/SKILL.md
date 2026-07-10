---
name: resend-email
description: >
  Send HTML emails with optional file attachments via the Resend REST API.
  Use this skill whenever an agent or serverless function needs to email a report,
  dashboard, or notification — including base64-encoded HTML file attachments.
---

# Resend Email — Sending Pattern

## Why Resend
Gmail App Passwords are blocked by Passkey login. Resend uses a pure REST API —
no SMTP, no OAuth, no credential complexity. Free tier: 3,000 emails/month.

## Send function
```js
async function sendEmail(subject, html, attachments = []) {
  const resendApiKey = process.env.RESEND_API_KEY
  const emailTo      = process.env.EMAIL_TO ?? "rod.brathwaite@gmail.com"
  const emailCc      = (process.env.EMAIL_CC ?? "").split(",").map(s => s.trim()).filter(Boolean)

  if (!resendApiKey) { console.warn("RESEND_API_KEY not set — skipping email"); return }

  const body = {
    from:    "CPM Report Agent <onboarding@resend.dev>",
    to:      [emailTo],
    subject,
    html,
  }
  if (emailCc.length > 0) body.cc = emailCc
  if (attachments.length > 0) {
    body.attachments = attachments.map(a => ({ filename: a.filename, content: a.content }))
  }

  const res = await fetch("https://api.resend.com/emails", {
    method:  "POST",
    headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  })
  if (res.ok) {
    const { id } = await res.json()
    console.log(`✅ Email sent (Resend ID: ${id})`)
  } else {
    console.warn(`❌ Resend ${res.status}:`, await res.text())
  }
}
```

## Attaching an HTML file
Convert the HTML string to base64 — Resend accepts base64 content directly:

```js
const dashHtml   = buildInteractiveDashboard(rows, runDate, aiInsights)
const dashBase64 = Buffer.from(dashHtml, "utf-8").toString("base64")

await sendEmail(
  `📊 CPM Report — ${runDate}`,
  emailBodyHtml,
  [{ filename: "CPM-Dashboard.html", content: dashBase64 }]
)
```

The recipient can open the `.html` attachment locally — it includes all JS/CSS inline
so it works without internet access.

## In Vercel (no fetch available in older Node runtimes)
Use the raw `https` module instead:

```js
import https from "https"
// ... use the request() helper from vercel-serverless skill
const res = await post("https://api.resend.com/emails",
  { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
  body
)
```

## From address
`onboarding@resend.dev` is Resend's shared sandbox sender — works on free tier.
For a custom domain sender, verify the domain in the Resend dashboard first.

## Environment variables
| Var | Notes |
|-----|-------|
| `RESEND_API_KEY` | From resend.com → API Keys (starts with `re_`) |
| `EMAIL_TO` | Primary recipient |
| `EMAIL_CC` | Optional comma-separated CC list |
