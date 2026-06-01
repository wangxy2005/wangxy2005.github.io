// ═══════════════════════════════════════════════════════════════════════════
// Scientific Evidence Chain Tracker for OpenClaw
// 科研证据链追踪插件
//
// Purpose: Monitor and verify citations when OpenClaw agent generates research ideas
// 目的：监控并验证 OpenClaw agent 生成研究 idea 时的引用文献
//
// Workflow:
// 1. User uploads PDF and asks agent to generate ideas
// 2. Agent reads PDF and generates ideas (with citations)
// 3. Plugin records each citation the agent makes
// 4. Plugin verifies each citation against academic databases
// 5. Plugin generates color-coded evidence chain report
// ═══════════════════════════════════════════════════════════════════════════

import { Type } from "@sinclair/typebox";

// ── Types ──────────────────────────────────────────────────────────────────

interface Citation {
  citation_id: string;
  claim: string; // The claim/statement being made
  cited_source: string; // What the agent cited (title, author, etc.)
  context: string; // Context where this citation appears
  recorded_at: string;
}

interface VerifiedCitation extends Citation {
  verdict: "GREEN" | "YELLOW" | "RED";
  verdict_emoji: string;
  verification_reason: string;
  actual_source_title?: string;
  actual_source_url?: string;
  support_level: number; // 0-1 score
}

interface EvidenceSession {
  session_id: string;
  source_paper: string;
  idea_title: string;
  started_at: string;
  citations: Citation[];
  verified_citations: VerifiedCitation[];
  is_active: boolean;
}

// ── State Management ───────────────────────────────────────────────────────

let currentSession: EvidenceSession | null = null;
const sessionHistory: EvidenceSession[] = [];

// ── Citation Validation Helpers ────────────────────────────────────────────

// Extract DOI from citation string
function extractDOI(citation: string): string | null {
  const doiPattern = /10\.\d{4,}\/[^\s,)]+/;
  const match = citation.match(doiPattern);
  return match ? match[0].replace(/[,.]$/, '') : null;
}

// Extract arXiv ID from citation string
function extractArxivId(citation: string): string | null {
  // Support multiple formats:
  // - arXiv:1706.03762
  // - arXiv: 1706.03762
  // - arxiv:1706.03762
  // - 1706.03762 (if appears after "arXiv" keyword)
  const arxivPattern = /(?:arXiv\s*:\s*)?(\d{4}\.\d{4,5})/i;
  const match = citation.match(arxivPattern);
  return match ? match[1] : null;
}

// Extract author and year from citation string
function extractAuthorYear(citation: string): { author: string; year: string } | null {
  // Pattern: "Author et al., Year" or "Author et al. (Year)"
  const pattern1 = /([A-Z][a-z]+(?:\s+et\s+al\.?)?)[,\s]+(\d{4})/;
  const match1 = citation.match(pattern1);
  if (match1) {
    return { author: match1[1].replace(/\s+et\s+al\.?/, ''), year: match1[2] };
  }

  // Pattern: "(Author et al., Year)"
  const pattern2 = /\(([A-Z][a-z]+(?:\s+et\s+al\.?)?)[,\s]+(\d{4})\)/;
  const match2 = citation.match(pattern2);
  if (match2) {
    return { author: match2[1].replace(/\s+et\s+al\.?/, ''), year: match2[2] };
  }

  return null;
}

// Extract title from citation string (improved heuristic)
function extractTitle(citation: string): string | null {
  // Look for quoted title
  const quotedPattern = /"([^"]+)"/;
  const match = citation.match(quotedPattern);
  if (match) return match[1];

  // Look for title after comma (common format: "Author et al., Year, Title")
  const parts = citation.split(',');
  if (parts.length >= 3) {
    let potentialTitle = parts.slice(2).join(',').trim();

    // Remove arXiv ID, DOI, and other metadata from title
    potentialTitle = potentialTitle
      .replace(/,?\s*arXiv:\d+\.\d+/gi, '')
      .replace(/,?\s*doi:\S+/gi, '')
      .replace(/,?\s*pp?\.\s*\d+/gi, '')
      .replace(/,?\s*vol\.\s*\d+/gi, '')
      .trim();

    // Filter out if it's too short or looks like metadata
    if (potentialTitle.length > 15 && !potentialTitle.match(/^\d+$|^pp?\.|^vol\./i)) {
      return potentialTitle;
    }
  }

  // Look for capitalized phrase that might be a title (at least 3 words)
  const titlePattern = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){2,})/;
  const titleMatch = citation.match(titlePattern);
  if (titleMatch && titleMatch[1].length > 20) {
    return titleMatch[1];
  }

  return null;
}

// Calculate title similarity using Jaccard index
function titleSimilarity(title1: string, title2: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '');
  const t1 = normalize(title1);
  const t2 = normalize(title2);

  const words1 = new Set(t1.split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(t2.split(/\s+/).filter(w => w.length > 2));

  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return union.size > 0 ? intersection.size / union.size : 0;
}

