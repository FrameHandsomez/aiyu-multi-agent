'use strict';

/**
 * DevApp — Ink-based TUI for `aiyu-multi-agent dev`
 *
 * Architecture (Claude Code pattern):
 *   Static   — completed messages (rendered once, scroll out)
 *   Dynamic  — input bar + status bar (always re-renders)
 *
 * No JSX: uses React.createElement throughout (no build step needed).
 */

const React = require('react');
const { render, Box, Text, useInput, useApp, Static } = require('ink');
const H = require('../core/hermes-theme');

// ── Spinner hook ──────────────────────────────────────────────────────────

function useSpinner(active) {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    if (!active) { setFrame(0); return; }
    const id = setInterval(() => setFrame(f => f + 1), 200);
    return () => clearInterval(id);
  }, [active]);
  return active ? H.getKawaiiSpinnerFrame(frame) : null;
}

// ── Elapsed timer hook ────────────────────────────────────────────────────

function useElapsed(active) {
  const [ms, setMs] = React.useState(0);
  React.useEffect(() => {
    if (!active) { setMs(0); return; }
    const start = Date.now();
    const id = setInterval(() => setMs(Date.now() - start), 500);
    return () => clearInterval(id);
  }, [active]);
  if (!active || ms === 0) return '';
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

// ── Components ────────────────────────────────────────────────────────────

function c(type, props, ...children) {
  return React.createElement(type, props, ...children);
}

/** User message bubble */
function UserMessage({ content }) {
  return c(Box, { marginTop: 1 },
    c(Text, { color: '#FFD700', bold: true }, '  You  '),
    c(Text, { color: '#FFF8DC' }, content),
  );
}

/** Agent response in a box */
function AgentMessage({ content, agentName, durationSec, steps }) {
  const cols = process.stdout.columns || 80;
  const inner = cols - 4;
  const kaomoji = H.PERSONA_KAOMOJI[agentName] || H.PERSONA_KAOMOJI.default;
  const durLabel = durationSec ? `  ${durationSec}s` : '';

  const topBorder = '╭─ ⚔ Aiyu' + '─'.repeat(Math.max(0, inner - 9));
  const botBorder = '╰' + '─'.repeat(inner);

  return c(Box, { flexDirection: 'column', marginTop: 1 },
    c(Text, { color: '#CD7F32' }, '  ' + topBorder),
    c(Box, { paddingLeft: 4 },
      c(Text, { color: '#FFF8DC', wrap: 'wrap' }, content),
    ),
    c(Text, { color: '#CD7F32' }, '  ' + botBorder),
    c(Text, { color: '#8B8682' },
      `  ${'─'.repeat(20)} ${agentName} ${kaomoji}${durLabel}`
    ),
  );
}

/** Tool step line (shown in verbose mode) */
function StepLine({ step }) {
  const icon = step.error ? '✗' : '✓';
  const color = step.error ? '#FF6B6B' : '#8FBC8F';
  const tools = (step.toolCalls || [])
    .map(tc => tc.tool + (tc.error ? '✗' : ''))
    .join(', ');

  return c(Box, { paddingLeft: 4 },
    c(Text, { color }, `${icon} step ${step.step}`),
    tools ? c(Text, { color: '#8B8682' }, `  [${tools}]`) : null,
    step.duration_ms
      ? c(Text, { color: '#8B8682' }, `  ${(step.duration_ms / 1000).toFixed(1)}s`)
      : null,
  );
}

/** Input bar — shows ❯ and current typed text */
function InputBar({ value, processing }) {
  const symbol = processing ? '⚔' : '❯';
  const symColor = processing ? '#CD7F32' : '#FFD700';

  return c(Box, { marginTop: 1 },
    c(Text, { color: symColor, bold: true }, `  ${symbol} `),
    c(Text, { color: '#FFF8DC' }, value),
    processing
      ? null
      : c(Text, { backgroundColor: '#FFF8DC', color: '#1a1a2e' }, ' '), // block cursor
  );
}

/** Sticky status bar at bottom */
function StatusBar({ agentName, model, processing, elapsed, spinner }) {
  const cols = process.stdout.columns || 80;
  const parts = [];
  if (processing) {
    parts.push(spinner || '…');
    if (elapsed) parts.push(elapsed);
  }
  parts.push(agentName);
  if (model) parts.push(model);
  if (!processing) parts.push('ready');

  const text = ' ' + parts.join('  │  ') + ' ';
  const padded = text.padEnd(cols - 1).slice(0, cols - 1);

  return c(Box, { marginTop: 0 },
    c(Text, {
      backgroundColor: '#1a1a2e',
      color: processing ? '#FFD700' : '#C0C0C0',
      bold: processing,
    }, padded),
  );
}

/** Hint line below input */
function HintLine({ processing }) {
  if (processing) return null;
  return c(Text, { color: '#8B8682' },
    '  Type your message, or \'exit\' to quit',
  );
}

// ── Main App ──────────────────────────────────────────────────────────────

function DevApp({ agentName, model, verbose, onRun }) {
  const { exit } = useApp();

  const [messages, setMessages] = React.useState([]);
  const [input, setInput] = React.useState('');
  const [processing, setProcessing] = React.useState(false);
  const [history, setHistory] = React.useState([]);
  const [histIdx, setHistIdx] = React.useState(-1);

  const spinner = useSpinner(processing);
  const elapsed = useElapsed(processing);

  const submit = React.useCallback(async (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed === 'exit' || trimmed === 'quit') { exit(); return; }

    setMessages(m => [...m, { type: 'user', content: trimmed }]);
    setHistory(h => [trimmed, ...h.filter(x => x !== trimmed)].slice(0, 100));
    setHistIdx(-1);
    setProcessing(true);

    try {
      const result = await onRun(trimmed);
      const content = result.output || result.error || '(no output)';
      const durationMs = (result.steps || []).reduce((s, st) => s + (st.duration_ms || 0), 0);

      if (verbose && result.steps?.length > 0) {
        setMessages(m => [
          ...m,
          ...result.steps.map(st => ({ type: 'step', step: st })),
        ]);
      }
      setMessages(m => [...m, {
        type: 'agent',
        content,
        agentName,
        durationSec: durationMs > 0 ? (durationMs / 1000).toFixed(1) : null,
      }]);
    } catch (e) {
      setMessages(m => [...m, { type: 'agent', content: `Error: ${e.message}`, agentName }]);
    } finally {
      setProcessing(false);
    }
  }, [agentName, verbose, onRun, exit]);

  useInput((char, key) => {
    if (processing) {
      // Ctrl+C while processing = exit (no cancel support in dev mode)
      if (key.ctrl && char === 'c') { exit(); }
      return;
    }

    if (key.return) {
      const val = input;
      setInput('');
      submit(val);
      return;
    }

    if (key.backspace || key.delete) {
      setInput(s => s.slice(0, -1));
      return;
    }

    if (key.upArrow) {
      setHistIdx(i => {
        const next = Math.min(i + 1, history.length - 1);
        if (next >= 0 && history[next] !== undefined) setInput(history[next]);
        return next;
      });
      return;
    }

    if (key.downArrow) {
      setHistIdx(i => {
        const next = i - 1;
        if (next < 0) { setInput(''); return -1; }
        if (history[next] !== undefined) setInput(history[next]);
        return next;
      });
      return;
    }

    if (key.ctrl && char === 'c') { exit(); return; }
    if (key.ctrl && char === 'l') {
      setMessages([]);
      return;
    }

    if (char && !key.ctrl && !key.meta && !key.escape) {
      setInput(s => s + char);
    }
  });

  // Render completed messages via Static (each renders once)
  const staticItems = messages.map((msg, i) => ({ ...msg, _key: i }));

  return c(Box, { flexDirection: 'column' },
    c(Static, { items: staticItems },
      item => {
        switch (item.type) {
          case 'user':  return c(UserMessage,  { key: item._key, content: item.content });
          case 'agent': return c(AgentMessage, { key: item._key, ...item });
          case 'step':  return c(StepLine,     { key: item._key, step: item.step });
          default:      return null;
        }
      }
    ),
    c(InputBar,  { value: input, processing }),
    c(HintLine,  { processing }),
    c(StatusBar, { agentName, model, processing, elapsed, spinner }),
  );
}

// ── Entry point ───────────────────────────────────────────────────────────

/**
 * Start the Ink dev REPL.
 * @param {object} opts
 * @param {string}   opts.agentName
 * @param {string}   [opts.model]
 * @param {boolean}  [opts.verbose]
 * @param {Function} opts.onRun   async (input) => { output, steps, error, status }
 * @returns {Promise<void>} resolves when user exits
 */
function startDevApp(opts) {
  const { agentName, model, verbose = false, onRun } = opts;
  return new Promise((resolve) => {
    const { waitUntilExit } = render(
      c(DevApp, { agentName, model, verbose, onRun })
    );
    waitUntilExit().then(resolve).catch(resolve);
  });
}

module.exports = { startDevApp };
