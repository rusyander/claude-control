#!/usr/bin/env node
// Fake Claude CLI speaking the stream-json input protocol: one process, many turns.
// Each user line → init, text delta "turn <n> pid <pid>", result with CUMULATIVE cost
// (0.01 per turn, as the real CLI reports it). A message containing WAKE makes the
// process start one more turn by itself 150 ms after the result — the shape the real
// CLI shows when a background task finishes. ARGV dumps argv for signature checks.
/* global process, setTimeout */
import { createInterface } from 'node:readline';

const SESSION = 'live-session-0001';
let turn = 0;
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');

function runTurn(text) {
  turn += 1;
  out({ type: 'system', subtype: 'init', session_id: SESSION, model: 'fake', tools: [] });
  out({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  });
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: Number((0.01 * turn).toFixed(2)),
    duration_ms: 1,
    session_id: SESSION,
  });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const content = String(message.message?.content ?? '');
  if (content.includes('ARGV')) {
    runTurn(`argv ${JSON.stringify(process.argv.slice(2))}`);
    return;
  }
  if (content.includes('SLOW')) {
    // Long turn: text right away, result only after 30 s — time enough for Stop.
    turn += 1;
    out({ type: 'system', subtype: 'init', session_id: SESSION, model: 'fake', tools: [] });
    out({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: `slow pid ${process.pid}` },
      },
    });
    setTimeout(
      () => out({ type: 'result', subtype: 'success', total_cost_usd: 0, session_id: SESSION }),
      30_000,
    );
    return;
  }
  runTurn(`turn ${turn + 1} pid ${process.pid}`);
  if (content.includes('WAKE')) {
    setTimeout(() => {
      out({ type: 'system', subtype: 'task_notification', status: 'completed' });
      runTurn(`woke pid ${process.pid}`);
    }, 150);
  }
});
