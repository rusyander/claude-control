#!/usr/bin/env node
// Fake Claude CLI speaking the stream-json input protocol: one process, many turns.
// Each user line → init, text delta "turn <n> pid <pid>", result with CUMULATIVE cost
// (0.01 per turn, as the real CLI reports it). A message containing WAKE makes the
// process start one more turn by itself 150 ms after the result — the shape the real
// CLI shows when a background task finishes. ARGV dumps argv for signature checks.
// STEER / STEERLATE model a message written to stdin mid-turn (claude 2.1.285, measured
// 30.09): STEER absorbs it into the open turn (one result, the text names it); STEERLATE
// has no step left — the turn ends and the CLI starts the next turn with it by itself.
// HANG <file> writes its pid to <file> and never answers nor exits (a hung CLI). TOOLHOOK runs
// the first PreToolUse hook of the --settings file the way the CLI does (shell, call JSON on
// stdin) and reports its exit code. FAKE_ARGV_DUMP=<file> appends argv at start-up — for
// paths whose prompt the test does not choose. STARTONLY <file> / STARTTOOL: the turn starts
// (message_start with tokens) and then hangs, bare or after a tool call — a cut keep-alive ping.
/* global process, setTimeout, clearTimeout, setInterval, clearInterval */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.env.FAKE_ARGV_DUMP) {
  appendFileSync(process.env.FAKE_ARGV_DUMP, JSON.stringify(process.argv.slice(2)) + '\n');
}

const SESSION = 'live-session-0001';
let turn = 0;
// A turn the CLI starts itself after a background task closes with this origin (2.1.286).
const NOTIFIED = { kind: 'task-notification', producer: 'session-task' };
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');

function runTurn(text, origin) {
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
    ...(origin ? { origin } : {}),
  });
}

/** Open STEER turn: a line arriving now is absorbed into it (or deferred for STEERLATE). */
let steer;

function steerTurn(late) {
  turn += 1;
  out({ type: 'system', subtype: 'init', session_id: SESSION, model: 'fake', tools: [] });
  out({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'working ' } },
  });
  const finish = (seen) => {
    steer = undefined;
    clearTimeout(timer);
    if (seen && !late) {
      out({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `saw ${seen}` } },
      });
    }
    out({ type: 'result', subtype: 'success', total_cost_usd: 0, session_id: SESSION });
    if (seen && late) setTimeout(() => runTurn(`next turn got ${seen}`), 50);
  };
  const timer = setTimeout(() => finish(undefined), 8_000);
  steer = finish;
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const content = String(message.message?.content ?? '');
  if (steer) {
    steer(content);
    return;
  }
  if (content.includes('STEERLATE')) {
    steerTurn(true);
    return;
  }
  if (content.includes('STEER')) {
    steerTurn(false);
    return;
  }
  if (content.includes('ARGV')) {
    runTurn(`argv ${JSON.stringify(process.argv.slice(2))}`);
    return;
  }
  if (content.includes('STARTONLY') || content.includes('STARTTOOL')) {
    // The request reached the model (message_start carries its input and cache tokens), then
    // either nothing more (STARTONLY <file>: pid to <file>, never answers) or a tool call
    // that the panel has to cut (STARTTOOL) — neither ever sends message_delta nor result.
    out({ type: 'system', subtype: 'init', session_id: SESSION, model: 'fake', tools: [] });
    const usage = {
      input_tokens: 3,
      output_tokens: 1,
      cache_read_input_tokens: 120000,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_1h_input_tokens: 300 },
    };
    const message = { id: 'msg-start', model: 'fake', role: 'assistant', content: [], usage };
    out({ type: 'stream_event', event: { type: 'message_start', message } });
    if (content.includes('STARTTOOL')) {
      const call = { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } };
      out({ type: 'assistant', message: { ...message, content: [call] } });
    } else {
      writeFileSync(
        content.slice(content.indexOf('STARTONLY') + 'STARTONLY'.length).trim(),
        String(process.pid),
      );
    }
    setInterval(() => undefined, 1_000);
    return;
  }
  if (content.includes('HANG')) {
    writeFileSync(
      content.slice(content.indexOf('HANG') + 'HANG'.length).trim(),
      String(process.pid),
    );
    out({ type: 'system', subtype: 'init', session_id: SESSION, model: 'fake', tools: [] });
    // Neither a result nor an exit, even when stdin closes.
    setInterval(() => undefined, 1_000);
    return;
  }
  if (content.includes('TOOLHOOK')) {
    const argv = process.argv.slice(2);
    const at = argv.indexOf('--settings');
    const settings = at >= 0 ? JSON.parse(readFileSync(argv[at + 1], 'utf8')) : {};
    const command = settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
    if (!command) {
      runTurn('hook none');
      return;
    }
    const call = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };
    const result = spawnSync(command, {
      shell: true,
      input: JSON.stringify(call),
      encoding: 'utf8',
    });
    runTurn(`hook exit ${result.status} stderr ${String(result.stderr).trim()}`);
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
  if (content.includes('GHOST')) {
    // Resume over a background task the previous process died with (claude 2.1.286,
    // measured 06.10): the CLI first closes its own notification turn — init, then a
    // `result` with origin task-notification, no model call, empty text — and only then
    // runs the turn carrying this message.
    out({ type: 'system', subtype: 'task_notification', status: 'stopped' });
    out({ type: 'system', subtype: 'init', session_id: SESSION, model: 'fake', tools: [] });
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 0,
      result: '',
      origin: { kind: 'task-notification' },
      total_cost_usd: Number((0.01 * turn).toFixed(2)),
      session_id: SESSION,
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
  if (content.includes('BGASK')) {
    // Background SUBAGENT that outlives the turn (claude 2.1.286 task shape, live run
    // 14.10): it finishes only when the file named after BGASK appears, then the CLI
    // wakes itself. End of input while it runs = the CLI leaves without it (exit 3).
    const release = content.slice(content.indexOf('BGASK') + 'BGASK'.length).trim();
    const task = { task_id: 'a53c', task_type: 'local_agent', description: 'Fetch MR' };
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [task] });
    runTurn(`turn ${turn + 1} pid ${process.pid}`);
    const poll = setInterval(() => {
      if (!existsSync(release)) return;
      clearInterval(poll);
      out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
      out({ type: 'system', subtype: 'task_notification', status: 'completed' });
      runTurn(`woke pid ${process.pid}`, NOTIFIED);
    }, 50);
    process.stdin.once('end', () => {
      clearInterval(poll);
      process.exit(3);
    });
    return;
  }
  if (content.includes('LATEWAKE')) {
    // Background task that outlives the turn by 3 s — time enough to kill the server.
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 'bg-1' }] });
    runTurn(`turn ${turn + 1} pid ${process.pid}`);
    setTimeout(() => {
      out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
      out({ type: 'system', subtype: 'task_notification', status: 'completed' });
      runTurn(`woke pid ${process.pid}`, NOTIFIED);
    }, 3_000);
    return;
  }
  runTurn(`turn ${turn + 1} pid ${process.pid}`);
  if (content.includes('WAKE')) {
    setTimeout(() => {
      out({ type: 'system', subtype: 'task_notification', status: 'completed' });
      runTurn(`woke pid ${process.pid}`, NOTIFIED);
    }, 150);
  }
});
