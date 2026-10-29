import { inputSchemaOf, MODEL_TOOL_NAMES } from '@agentdeck/contracts/core/model-tools';
import {
  startStubModel,
  type DialectId,
  type StepFn,
  type StepContext,
  type StepLike,
  type StubModel,
} from '@agentdeck/stub-model';
import { afterEach, describe, expect, it } from 'vitest';
import { STUB_TASKS } from './__fixtures__/library/index.ts';
import { STALLED_STREAM } from './__fixtures__/library/waste.ts';
import {
  briefFor,
  commandLine,
  deferredName,
  fill,
  fillDeep,
  scriptFor,
  SIDE_REPLY,
  stepFor,
} from './__fixtures__/script.ts';
import type { Move, StubTask } from './__fixtures__/stub-tasks.types.ts';

/**
 * Каждая задача обслуживается каждым своим протоколом через общую заглушку (P120): разговор
 * идёт по настоящему проводу (`/v1/messages`, `/v1/chat/completions`, `/v1/responses`), без
 * потока, и ответ на каждом ходе — ровно тот, что записан в задаче, под именами и аргументами,
 * которые объявил «CLI» этого протокола. Задержки ходов (тишина потока) сняты обёрткой: их
 * исполняет сама заглушка, здесь — только что они попали в шаг.
 */

const VALUES = { stepId: '01920000-0000-7000-8000-0000000051e9', copy: 'C:/stub/copy' };

interface Vocabulary {
  path: string;
  write: { name: string; pathKey: string };
  read: { name: string; pathKey: string };
  shell: { name: string; bgKey?: string; bgRequired?: boolean };
  /** Как CLI называет инструменты сервера `agentdeck`. */
  core: (tool: string) => string;
}

/** Имена встроенных — как их объявляют Claude Code (messages) и Qwen Code (chat); responses — общий вид. */
const VOCAB: Record<DialectId, Vocabulary> = {
  'anthropic-messages': {
    path: '/v1/messages',
    write: { name: 'Write', pathKey: 'file_path' },
    read: { name: 'Read', pathKey: 'file_path' },
    shell: { name: 'Bash', bgKey: 'run_in_background' },
    core: (tool) => `mcp__agentdeck__${tool}`,
  },
  'openai-chat': {
    path: '/v1/chat/completions',
    write: { name: 'write_file', pathKey: 'file_path' },
    read: { name: 'read_file', pathKey: 'absolute_path' },
    shell: { name: 'run_shell_command', bgKey: 'is_background', bgRequired: true },
    core: (tool) => tool,
  },
  'openai-responses': {
    path: '/v1/responses',
    write: { name: 'write_file', pathKey: 'path' },
    read: { name: 'read_file', pathKey: 'path' },
    shell: { name: 'run_shell_command' },
    core: (tool) => `agentdeck__${tool}`,
  },
};

type Decl = { name: string; description: string; schema: Record<string, unknown> };

function object(props: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties: props, required };
}

function declared(v: Vocabulary, withShell = true): Decl[] {
  const str = { type: 'string' };
  const shellProps: Record<string, unknown> = { command: str, description: str };
  if (v.shell.bgKey) shellProps[v.shell.bgKey] = { type: 'boolean' };
  const tools: Decl[] = [
    {
      name: v.write.name,
      description: 'write',
      schema: object({ [v.write.pathKey]: str, content: str }, [v.write.pathKey, 'content']),
    },
    { name: v.read.name, description: 'read', schema: object({ [v.read.pathKey]: str }, []) },
  ];
  if (withShell) {
    const required = ['command', ...(v.shell.bgRequired && v.shell.bgKey ? [v.shell.bgKey] : [])];
    tools.push({ name: v.shell.name, description: 'shell', schema: object(shellProps, required) });
  }
  for (const tool of MODEL_TOOL_NAMES)
    tools.push({ name: v.core(tool), description: tool, schema: inputSchemaOf(tool) });
  return tools;
}

type Reply = { text: string } | { tool: string; args: Record<string, unknown> };

interface Conversation {
  body(): Record<string, unknown>;
  /** Ответ заглушки в историю + результат инструмента (или «continue» после текста). */
  push(raw: unknown): void;
  read(json: Record<string, unknown>): Reply;
}

