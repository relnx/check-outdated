// Relnx — Check Outdated Tools GitHub Action.
//
// Dependency-free (Node 20 built-ins only) so it runs without a bundling step.
// It collects {slug, version} pairs from the `tools` input and/or a Helm
// Chart.lock, asks the Relnx API how far behind each is, writes a job summary,
// sets outputs, and fails the job according to `fail-on`.

const fs = require('node:fs')
const https = require('node:https')
const http = require('node:http')
const { URL } = require('node:url')

function getInput(name, fallback = '') {
  // GitHub exposes inputs as INPUT_<NAME> with spaces -> "_" and uppercased
  // (hyphens are preserved), matching @actions/core's getInput.
  const key = 'INPUT_' + name.replace(/ /g, '_').toUpperCase()
  const v = process.env[key]
  return (v === undefined ? fallback : v).trim()
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT
  if (file) fs.appendFileSync(file, `${name}=${value}\n`)
}

function writeSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file) fs.appendFileSync(file, md + '\n')
}

// Parse "slug@version" lines into query objects.
function parseToolsInput(raw) {
  const out = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const at = t.lastIndexOf('@')
    if (at <= 0) continue
    out.push({ slug: t.slice(0, at).trim(), version: t.slice(at + 1).trim() })
  }
  return out
}

// Minimal Helm Chart.lock parser. Chart.lock has a stable shape:
//   dependencies:
//   - name: argo-cd
//     version: 5.51.6
function parseChartLock(path) {
  const text = fs.readFileSync(path, 'utf8')
  const out = []
  let name = null
  for (const line of text.split('\n')) {
    const nameM = line.match(/^\s*-?\s*name:\s*["']?([^"'\s]+)["']?/)
    if (nameM) {
      name = nameM[1]
      continue
    }
    const verM = line.match(/^\s*version:\s*["']?([^"'\s]+)["']?/)
    if (verM && name) {
      out.push({ slug: name, version: verM[1] })
      name = null
    }
  }
  return out
}

function postJSON(apiUrl, body, apiKey) {
  return new Promise((resolve, reject) => {
    const u = new URL(apiUrl)
    const payload = JSON.stringify(body)
    const lib = u.protocol === 'http:' ? http : https
    const req = lib.request(
      u,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'relnx-check-outdated-action',
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`API returned ${res.statusCode}: ${data.slice(0, 300)}`))
            return
          }
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(new Error(`invalid JSON from API: ${e.message}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function fail(msg) {
  console.error(`::error::${msg}`)
  process.exit(1)
}

async function main() {
  const failOn = (getInput('fail-on') || 'security').toLowerCase()
  const apiUrl = getInput('api-url') || 'https://relnx.io/api/v1/check-outdated'

  const apiKey = getInput('api-key')
  if (!apiKey) {
    fail('`api-key` is required — generate one in Relnx → Profile → Integrations → API Keys and pass it via secrets (e.g. ${{ secrets.RELNX_API_KEY }})')
  }

  let tools = parseToolsInput(getInput('tools'))

  const chartLock = getInput('chart-lock')
  if (chartLock) {
    if (!fs.existsSync(chartLock)) fail(`chart-lock file not found: ${chartLock}`)
    tools = tools.concat(parseChartLock(chartLock))
  }

  // De-duplicate by slug (keep the first occurrence).
  const seen = new Set()
  tools = tools.filter((t) => (seen.has(t.slug) ? false : seen.add(t.slug)))

  if (tools.length === 0) {
    fail('no tools to check — provide the `tools` input or a `chart-lock` path')
  }

  console.log(`Checking ${tools.length} tool(s) against ${apiUrl}`)

  let resp
  try {
    resp = await postJSON(apiUrl, { tools }, apiKey)
  } catch (e) {
    if (/\b401\b/.test(e.message)) {
      fail('Relnx API rejected the key (401) — check your `api-key` secret is valid and not revoked')
    } else if (/\b403\b/.test(e.message)) {
      fail('Relnx API access is not enabled for your plan (403) — this feature requires an Enterprise plan')
    }
    fail(`failed to call Relnx API: ${e.message}`)
    return
  }

  const { results = [], summary = {} } = resp

  // Build the job summary table.
  let md = '## Relnx — tool version check\n\n'
  md += '| Tool | Current | Latest | Behind | 🔒 Security | ⚠️ Breaking |\n'
  md += '|------|---------|--------|--------|------------|-------------|\n'
  for (const r of results) {
    const status = r.up_to_date ? '✅ up to date' : `${r.versions_behind} behind`
    md += `| [${r.name}](${r.tool_url}) | \`${r.current_version}\` | \`${r.latest_version}\` | ${status} | ${r.security_fixes || 0} | ${r.breaking_changes || 0} |\n`
  }
  if (summary.not_found && summary.not_found.length) {
    md += `\n> Not tracked by Relnx (skipped): ${summary.not_found.map((s) => `\`${s}\``).join(', ')}\n`
  }
  writeSummary(md)
  console.log(md)

  setOutput('outdated', summary.outdated || 0)
  setOutput('security', summary.with_security_fixes || 0)
  setOutput('breaking', summary.with_breaking_changes || 0)

  // Apply the fail policy.
  if (failOn === 'none') return
  if (failOn === 'security' && (summary.with_security_fixes || 0) > 0) {
    fail(`${summary.with_security_fixes} tool(s) have security fixes you haven't picked up`)
  }
  if (failOn === 'breaking' && (summary.with_breaking_changes || 0) > 0) {
    fail(`${summary.with_breaking_changes} tool(s) have breaking changes since your version`)
  }
  if (failOn === 'outdated' && (summary.outdated || 0) > 0) {
    fail(`${summary.outdated} tool(s) are behind the latest version`)
  }
}

main().catch((e) => fail(e.message))