// Validate citation exists using free APIs (with retry)
async function validateCitationExists(
  citedSource: string
): Promise<{ exists: boolean; metadata: any; doi?: string }> {

  const doi = extractDOI(citedSource);
  const arxivId = extractArxivId(citedSource);
  const title = extractTitle(citedSource);
  const authorYear = extractAuthorYear(citedSource);

  console.log(`[validateCitationExists] Checking: "${citedSource}"`);
  console.log(`  - DOI: ${doi || 'none'}`);
  console.log(`  - arXiv: ${arxivId || 'none'}`);
  console.log(`  - Title: ${title || 'none'}`);
  console.log(`  - Author+Year: ${authorYear ? `${authorYear.author} ${authorYear.year}` : 'none'}`);

  // Helper function to retry API calls
  async function retryFetch(url: string, options: any, maxRetries = 2): Promise<Response> {
    for (let i = 0; i <= maxRetries; i++) {
      try {
        const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
        return response;
      } catch (err) {
        if (i === maxRetries) throw err;
        console.log(`  Retry ${i + 1}/${maxRetries} after error:`, err);
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // exponential backoff
      }
    }
    throw new Error('Max retries exceeded');
  }

  // ========================================
  // STRATEGY 1: Use arXiv ID if available (highest priority)
  // ========================================
  if (arxivId) {
    console.log(`  [Strategy 1] Using arXiv ID: ${arxivId}`);

    // 1a. Try arXiv API directly (fast, authoritative)
    try {
      console.log(`    → arXiv.org API...`);
      const response = await retryFetch(
        `http://export.arxiv.org/api/query?id_list=${arxivId}&max_results=1`,
        { headers: { 'User-Agent': 'OpenClaw-Evidence-Tracker/1.0' } }
      );
      if (response.ok) {
        const xmlText = await response.text();
        if (xmlText.includes('<entry>')) {
          const titleMatch = xmlText.match(/<title>(.*?)<\/title>/s);
          const abstractMatch = xmlText.match(/<summary>(.*?)<\/summary>/s);
          const authorMatch = xmlText.matchAll(/<name>(.*?)<\/name>/g);
          const publishedMatch = xmlText.match(/<published>(.*?)<\/published>/);

          const paperTitle = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : '';
          const paperAbstract = abstractMatch ? abstractMatch[1].trim().replace(/\s+/g, ' ') : '';
          const authors = Array.from(authorMatch, m => ({ name: m[1].trim() }));
          const year = publishedMatch ? parseInt(publishedMatch[1].substring(0, 4)) : null;

          console.log(`  ✓ Found via arXiv.org: ${paperTitle}`);
          return {
            exists: true,
            metadata: {
              title: paperTitle,
              abstract: paperAbstract,
              authors,
              year,
              externalIds: { ArXiv: arxivId }
            },
            doi: null
          };
        }
      }
    } catch (err) {
      console.error('    ✗ arXiv.org failed:', err);
    }

    // 1b. Try Semantic Scholar with arXiv ID
    try {
      console.log(`    → Semantic Scholar (arXiv:${arxivId})...`);
      const response = await retryFetch(
        `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=title,abstract,authors,year,citationCount,fieldsOfStudy,paperId,externalIds`,
        { headers: { 'User-Agent': 'OpenClaw-Evidence-Tracker/1.0' } }
      );
      if (response.ok) {
        const data = await response.json();
        console.log(`  ✓ Found via Semantic Scholar (arXiv): ${data.title}`);
        return {
          exists: true,
          metadata: data,
          doi: data.externalIds?.DOI || doi
        };
      }
    } catch (err) {
      console.error('    ✗ Semantic Scholar (arXiv) failed:', err);
    }

    // If arXiv ID search failed, continue to DOI/title search
    console.log(`  ✗ arXiv ID search failed, trying other methods...`);
  }

  // ========================================
  // STRATEGY 2: Use DOI if available (second priority)
  // ========================================
  if (doi) {
    console.log(`  [Strategy 2] Using DOI: ${doi}`);

    // 2a. Try CrossRef API
    try {
      console.log(`    → CrossRef...`);
      const response = await retryFetch(`https://api.crossref.org/works/${doi}`, {});
      if (response.ok) {
        const data = await response.json();
        const crossrefMetadata = {
          title: data.message.title?.[0],
          abstract: data.message.abstract,
          authors: data.message.author,
          year: data.message.published?.['date-parts']?.[0]?.[0],
          fieldsOfStudy: data.message.subject || []
        };

        console.log(`  ✓ Found via CrossRef: ${crossrefMetadata.title}`);

        // If CrossRef has abstract, return immediately
        if (crossrefMetadata.abstract) {
          return {
            exists: true,
            metadata: crossrefMetadata,
            doi
          };
        }

        // Otherwise, try Semantic Scholar for abstract
        console.log(`    CrossRef has no abstract, trying Semantic Scholar...`);
        try {
          const s2Response = await retryFetch(
            `https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}?fields=abstract`,
            { headers: { 'User-Agent': 'OpenClaw-Evidence-Tracker/1.0' } }
          );
          if (s2Response.ok) {
            const s2Data = await s2Response.json();
            if (s2Data.abstract) {
              console.log(`  ✓ Found abstract via Semantic Scholar`);
              crossrefMetadata.abstract = s2Data.abstract;
            }
          }
        } catch (s2Err) {
          console.error(`    ✗ Semantic Scholar abstract fetch failed:`, s2Err);
        }

        // Return CrossRef metadata (with or without abstract from S2)
        return {
          exists: true,
          metadata: crossrefMetadata,
          doi
        };
      }
    } catch (err) {
      console.error('    ✗ CrossRef failed:', err);
    }

    // 2b. Try Semantic Scholar with DOI
    try {
      console.log(`    → Semantic Scholar (DOI)...`);
      const response = await retryFetch(
        `https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}?fields=title,abstract,authors,year,citationCount,fieldsOfStudy,paperId,externalIds`,
        { headers: { 'User-Agent': 'OpenClaw-Evidence-Tracker/1.0' } }
      );
      if (response.ok) {
        const data = await response.json();
        console.log(`  ✓ Found via Semantic Scholar (DOI): ${data.title}`);
        return {
          exists: true,
          metadata: data,
          doi
        };
      }
    } catch (err) {
      console.error('    ✗ Semantic Scholar (DOI) failed:', err);
    }

    console.log(`  ✗ DOI search failed, trying title search...`);
  }

  // ========================================
  // STRATEGY 3: Fallback to title search (lowest priority)
  // ========================================
  if (title && title.length > 10) {
    console.log(`  [Strategy 3] Using title search: "${title}"`);

    // 3a. Try Semantic Scholar title search
    try {
      console.log(`    → Semantic Scholar (title)...`);
      const response = await retryFetch(
        `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&limit=3&fields=title,abstract,authors,year,paperId,fieldsOfStudy,externalIds`,
        { headers: { 'User-Agent': 'OpenClaw-Evidence-Tracker/1.0' } }
      );
      if (response.ok) {
        const data = await response.json();
        if (data.data && data.data.length > 0) {
          // Find best title match
          for (const paper of data.data) {
            const similarity = titleSimilarity(title, paper.title);
            console.log(`      - "${paper.title}" (similarity: ${(similarity * 100).toFixed(0)}%)`);
            if (similarity > 0.6) {
              console.log(`  ✓ Found via title match`);
              return {
                exists: true,
                metadata: paper,
                doi: paper.externalIds?.DOI
              };
            }
          }
        }
      }
    } catch (err) {
      console.error('    ✗ Semantic Scholar (title) failed:', err);
    }

    // 3b. Try DBLP title search
    try {
      console.log(`    → DBLP (title)...`);
      const response = await retryFetch(
        `https://dblp.org/search/publ/api?q=${encodeURIComponent(title)}&format=json&h=3`,
        {}
      );
      if (response.ok) {
        const data = await response.json();
        if (data.result?.hits?.hit && data.result.hits.hit.length > 0) {
          for (const hit of data.result.hits.hit) {
            const paperTitle = hit.info?.title || '';
            const similarity = titleSimilarity(title, paperTitle);
            console.log(`      - "${paperTitle}" (similarity: ${(similarity * 100).toFixed(0)}%)`);
            if (similarity > 0.6) {
              console.log(`  ✓ Found via DBLP title match`);
              return {
                exists: true,
                metadata: {
                  title: paperTitle,
                  authors: hit.info?.authors?.author || [],
                  year: hit.info?.year,
                  venue: hit.info?.venue
                },
                doi: hit.info?.doi
              };
            }
          }
        }
      }
    } catch (err) {
      console.error('    ✗ DBLP (title) failed:', err);
    }

    console.log(`  ✗ Title search failed, trying author+year...`);
  }

  // ========================================
  // STRATEGY 4: Last resort - author + year search
  // ========================================
  if (authorYear) {
    console.log(`  [Strategy 4] Using author+year: ${authorYear.author} ${authorYear.year}`);

    try {
      const query = `${authorYear.author} ${authorYear.year}`;
      console.log(`    → Semantic Scholar (author+year)...`);
      const response = await retryFetch(
        `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&year=${authorYear.year}&limit=5&fields=title,abstract,authors,year,paperId,fieldsOfStudy,externalIds`,
        { headers: { 'User-Agent': 'OpenClaw-Evidence-Tracker/1.0' } }
      );
      if (response.ok) {
        const data = await response.json();
        if (data.data && data.data.length > 0) {
          // Find paper with matching author surname and year
          for (const paper of data.data) {
            const hasMatchingAuthor = paper.authors?.some((a: any) =>
              a.name?.toLowerCase().includes(authorYear.author.toLowerCase())
            );
            if (hasMatchingAuthor && paper.year === parseInt(authorYear.year)) {
              console.log(`  ✓ Found via author+year: ${paper.title}`);
              return {
                exists: true,
                metadata: paper,
                doi: paper.externalIds?.DOI
              };
            }
          }
          // If no exact match, return the first result from that year
          const firstMatch = data.data.find((p: any) => p.year === parseInt(authorYear.year));
          if (firstMatch) {
            console.log(`  ✓ Found via year match: ${firstMatch.title}`);
            return {
              exists: true,
              metadata: firstMatch,
              doi: firstMatch.externalIds?.DOI
            };
          }
        }
      }
    } catch (err) {
      console.error('    ✗ Semantic Scholar (author+year) failed:', err);
    }
  }

  // ========================================
  // All strategies failed
  // ========================================
  console.log(`  ✗ Citation not found in any database`);
  return { exists: false, metadata: null };
}