function conversation(
  dialect: DialectId,
  system: string,
  user: string,
  tools: Decl[],
): Conversation {
  const history: unknown[] = [];
  let n = 0;
  if (dialect === 'anthropic-messages') {
    history.push({ role: 'user', content: user });
    return {
      body: () => ({
        model: 'stub-model',
        max_tokens: 1024,
        system,
        messages: history,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.schema,
        })),
      }),
      read(json) {
        const blocks = json.content as {
          type: string;
          text?: string;
          name?: string;
          input?: unknown;
        }[];
        const call = blocks.find((b) => b.type === 'tool_use');
        if (call) return { tool: call.name as string, args: call.input as Record<string, unknown> };
        return { text: blocks.map((b) => b.text ?? '').join('') };
      },
      push(raw) {
        const json = raw as { content: { type: string; id?: string }[] };
        history.push({ role: 'assistant', content: json.content });
        const call = json.content.find((b) => b.type === 'tool_use');
        history.push(
          call
            ? {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: call.id, content: 'ok' }],
              }
            : { role: 'user', content: 'continue' },
        );
      },
    };
  }
  if (dialect === 'openai-chat') {
    history.push({ role: 'system', content: system }, { role: 'user', content: user });
    return {
      body: () => ({
        model: 'stub-model',
        messages: history,
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.schema },
        })),
      }),
      read(json) {
        const message = (json.choices as { message: Record<string, unknown> }[])[0]?.message ?? {};
        const calls = message.tool_calls as
          { function: { name: string; arguments: string } }[] | undefined;
        const call = calls?.[0];
        if (call) return { tool: call.function.name, args: JSON.parse(call.function.arguments) };
        return { text: String(message.content ?? '') };
      },
      push(raw) {
        const message = (raw as { choices: { message: Record<string, unknown> }[] }).choices[0]!
          .message;
        history.push(message);
        const calls = message.tool_calls as { id: string }[] | undefined;
        if (calls?.[0]) history.push({ role: 'tool', tool_call_id: calls[0].id, content: 'ok' });
        else history.push({ role: 'user', content: 'continue' });
      },
    };
  }
  history.push({ role: 'user', content: user });
  return {
    body: () => ({
      model: 'stub-model',
      instructions: system,
      input: history,
      tools: tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.schema,
      })),
    }),
    read(json) {
      const output = json.output as Record<string, unknown>[];
      const call = output.find((o) => o.type === 'function_call');
      if (call) return { tool: call.name as string, args: JSON.parse(call.arguments as string) };
      const message = output.find((o) => o.type === 'message') as
        { content: { text?: string }[] } | undefined;
      return { text: (message?.content ?? []).map((c) => c.text ?? '').join('') };
    },
    push(raw) {
      const output = (raw as { output: Record<string, unknown>[] }).output;
      history.push(...output);
      const call = output.find((o) => o.type === 'function_call');
      n += 1;
      history.push(
        call
          ? { type: 'function_call_output', call_id: call.call_id, output: 'ok' }
          : { role: 'user', content: `continue ${n}` },
      );
    },
  };
}

function expected(move: Move, v: Vocabulary): Reply {
  switch (move.op) {
    case 'text':
      return { text: move.text };
    case 'write':
      return {
        tool: v.write.name,
        args: { [v.write.pathKey]: fill(move.path, VALUES), content: move.content },
      };
    case 'read':
      return { tool: v.read.name, args: { [v.read.pathKey]: fill(move.path, VALUES) } };
    case 'shell': {
      // `Bash` Claude — bash на любой ОС; инструмент Qwen — оболочка системы (cmd.exe на Windows).
      const shell = v.shell.name !== 'Bash' && process.platform === 'win32' ? 'cmd' : 'posix';
      const args: Record<string, unknown> = {
        command: commandLine(
          move.argv.map((a) => fill(a, VALUES)),
          shell,
        ),
        description: 'stub task move',
      };
      const bg = move.background === true;
      if (v.shell.bgKey && (bg || v.shell.bgRequired)) args[v.shell.bgKey] = bg;
      return { tool: v.shell.name, args };
    }
    case 'model-tool':
      return {
        tool: v.core(move.tool),
        args: fillDeep(move.args, VALUES) as Record<string, unknown>,
      };
  }
}

/** Задержки шага снимаются: их исполнение — дело заглушки, здесь проверяется только ответ. */
function untimed(script: StepFn): StepFn {
  return async (ctx) => {
    const step = (await script(ctx)) as StepLike;
    if (typeof step === 'string') return step;
    const { holdMs: _h, stallMs: _s, ...rest } = step;
    return rest;
  };
}

