# OpenClaw Evidence Tracker

OpenClaw Evidence Tracker is a research-assistant plugin for tracing and verifying the evidence chain behind LLM-generated scientific ideas.

## What It Does

- Parses research PDFs.
- Records generated research ideas, hypotheses, and verifiable claims.
- Searches academic literature for supporting or contradicting evidence.
- Uses LLM semantic verification to classify each claim.
- Generates a Markdown evidence chain report with GREEN, YELLOW, and RED verdicts.

## Main Tools

| Tool | Purpose |
| --- | --- |
| `parse_research_pdf` | Extract text from a research PDF |
| `search_literature` | Search academic literature |
| `run_evidence_chain` | Run the full PDF to idea to verification to report workflow |
| `verify_single_claim` | Verify one specific factual claim |

## Credentials

This public copy does not include real API keys or local LLM service credentials. Provide credentials through OpenClaw configuration or environment variables, for example:

```bash
export RAG_AC_API_KEY="your-api-key"
```

## Files

- `index.ts`: active plugin implementation
- `openclaw.plugin.json`: OpenClaw plugin manifest
- `skills/evidence-tracker/`: skill definition
- `TECHNICAL_REPORT.md`: technical design report
- `test-smoke.mjs`, `test-tools.mjs`: optional local tests
