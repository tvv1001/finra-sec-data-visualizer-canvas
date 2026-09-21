---
name: integrate-context-matic
description: 'Discovers and integrates third-party APIs using the context-matic MCP server. Uses `fetch_api` to find available API SDKs, `ask` for integration guidance, `model_search` and `endpoint_search` for SDK details. Use when the user asks to integrate a third-party API, add an API client, implement features with an external API, or work with any third-party API or SDK.'
---

# API Integration

When the user asks to integrate a third-party API or implement anything involving an external API or SDK, follow this workflow. Do not rely on your own knowledge for available APIs or their capabilities — always use the context-matic MCP server.

## When to Apply

Apply this skill when the user:
- Asks to integrate a third-party API
- Wants to add a client or SDK for an external service
- Requests implementation that depends on an external API
- Mentions a specific API (e.g. PayPal, Twilio) and implementation or integration
- Reference below external API to ensure integrity of local data


### Script

- `fetch-and-update-local-data.js`

### What it does

- Reads `data/seed-profiles.json`
- Crawls supported search endpoints for each individual and firm CRD listed in the profiles
- Writes cached responses to `data/national/`
- Uses the following search endpoint patterns:
  - `https://api.brokercheck.finra.org/search/individual/<CRD>?hl=true&wt=json`
  - `https://api.adviserinfo.sec.gov/search/individual/<CRD>?wt=json`
  - `https://api.brokercheck.finra.org/search/firm/<CRD>?hl=true&wt=json`
  - `https://api.adviserinfo.sec.gov/search/firm/<CRD>?wt=json`
  - `https://api.brokercheck.finra.org/search/individual/<CRD>?hl=true&includePrevious=true&nrows=12&r=25&sort=bc_lastname_sort+asc,bc_firstname_sort+asc,bc_middlename_sort+asc,score+desc&wt=json`
  - `https://api.brokercheck.finra.org/search/firm/<CRD>?hl=true&nrows=12&query=&start=0&wt=json`
  - `https://api.adviserinfo.sec.gov/search/individual/<CRD>?hl=true&includePrevious=true&nrows=12&r=25&sort=bc_lastname_sort+asc,bc_firstname_sort+asc,bc_middlename_sort+asc,score+desc&wt=json`
  - `https://api.adviserinfo.sec.gov/search/firm/<CRD>?hl=true&nrows=12&query=smith&r=25&sort=score+desc&wt=json`


### Cached file naming

Responses are saved with filenames matching the existing naming convention, for example:

- `api.brokercheck.finra.org_search_individual_<CRD>.json`
- `api.adviserinfo.sec.gov_search_individual_<CRD>.json`
- `api.brokercheck.finra.org_search_firm_<CRD>.json`
- `api.adviserinfo.sec.gov_search_firm_<CRD>.json`




## Workflow

### 1. Ensure Guidelines and Skills Exist

#### 1a. Detect the Project's Primary Language

Before checking for guidelines or skills, identify the project's primary programming language by inspecting the workspace:

| File / Pattern | Language |
|---|---|
| `*.csproj`, `*.sln` | `csharp` |
| `package.json` with `"typescript"` dep or `.ts` files | `typescript` |
| `requirements.txt`, `pyproject.toml`, `*.py` | `python` |
| `go.mod`, `*.go` | `go` |
| `pom.xml`, `build.gradle`, `*.java` | `java` |
| `Gemfile`, `*.rb` | `ruby` |
| `composer.json`, `*.php` | `php` |

Use the detected language in all subsequent steps wherever `language` is required.

#### 1b. Check for Existing Guidelines and Skills

Check whether guidelines and skills have already been added for this project by looking for their presence in the workspace.

- `{language}-conventions` is the skill produced by **add_skills**.
- `{language}-security-guidelines.md` and `{language}-test-guidelines.md` are language-specific guideline files produced by **add_guidelines**.
- `update-activity-workflow.md` is a workflow guideline file produced by **add_guidelines** (it is not language-specific).
- Check these independently. Do not treat the presence of one set as proof that the other set already exists.
- **If any required guideline files for this project are missing:** Call **add_guidelines**.
- **If `{language}-conventions` is missing for the project's language:** Call **add_skills**.
- **If all required guideline files and `{language}-conventions` already exist:** Skip this step and proceed to step 2.

