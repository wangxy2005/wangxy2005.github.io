/**
 * Smoke test for openclaw-evidence-tracker
 * Runs the full pipeline WITHOUT the OpenClaw runtime (stubs out llm()).
 * Usage: node test-smoke.mjs
 */

import { createRequire } from "module";
import { readFile, writeFile } from "fs/promises";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

const RAG_AC_KEY = process.env.RAG_AC_API_KEY ?? "";
const PDF_PATH   = process.env.PDF_PATH ?? "/home/wxy/transformer.pdf";
const OUT_PATH   = process.env.OUT_PATH ?? "/home/wxy/evidence-report.md";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvidenceId(i) { return `EV-${String(i + 1).padStart(3, "0")}`; }
function verdictEmoji(v)   { return v === "GREEN" ? "🟢" : v === "YELLOW" ? "🟡" : "🔴"; }

// ─── Search backends ──────────────────────────────────────────────────────────

async function crossRefSearch(query, topK) {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${topK}&select=title,abstract,URL,DOI`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "openclaw-evidence-tracker/0.1.0 (smoke-test)" },
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) throw new Error(`CrossRef HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.message?.items ?? []).map((item, i) => ({
    title:   (item.title ?? ["Unknown"])[0],
    url:     item.URL ?? (item.DOI ? `https://doi.org/${item.DOI}` : ""),
    snippet: (item.abstract ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400),
    score:   Math.max(0.3, 0.85 - i * 0.08),
  }));
}

async function semanticScholarSearch(query, topK) {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${topK}&fields=title,abstract,url,externalIds`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "openclaw-evidence-tracker/0.1.0 (smoke-test)" },
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) throw new Error(`S2 HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.data ?? []).map((p, i) => ({
    title:   p.title ?? "Unknown",
    url:     p.url ?? (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : ""),
    snippet: (p.abstract ?? "").slice(0, 400),
    score:   Math.max(0.3, 0.85 - i * 0.08),
  }));
}