// Calculate keyword-based similarity
function calculateKeywordSimilarity(claim: string, abstract: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '');
  const claimWords = new Set(
    normalize(claim).split(/\s+/).filter(w => w.length > 3)
  );
  const abstractWords = new Set(
    normalize(abstract).split(/\s+/).filter(w => w.length > 3)
  );

  const intersection = new Set([...claimWords].filter(w => abstractWords.has(w)));
  const union = new Set([...claimWords, ...abstractWords]);

  return union.size > 0 ? intersection.size / union.size : 0;
}

// Check if paper is relevant for cross-disciplinary research
function checkCrossDisciplinaryRelevance(
  paperFields: string[],
  ideaTitle?: string
): boolean {
  if (!ideaTitle) return false;

  const crossDisciplinaryKeywords = [
    'cross-modal', 'multi-modal', 'multimodal', 'interdisciplinary',
    'cross-disciplinary', 'transfer', 'application', 'inspired by',
    'adapted from', 'apply', 'extend'
  ];

  const ideaLower = ideaTitle.toLowerCase();
  const hasCrossDisciplinaryIntent = crossDisciplinaryKeywords.some(
    kw => ideaLower.includes(kw)
  );

  if (hasCrossDisciplinaryIntent && paperFields && paperFields.length > 0) {
    const relatedFields = [
      'Computer Science', 'Engineering', 'Mathematics', 'Physics',
      'Biology', 'Medicine', 'Chemistry', 'Materials Science'
    ];
    return paperFields.some(field =>
      relatedFields.some(rf => field.includes(rf))
    );
  }

  return false;
}