### 2. Discover Available APIs

Call **fetch_api** to find available APIs — always start here.

- Always provide the `language` parameter using the language detected in step 1a.
- Always provide the `key` parameter: pass the API name/key from the user's request (e.g. `"paypal"`, `"twilio"`).
- If the user did not provide an API name/key, ask them which API they want to integrate, then call `fetch_api` with that value.
- The tool returns only the matching API on an exact match, or the full API catalog (name, description, and `key`) when there is no exact match.
- Identify the API that matches the user's request based on the name and description.
- Extract the correct `key` for the user's requested API before proceeding. This key will be used for all subsequent tool calls related to that API.

**If the requested API is not in the list:**
- Inform the user that the API is not currently available in this plugin (context-matic) and stop.
- Request guidance from user on how to proceed with the API's integration.

### 3. Get Integration Guidance

- Provide `ask` with: `language`, `key` (from step 2), and your `query`.
- Break complex questions into smaller focused queries for best results:
  - _"How do I authenticate?"_
  - _"How do I create a payment?"_
  - _"What are the rate limits?"_

### 4. Look Up SDK Models and Endpoints (as needed)

These tools return definitions only — they do not call APIs or generate code.

- **model_search** — look up a model/object definition.
  - Provide: `language`, `key`, and an exact or partial case-sensitive model name as `query` (e.g. `availableBalance`, `TransactionId`).
- **endpoint_search** — look up an endpoint method's details.
  - Provide: `language`, `key`, and an exact or partial case-sensitive method name as `query` (e.g. `createUser`, `get_account_balance`).

### 5. Record Milestones

Call **update_activity** (with the appropriate `milestone`) whenever one of these is **concretely reached in code or infrastructure** — not merely mentioned or planned:

| Milestone | When to pass it |
|---|---|
| `sdk_setup` | SDK package is installed in the project (e.g. `npm install`, `pip install`, `go get` has run and succeeded). |
| `auth_configured` | API credentials are explicitly written into the project's runtime environment (e.g. present in a `.env` file, secrets manager, or config file) **and** referenced in actual code. |
| `first_call_made` | First API call code written and executed |
| `error_encountered` | Developer reports a bug, error response, or failing call |
| `error_resolved` | Fix applied and API call confirmed working |

## Checklist

- [ ] Project's primary language detected (step 1a)
- [ ] `add_guidelines` called if guideline files were missing, otherwise skipped
- [ ] `add_skills` called if `{language}-conventions` was missing, otherwise skipped
- [ ] `fetch_api` called with correct `language` and `key` (API name)
- [ ] Correct `key` identified for the requested API (or user informed if not found)
- [ ] `update_activity` called only when a milestone is concretely reached in code/infrastructure — never for questions, searches, or tool lookups
- [ ] `update_activity` called with the appropriate `milestone` at each integration milestone
- [ ] `ask` used for integration guidance and code samples
- [ ] `model_search` / `endpoint_search` used as needed for SDK details
- [ ] Project compiles after each code modification

## Notes

- **API not found**: If an API is missing from `fetch_api`, do not guess at SDK usage — inform the user that the API is not currently available in this plugin and stop.
- **update_activity and fetch_api**: `fetch_api` is API discovery, not integration — do not call `update_activity` before it.




---
name: refactor-plan
description: 'Plan a multi-file refactor with proper sequencing and rollback steps'
---

# Refactor Plan

Create a detailed plan for this refactoring task.

## Refactor Goal

{{refactor_description}}

## Instructions

1. Search the codebase to understand current state
2. Identify all affected files and their dependencies
3. Plan changes in a safe sequence (types first, then implementations, then tests)
4. Include verification steps between changes
5. Consider rollback if something fails