let stub: StubModel | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${stub!.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer stub' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

const CASES = STUB_TASKS.flatMap((task) =>
  task.dialects.map((dialect) => [task.id, dialect, task] as const),
);

describe('stub tasks over the shared stub model', () => {
  it.each(CASES)(
    '%s via %s: every move comes back as written',
    async (_id, dialect, task: StubTask) => {
      stub = await startStubModel({ script: untimed(scriptFor(task)) });
      const vocab = VOCAB[dialect];
      const system = briefFor({
        stepId: VALUES.stepId,
        copyRoot: VALUES.copy,
        request: task.input.request,
      });
      const talk = conversation(dialect, system, task.input.request, declared(vocab));
      for (const move of task.moves) {
        const raw = await post(vocab.path, talk.body());
        const reply = talk.read(raw);
        expect(reply).toEqual(expected(move, vocab));
        talk.push(raw);
      }
      const closing = talk.read(await post(vocab.path, talk.body()));
      expect(closing).toEqual({ text: 'done' });
      expect(stub.requests.every((r) => r.dialect === dialect)).toBe(true);
    },
  );

  it.each(['anthropic-messages', 'openai-chat', 'openai-responses'] as const)(
    'side request without a shell tool (%s) gets the side reply and spends no move',
    async (dialect) => {
      const task = STUB_TASKS[0]!;
      stub = await startStubModel({ script: scriptFor(task) });
      const vocab = VOCAB[dialect];
      const system = briefFor({ stepId: VALUES.stepId, copyRoot: VALUES.copy, request: 'title' });
      const side = conversation(dialect, system, 'Write a title', declared(vocab, false));
      expect(side.read(await post(vocab.path, side.body()))).toEqual({ text: SIDE_REPLY });
      const main = conversation(dialect, system, task.input.request, declared(vocab));
      expect(main.read(await post(vocab.path, main.body()))).toEqual(
        expected(task.moves[0]!, vocab),
      );
    },
  );

  it('a stalled move carries its stall into the stub step', async () => {
    const script = scriptFor(STALLED_STREAM);
    stub = await startStubModel({
      script: async (ctx) => {
        const step = (await script(ctx)) as Exclude<StepLike, string>;
        expect(step.stallMs).toBe(30_000);
        const { stallMs: _s, ...rest } = step;
        return rest;
      },
    });
    const vocab = VOCAB['anthropic-messages'];
    const system = briefFor({ stepId: VALUES.stepId, copyRoot: VALUES.copy, request: 'r' });
    const talk = conversation('anthropic-messages', system, 'r', declared(vocab));
    expect(talk.read(await post(vocab.path, talk.body()))).toEqual(
      expected(STALLED_STREAM.moves[0]!, vocab),
    );
    expect(stub.requests[0]?.scriptError).toBeUndefined();
  });

  /** Инструменты ядра отложены: в списке их нет, CLI называет их только в промпте. */
  function deferredStart(dialect: DialectId, extra: Decl) {
    const task = STUB_TASKS.find((t) => t.id === 'happy-path')!;
    const vocab = VOCAB[dialect];
    const own = new Set(MODEL_TOOL_NAMES.map((t) => vocab.core(t)));
    const tools = [...declared(vocab).filter((t) => !own.has(t.name)), extra];
    const names = MODEL_TOOL_NAMES.map((t) => `- "mcp__agentdeck__${t}"`).join('\n');
    const system = `${briefFor({ stepId: VALUES.stepId, copyRoot: VALUES.copy, request: task.input.request })}\n\nDeferred tools:\n${names}`;
    const talk = conversation(dialect, system, task.input.request, tools);
    const coreAt = task.moves.findIndex((m) => m.op === 'model-tool');
    const coreMove = task.moves[coreAt] as Extract<Move, { op: 'model-tool' }>;
    return { task, vocab, tools, talk, coreAt, coreMove };
  }

  it('a deferred core tool behind a loader: loader turn first, then the move, the loader spends no move', async () => {
    const loader: Decl = {
      name: 'ToolSearch',
      description: 'load deferred tools',
      schema: object({ query: { type: 'string' }, max_results: { type: 'number' } }, ['query']),
    };
    const run = deferredStart('anthropic-messages', loader);
    stub = await startStubModel({ script: untimed(scriptFor(run.task)) });
    for (const move of run.task.moves.slice(0, run.coreAt)) {
      const raw = await post(run.vocab.path, run.talk.body());
      expect(run.talk.read(raw)).toEqual(expected(move, run.vocab));
      run.talk.push(raw);
    }
    const full = `mcp__agentdeck__${run.coreMove.tool}`;
    const load = await post(run.vocab.path, run.talk.body());
    expect(run.talk.read(load)).toEqual({
      tool: 'ToolSearch',
      args: { query: `select:${full}`, max_results: 1 },
    });
    run.talk.push(load);
    // Загруженный инструмент CLI объявляет прямо — следующий ответ и есть ход задачи.
    run.tools.push({
      name: full,
      description: run.coreMove.tool,
      schema: inputSchemaOf(run.coreMove.tool),
    });
    const call = await post(run.vocab.path, run.talk.body());
    expect(run.talk.read(call)).toEqual(expected(run.coreMove, run.vocab));
    run.talk.push(call);
    for (const move of run.task.moves.slice(run.coreAt + 1)) {
      const raw = await post(run.vocab.path, run.talk.body());
      expect(run.talk.read(raw)).toEqual(expected(move, run.vocab));
      run.talk.push(raw);
    }
    expect(run.talk.read(await post(run.vocab.path, run.talk.body()))).toEqual({ text: 'done' });
  });

  it('a background move goes through the tool whose end wakes the CLI: direct, deferred behind a proxy, else the shell', () => {
    const bg: Move = { op: 'shell', argv: ['sleep', '2'], background: true };
    const tool = (name: string, props: Record<string, unknown>) => ({
      name,
      schema: { type: 'object', properties: props },
    });
    const shell = tool('run_shell_command', { command: {}, is_background: {} });
    const ctx = (tools: unknown[], system: string) =>
      ({
        dialect: 'openai-chat',
        request: { body: { messages: [{ role: 'system', content: system }] } },
        info: { tools },
      }) as unknown as StepContext;
    const listed = 'deferred:\n- "monitor": "Starts a long-running shell command"';
    // Qwen: монитор отложен и назван в промпте — через посредника.
    expect(stepFor(bg, ctx([shell, tool('tool_call', {})], listed))).toEqual({
      tool: {
        name: 'tool_call',
        args: { name: 'monitor', arguments: { command: 'sleep 2', description: 'stub task move' } },
      },
    });
    // Объявлен прямо — зовётся прямо, описание только если схема его знает.
    expect(stepFor(bg, ctx([shell, tool('monitor', { command: {} })], ''))).toEqual({
      tool: { name: 'monitor', args: { command: 'sleep 2' } },
    });
    // Посредник есть, монитор не назван; посредника нет (Claude) — фоновая команда оболочки.
    const viaShell = {
      tool: { name: 'run_shell_command', args: { command: 'sleep 2', is_background: true } },
    };
    expect(
      stepFor(bg, ctx([shell, tool('tool_call', {})], 'a monitor named in prose, not listed')),
    ).toEqual(viaShell);
    expect(stepFor(bg, ctx([shell], listed))).toEqual(viaShell);
    // Не фоновая команда монитора не трогает.
    expect(stepFor({ ...bg, background: false }, ctx([shell, tool('monitor', {})], ''))).toEqual({
      tool: { name: 'run_shell_command', args: { command: 'sleep 2' } },
    });
  });

  it('a deferred name is matched as a whole token, not as the head of a longer name', () => {
    const body = {
      system: 'tools:\n- mcp__other__step_done_later\n- "mcp__agentdeck__step_done": ends a step',
    };
    expect(deferredName(body, 'step_done')).toBe('mcp__agentdeck__step_done');
    expect(deferredName(body, 'blocker')).toBeUndefined();
  });

  it('a deferred core tool behind a proxy: the move goes through the proxy as is', async () => {
    const proxy: Decl = {
      name: 'tool_call',
      description: 'invoke a deferred tool',
      schema: object({ name: { type: 'string' }, arguments: { type: 'object' } }, [
        'name',
        'arguments',
      ]),
    };
    const run = deferredStart('openai-chat', proxy);
    stub = await startStubModel({ script: untimed(scriptFor(run.task)) });
    for (const [index, move] of run.task.moves.entries()) {
      const raw = await post(run.vocab.path, run.talk.body());
      expect(run.talk.read(raw)).toEqual(
        index === run.coreAt
          ? {
              tool: 'tool_call',
              args: {
                name: `mcp__agentdeck__${run.coreMove.tool}`,
                arguments: fillDeep(run.coreMove.args, VALUES),
              },
            }
          : expected(move, run.vocab),
      );
      run.talk.push(raw);
    }
    expect(run.talk.read(await post(run.vocab.path, run.talk.body()))).toEqual({ text: 'done' });
  });
});