// Normalize support level to 0-1 range
function normalizeSupportLevel(rawScore: number): number {
  return Math.min(1.0, Math.max(0.0, rawScore));
}

function generateSessionId(): string {
  return `EVD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateCitationId(index: number): string {
  return `CIT-${String(index + 1).padStart(3, "0")}`;
}

// ── External APIs ──────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number;
}

async function searchLiterature(query: string, topK = 3): Promise<SearchResult[]> {
  // Try CrossRef first (free, no API key needed)
  try {
    const results = await crossRefSearch(query, topK);
    if (results.length > 0) return results;
  } catch {}

  // Fallback to Semantic Scholar
  try {
    const results = await semanticScholarSearch(query, topK);
    if (results.length > 0) return results;
  } catch {}

  return [{ title: "(Search unavailable)", url: "", snippet: "", score: 0.1 }];
}

async function crossRefSearch(query: string, topK: number): Promise<SearchResult[]> {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${topK}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "OpenClaw-EvidenceTracker/1.0" },
  });

  if (!resp.ok) throw new Error(`CrossRef API error: ${resp.status}`);

  const data = await resp.json();
  const items = data.message?.items ?? [];

  return items.map((item: any) => ({
    title: item.title?.[0] ?? "(No title)",
    url: item.DOI ? `https://doi.org/${item.DOI}` : "",
    snippet: item.abstract ?? item.title?.[0] ?? "",
    score: item.score ?? 0.5,
  }));
}

async function semanticScholarSearch(query: string, topK: number): Promise<SearchResult[]> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${topK}&fields=title,abstract,url,citationCount`;
  const resp = await fetch(url);

  if (!resp.ok) throw new Error(`Semantic Scholar API error: ${resp.status}`);

  const data = await resp.json();
  const papers = data.data ?? [];

  return papers.map((paper: any) => ({
    title: paper.title ?? "(No title)",
    url: paper.url ?? "",
    snippet: paper.abstract ?? paper.title ?? "",
    score: Math.min(1.0, (paper.citationCount ?? 0) / 100),
  }));
}

// ── LLM Integration ────────────────────────────────────────────────────────

// Store api reference for use in async functions
let pluginApi: any = null;

async function callLLM(prompt: string, temperature = 0.3): Promise<string> {
  if (!pluginApi) {
    throw new Error("Plugin API not initialized");
  }

  try {
    // Direct HTTP call to OpenClaw's configured LLM API
    // Read the API configuration from openclaw.json
    const fs = await import("fs/promises");
    const path = await import("path");
    const os = await import("os");

    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const configContent = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(configContent);

    // Get the primary model configuration
    const primaryModel = config.agents?.defaults?.model?.primary || "openai-relay/gpt-5.5";
    const [provider, model] = primaryModel.split("/");

    const providerConfig = config.models?.providers?.[provider];
    if (!providerConfig) {
      throw new Error(`Provider ${provider} not found in config`);
    }

    const baseUrl = providerConfig.baseUrl;
    const apiKey = providerConfig.apiKey;

    // Make direct API call
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: "system",
            content: "You are a research verification expert. Respond with ONLY the requested JSON format, no markdown, no code blocks, no additional text.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: temperature,
        stream: true,  // Explicitly request streaming
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API returned ${response.status}: ${errorText.slice(0, 200)}`);
    }

    // Always read as text first to handle both SSE and JSON
    const text = await response.text();

    // Try to parse as SSE format first
    if (text.includes("data: ")) {
      const lines = text.split("\n");
      let fullContent = "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        const jsonStr = line.slice(6).trim(); // Remove "data: " prefix
        if (jsonStr === "[DONE]") break;
        if (jsonStr === "") continue;

        try {
          const chunk = JSON.parse(jsonStr);

          // Try different response formats
          const delta = chunk.choices?.[0]?.delta?.content ||
                       chunk.choices?.[0]?.message?.content ||
                       "";

          if (delta) {
            fullContent += delta;
          }
        } catch (e) {
          // Skip invalid JSON chunks
        }
      }

      if (fullContent) {
        return fullContent.trim();
      }

      // If no content found in SSE, log the response for debugging
      pluginApi.logger.error(`No content in SSE response. Full response: ${text.slice(0, 1000)}`);
      throw new Error(`Empty SSE response (no content generated)`);
    }

    // Try to parse as standard JSON
    try {
      const data = JSON.parse(text);
      const content = data.choices?.[0]?.message?.content;

      if (typeof content === 'string') {
        return content.trim();
      }

      throw new Error(`No content in JSON response: ${JSON.stringify(data).slice(0, 500)}`);
    } catch (parseErr: any) {
      pluginApi.logger.error(`Failed to parse response as JSON: ${parseErr.message}`);
      throw new Error(`Unexpected API response format: ${text.slice(0, 500)}`);
    }
  } catch (err: any) {
    pluginApi.logger.error(`LLM call failed: ${err.message}, stack: ${err.stack?.slice(0, 200)}`);
    throw new Error(`LLM_CALL_FAILED: ${err.message}`);
  }
}

