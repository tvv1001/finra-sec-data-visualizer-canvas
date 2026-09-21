Run Playwright E2E inside Docker

Use the included helper script to run Playwright tests in the official Playwright Docker image (browsers included).

Examples:

- Run all tests (no env file):

  ./.local/scripts/run-e2e-docker.sh

- Run tests with env vars from a file:

  ./.local/scripts/run-e2e-docker.sh --env-file .env.test

- Run a single spec, headed (useful for debugging):

  ./.local/scripts/run-e2e-docker.sh --spec tests/e2e/smoke.spec.ts --headed

- Use docker-compose (runs default command):

  docker compose -f docker-compose.playwright.yml run --rm playwright

Notes:

- Docker must be installed and running.
- The container maps port 4444 for any dev server the tests start; adjust if your app uses a different port.