## Output Format

```markdown
## Refactor Plan: [title]

### Current State
[Brief description of how things work now]

### Target State
[Brief description of how things will work after]

### Affected Files
| File | Change Type | Dependencies |
|------|-------------|--------------|
| path | modify/create/delete | blocks X, blocked by Y |

### Execution Plan

#### Phase 1: Types and Interfaces
- [ ] Step 1.1: [action] in `file.ts`
- [ ] Verify: [how to check it worked]

#### Phase 2: Implementation
- [ ] Step 2.1: [action] in `file.ts`
- [ ] Verify: [how to check]

#### Phase 3: Tests
- [ ] Step 3.1: Update tests in `file.test.ts`
- [ ] Verify: Run `npm test`

#### Phase 4: Cleanup
- [ ] Remove deprecated code
- [ ] Update documentation

### Rollback Plan
If something fails:
1. [Step to undo]
2. [Step to undo]

### Risks
- [Potential issue and mitigation]
```

Shall I proceed with Phase 1?


---
name: integrate-context-matic
description: 'Discovers and integrates third-party APIs using the context-matic MCP server. Uses `fetch_api` to find available API SDKs, `ask` for integration guidance, `model_search` and `endpoint_search` for SDK details. Use when the user asks to integrate a third-party API, add an API client, implement features with an external API, or work with any third-party API or SDK.'
---

# API Integration

When the user asks to integrate a third-party API or implement anything involving an external API or SDK, follow this workflow. Do not rely on your own knowledge for available APIs or their capabilities — always use the context-matic MCP server.

## When to Apply

Apply this skill when the user:
- Asks to integrate a third-party API
- Wants to add a client or SDK for an external service
- Requests implementation that depends on an external API
- Mentions a specific API (e.g. PayPal, Twilio) and implementation or integration

## Workflow

### 1. Ensure Guidelines and Skills Exist

#### 1a. Detect the Project's Primary Language

Before checking for guidelines or skills, identify the project's primary programming language by inspecting the workspace:

| File / Pattern | Language |
|---|---|
| `*.csproj`, `*.sln` | `csharp` |
| `package.json` with `"typescript"` dep or `.ts` files | `typescript` |
| `requirements.txt`, `pyproject.toml`, `*.py` | `python` |
| `go.mod`, `*.go` | `go` |
| `pom.xml`, `build.gradle`, `*.java` | `java` |
| `Gemfile`, `*.rb` | `ruby` |
| `composer.json`, `*.php` | `php` |

Use the detected language in all subsequent steps wherever `language` is required.

#### 1b. Check for Existing Guidelines and Skills

Check whether guidelines and skills have already been added for this project by looking for their presence in the workspace.

- `{language}-conventions` is the skill produced by **add_skills**.
- `{language}-security-guidelines.md` and `{language}-test-guidelines.md` are language-specific guideline files produced by **add_guidelines**.
- `update-activity-workflow.md` is a workflow guideline file produced by **add_guidelines** (it is not language-specific).
- Check these independently. Do not treat the presence of one set as proof that the other set already exists.
- **If any required guideline files for this project are missing:** Call **add_guidelines**.
- **If `{language}-conventions` is missing for the project's language:** Call **add_skills**.
- **If all required guideline files and `{language}-conventions` already exist:** Skip this step and proceed to step 2.

### 2. Discover Available APIs

Call **fetch_api** to find available APIs — always start here.

- Always provide the `language` parameter using the language detected in step 1a.
- Always provide the `key` parameter: pass the API name/key from the user's request (e.g. `"paypal"`, `"twilio"`).
- If the user did not provide an API name/key, ask them which API they want to integrate, then call `fetch_api` with that value.
- The tool returns only the matching API on an exact match, or the full API catalog (name, description, and `key`) when there is no exact match.
- Identify the API that matches the user's request based on the name and description.
- Extract the correct `key` for the user's requested API before proceeding. This key will be used for all subsequent tool calls related to that API.