async function verifyCitation(
  claim: string,
  citedSource: string,
  searchResults: SearchResult[],
  ideaTitle?: string
): Promise<{
  verdict: "GREEN" | "YELLOW" | "RED";
  reason: string;
  support_level: number;
  actual_source_title?: string;
  actual_source_url?: string;
}> {

  // STEP 1: Validate citation exists
  const citationValidation = await validateCitationExists(citedSource);

  if (!citationValidation.exists) {
    return {
      verdict: "RED",
      reason: "Citation does not exist or cannot be verified in academic databases",
      support_level: 0.0
    };
  }

  // STEP 2: Get paper metadata
  let paperAbstract = citationValidation.metadata.abstract || "";
  const paperTitle = citationValidation.metadata.title || "";
  const paperFields = citationValidation.metadata.fieldsOfStudy || [];
  const paperUrl = citationValidation.doi
    ? `https://doi.org/${citationValidation.doi}`
    : undefined;

  // If no abstract, try to fetch from alternative sources
  if (!paperAbstract) {
    console.log(`  No abstract from primary source, trying alternatives...`);

    // Try Semantic Scholar if we have DOI or arXiv ID
    const doi = extractDOI(citedSource);
    const arxivId = extractArxivId(citedSource);

    if (doi) {
      try {
        console.log(`    → Semantic Scholar (DOI) for abstract...`);
        const response = await fetch(
          `https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}?fields=abstract`,
          { headers: { 'User-Agent': 'OpenClaw-Evidence-Tracker/1.0' }, signal: AbortSignal.timeout(10000) }
        );
        if (response.ok) {
          const data = await response.json();
          if (data.abstract) {
            console.log(`  ✓ Found abstract via Semantic Scholar`);
            paperAbstract = data.abstract;
          }
        }
      } catch (err) {
        console.error(`    ✗ Semantic Scholar abstract fetch failed:`, err);
      }
    }

    if (!paperAbstract && arxivId) {
      try {
        console.log(`    → arXiv.org for abstract...`);
        const response = await fetch(
          `http://export.arxiv.org/api/query?id_list=${arxivId}&max_results=1`,
          { headers: { 'User-Agent': 'OpenClaw-Evidence-Tracker/1.0' }, signal: AbortSignal.timeout(10000) }
        );
        if (response.ok) {
          const xmlText = await response.text();
          const abstractMatch = xmlText.match(/<summary>(.*?)<\/summary>/s);
          if (abstractMatch) {
            paperAbstract = abstractMatch[1].trim().replace(/\s+/g, ' ');
            console.log(`  ✓ Found abstract via arXiv.org`);
          }
        }
      } catch (err) {
        console.error(`    ✗ arXiv abstract fetch failed:`, err);
      }
    }
  }

  // If still no abstract after all attempts, return YELLOW
  if (!paperAbstract) {
    return {
      verdict: "YELLOW",
      reason: "Citation exists but abstract not available for verification - cannot confirm claim support",
      support_level: 0.5,
      actual_source_title: paperTitle,
      actual_source_url: paperUrl
    };
  }

  // STEP 3: Let LLM handle ALL semantic verification
  // No more keyword similarity filtering - LLM is better at understanding cross-disciplinary connections
  const llmVerdict = await verifyWithLLM(claim, citedSource, paperAbstract, paperTitle, ideaTitle);

  return {
    verdict: llmVerdict.verdict,
    reason: llmVerdict.reason,
    support_level: llmVerdict.confidence,
    actual_source_title: paperTitle,
    actual_source_url: paperUrl
  };
}

// LLM-based verification with strict prompt
async function verifyWithLLM(
  claim: string,
  citedSource: string,
  paperAbstract: string,
  paperTitle: string,
  ideaTitle?: string
): Promise<{ verdict: "GREEN" | "YELLOW" | "RED"; reason: string; confidence: number }> {

  const contextNote = ideaTitle
    ? `\n**Research Context**: This citation is used in a cross-disciplinary research idea titled "${ideaTitle}". Consider whether the cited paper provides foundational concepts, methods, or evidence that logically support the claim, even if from a different field.`
    : "";

  const prompt = `You are a research verification expert. Evaluate whether the following claim is supported by the provided paper abstract.

**Claim**: "${claim}"

**Cited Source**: "${citedSource}"

**Paper Title**: "${paperTitle}"

**Paper Abstract**:
${paperAbstract.slice(0, 1500)}
${contextNote}

**EVALUATION CRITERIA**:

🟢 **GREEN** (Well-supported):
- The abstract DIRECTLY discusses and supports the claim
- The paper provides foundational concepts, methods, or evidence that back up the claim
- For cross-disciplinary citations: the paper establishes a technique/concept that is being applied to a new domain
- The claim accurately represents what the paper contributes

🟡 **YELLOW** (Uncertain) - Provide specific reason:
- "Paper discusses related concepts but abstract lacks sufficient detail to fully confirm the claim"
- "Cross-disciplinary citation - the connection is plausible but requires domain expertise to verify"
- "Paper provides partial support but the claim may be slightly overclaimed"
- "Abstract is too brief to verify the specific claim, though the paper topic is relevant"

🔴 **RED** (Not supported) - Provide specific reason:
- "Paper directly contradicts the claim: [explain contradiction]"
- "Overclaim - claim significantly overstates what the cited paper demonstrates"
- "Wrong paper - the cited source title/authors don't match this paper"
- "Paper is completely unrelated - discusses entirely different topic with no logical connection"

**IMPORTANT GUIDELINES**:
1. **For cross-disciplinary research**: Be LENIENT if the cited paper provides foundational methods/concepts being applied to a new field. Example: citing AlphaFold in a protein design paper is valid even if AlphaFold doesn't discuss design.
2. **For methodological citations**: If the claim is about a technique (e.g., "Transformers can model sequences"), verify the paper demonstrates that technique, even if applied to a different domain.
3. **For foundational citations**: If the claim establishes background (e.g., "X showed Y is possible"), verify the paper achieved Y, even if the current research applies it differently.
4. **Only mark RED** if there's a clear error: wrong paper, contradiction, or completely unrelated topic.
5. **Prefer YELLOW over RED** when uncertain - it's better to flag for human review than to incorrectly reject a valid citation.

Respond with ONLY a JSON object (no markdown, no code blocks):
{
  "verdict": "GREEN" | "YELLOW" | "RED",
  "reason": "Specific explanation with details",
  "confidence": 0.0-1.0
}`;

  try {
    const response = await callLLM(prompt, 0.2);
    const match = response.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      return {
        verdict: result.verdict,
        reason: result.reason,
        confidence: result.confidence
      };
    }
  } catch (err: any) {
    console.error("LLM verification failed:", err);
    // If LLM call fails, return YELLOW with error message
    return {
      verdict: "YELLOW",
      reason: `LLM verification failed: ${err.message}. Manual review required.`,
      confidence: 0.3
    };
  }

  // Fallback: if response parsing fails, return YELLOW
  return {
    verdict: "YELLOW",
    reason: "LLM returned unexpected format. Manual review recommended.",
    confidence: 0.5
  };
}

