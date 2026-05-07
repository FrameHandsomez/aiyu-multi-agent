/**
 * Chat Session — Interactive chat with an agent (multi-turn ReAct loop)
 *
 * Separated from agent-runtime.js for maintainability.
 * Sliding window + char-based context limit + per-provider failover.
 */

const fs = require("fs");
const path = require("path");
const tracing = require("./tracing");
const agentSystem = require("./agent-system");
const { callLLMWithFailover } = require("./failover");
const { loadAgentSpec, loadSkillInstructions, DEFAULT_MAX_STEPS, MAX_ALLOWED_STEPS } = require("./agent-loader");
const { buildSystemPrompt } = require("./prompt-builder");
const { parseToolCalls } = require("./tool-parser");
const { sanitizeInput, safeStringify } = require("./input-sanitizer");
const toolRegistry = require("./tool-registry");

const MAX_CONTEXT_CHARS = 200000;
const TOOL_TIMEOUT_MS = 30000;

function createChatSession(options) {
  const {
    agentName,
    projectDir = process.cwd(),
    provider: overrideProvider,
    model: overrideModel,
    maxSteps: overrideMaxSteps,
    onStep,
  } = options;

  const agentSpec = loadAgentSpec(projectDir, agentName);
  const skillInstructions = loadSkillInstructions(projectDir, agentSpec.skills);
  const provider = overrideProvider ?? agentSpec.provider ?? "mock";
  const model = overrideModel ?? agentSpec.model ?? "gpt-4";
  const outputFormat = options.outputFormat ?? agentSpec.outputFormat ?? "text";
  const chatProfile = agentSystem.detect(projectDir);
  const systemPrompt = buildSystemPrompt(agentSpec, skillInstructions, chatProfile);

  const messages = [{ role: "system", content: systemPrompt }];
  const history = [];
  let _cancelled = false;
  let _abortController = null;

  /** Check if cancelled and reset flag for next run */
  function checkCancelled() {
    if (_cancelled) {
      _cancelled = false;
      const err = new Error("Cancelled by user");
      err.cancelled = true;
      throw err;
    }
  }

  /**
   * Convert messages with [image:path] text references into content arrays
   * with base64 image blocks (Claude format). Providers transform to their
   * native format in llm-providers.js.
   */
  function buildMessagesWithImages(msgs) {
    const result = [];
    const imagePattern = /\[image:([^\]]+)\]/g;
    for (const msg of msgs) {
      if (msg.role === "system" || typeof msg.content !== "string") {
        result.push(msg);
        continue;
      }
      const text = msg.content;
      const matches = Array.from(text.matchAll(imagePattern));
      if (matches.length === 0) {
        result.push(msg);
        continue;
      }
      const content = [];
      let lastIndex = 0;
      for (const match of matches) {
        const imgPath = match[1].trim();
        const before = text.slice(lastIndex, match.index).trim();
        if (before) content.push({ type: "text", text: before });
        try {
          if (fs.existsSync(imgPath)) {
            const buf = fs.readFileSync(imgPath);
            const b64 = buf.toString("base64");
            const ext = path.extname(imgPath).toLowerCase().slice(1) || "png";
            const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
            content.push({
              type: "image",
              source: { type: "base64", media_type: mediaType, data: b64 }
            });
          }
        } catch {
          content.push({ type: "text", text: `[image missing: ${imgPath}]` });
        }
        lastIndex = match.index + match[0].length;
      }
      const after = text.slice(lastIndex).trim();
      if (after) content.push({ type: "text", text: after });
      if (content.length === 1) {
        result.push({ role: msg.role, content: content[0].text || "" });
      } else {
        result.push({ role: msg.role, content });
      }
    }
    return result;
  }

  return {
    agentName: agentSpec.name,
    provider,
    model,
    outputFormat,

    cancel() {
      _cancelled = true;
      if (_abortController) {
        try { _abortController.abort(); } catch {}
      }
    },

    async send(userInput, opts = {}) {
      _cancelled = false; // reset for each send
      _abortController = new AbortController();
      const safeChatInput = sanitizeInput(userInput);
      messages.push({ role: "user", content: safeChatInput });

      // Sliding window: keep system prompt + last N messages to prevent context overflow
      const MAX_CONTEXT_MESSAGES = 20;
      if (messages.length > MAX_CONTEXT_MESSAGES + 1) {
        const systemMsg = messages[0];
        const recent = messages.slice(-MAX_CONTEXT_MESSAGES);
        messages.length = 0;
        messages.push(systemMsg, ...recent);
      }

      // Enforce context size limit (char-based, more precise than message count)
      const totalChars = messages.reduce((sum, m) => {
        if (typeof m.content === "string") return sum + m.content.length;
        if (Array.isArray(m.content)) {
          return sum + m.content.reduce((s, c) => s + (c.text?.length || 0), 0);
        }
        return sum;
      }, 0);
      if (totalChars > MAX_CONTEXT_CHARS) {
        const systemMsg = messages[0];
        const recent = messages.slice(-10);
        messages.length = 0;
        messages.push(systemMsg, ...recent);
      }

      // Convert image references to content arrays before sending to LLM
      const messagesForLlm = buildMessagesWithImages(messages);

      const maxChatSteps = Math.min(overrideMaxSteps ?? agentSpec.maxSteps ?? DEFAULT_MAX_STEPS, MAX_ALLOWED_STEPS);
      const chatLlmOpts = { provider, model, abortSignal: _abortController.signal };
      if (opts.onToken) chatLlmOpts.onToken = opts.onToken;
      if (outputFormat && outputFormat !== "text") chatLlmOpts.outputFormat = outputFormat;
      if (agentSpec.deterministic) chatLlmOpts.temperature = 0;
      let actualSteps = 0;
      let finalContent = "";
      const toolResults = [];
      let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      // Start trace for this chat turn
      const chatTraceId = tracing.startTrace(`chat.${agentSpec.name}`, { agentName: agentSpec.name, provider });
      const chatSpanId = tracing.startSpan(chatTraceId, `chat.turn`, { step: 0 });

      // Full ReAct loop within the chat session
      const chatSteps = [];
      for (let step = 0; step < maxChatSteps; step++) {
        actualSteps = step + 1;
        checkCancelled(); // User pressed Ctrl+C?
        const stepStart = Date.now();
        let response;
        try {
          const result = await callLLMWithFailover(messagesForLlm, chatLlmOpts);
          checkCancelled(); // Check again after LLM returns
          response = result.response;
          if (result.provider !== chatLlmOpts.provider) {
            chatLlmOpts.provider = result.provider;
          }
        } catch (err) {
          finalContent = `LLM call failed: ${err.message}`;
          messages.push({ role: "assistant", content: finalContent });
          chatSteps.push({ step: step + 1, thought: finalContent, toolCalls: [], duration_ms: Date.now() - stepStart, error: err.message });
          break;
        }
        messages.push({ role: "assistant", content: response.content });

        if (response.usage) {
          totalUsage.promptTokens += response.usage.promptTokens || 0;
          totalUsage.completionTokens += response.usage.completionTokens || 0;
          totalUsage.totalTokens += response.usage.totalTokens || 0;
        }

        const toolCalls = parseToolCalls(response.content, response.toolCalls);
        finalContent = response.content;

        if (toolCalls.length === 0) {
          chatSteps.push({ step: step + 1, thought: response.content.slice(0, 200), toolCalls: [], duration_ms: Date.now() - stepStart });
          if (onStep) onStep({ type: "thinking", step: step + 1, content: response.content, duration_ms: Date.now() - stepStart });
          break;
        }

        if (onStep) onStep({ type: "thinking", step: step + 1, content: response.content.slice(0, 300), duration_ms: Date.now() - stepStart });

        const stepToolResults = [];
        for (const tc of toolCalls) {
          checkCancelled(); // Allow cancelling between tool calls
          const resolvedName = toolRegistry.resolveToolName(tc.tool);
          const tool = toolRegistry.getTool(resolvedName);
          if (tool) {
            const validationErr = toolRegistry.validateToolArgs(resolvedName, tc.args || {});
            if (validationErr) {
              messages.push({ role: "user", content: `Tool validation error (${resolvedName}): ${validationErr}` });
              stepToolResults.push({ tool: resolvedName, error: validationErr });
              continue;
            }
            try {
              if (onStep) onStep({ type: "tool_call", step: step + 1, tool: resolvedName, args: tc.args });
              const toolArgs = { ...(tc.args || {}), projectRoot: projectDir };
              const toolPromise = tool(toolArgs);
              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Tool "${resolvedName}" timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS)
              );
              let result = await Promise.race([toolPromise, timeoutPromise]);
              result = toolRegistry.truncateResult(result);
              toolResults.push({ tool: resolvedName, result });
              stepToolResults.push({ tool: resolvedName, result });
              if (onStep) onStep({ type: "tool_result", step: step + 1, tool: resolvedName, result: typeof result === "string" ? result.slice(0, 200) : JSON.stringify(result).slice(0, 200) });
              messages.push({ role: "user", content: `Tool result (${resolvedName}): ${safeStringify(result)}` });
              checkCancelled(); // Allow cancelling immediately after a tool
            } catch (err) {
              toolResults.push({ tool: resolvedName, error: err.message });
              stepToolResults.push({ tool: resolvedName, error: err.message });
              if (onStep) onStep({ type: "tool_error", step: step + 1, tool: resolvedName, error: err.message });
              messages.push({ role: "user", content: `Tool error (${resolvedName}): ${err.message}` });
              checkCancelled();
            }
          }
        }
        chatSteps.push({ step: step + 1, thought: response.content.slice(0, 200), toolCalls: stepToolResults, duration_ms: Date.now() - stepStart });
      }

      // End chat trace
      tracing.endSpan(chatTraceId, chatSpanId, { result: finalContent ? "ok" : "error" });
      tracing.endTrace(chatTraceId, finalContent ? "ok" : "error", { steps: actualSteps, tokens: totalUsage.totalTokens });

      // Output format enforcement
      const chatOutputFormat = outputFormat || agentSpec.outputFormat || "text";
      if (chatOutputFormat === "json" && finalContent) {
        try {
          JSON.parse(finalContent);
        } catch {
          finalContent = JSON.stringify({ text: finalContent });
        }
      }

      const entry = {
        role: "assistant",
        content: finalContent,
        toolCalls: toolResults,
        steps: chatSteps,
        usage: totalUsage,
        traceId: chatTraceId,
      };
      history.push(entry);

      _abortController = null;
      return entry;
    },

    getHistory() {
      return history;
    },

    getMessages() {
      return messages;
    },

    /** Load messages from a saved session (preserves system prompt as [0]). */
    setMessages(loadedMessages) {
      messages.length = 0;
      for (const m of loadedMessages) messages.push(m);
    },

    /** Switch model mid-session without losing context. */
    setModel(newModel) {
      this.model = newModel;
    },
  };
}

module.exports = {
  createChatSession,
  MAX_CONTEXT_CHARS,
  TOOL_TIMEOUT_MS,
};
