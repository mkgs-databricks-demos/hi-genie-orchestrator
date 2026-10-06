#!/usr/bin/env bash
# app_deploy.sh — Deploy the mcp-hi-genie-orchestrator app bundle.
#
# Resolves infra-derived variables from the hi-genie-infra bundle summary
# and passes them as --var overrides to `databricks bundle deploy`.
#
# First-deploy bootstrapping:
#   On first deploy, the app SPN doesn't exist yet (chicken-and-egg).
#   This script handles it gracefully:
#   1. Checks if client_id/client_secret secrets exist and are not placeholders
#   2. If missing: creates PLACEHOLDER secrets, deploys the app resource
#      (which creates the SPN), retrieves the real client_id, updates the
#      secret, then exits with instructions to set client_secret manually
#   3. Only deploys the app live when both secrets are proven real
#
# Usage:
#   ./app_deploy.sh [--target dev|hls_fde|prod] [--auto-approve]
#
# Later, a top-level deploy.sh at the orchestrator root will call this
# after deploying the infra bundle.

set -euo pipefail

# ─── Defaults ─────────────────────────────────────────────────────────────────
TARGET="dev"
AUTO_APPROVE=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${SCRIPT_DIR}/../hi-genie-infra"

# ─── Parse arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)   TARGET="$2"; shift 2 ;;
    --auto-approve) AUTO_APPROVE="--auto-approve"; shift ;;
    *)          echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

echo "═══════════════════════════════════════════════════════════════════════════"
echo "  Hi Genie Orchestrator — App Deploy"
echo "  Target: ${TARGET}"
echo "═══════════════════════════════════════════════════════════════════════════"

# ─── Helpers ──────────────────────────────────────────────────────────────────
# safe() — quote a value for shell interpolation (preserves special chars)
safe() { printf '%s' "$1"; }
# safe_url() — preserves :// in workspace host URLs
safe_url() { printf '%s' "$1"; }

# Sentinel value for first-deploy bootstrapping
PLACEHOLDER_VALUE="PLACEHOLDER_PENDING_FIRST_DEPLOY"

# ─── Resolve infra bundle outputs ────────────────────────────────────────────
echo ""
echo "▶ Resolving infra bundle summary (target: ${TARGET})..."

INFRA_SUMMARY=$(cd "${INFRA_DIR}" && databricks bundle summary --target "${TARGET}" --output json 2>/dev/null || echo "")

# Validate that we got actual JSON (not an error message or empty)
if [[ -n "${INFRA_SUMMARY}" ]] && ! echo "${INFRA_SUMMARY}" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  echo "⚠  Infra bundle summary returned non-JSON. Falling back to defaults."
  INFRA_SUMMARY=""
fi

if [[ -z "${INFRA_SUMMARY}" ]]; then
  echo "⚠  Could not read infra bundle summary. Using target defaults from databricks.yml."
fi

# ── Catalog & Schema (from schema resource) ───────────────────────────────────
if [[ -n "${INFRA_SUMMARY}" ]]; then
  CATALOG=$(echo "${INFRA_SUMMARY}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('resources', {}).get('schemas', {}).get('hi_genie_schema', {}).get('catalog_name', ''))
")
  SCHEMA=$(echo "${INFRA_SUMMARY}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('resources', {}).get('schemas', {}).get('hi_genie_schema', {}).get('name', ''))
")
else
  CATALOG=""
  SCHEMA=""
fi

echo "   catalog          = ${CATALOG:-<not resolved>}"
echo "   schema           = ${SCHEMA:-<not resolved>}"

# ── Lakebase project ID (from postgres_projects resource) ─────────────────────
if [[ -n "${INFRA_SUMMARY}" ]]; then
  LAKEBASE_PROJECT_ID=$(echo "${INFRA_SUMMARY}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
projects = data.get('resources', {}).get('postgres_projects', {})
for k, v in projects.items():
    print(v.get('project_id', v.get('name', '')))
    break
")
else
  LAKEBASE_PROJECT_ID="hi-genie-orchestrator"
fi

echo "   lakebase_project = ${LAKEBASE_PROJECT_ID}"

# ── MLflow experiment ID (from experiments resource) ────────────────────────
if [[ -n "${INFRA_SUMMARY}" ]]; then
  MLFLOW_EXPERIMENT_ID=$(echo "${INFRA_SUMMARY}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('resources', {}).get('experiments', {}).get('hi_genie_traces', {}).get('id', ''))
")
else
  MLFLOW_EXPERIMENT_ID=""
fi

echo "   mlflow_exp_id    = ${MLFLOW_EXPERIMENT_ID:-<not resolved>}"

# ── Lakebase branch (target-dependent) ────────────────────────────────────────
case "${TARGET}" in
  dev)      LAKEBASE_BRANCH="development" ;;
  hls_fde)  LAKEBASE_BRANCH="production" ;;
  prod)     LAKEBASE_BRANCH="production" ;;
  *)        LAKEBASE_BRANCH="production" ;;
esac

echo "   lakebase_branch  = ${LAKEBASE_BRANCH}"

# ── Lakebase database ID (from CLI) ──────────────────────────────────────────
echo ""
echo "▶ Resolving Lakebase database ID..."

LAKEBASE_RESOURCE_PATH="projects/$(safe "${LAKEBASE_PROJECT_ID}")/branches/${LAKEBASE_BRANCH}"

