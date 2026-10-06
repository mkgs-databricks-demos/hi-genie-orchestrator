#!/usr/bin/env bash
# deploy_source.sh — Trigger app deployment after bundle deploy.
# Sourced by app_deploy.sh. Expects APP_NAME and SOURCE_CODE_PATH already set.
#
# Creates a new deployment via the REST API (the CLI `apps deploy` command
# incorrectly rejects valid workspace paths; the API accepts them).

databricks api post /api/2.0/apps/${APP_NAME}/deployments \
  --json "{\"source_code_path\": \"${SOURCE_CODE_PATH}\"}"