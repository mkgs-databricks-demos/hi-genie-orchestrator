#!/usr/bin/env bash
# bootstrap_credentials.sh — First-deploy credential bootstrapping.
# Sourced by app_deploy.sh. If CREDS_READY=true, this is a no-op.

if [[ "${CREDS_READY}" == "true" ]]; then
  return 0 2>/dev/null || true
fi

echo ""
echo "================================================================="
echo "  FIRST-DEPLOY BOOTSTRAP MODE"
echo "================================================================="
echo ""

# Step 1: Create placeholder secrets so DAB deploy can succeed
echo "Step 1: Ensuring placeholder secrets exist..."

if [[ -z "${CURRENT_CLIENT_ID}" ]]; then
  databricks secrets put-secret "${SECRET_SCOPE}" "${CLIENT_ID_KEY}" \
    --string-value "${PLACEHOLDER_VALUE}"
  echo "   Created placeholder: ${CLIENT_ID_KEY}"
fi

if [[ -z "${CURRENT_CLIENT_SECRET}" ]]; then
  databricks secrets put-secret "${SECRET_SCOPE}" "${CLIENT_SECRET_KEY}" \
    --string-value "${PLACEHOLDER_VALUE}"
  echo "   Created placeholder: ${CLIENT_SECRET_KEY}"
fi

# Step 2: Deploy app resource (creates SPN)
echo ""
echo "Step 2: Deploying app bundle to create SPN..."

BOOTSTRAP_VARS=()
[[ -n "${CATALOG}" ]]            && BOOTSTRAP_VARS+=(--var "catalog=$(safe "${CATALOG}")")
[[ -n "${SCHEMA}" ]]             && BOOTSTRAP_VARS+=(--var "schema=$(safe "${SCHEMA}")")
[[ -n "${LAKEBASE_PROJECT_ID}" ]] && BOOTSTRAP_VARS+=(--var "lakebase_project_id=$(safe "${LAKEBASE_PROJECT_ID}")")
[[ -n "${LAKEBASE_BRANCH}" ]]    && BOOTSTRAP_VARS+=(--var "lakebase_branch=$(safe "${LAKEBASE_BRANCH}")")
[[ -n "${LAKEBASE_DB_ID}" ]]     && BOOTSTRAP_VARS+=(--var "lakebase_database_id=$(safe "${LAKEBASE_DB_ID}")")

cd "${SCRIPT_DIR}"
databricks bundle deploy --target "${TARGET}" --auto-approve "${BOOTSTRAP_VARS[@]}"

# Step 3: Retrieve app SPN client_id
echo ""
echo "Step 3: Retrieving app SPN client_id..."

APP_NAME=$(databricks bundle summary --target "${TARGET}" --output json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
apps = data.get('resources', {}).get('apps', {})
for k, v in apps.items():
    print(v.get('name', ''))
    break
")

if [[ -z "${APP_NAME}" ]]; then
  echo "ERROR: Could not determine app name. Set client_id manually and re-run."
  exit 1
fi

SPN_CLIENT_ID=$(databricks apps get "${APP_NAME}" --output json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
sp = data.get('service_principal', {}) or {}
print(sp.get('client_id', '') or sp.get('application_id', '') or data.get('service_principal_client_id', '') or '')
")

if [[ -z "${SPN_CLIENT_ID}" ]]; then
  echo "WARNING: Could not retrieve SPN client_id. App may still be initializing."
  echo "  databricks apps get ${APP_NAME} --output json"
  exit 1
fi

echo "   spn_client_id    = ${SPN_CLIENT_ID}"

# Step 4: Update client_id secret with real value
echo ""
echo "Step 4: Updating client_id secret..."
databricks secrets put-secret "${SECRET_SCOPE}" "${CLIENT_ID_KEY}" \
  --string-value "${SPN_CLIENT_ID}"
echo "   Updated: ${CLIENT_ID_KEY}"

# Step 5: Instructions
echo ""
echo "================================================================="
echo "  MANUAL STEP REQUIRED"
echo "================================================================="
echo ""
echo "  client_id set automatically: ${SPN_CLIENT_ID}"
echo ""
echo "  Now generate an OAuth2 M2M secret for this SPN:"
echo "  1. Account Console > Service Principals > ${SPN_CLIENT_ID}"
echo "  2. Generate OAuth2 secret"
echo "  3. databricks secrets put-secret ${SECRET_SCOPE} ${CLIENT_SECRET_KEY} \\"
echo "       --string-value <the_generated_secret>"
echo "  4. Re-run: ./app_deploy.sh --target ${TARGET}"
echo ""
echo "  Bootstrap complete. App created but NOT live."
echo "================================================================="
exit 0