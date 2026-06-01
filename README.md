# Relnx — Check Outdated Tools (GitHub Action)

Fail your CI when the cloud-native tools your repo pins are **behind the latest
release**, or — more importantly — when they have **security fixes** or
**breaking changes** you haven't picked up yet. Data comes from
[relnx.io](https://relnx.io).

> Published to the GitHub Marketplace as `relnx/check-outdated@v1`.

## Requirements

This action needs a **Relnx API key**, available on the **Enterprise** plan.
Generate one in **Relnx → Settings → API Keys**, then add it to your repo as a
secret (e.g. `RELNX_API_KEY`).

## Usage

```yaml
name: Dependency freshness
on:
  pull_request:
  schedule:
    - cron: '0 6 * * 1' # weekly
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Option A — read a Helm Chart.lock
      - uses: relnx/check-outdated@v1
        with:
          api-key: ${{ secrets.RELNX_API_KEY }}
          chart-lock: ./charts/platform/Chart.lock
          fail-on: security

      # Option B — list tools explicitly
      - uses: relnx/check-outdated@v1
        with:
          api-key: ${{ secrets.RELNX_API_KEY }}
          tools: |
            argo-cd@2.10.0
            cert-manager@1.14.0
            cilium@1.15.1
          fail-on: breaking
```

## Inputs

| Input        | Default                                  | Description |
|--------------|------------------------------------------|-------------|
| `api-key`    | — (**required**)                         | Relnx API key (Enterprise). Store as a secret. |
| `tools`      | `''`                                     | Tools to check, one `slug@version` per line. |
| `chart-lock` | `''`                                     | Path to a Helm `Chart.lock`; its dependencies are read automatically. |
| `fail-on`    | `security`                               | `security` \| `breaking` \| `outdated` \| `none`. |
| `api-url`    | `https://relnx.io/api/v1/check-outdated` | Override for self-hosted/testing. |

`tools` and `chart-lock` can be combined; results are de-duplicated by slug.
The `slug` is the Relnx tool slug (the last path segment of `relnx.io/tools/<slug>`).

## Outputs

| Output     | Description |
|------------|-------------|
| `outdated` | Count of tools behind the latest version. |
| `security` | Count of tools with security fixes since your version. |
| `breaking` | Count of tools with breaking changes since your version. |

Every run also writes a table to the **GitHub Step Summary**.

## How it works

The action collects `{slug, version}` pairs, POSTs them to the Relnx
`check-outdated` endpoint, and the API returns — per tool — the latest version,
how many versions behind you are, and the number of security fixes / breaking
changes between your version and the latest. No token is required; only tool
slugs and versions are sent.

## Notes / roadmap

- Tools not tracked by Relnx are listed under "Not tracked" and skipped (they
  never fail the build).
- `chart-lock` parsing is built in. `helmfile.yaml` and Helm `values.yaml`
  auto-detection are planned — for those, use the explicit `tools` input today.
- Dependency-free (Node 20 built-ins only), so no bundling/`node_modules` step.