async function ragSearch(query, apiKey, topK = 3) {
  // 1. rag.ac
  if (apiKey) {
    for (const base of ["https://rag.ac/v1", "https://api.rag.ac/v1", "https://api.rag.ac"]) {
      try {
        const resp = await fetch(`${base}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, top_k: topK }),
          signal: AbortSignal.timeout(7000),
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data.results?.length) {
          return data.results.map(r => ({
            title: r.title ?? "Unknown", url: r.url ?? "",
            snippet: (r.abstract ?? r.snippet ?? "").slice(0, 400),
            score: typeof r.score === "number" ? r.score : 0.5,
          }));
        }
      } catch { /* try next */ }
    }
  }
  // 2. Semantic Scholar
  try { const r = await semanticScholarSearch(query, topK); if (r.length) return r; } catch { }
  // 3. CrossRef
  try { const r = await crossRefSearch(query, topK); if (r.length) return r; } catch { }
  return [{ title: "(Search unavailable)", url: "", snippet: "All backends failed.", score: 0.1 }];
}

// ─── LLM stub (uses real OpenAI-relay codex via env-injected key if available) ─

async function callLLM(prompt, temperature = 0.3) {
  // If OPENAI_API_KEY or similar is available, use it; otherwise use a mock
  const key = process.env.OPENAI_API_KEY ?? process.env.CODEX_API_KEY ?? "";
  const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

  if (key) {
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.CODEX_MODEL ?? "gpt-4o-mini",
        temperature,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (resp.ok) {
      const data = await resp.json();
      return data.choices?.[0]?.message?.content ?? "";
    }
  }

  // ── Deterministic mock (no API key needed) ──────────────────────────────────
  console.log("[LLM-MOCK] No API key found, using deterministic mock response.");
  if (prompt.includes("idea_title")) {
    return JSON.stringify({
      idea_title: "Cross-Modal Attention for Drug-Protein Interaction Prediction",
      hypothesis: "Applying transformer self-attention across heterogeneous molecular modalities (sequence, structure, expression) will outperform unimodal baselines in drug-target interaction prediction.",
      claims: [
        "Self-attention mechanisms can capture long-range dependencies in biological sequences.",
        "Multi-head attention allows the model to jointly attend to information from different representation subspaces.",
        "Positional encoding is necessary for transformers processing sequential data without recurrence.",
        "Transformer models trained on large corpora transfer effectively to downstream tasks via fine-tuning.",
        "Scaled dot-product attention has O(n²) complexity with respect to sequence length.",
      ],
    });
  }
  if (prompt.includes("relation")) {
    return JSON.stringify({ relation: "SUPPORTS", reason: "The snippet directly references the concept in the claim." });
  }
  return "{}";
}

// ─── Idea generation ──────────────────────────────────────────────────────────

async function generateIdea(paperText, paperTitle) {
  const truncated = paperText.slice(0, 6000);
  const prompt = `You are a research scientist. Given the paper excerpt below, do three things:
1. Propose ONE novel cross-disciplinary research idea inspired by this paper.
2. State the core hypothesis in one sentence.
3. List 4-6 specific verifiable factual claims this idea relies on.

Paper title: ${paperTitle}
---
${truncated}
---
Respond ONLY with valid JSON (no markdown fences):
{"idea_title":"...","hypothesis":"...","claims":["...","..."]}`;

  const raw = await callLLM(prompt, 0.6);
  try { return JSON.parse(raw.trim()); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("LLM JSON parse failed: " + raw.slice(0, 200));
  }
}

// ─── Claim classification ─────────────────────────────────────────────────────

async function classifyEvidence(claim, snippet, score) {
  const prompt = `You are a scientific fact-checker. Does the snippet support or contradict the claim?

Claim: ${claim}
Snippet: ${snippet}
Similarity score (0-1): ${score.toFixed(2)}

Choose ONE: SUPPORTS | OVERCLAIM | MIS_CITATION | CONTRADICTION | UNSUPPORTED
Respond ONLY with valid JSON: {"relation":"<one of above>","reason":"<one sentence>"}`;

  let relation = "UNSUPPORTED";
  try {
    const raw = await callLLM(prompt, 0.1);
    const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```$/g, "");
    relation = (JSON.parse(cleaned).relation ?? "UNSUPPORTED").toUpperCase();
  } catch { }

  const errorMap = { OVERCLAIM: "Overclaim", MIS_CITATION: "Mis-citation", CONTRADICTION: "Contradiction", UNSUPPORTED: "Unsupported" };
  const error_type = errorMap[relation];
  let verdict;
  if (relation === "SUPPORTS")                                    verdict = score >= 0.75 ? "GREEN" : "YELLOW";
  else if (relation === "CONTRADICTION" || relation === "MIS_CITATION") verdict = "RED";
  else                                                            verdict = score >= 0.5  ? "YELLOW" : "RED";
  return { error_type, verdict };
}

// ─── Markdown report ──────────────────────────────────────────────────────────

function buildReport(report) {
  const { idea_title, hypothesis, input_paper_title, generated_at, evidence_chain, summary_stats } = report;
  const lines = [
    `# 📄 Scientific Evidence Chain Report`,
    ``,
    `> **Generated**: ${generated_at}`,
    `> **Input paper**: ${input_paper_title}`,
    ``,
    `---`,
    ``,
    `## 💡 Generated Research Idea`,
    ``,
    `**${idea_title}**`,
    ``,
    `## 🔬 Core Hypothesis`,
    ``,
    `> ${hypothesis}`,
    ``,
    `---`,
    ``,
    `## 🔗 Evidence Chain`,
    ``,
    `| ID | Verdict | Claim | Source | Error Type |`,
    `|----|---------|-------|--------|------------|`,
  ];

  for (const ev of evidence_chain) {
    const srcLink = ev.source_url ? `[${ev.source_title.slice(0, 45)}](${ev.source_url})` : ev.source_title.slice(0, 45);
    lines.push(`| ${ev.evidence_id} | ${verdictEmoji(ev.verdict)} ${ev.verdict} | ${ev.claim.replace(/\|/g,"\\|").slice(0,80)} | ${srcLink} | ${ev.error_type ?? "—"} |`);
  }

  lines.push(``, `---`, ``,
    `## 📊 Summary`, ``,
    `- 🟢 **Supported (GREEN)**: ${summary_stats.green}`,
    `- 🟡 **Uncertain (YELLOW)**: ${summary_stats.yellow}`,
    `- 🔴 **Erroneous (RED)**: ${summary_stats.red}`,
    ``, `---`, ``, `## 🔍 Detailed Evidence`, ``);

  for (const ev of evidence_chain) {
    const errLabel = ev.error_type ? ` (${ev.error_type})` : "";
    lines.push(
      `### ${verdictEmoji(ev.verdict)} ${ev.evidence_id} — ${ev.verdict}${errLabel}`, ``,
      `**Claim**: ${ev.claim}`, ``,
      `**Source**: [${ev.source_title}](${ev.source_url})`, ``,
      `**Similarity score**: ${(ev.support_level * 100).toFixed(1)}%`, ``
    );
    if (ev.snippet) {
      lines.push(`**Relevant snippet**:`, ``, `> ${ev.snippet.slice(0, 300).replace(/\n/g, " ")}`, ``);
    }
    lines.push(`---`, ``);
  }
  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  OpenClaw Evidence Tracker — Smoke Test");
  console.log("═══════════════════════════════════════════════════");

  // Step 1: Parse PDF
  console.log("\n[1/5] Parsing PDF:", PDF_PATH);
  const buffer = await readFile(PDF_PATH);
  const parsed = await pdfParse(buffer);
  const pdfText = parsed.text ?? "";
  const paperTitle = pdfText.split("\n").map(l => l.trim()).find(l => l.length > 10 && l.length < 200) ?? "Unknown Paper";
  console.log(`      Pages: ${parsed.numpages}, Chars: ${pdfText.length}`);
  console.log(`      Title: ${paperTitle}`);

  // Step 2: Generate idea
  console.log("\n[2/5] Generating research idea via LLM...");
  const { idea_title, hypothesis, claims } = await generateIdea(pdfText, paperTitle);
  console.log(`      Idea : ${idea_title}`);
  console.log(`      Hypo : ${hypothesis}`);
  console.log(`      Claims (${claims.length}): ${claims.map((c,i) => `\n        ${i+1}. ${c.slice(0,70)}`).join("")}`);

  // Step 3: Verify each claim
  console.log("\n[3/5] Verifying claims via literature search...");
  const evidence_chain = [];
  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    process.stdout.write(`      [${i+1}/${claims.length}] Searching: "${claim.slice(0,50)}..." `);
    const results = await ragSearch(claim, RAG_AC_KEY, 3);
    const best = results[0];
    const { error_type, verdict } = await classifyEvidence(claim, best.snippet, best.score);
    process.stdout.write(`→ ${verdictEmoji(verdict)} ${verdict}\n`);
    evidence_chain.push({
      evidence_id:   makeEvidenceId(i),
      claim,
      source_title:  best.title,
      source_url:    best.url,
      support_level: best.score,
      error_type,
      verdict,
      snippet:       best.snippet,
    });
  }

  // Step 4: Build report
  console.log("\n[4/5] Building Markdown report...");
  const summary_stats = {
    green:  evidence_chain.filter(e => e.verdict === "GREEN").length,
    yellow: evidence_chain.filter(e => e.verdict === "YELLOW").length,
    red:    evidence_chain.filter(e => e.verdict === "RED").length,
  };
  const reportData = { idea_title, hypothesis, generated_at: new Date().toISOString(), input_paper_title: paperTitle, evidence_chain, summary_stats };
  const markdown = buildReport(reportData);

  // Step 5: Write output
  console.log("\n[5/5] Writing report to:", OUT_PATH);
  await writeFile(OUT_PATH, markdown, "utf-8");

  console.log("\n═══════════════════════════════════════════════════");
  console.log(`  ✅ Done!  🟢 ${summary_stats.green}  🟡 ${summary_stats.yellow}  🔴 ${summary_stats.red}`);
  console.log(`  Report: ${OUT_PATH}`);
  console.log("═══════════════════════════════════════════════════\n");
  console.log("── Report preview (first 60 lines) ──────────────────");
  console.log(markdown.split("\n").slice(0, 60).join("\n"));
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