// ── Report Generation ──────────────────────────────────────────────────────

function buildEvidenceReport(session: EvidenceSession): string {
  const stats = {
    total: session.verified_citations.length,
    green: session.verified_citations.filter((c) => c.verdict === "GREEN").length,
    yellow: session.verified_citations.filter((c) => c.verdict === "YELLOW").length,
    red: session.verified_citations.filter((c) => c.verdict === "RED").length,
  };

  let md = `# 📄 Evidence Chain Report\n\n`;
  md += `**Session ID**: ${session.session_id}\n`;
  md += `**Source Paper**: ${session.source_paper}\n`;
  md += `**Generated Idea**: ${session.idea_title}\n`;
  md += `**Started**: ${session.started_at}\n\n`;

  md += `## 📊 Summary Statistics\n\n`;
  md += `- **Total Citations**: ${stats.total}\n`;
  md += `- 🟢 **GREEN** (Correct): ${stats.green}\n`;
  md += `- 🟡 **YELLOW** (Uncertain): ${stats.yellow}\n`;
  md += `- 🔴 **RED** (Error): ${stats.red}\n\n`;

  md += `## 🔗 Citation Verification Details\n\n`;

  for (const cit of session.verified_citations) {
    // CHANGE 1: Show full claim instead of truncated preview
    const claimText = cit.claim || "(No claim)";
    md += `### ${cit.verdict_emoji} ${cit.citation_id}: ${claimText}\n\n`;
    md += `**Cited Source**: ${cit.cited_source || "(No source)"}\n\n`;
    md += `**Context**: ${cit.context || "(No context)"}\n\n`;
    md += `**Verdict**: ${cit.verdict} (Support Level: ${(cit.support_level * 100).toFixed(0)}%)\n\n`;

    // CHANGE 2: Classify non-GREEN citations
    if (cit.verdict !== "GREEN") {
      const errorType = classifyErrorType(cit.verification_reason || "");
      md += `**Error Type**: ${errorType}\n\n`;
    }

    md += `**Reason**: ${cit.verification_reason || "(No reason)"}\n\n`;

    if (cit.actual_source_title) {
      md += `**Actual Source Found**: [${cit.actual_source_title}](${cit.actual_source_url || "#"})\n\n`;
    }

    md += `---\n\n`;
  }

  // CHANGE 3: Add Evidence Table
  md += `## 📋 Evidence Table\n\n`;
  md += `| Case ID | Claim | Cited Evidence | Verdict | Error Type | Explanation |\n`;
  md += `|---------|-------|----------------|---------|------------|-------------|\n`;

  for (const cit of session.verified_citations) {
    const caseId = cit.citation_id;
    const claim = (cit.claim || "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 80) + "...";
    const evidence = (cit.cited_source || "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 60) + "...";
    const verdict = cit.verdict_emoji + " " + cit.verdict;
    const errorType = cit.verdict !== "GREEN" ? classifyErrorType(cit.verification_reason || "") : "N/A";
    const explanation = (cit.verification_reason || "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 100) + "...";

    md += `| ${caseId} | ${claim} | ${evidence} | ${verdict} | ${errorType} | ${explanation} |\n`;
  }

  md += `\n`;

  return md;
}

// Helper function to classify error types for non-GREEN citations
function classifyErrorType(reason: string): string {
  const lowerReason = reason.toLowerCase();

  // 1. Unsupported Claim: no material supports the conclusion
  if (lowerReason.includes("abstract not available") ||
      lowerReason.includes("cannot confirm") ||
      lowerReason.includes("no content") ||
      lowerReason.includes("llm verification failed")) {
    return "Unsupported Claim";
  }

  // 2. Contradiction: conclusion conflicts with material
  if (lowerReason.includes("contradict") ||
      lowerReason.includes("opposite") ||
      lowerReason.includes("conflicts with") ||
      lowerReason.includes("does not support")) {
    return "Contradiction";
  }

  // 3. Overclaim: material supports weaker conclusion
  if (lowerReason.includes("abstract only") ||
      lowerReason.includes("lacks sufficient detail") ||
      lowerReason.includes("cannot be fully verified") ||
      lowerReason.includes("likely accurate for the full paper") ||
      lowerReason.includes("does not explicitly")) {
    return "Overclaim";
  }

  // 4. Mis-citation: related but doesn't support specific conclusion
  if (lowerReason.includes("relevant") ||
      lowerReason.includes("related") ||
      lowerReason.includes("does not specifically") ||
      lowerReason.includes("general claim")) {
    return "Mis-citation";
  }

  // Default: Unsupported Claim
  return "Unsupported Claim";
}


// ── Tools ──────────────────────────────────────────────────────────────────

function createTools(api: any) {
  return [
    // ── 1. start_evidence_tracking ────────────────────────────────────────────
    (ctx: any) => ({
      name: "start_evidence_tracking",
      description:
        "🔍 开始证据链追踪 (Start Evidence Tracking): Begin tracking citations for a new research idea generation session. Call this BEFORE you start generating ideas based on a paper. This creates a new evidence tracking session that will monitor all citations you make. IMPORTANT: Generate NEW research ideas - they can be within the same field OR cross-disciplinary, whichever makes more sense. Do NOT force cross-disciplinary ideas if staying within the field produces better research directions.",
      parameters: Type.Object({
        source_paper: Type.String({ description: "Title or path of the source paper being analyzed" }),
        idea_title: Type.String({ description: "Title of the research idea you're about to generate" }),
      }),
      async execute(_toolCallId: string, params: any) {
        const { source_paper, idea_title } = params;

        // Auto-close previous session if exists
        if (currentSession && currentSession.is_active) {
          console.log(`[evidence-tracker] Auto-closing previous session: ${currentSession.session_id}`);
          currentSession.is_active = false;
        }

        currentSession = {
          session_id: generateSessionId(),
          source_paper,
          idea_title,
          started_at: new Date().toISOString(),
          citations: [],
          verified_citations: [],
          is_active: true,
        };

        return {
          success: true,
          session_id: currentSession.session_id,
          message: `Evidence tracking started. Now generate your idea and use record_citation() each time you cite a source.`,
        };
      },
    }),

    // ── 2. record_citation ─────────────────────────────────────────────────────
    (ctx: any) => ({
      name: "record_citation",
      description:
        "📝 记录引用 (Record Citation): Record a citation you just made while generating a research idea. Call this EACH TIME you cite a source or make a claim that references literature. **IMPORTANT**: When citing papers, ALWAYS include arXiv ID (e.g., 'arXiv:1706.03762') or DOI in the cited_source field to enable accurate verification. Format: 'Author et al., Year, Title, arXiv:XXXX.XXXXX' or 'Author et al., Year, Title, doi:10.XXXX/XXXXX'. REQUIRED PARAMETERS: claim (string), cited_source (string with arXiv/DOI), context (string - use empty string if no context).",
      parameters: Type.Object({
        claim: Type.String({ description: "The claim or statement you're making" }),
        cited_source: Type.String({ description: "The source you're citing. MUST include arXiv ID (arXiv:XXXX.XXXXX) or DOI (doi:10.XXXX/XXXXX) for verification. Format: 'Author et al., Year, Title, arXiv:1706.03762'" }),
        context: Type.String({ description: "Context where this citation appears (use empty string '' if no context)" }),
      }),
      async execute(_toolCallId: string, params: any) {
        const { claim, cited_source, context } = params;

        if (!currentSession || !currentSession.is_active) {
          return {
            success: false,
            error: "No active evidence tracking session. Call start_evidence_tracking() first.",
          };
        }

        const citation: Citation = {
          citation_id: generateCitationId(currentSession.citations.length),
          claim,
          cited_source,
          context: context || "",
          recorded_at: new Date().toISOString(),
        };

        currentSession.citations.push(citation);

        return {
          success: true,
          citation_id: citation.citation_id,
          total_citations: currentSession.citations.length,
          message: `Citation recorded. Continue generating your idea and record more citations as needed.`,
        };
      },
    }),

    // ── 3. verify_evidence_chain ───────────────────────────────────────────────
    (ctx: any) => ({
      name: "verify_evidence_chain",
      description:
        "✅ 验证证据链 (Verify Evidence Chain): Verify all recorded citations using citation existence validation + semantic similarity + LLM verification. Returns color-coded verdicts (🟢 GREEN / 🟡 YELLOW / 🔴 RED) with specific reasons.",
      parameters: Type.Object({}),
      async execute(_toolCallId: string, params: any) {
        if (!currentSession || !currentSession.is_active) {
          return {
            success: false,
            error: "No active evidence tracking session. Call start_evidence_tracking() first.",
          };
        }

        if (currentSession.citations.length === 0) {
          return {
            success: false,
            error: "No citations recorded yet. Use record_citation() to record citations first.",
          };
        }

        // Verify each citation with new logic
        for (const citation of currentSession.citations) {
          // Still search for context, but mainly rely on citation validation
          const searchResults = await searchLiterature(
            `${citation.claim} ${citation.cited_source}`,
            3
          );

          const verificationResult = await verifyCitation(
            citation.claim,
            citation.cited_source,
            searchResults,
            currentSession.idea_title
          );

          const verdictEmoji = verificationResult.verdict === "GREEN" ? "🟢"
            : verificationResult.verdict === "YELLOW" ? "🟡" : "🔴";

          const verifiedCitation: VerifiedCitation = {
            ...citation,
            verdict: verificationResult.verdict,
            verdict_emoji: verdictEmoji,
            verification_reason: verificationResult.reason,
            actual_source_title: verificationResult.actual_source_title,
            actual_source_url: verificationResult.actual_source_url,
            support_level: verificationResult.support_level,
          };

          currentSession.verified_citations.push(verifiedCitation);
        }

        const stats = {
          total: currentSession.verified_citations.length,
          green: currentSession.verified_citations.filter((c) => c.verdict === "GREEN").length,
          yellow: currentSession.verified_citations.filter((c) => c.verdict === "YELLOW").length,
          red: currentSession.verified_citations.filter((c) => c.verdict === "RED").length,
        };

        return {
          success: true,
          session_id: currentSession.session_id,
          summary_stats: stats,
          verified_citations: currentSession.verified_citations,
          message: `Verification complete. ${stats.green} 🟢 GREEN, ${stats.yellow} 🟡 YELLOW, ${stats.red} 🔴 RED`,
        };
      },
    }),

    // ── 4. generate_evidence_report ────────────────────────────────────────────
    (ctx: any) => ({
      name: "generate_evidence_report",
      description:
        "📊 生成证据链报告 (Generate Evidence Report): Generate a comprehensive Markdown report of the verified evidence chain. Call this after verify_evidence_chain() to create a detailed report with color-coded verdicts.",
      parameters: Type.Object({
        output_path: Type.Optional(Type.String({ description: "Optional path to save the report (e.g., /home/wxy/.openclaw/workspace/evidence_report.md)" })),
      }),
      async execute(_toolCallId: string, params: any) {
        const { output_path } = params;

        if (!currentSession) {
          return {
            success: false,
            error: "No evidence tracking session found.",
          };
        }

        if (currentSession.verified_citations.length === 0) {
          return {
            success: false,
            error: "No verified citations yet. Call verify_evidence_chain() first.",
          };
        }

        const markdown = buildEvidenceReport(currentSession);

        // Save to file if path provided
        if (output_path) {
          const { writeFile } = await import("fs/promises");
          await writeFile(output_path, markdown, "utf-8");
        }

        // ========================================
        // NEW: Save to JSON memory file
        // ========================================
        try {
          const { readFile, writeFile, mkdir } = await import("fs/promises");
          const { dirname } = await import("path");

          // Memory file path
          const memoryPath = "/home/wxy/.openclaw/workspace/evidence_chain_memory.json";

          // Ensure directory exists
          await mkdir(dirname(memoryPath), { recursive: true });

          // Read existing memory or create new array
          let memoryRecords: any[] = [];
          try {
            const existingContent = await readFile(memoryPath, "utf-8");
            memoryRecords = JSON.parse(existingContent);
          } catch {
            // File doesn't exist or is invalid, start fresh
            memoryRecords = [];
          }

          // Build memory record
          const memoryRecord = {
            session_id: currentSession.session_id,
            timestamp: currentSession.started_at,
            source_paper: currentSession.source_paper,
            idea_title: currentSession.idea_title,
            ideas: currentSession.citations.map((cit) => ({
              claim: cit.claim,
              cited_source: cit.cited_source,
              context: cit.context,
            })),
            evidence_chain: currentSession.verified_citations.map((ver) => ({
              citation_id: ver.citation_id,
              claim: ver.claim,
              cited_source: ver.cited_source,
              context: ver.context,
              verdict: ver.verdict,
              verdict_emoji: ver.verdict === "GREEN" ? "🟢" : ver.verdict === "YELLOW" ? "🟡" : "🔴",
              reason: ver.reason,
              support_level: ver.support_level,
              actual_source_title: ver.actual_source_title,
              actual_source_url: ver.actual_source_url,
            })),
            summary_stats: {
              total_citations: currentSession.verified_citations.length,
              green: currentSession.verified_citations.filter((v) => v.verdict === "GREEN").length,
              yellow: currentSession.verified_citations.filter((v) => v.verdict === "YELLOW").length,
              red: currentSession.verified_citations.filter((v) => v.verdict === "RED").length,
            },
          };

          // Append to memory
          memoryRecords.push(memoryRecord);

          // Save back to file
          await writeFile(memoryPath, JSON.stringify(memoryRecords, null, 2), "utf-8");

          console.log(`✓ Saved to memory: ${memoryPath}`);
        } catch (err: any) {
          console.error(`✗ Failed to save to memory:`, err.message);
          // Don't fail the whole operation if memory save fails
        }
        // ========================================

        // Mark session as complete and archive it
        currentSession.is_active = false;
        sessionHistory.push(currentSession);
        const completedSessionId = currentSession.session_id;
        currentSession = null;

        return {
          success: true,
          session_id: completedSessionId,
          markdown_report: markdown,
          output_path: output_path ?? null,
          message: "Evidence chain report generated successfully.",
        };
      },
    }),

    // ── 5. get_session_status ──────────────────────────────────────────────────
    (ctx: any) => ({
      name: "get_session_status",
      description:
        "📋 获取会话状态 (Get Session Status): Check the status of the current evidence tracking session. Shows how many citations have been recorded and whether verification is complete.",
      parameters: Type.Object({}),
      async execute(_toolCallId: string, params: any) {
        if (!currentSession) {
          return {
            success: true,
            is_active: false,
            message: "No active evidence tracking session.",
            session_history_count: sessionHistory.length,
          };
        }

        return {
          success: true,
          is_active: currentSession.is_active,
          session_id: currentSession.session_id,
          source_paper: currentSession.source_paper,
          idea_title: currentSession.idea_title,
          citations_recorded: currentSession.citations.length,
          citations_verified: currentSession.verified_citations.length,
          started_at: currentSession.started_at,
        };
      },
    }),
  ];
}

// ── Plugin Registration ────────────────────────────────────────────────────

const evidenceTrackerPlugin = {
  id: "openclaw-evidence-tracker",
  name: "Scientific Evidence Chain Tracker",
  description:
    "证据链追踪 (Evidence Chain Tracker): Monitors and verifies citations when OpenClaw agent generates research ideas. Records each citation, searches academic databases, and produces color-coded verification reports (🟢 green / 🟡 yellow / 🔴 red).",
  kind: "tools" as const,

  register(api: any) {
    api.logger.info("evidence-tracker: initializing plugin");

    // Store api reference for LLM calls
    pluginApi = api;

    const tools = createTools(api);

    // Register each tool with metadata
    api.registerTool(tools[0], { name: "start_evidence_tracking" });
    api.registerTool(tools[1], { name: "record_citation" });
    api.registerTool(tools[2], { name: "verify_evidence_chain" });
    api.registerTool(tools[3], { name: "generate_evidence_report" });
    api.registerTool(tools[4], { name: "get_session_status" });

    api.logger.info(`evidence-tracker: registered ${tools.length} tools`);
  },
};

export default evidenceTrackerPlugin;
