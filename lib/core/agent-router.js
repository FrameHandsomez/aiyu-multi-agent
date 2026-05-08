/**
 * Agent Router — Automatic agent selection based on user input keywords
 *
 * Reads agent frontmatter (description + keywords) from .windsurf/agents/
 * and scores each agent against the user's input to pick the best match.
 *
 * Usage:
 *   const router = require("./agent-router");
 *   const agent = router.route("fix the login bug", projectDir);
 *   // → "debugger"
 */

const fs = require("fs");
const path = require("path");
const config = require("./config");
const utils = require("../utils");

// Cache parsed agent metadata per project dir
const _cache = new Map();

/**
 * Parse agent frontmatter to extract routing metadata.
 * Returns { name, keywords, description, skills }
 */
function parseAgentMeta(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return null;

    const raw = fmMatch[1];
    const nameMatch = raw.match(/^name:\s*(.+)$/m);
    const descMatch = raw.match(/^description:\s*(.+)$/m);
    const skillsMatch = raw.match(/^skills:\s*(.+)$/m);

    const name = nameMatch ? nameMatch[1].trim() : null;
    const description = descMatch ? descMatch[1].trim() : "";
    const skills = skillsMatch ? skillsMatch[1].trim() : "";

    // Extract trigger keywords from description
    // Pattern: "Triggers on X, Y, Z" or "triggers on X, Y, Z"
    const triggerMatch = description.match(/[Tt]riggers?\s+on\s+([^.]+)/);
    let keywords = [];
    if (triggerMatch) {
      keywords = triggerMatch[1]
        .split(/[,;]/)
        .map(k => k.trim().toLowerCase())
        .filter(k => k.length > 0);
    }

    // Also extract "Use when..." or "Use for..." phrases
    const useWhenMatch = description.match(/[Uu]se\s+(?:when|for)\s+([^.]+)/g);
    if (useWhenMatch) {
      for (const phrase of useWhenMatch) {
        const words = phrase
          .replace(/[Uu]se\s+(?:when|for)\s+/, "")
          .split(/[,;]/)
          .map(k => k.trim().toLowerCase())
          .filter(k => k.length > 0);
        keywords.push(...words);
      }
    }

    // Add the agent name itself as a keyword
    if (name) keywords.push(name.toLowerCase().replace(/-/g, " "));

    // Add skill names as keywords (e.g., "systematic-debugging" → "debugging")
    if (skills) {
      const skillKeywords = skills
        .split(",")
        .map(s => s.trim().toLowerCase().replace(/-/g, " "))
        .filter(s => s.length > 0);
      keywords.push(...skillKeywords);
    }

    // Deduplicate
    keywords = [...new Set(keywords)];

    return { name, keywords, description, skills };
  } catch {
    return null;
  }
}

/**
 * Load all agent metadata for a project.
 * Results are cached per projectDir.
 */
function loadAgentIndex(projectDir) {
  if (_cache.has(projectDir)) return _cache.get(projectDir);

  const cfgDir = config.getConfigDir(projectDir);
  if (!cfgDir) return [];

  const agentsDir = path.join(cfgDir, "agents");
  if (!fs.existsSync(agentsDir)) return [];

  const agents = [];
  const files = fs.readdirSync(agentsDir).filter(f => f.endsWith(".md"));

  for (const file of files) {
    const meta = parseAgentMeta(path.join(agentsDir, file));
    if (meta && meta.name) agents.push(meta);
  }

  _cache.set(projectDir, agents);
  return agents;
}

/**
 * Clear the agent index cache (e.g., after adding/removing agents).
 */
function clearCache() {
  _cache.clear();
}

/**
 * Score an agent against user input.
 * Higher score = better match.
 *
 * Scoring:
 *   - Exact keyword match in input: +10
 *   - Partial keyword match (keyword is substring of input word): +5
 *   - Input word is substring of keyword: +3
 *   - Agent name exact match: +20 (user explicitly mentioned the agent)
 */
function scoreAgent(agent, inputLower) {
  let score = 0;
  const inputWords = inputLower.split(/\s+/);

  for (const kw of agent.keywords) {
    const kwLower = kw.toLowerCase();

    // Exact keyword match in input
    if (inputLower.includes(kwLower)) {
      score += 10;
      continue;
    }

    // Partial: keyword is substring of an input word
    let partialMatch = false;
    for (const word of inputWords) {
      if (word.includes(kwLower) || kwLower.includes(word)) {
        score += 3;
        partialMatch = true;
        break;
      }
    }
    if (partialMatch) continue;
  }

  // Bonus: agent name explicitly mentioned
  if (agent.name && inputLower.includes(agent.name.toLowerCase().replace(/-/g, " "))) {
    score += 20;
  }

  // Bonus: description contains input words
  const descLower = agent.description.toLowerCase();
  for (const word of inputWords) {
    if (word.length > 3 && descLower.includes(word)) {
      score += 2;
    }
  }

  return score;
}

/**
 * Domain keyword groups for fallback matching when no agent scores high.
 * Maps domain → preferred agent name.
 */
