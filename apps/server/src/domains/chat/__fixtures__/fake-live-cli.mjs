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
  if (content.includes('MIDTURN')) {
    // Turn that outlives a server restart: text now, result 4 s later.
    turn += 1;
    out({ type: 'system', subtype: 'init', session_id: SESSION, model: 'fake', tools: [] });
    setTimeout(() => {
      out({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: `midturn pid ${process.pid}` },
        },
      });
      out({ type: 'result', subtype: 'success', total_cost_usd: 0.01, session_id: SESSION });
    }, 4_000);
    return;
  }
  if (content.includes('SYNTHETIC')) {
    // CLI stub reply (model <synthetic>) streamed before the real turn.
    const zero = { input_tokens: 0, output_tokens: 0 };
    const stub = { id: 'syn', model: '<synthetic>', role: 'assistant', content: [], usage: zero };
    out({ type: 'stream_event', event: { type: 'message_start', message: stub } });
    out({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'No response requested.' },
      },
    });
    out({ type: 'stream_event', event: { type: 'message_delta', usage: zero } });
    out({ type: 'stream_event', event: { type: 'message_stop' } });
    out({
      type: 'assistant',
      message: { ...stub, content: [{ type: 'text', text: 'No response requested.' }] },
    });
    runTurn(`turn ${turn + 1} pid ${process.pid}`);
    return;
  }
  if (content.includes('HOLDBG')) {
    // Background task that never finishes: the process holds it until it dies.
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 'bg-hold' }] });
    runTurn(`turn ${turn + 1} pid ${process.pid}`);
    return;
  }
  if (content.includes('LATEWAKE')) {
    // Background task that outlives the turn by 3 s — time enough to kill the server.
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 'bg-1' }] });
    runTurn(`turn ${turn + 1} pid ${process.pid}`);
    setTimeout(() => {
      out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
      out({ type: 'system', subtype: 'task_notification', status: 'completed' });
      runTurn(`woke pid ${process.pid}`);
    }, 3_000);
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
