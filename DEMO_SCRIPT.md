# CodeWhy: Prototype Submission & Live Demonstration Script

## Executive Overview

**CodeWhy** answers why software code exists the way it is, reconstructed directly from engineering history.

### The Core Promise
> **Ask why code exists → Retrieve the historical decision → Verify original verbatim evidence → Explain temporal context & supersession → Refuse when evidence is insufficient.**

---

## 1. System Preflight & Verified Architecture

| Component | Status | Details |
| :--- | :--- | :--- |
| **Repository Under Test** | `urllib3/urllib3` (Indexed ID: `urllib3-urllib3`) | Ingested GitHub PRs, commits, issues, and diffs |
| **Graph Database** | Neo4j AuraDB (`DATA_SOURCE=graph`) | 34 verified decisions, 24 entities, 299 PRs, 735 commits |
| **Embedding Engine** | `all-MiniLM-L6-v2` | Warm-cached at process startup (sub-millisecond lookups) |
| **Backend API** | `http://127.0.0.1:8000/api/v1` | FastAPI running with validated OpenAPI contract |
| **Frontend UI** | `http://localhost:5173` | Warm-black (`#080907`), Olive (`#12130F`), Bronze (`#B9915E`) |

---

## 2. The 3 Demonstration Scenarios

### Scenario A: Verified Historical Decision & Verbatim Quotations
*Demonstrating: Entity resolution, multi-decision synthesis, verbatim PR quote extraction, and high confidence calibration.*

* **User Input**:
  ```text
  Why was src/urllib3/util/url.py changed?
  ```
