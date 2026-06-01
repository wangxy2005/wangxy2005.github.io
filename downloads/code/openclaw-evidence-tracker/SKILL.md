---
name: evidence-chain-tracker
description: 证据链追踪 - Automatically analyze research PDFs and verify evidence chains
metadata:
  {
    "openclaw": {
      "requires": { "bins": [] },
      "emoji": "🔗"
    }
  }
---

# 🔗 Evidence Chain Tracker (证据链追踪)

## Purpose
Automatically track and verify evidence chains when users provide research PDFs or ask for citation verification.

## Automatic Triggers
- User mentions: 证据链追踪, 证据链, 引文验证, 研究验证
- User provides a `.pdf` file
- User asks to generate and verify research ideas

## Workflow
1. Parse PDF with `parse_research_pdf`
2. Generate research ideas using your reasoning
3. Record each idea with `record_evidence` (includes automatic verification)
4. Generate final report with `generate_evidence_report`

## Tools
- `parse_research_pdf` — Extract text from PDF
- `record_evidence` — Record and verify one idea's evidence
- `generate_evidence_report` — Generate final MD report
- `search_literature` — Search academic databases
- `verify_single_claim` — Verify single claim

## Output
Color-coded Markdown report with verification results:
- 🟢 GREEN: Well-supported
- 🟡 YELLOW: Uncertain
- 🔴 RED: Contradicted or mis-cited

## Example Usage

### User Request
```
我需要进行证据链追踪
[uploads transformer.pdf]
```

### Your Response
```
我先读取PDF内容...
[Call parse_research_pdf]

基于这篇论文，我生成第一个跨学科研究idea：
"Cross-Modal Attention for Drug Discovery"
核心假设：Transformer attention can model protein-ligand interactions
支持证据：
1. Self-attention captures long-range dependencies
2. Transformers outperform RNNs on sequence modeling
3. Attention mechanisms are transferable across domains

让我记录并验证这些证据...
[Call record_evidence]

第一个idea的证据验证完成：2个🟢支持，1个🟡不确定

[Repeat for ideas 2 and 3]

所有idea生成完毕，现在生成完整报告...
[Call generate_evidence_report]

证据链报告已生成：
- 共3个研究idea
- 11条证据：8个🟢支持，2个🟡不确定，1个🔴错误
- 报告已保存到 evidence_report.md
```

## Important Notes
- Do not ask for confirmation when you detect evidence chain tracking intent
- Generate ideas using your own LLM capabilities, not the plugin
- Call `record_evidence` immediately after generating each idea
- Always call `generate_evidence_report` at the end to produce the final MD file