**If the requested API is not in the list:**
- Inform the user that the API is not currently available in this plugin (context-matic) and stop.
- Request guidance from user on how to proceed with the API's integration.

### 3. Get Integration Guidance

- Provide `ask` with: `language`, `key` (from step 2), and your `query`.
- Break complex questions into smaller focused queries for best results:
  - _"How do I authenticate?"_
  - _"How do I create a payment?"_
  - _"What are the rate limits?"_

### 4. Look Up SDK Models and Endpoints (as needed)

These tools return definitions only — they do not call APIs or generate code.

- **model_search** — look up a model/object definition.
  - Provide: `language`, `key`, and an exact or partial case-sensitive model name as `query` (e.g. `availableBalance`, `TransactionId`).
- **endpoint_search** — look up an endpoint method's details.
  - Provide: `language`, `key`, and an exact or partial case-sensitive method name as `query` (e.g. `createUser`, `get_account_balance`).

### 5. Record Milestones

Call **update_activity** (with the appropriate `milestone`) whenever one of these is **concretely reached in code or infrastructure** — not merely mentioned or planned:

| Milestone | When to pass it |
|---|---|
| `sdk_setup` | SDK package is installed in the project (e.g. `npm install`, `pip install`, `go get` has run and succeeded). |
| `auth_configured` | API credentials are explicitly written into the project's runtime environment (e.g. present in a `.env` file, secrets manager, or config file) **and** referenced in actual code. |
| `first_call_made` | First API call code written and executed |
| `error_encountered` | Developer reports a bug, error response, or failing call |
| `error_resolved` | Fix applied and API call confirmed working |

## Checklist

- [ ] Project's primary language detected (step 1a)
- [ ] `add_guidelines` called if guideline files were missing, otherwise skipped
- [ ] `add_skills` called if `{language}-conventions` was missing, otherwise skipped
- [ ] `fetch_api` called with correct `language` and `key` (API name)
- [ ] Correct `key` identified for the requested API (or user informed if not found)
- [ ] `update_activity` called only when a milestone is concretely reached in code/infrastructure — never for questions, searches, or tool lookups
- [ ] `update_activity` called with the appropriate `milestone` at each integration milestone
- [ ] `ask` used for integration guidance and code samples
- [ ] `model_search` / `endpoint_search` used as needed for SDK details
- [ ] Project compiles after each code modification

## Notes

- **API not found**: If an API is missing from `fetch_api`, do not guess at SDK usage — inform the user that the API is not currently available in this plugin and stop.
- **update_activity and fetch_api**: `fetch_api` is API discovery, not integration — do not call `update_activity` before it.




---
name: refactor-plan
description: 'Plan a multi-file refactor with proper sequencing and rollback steps'
---

# Refactor Plan

Create a detailed plan for this refactoring task.

## Refactor Goal

{{refactor_description}}

## Instructions

1. Search the codebase to understand current state
2. Identify all affected files and their dependencies
3. Plan changes in a safe sequence (types first, then implementations, then tests)
4. Include verification steps between changes
5. Consider rollback if something fails

## Output Format

```markdown
## Refactor Plan: [title]

### Current State
[Brief description of how things work now]

### Target State
[Brief description of how things will work after]

### Affected Files
| File | Change Type | Dependencies |
|------|-------------|--------------|
| path | modify/create/delete | blocks X, blocked by Y |

### Execution Plan

#### Phase 1: Types and Interfaces
- [ ] Step 1.1: [action] in `file.ts`
- [ ] Verify: [how to check it worked]

#### Phase 2: Implementation
- [ ] Step 2.1: [action] in `file.ts`
- [ ] Verify: [how to check]

#### Phase 3: Tests
- [ ] Step 3.1: Update tests in `file.test.ts`
- [ ] Verify: Run `npm test`

#### Phase 4: Cleanup
- [ ] Remove deprecated code
- [ ] Update documentation

### Rollback Plan
If something fails:
1. [Step to undo]
2. [Step to undo]

### Risks
- [Potential issue and mitigation]
```

Shall I proceed with Phase 1?