* **Resolved Entity**: `file:urllib3/urllib3:src/urllib3/util/url.py`
* **Response Outcome**: `full`
* **Confidence**: `HIGH (Score: 0.9166)`
* **Active Historical Decisions Retrieved**:
  1. `dec_374c15ea4fa9fa06`: Parse URLs using regular expressions conforming to RFC 3986 (PR #1487).
  2. `dec_5bf9c85e20b5cb14`: Percent-encode invalid characters in URL paths and queries (PR #2139).
  3. `dec_d93fcc65f36fe7a9`: Normalise IPv6 addresses in URL parsing (PR #1647).
* **Verbatim Evidence Quotes**:
  - *"This brings our URL parser in-line with Python standard library parsing which all use RFC 3986."* (PR #1487)
  - *"Make all `urllib3.util.url` regular expressions private to protect our internal APIs"* (PR #2139)
  - *"Mostly proxy users that have their email address as their \"username\" and therefore have an \"@\" symbol within the auth section."* (PR #1647)
* **Presenter Talking Point**:
  > *"Notice that CodeWhy does not hallucinate why `url.py` was altered. It cites the exact pull requests and reproduces the verbatim review quotes verified against GitHub commit history."*

---

### Scenario B: Temporal Lineage & Superseded Decision Detection
*Demonstrating: Temporal reasoning, superseded states, Rule 1 Revert Commit tracking, and prevention of engineering regressions.*

* **User Input**:
  ```text
  Why was src/urllib3/util/ssl_.py changed for HTTP/2 TLS support?
  ```
* **Resolved Entity**: `file:urllib3/urllib3:src/urllib3/util/ssl_.py`
* **Response Outcome**: `full`
* **Confidence**: `HIGH (Score: 0.8816)`
* **Temporal Lineage Dynamics**:
  - Earlier Decision: `dec_6dee7648b9ef5416` (Add HTTP/2 TLS support for RFC 9113 compliance via PR #3361).
  - Status: **`SUPERSEDED`** (Rule: `1_revert_commit`)
  - Superseded by: `dec_ce303eb845540d38` (Revert HTTP/2 TLS changes via PR #3466).
  - Status: **`ACTIVE`**
* **Presenter Talking Point**:
  > *"This is CodeWhy's core temporal superpower. When developers ask about TLS changes, naive LLMs report that HTTP/2 TLS is enabled because they read the original PR. CodeWhy traces the full commit lineage and shows that this decision was subsequently REVERTED in PR #3466, preventing developers from mistakenly relying on reverted code."*

---

### Scenario C: Principled Refusal & Evidence Gaps
*Demonstrating: Anti-hallucination guardrails, scoped retrieval, honest refusal codes, and zero fabrication.*

* **User Input**:
  ```text
  Why does urllib3 use Kubernetes for orchestration?
  ```
* **Response Outcome**: **`refusal`**
* **Reason Code**: `entity_not_found`
* **Evidence Gaps**: 1 gap recorded (`"This system covers urllib3/urllib3 at branch main, commits 2009-12-10..2026-10-01, 291 file paths touched by the fetched pull requests; ingest caps: max_ingestion_issues=100; no matching file was found."`)
* **Confidence**: `null` (Refused honestly prior to scoring)
* **Presenter Talking Point**:
  > *"When asked an ungrounded or fictitious question—like Kubernetes orchestration in a pure HTTP client—standard AI assistants fabricate plausible justifications. CodeWhy principled gates immediately refuse to fabricate history when verifiable evidence does not exist in the engineering record."*

---

## 3. Step-by-Step Presenter Walkthrough Guide

### Step 1: System Overview & Telemetry
1. Open `http://localhost:5173`.
2. Review the repository star selector (`urllib3/urllib3`).
3. Note the telemetry metrics in the workspace header:
   - 34 Verified Decisions
   - 24 Resolved Code Entities
   - 299 Ingested Pull Requests
   - 735 Commits Analyzed

### Step 2: Live Investigation
1. Navigate to the **Investigate** page.
2. Enter Scenario A query: `Why was src/urllib3/util/url.py changed?`
3. Hit **Ask CodeWhy**.
4. Point out the resulting components:
   - **Confidence Badge**: `HIGH (0.92)` with five transparent scoring signals (Directness, Provenance, Agreement, Relevance, Temporal Consistency).
   - **Verbatim Quote Panel**: Blue quote box showing verified text with direct GitHub PR hyperlink.
   - **Entity Resolver Badge**: Showing `file:urllib3/urllib3:src/urllib3/util/url.py`.

### Step 3: Decision History & Temporal Lineage
1. Navigate to the **Decisions** tab or ask Scenario B: `Why was src/urllib3/util/ssl_.py changed for HTTP/2 TLS support?`
2. Point to the **Status Filters** (`All`, `Active`, `Superseded`).
3. Click the `Superseded` filter pill:
   - Observe `dec_6dee7648b9ef5416` marked with a bronze warning badge: `SUPERSEDED (Rule 1: Revert Commit)`.
   - Click to open the **Decision Drawer**:
     - See the lineage link connecting to `dec_ce303eb845540d38` ("Revert HTTP/2 TLS support").

### Step 4: Principled Refusal
1. Enter Scenario C query: `Why does urllib3 use Kubernetes for orchestration?`
2. Point out the immediate refusal screen:
   - Distinctive principled refusal card with subtle olive-charcoal border.
   - Clear disclosure of evidence gaps without guessing or hallucinating.

### Step 5: Interactive Knowledge Graph
1. Navigate to the **Knowledge Graph** tab.
2. Click on the `src/urllib3/util/ssl_.py` entity node or zoom into the graph canvas.
3. Observe the connected nodes:
   - `CodeEntity` nodes in powder blue.
   - `Decision` nodes in bronze / warm taupe.
   - `PullRequest` nodes in sage green.
   - Directed edges: `GOVERNS`, `SUPPORTED_BY`, `SUPERSEDES`.
4. Demonstrate search and filter controls across node types.

---

## 4. Verification Suite & Test Benchmark

The project includes an automated submission benchmark verifying all critical behaviors:

```bash
# Run the 10-case evaluation benchmark
pytest backend/tests/unit/test_submission_benchmark.py -v

# Run the entire backend test suite (1,003 tests)
pytest backend/tests/unit

# Run frontend test suite (47 vitest tests)
cd frontend && pnpm exec vitest run

# Run production build
cd frontend && pnpm exec vite build
```

---
*CodeWhy — Engineering decisions grounded in truth, verified by history.*