LAKEBASE_DB_ID=$(databricks postgres list-databases "${LAKEBASE_RESOURCE_PATH}" \
  --output json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
dbs = data if isinstance(data, list) else data.get('databases', [])
if dbs:
    # Extract database_id from the resource name
    name = dbs[0].get('name', '')
    # name format: projects/{id}/branches/{branch}/databases/{db_id}
    parts = name.split('/databases/')
    if len(parts) == 2:
        print(parts[1])
    else:
        print(dbs[0].get('database_id', name))
else:
    print('')
" 2>/dev/null || echo "")

if [[ -z "${LAKEBASE_DB_ID}" ]]; then
  echo "⚠  Could not resolve lakebase_database_id. Deploy may fail if variable is required."
else
  echo "   lakebase_db_id   = ${LAKEBASE_DB_ID}"
fi

# ─── Resolve secret key names (target-dependent) ─────────────────────────────
case "${TARGET}" in
  dev)
    CLIENT_ID_KEY="client_id_dev_matthew_giglia_hi_genie"
    CLIENT_SECRET_KEY="client_secret_dev_matthew_giglia_hi_genie"
    ;;
  hls_fde)
    CLIENT_ID_KEY="client_id_hi_genie"
    CLIENT_SECRET_KEY="client_secret_hi_genie"
    ;;
  prod)
    CLIENT_ID_KEY="client_id_hi_genie_prod"
    CLIENT_SECRET_KEY="client_secret_hi_genie_prod"
    ;;
  *)
    CLIENT_ID_KEY="client_id"
    CLIENT_SECRET_KEY="client_secret"
    ;;
esac

SECRET_SCOPE="hi_genie_credentials"

# ─── Credential check ────────────────────────────────────────────────────────
echo ""
echo "▶ Checking SPN credentials (scope: ${SECRET_SCOPE})..."

get_secret() {
  local scope="$1" key="$2"
  databricks secrets get-secret "${scope}" "${key}" \
    --output json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('value', ''))
except:
    print('')
" 2>/dev/null || echo ""
}

CURRENT_CLIENT_ID=$(get_secret "${SECRET_SCOPE}" "${CLIENT_ID_KEY}")
CURRENT_CLIENT_SECRET=$(get_secret "${SECRET_SCOPE}" "${CLIENT_SECRET_KEY}")

CREDS_READY=true

if [[ -z "${CURRENT_CLIENT_ID}" || "${CURRENT_CLIENT_ID}" == "${PLACEHOLDER_VALUE}" ]]; then
  CREDS_READY=false
  echo "   client_id        = <missing or placeholder>"
else
  echo "   client_id        = ${CURRENT_CLIENT_ID:0:8}..."
fi

if [[ -z "${CURRENT_CLIENT_SECRET}" || "${CURRENT_CLIENT_SECRET}" == "${PLACEHOLDER_VALUE}" ]]; then
  CREDS_READY=false
  echo "   client_secret    = <missing or placeholder>"
else
  echo "   client_secret    = ********"
fi

# ─── Bootstrap path (first deploy) ───────────────────────────────────────────
source "${SCRIPT_DIR}/bootstrap_credentials.sh"

# ─── Deploy ───────────────────────────────────────────────────────────────────
echo ""
echo "▶ Deploying app bundle (target: ${TARGET})..."
echo ""

VAR_OVERRIDES=()
[[ -n "${CATALOG}" ]]            && VAR_OVERRIDES+=(--var "catalog=$(safe "${CATALOG}")")
[[ -n "${SCHEMA}" ]]             && VAR_OVERRIDES+=(--var "schema=$(safe "${SCHEMA}")")
[[ -n "${LAKEBASE_PROJECT_ID}" ]] && VAR_OVERRIDES+=(--var "lakebase_project_id=$(safe "${LAKEBASE_PROJECT_ID}")")
[[ -n "${LAKEBASE_BRANCH}" ]]    && VAR_OVERRIDES+=(--var "lakebase_branch=$(safe "${LAKEBASE_BRANCH}")")
[[ -n "${LAKEBASE_DB_ID}" ]]     && VAR_OVERRIDES+=(--var "lakebase_database_id=$(safe "${LAKEBASE_DB_ID}")")
[[ -n "${MLFLOW_EXPERIMENT_ID}" ]] && VAR_OVERRIDES+=(--var "mlflow_experiment_id=$(safe "${MLFLOW_EXPERIMENT_ID}")")

cd "${SCRIPT_DIR}"

databricks bundle deploy \
  --target "${TARGET}" \
  ${AUTO_APPROVE} \
  "${VAR_OVERRIDES[@]}"

# Resolve the app name from bundle summary
BUNDLE_JSON=$(databricks bundle summary --target "${TARGET}" --output json 2>/dev/null)

APP_NAME=$(echo "${BUNDLE_JSON}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
apps = data.get('resources', {}).get('apps', {})
for k, v in apps.items():
    print(v.get('name', ''))
    break
")

# Source code path for deployment API (full /Workspace path)
SOURCE_CODE_PATH="${SCRIPT_DIR}"

if [[ -z "${APP_NAME}" ]]; then
  echo ""
  echo "WARNING: Could not resolve app name from bundle summary."
  exit 1
fi

# Source deployment:
# - source_linked_deployment: true (dev) — bundle deploy already linked
#   the workspace folder as app source. Just start the app.
# - source_linked_deployment: false (hls_fde/prod) — bundle uploaded source
#   to .bundle/.../files/. Trigger deployment via deploy_source.sh.
echo ""
echo "Starting app (${APP_NAME})..."
echo ""

source "${SCRIPT_DIR}/deploy_source.sh"

echo ""
echo "═══════════════════════════════════════════════════════════════════════════"
echo "  ✓ App deploy complete (target: ${TARGET})"
echo "═══════════════════════════════════════════════════════════════════════════"