const DOMAIN_FALLBACKS = [
  // Frontend
  { keywords: ["component", "react", "vue", "ui", "ux", "css", "tailwind", "style", "layout", "responsive", "page", "frontend", "nextjs", "next.js", "svelte"], agent: "frontend-specialist" },
  // Backend
  { keywords: ["api", "endpoint", "server", "backend", "database", "rest", "graphql", "express", "fastify", "nestjs", "auth", "middleware"], agent: "backend-specialist" },
  // Debug
  { keywords: ["bug", "error", "crash", "broken", "fix", "not working", "debug", "investigate", "trace", "issue", "problem", "fault"], agent: "debugger" },
  // DevOps
  { keywords: ["deploy", "production", "server", "ci/cd", "pipeline", "docker", "kubernetes", "release", "rollback", "infra", "infrastructure"], agent: "devops-engineer" },
  // Security
  { keywords: ["security", "vulnerability", "hack", "pentest", "exploit", "owasp", "auth bypass", "xss", "csrf", "injection"], agent: "ethical-hacker" },
  // Database
  { keywords: ["schema", "migration", "query", "sql", "table", "index", "orm", "prisma", "mongodb", "postgres"], agent: "database-architect" },
  // Testing
  { keywords: ["test", "spec", "coverage", "unit test", "integration test", "e2e", "playwright", "jest", "vitest", "mock"], agent: "hard-negative-tester" },
  // Mobile
  { keywords: ["mobile", "ios", "android", "react native", "flutter", "swift", "kotlin", "app"], agent: "mobile-developer" },
  // Cloud
  { keywords: ["aws", "gcp", "azure", "cloud", "lambda", "serverless", "s3", "ec2"], agent: "cloud-architect" },
  // Docker
  { keywords: ["docker", "container", "compose", "dockerfile", "image", "volume"], agent: "docker-developer" },
  // Documentation
  { keywords: ["document", "readme", "docs", "comment", "explain", "describe", "guide"], agent: "documentation-writer" },
  // Go
  { keywords: ["golang", "go lang", "goroutine", "go module"], agent: "go-developer" },
  // Angular
  { keywords: ["angular", "rxjs", "ng", "ngrx"], agent: "angular-developer" },
  // Accessibility
  { keywords: ["a11y", "accessibility", "wcag", "aria", "screen reader", "keyboard nav"], agent: "accessibility-specialist" },
  // i18n
  { keywords: ["i18n", "localization", "locale", "translate", "rtl", "l10n"], agent: "i18n-specialist" },
  // Game
  { keywords: ["game", "unity", "unreal", "godot", "3d", "2d game"], agent: "game-developer" },
  // IoT
  { keywords: ["iot", "sensor", "embedded", "firmware", "device"], agent: "iot-specialist" },
  // Data
  { keywords: ["data pipeline", "ml", "machine learning", "model", "training", "analytics", "dashboard"], agent: "data-scientist" },
];

/**
 * Route user input to the best matching agent.
 *
 * @param {string} input - User's message/request
 * @param {string} projectDir - Project directory path
 * @param {object} [options] - Options
 * @param {string} [options.preferAgent] - Preferred agent (used if score is close)
 * @param {number} [options.minScore=5] - Minimum score threshold to accept a match
 * @returns {{ name: string, score: number, method: string } | null}
 */
function route(input, projectDir, options = {}) {
  const minScore = options.minScore ?? 5;
  const inputLower = (input || "").toLowerCase().trim();

  if (!inputLower) return null;

  const agents = loadAgentIndex(projectDir);
  if (agents.length === 0) return null;

  // Score all agents
  const scored = agents
    .map(agent => ({
      name: agent.name,
      score: scoreAgent(agent, inputLower),
      method: "keyword",
    }))
    .filter(a => a.score >= minScore)
    .sort((a, b) => b.score - a.score);

  // If we have a clear winner, return it
  if (scored.length > 0) {
    const best = scored[0];
    const secondBest = scored[1];

    // Prefer user-specified agent if scores are close (within 5 points)
    if (options.preferAgent) {
      const preferred = scored.find(a => a.name === options.preferAgent);
      if (preferred && (best.score - preferred.score) <= 5) {
        return { ...preferred, method: "keyword+prefer" };
      }
    }

    // If top 2 are very close, prefer the more specific one (longer keywords = more specific)
    if (secondBest && (best.score - secondBest.score) <= 3) {
      const bestAgent = agents.find(a => a.name === best.name);
      const secondAgent = agents.find(a => a.name === secondBest.name);
      const bestSpecificity = bestAgent ? bestAgent.keywords.filter(k => inputLower.includes(k)).length : 0;
      const secondSpecificity = secondAgent ? secondAgent.keywords.filter(k => inputLower.includes(k)).length : 0;
      if (secondSpecificity > bestSpecificity) {
        return { ...secondBest, method: "keyword+specificity" };
      }
    }

    return best;
  }

  // Fallback: domain keyword matching
  for (const domain of DOMAIN_FALLBACKS) {
    const matchCount = domain.keywords.filter(kw => inputLower.includes(kw)).length;
    if (matchCount >= 1) {
      // Check if this agent exists in the project
      const exists = agents.some(a => a.name === domain.agent);
      if (exists) {
        return { name: domain.agent, score: matchCount * 3, method: "domain-fallback" };
      }
    }
  }

  return null;
}

/**
 * List all available agents with their routing keywords.
 * Useful for /agents command in chat.
 */
function listAgents(projectDir) {
  const agents = loadAgentIndex(projectDir);
  return agents.map(a => ({
    name: a.name,
    keywords: a.keywords.slice(0, 10), // Top 10 keywords
    description: a.description.slice(0, 120),
  }));
}

/**
 * Get routing info for a specific agent.
 */
function getAgentInfo(projectDir, agentName) {
  const agents = loadAgentIndex(projectDir);
  return agents.find(a => a.name === agentName) || null;
}

module.exports = {
  route,
  listAgents,
  getAgentInfo,
  loadAgentIndex,
  clearCache,
  scoreAgent,
  parseAgentMeta,
  DOMAIN_FALLBACKS,
};
