/**
 * /api/dashboard — Serves the CPM Live Dashboard HTML
 * Avoids all CORS issues by serving from the same origin as /api/metrics
 */

import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

export default function handler(req, res) {
  try {
    const html = readFileSync(join(__dirname, "../dashboard.html"), "utf-8")
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.setHeader("Cache-Control", "no-cache")
    return res.status(200).send(html)
  } catch (e) {
    return res.status(500).send(`Could not load dashboard: ${e.message}`)
  }
}
