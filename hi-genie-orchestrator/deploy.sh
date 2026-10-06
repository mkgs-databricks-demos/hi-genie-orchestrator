#!/usr/bin/env bash
# deploy.sh — Full Hi Genie Orchestrator deployment.
#
# Deploys BOTH bundles in the correct sequence:
#   1. hi-genie-infra   — UC schema, Lakebase, secrets, SQL warehouse, MLflow experiment
#   2. UC Setup Job     — Lakebase extensions, app SPN grants, embedding endpoint secret
#   3. mcp-hi-genie-orchestrator — App bundle + container deployment
#
# Usage:
#   ./deploy.sh [--target dev|hls_fde|prod] [--auto-approve] [--skip-infra] [--skip-app]
#
# Options:
#   --target         Target environment (default: dev)
#   --auto-approve   Skip interactive confirmation prompts
#   --skip-infra     Skip infra bundle deploy (use when infra is already current)
#   --skip-app       Skip app bundle deploy (use when only infra changes needed)
#   --skip-uc-setup  Skip UC Setup Job run (use when Lakebase/secrets unchanged)
#
# Prerequisites:
#   - Databricks CLI >= 0.287.0 authenticated to the target workspace
#   - Python 3 available for JSON parsing
#   - Both bundles validated (`databricks bundle validate` in each)
#
# Exit codes:
#   0 — all steps succeeded
#   1 — infra deploy failed
#   2 — UC Setup Job failed or timed out
#   3 — app deploy failed

set -euo pipefail

# ─── Defaults ─────────────────────────────────────────────────────────────────
TARGET="dev"
AUTO_APPROVE=""
SKIP_INFRA=false
SKIP_APP=false
SKIP_UC_SETUP=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${SCRIPT_DIR}/hi-genie-infra"
APP_DIR="${SCRIPT_DIR}/mcp-hi-genie-orchestrator"

# ─── Parse arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)        TARGET="$2"; shift 2 ;;
    --auto-approve)  AUTO_APPROVE="--auto-approve"; shift ;;
    --skip-infra)    SKIP_INFRA=true; shift ;;
    --skip-app)      SKIP_APP=true; shift ;;
    --skip-uc-setup) SKIP_UC_SETUP=true; shift ;;
    *)               echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

echo "═══════════════════════════════════════════════════════════════════════════"
echo "  Hi Genie Orchestrator — Full Deployment"
echo "  Target: ${TARGET}"
echo "  Infra:  $(if ${SKIP_INFRA}; then echo 'SKIP'; else echo 'DEPLOY'; fi)"
echo "  UC Job: $(if ${SKIP_UC_SETUP}; then echo 'SKIP'; else echo 'RUN'; fi)"
echo "  App:    $(if ${SKIP_APP}; then echo 'SKIP'; else echo 'DEPLOY'; fi)"
echo "═══════════════════════════════════════════════════════════════════════════"
echo ""

# ─── Helpers ──────────────────────────────────────────────────────────────────
safe() { printf '%s' "$1"; }

# ─── Step 1: Deploy Infrastructure Bundle ─────────────────────────────────────
if [[ "${SKIP_INFRA}" == "false" ]]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Step 1/3: Deploying hi-genie-infra bundle"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  cd "${INFRA_DIR}"

  if ! databricks bundle deploy --target "${TARGET}" ${AUTO_APPROVE}; then
    echo ""
    echo "ERROR: Infra bundle deploy failed." >&2
    exit 1
  fi

  echo ""
  echo "  ✓ Infra bundle deployed successfully."
  echo ""
else
  echo "  ⏭  Skipping infra bundle deploy (--skip-infra)"
  echo ""
fi

# ─── Step 2: Run UC Setup Job ─────────────────────────────────────────────────
if [[ "${SKIP_UC_SETUP}" == "false" ]]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Step 2/3: Running UC Setup Job"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  cd "${INFRA_DIR}"

  # Run the UC Setup Job and wait for completion
  RUN_OUTPUT=$(databricks bundle run uc_setup --target "${TARGET}" 2>&1) || {
    echo ""
    echo "ERROR: UC Setup Job failed." >&2
    echo "${RUN_OUTPUT}" >&2
    exit 2
  }

  echo "${RUN_OUTPUT}"
  echo ""
  echo "  ✓ UC Setup Job completed successfully."
  echo ""
else
  echo "  ⏭  Skipping UC Setup Job (--skip-uc-setup)"
  echo ""
fi

# ─── Step 3: Deploy App Bundle ────────────────────────────────────────────────
if [[ "${SKIP_APP}" == "false" ]]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Step 3/3: Deploying mcp-hi-genie-orchestrator app"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  cd "${APP_DIR}"

  # app_deploy.sh resolves infra-derived vars from infra bundle summary
  # and handles credential bootstrapping on first deploy
  if ! bash ./app_deploy.sh --target "${TARGET}" ${AUTO_APPROVE}; then
    echo ""
    echo "ERROR: App bundle deploy failed." >&2
    exit 3
  fi

  echo ""
  echo "  ✓ App bundle deployed successfully."
  echo ""
else
  echo "  ⏭  Skipping app bundle deploy (--skip-app)"
  echo ""
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════════════════"
echo "  ✓ Full deployment complete (target: ${TARGET})"
echo ""
echo "  Next steps:"
echo "    1. Run post-deploy validation: databricks bundle run post_deploy_tests --target ${TARGET}"
echo "       (from ${APP_DIR})"
echo "    2. Verify app health: curl <app-url>/api/health"
echo "    3. Test MCP tools via AI Playground or SDK"
echo "═══════════════════════════════════════════════════════════════════════════"
