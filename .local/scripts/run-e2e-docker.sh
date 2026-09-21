#!/usr/bin/env bash
set -euo pipefail

# Run Playwright E2E inside official Playwright docker image with the repo mounted.
# Usage:
#   ./scripts/run-e2e-docker.sh [--env-file .env.local] [--headed] [--spec tests/e2e/smoke.spec.ts]

ENV_FILE=""
HEADED=""
SPEC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --headed)
      HEADED="--headed"
      shift
      ;;
    --spec)
      SPEC="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

CMD="corepack enable && corepack prepare pnpm@latest --activate && pnpm install --frozen-lockfile && npx playwright install --with-deps && npx playwright test ${HEADED} ${SPEC}"

if [[ -n "$ENV_FILE" ]]; then
  docker run --rm -it \
    -v "$PWD":/workspace \
    -w /workspace \
    --env-file "$ENV_FILE" \
    -p 4444:4444 \
    mcr.microsoft.com/playwright:latest \
    bash -lc "$CMD"
else
  docker run --rm -it \
    -v "$PWD":/workspace \
    -w /workspace \
    -p 4444:4444 \
    mcr.microsoft.com/playwright:latest \
    bash -lc "$CMD"
fi
