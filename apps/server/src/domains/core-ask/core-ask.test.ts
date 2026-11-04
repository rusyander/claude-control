import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AskFields } from '@agentdeck/contracts/core/ask';
import { attachTextCodes, serverText } from '../../lib/server-texts/server-texts.ts';
import { createCoreAskPort, runCoreAsk } from './core-ask.ts';
import type { CoreAskEvent } from './core-ask.types.ts';
import { startFakeCore, type FakeCore, type FakeCoreOptions } from './__fixtures__/fake-core.ts';

/**
 * Клиент вопроса ядру (этап 10, F2): строка ядра из `procs.json`, сверка слушателя, bearer ядра,
 * число загрузки на каждую просьбу, поток вида сеанса. Ядро — заглушка на настоящем HTTP, которая
 * разбирает тело тем же контрактом (`askBodySchema`) и, как живое ядро, требует UUIDv7 загрузки.
 */
const FIELDS: AskFields = { title: 'ask test', prompt: 'сколько будет 2+2?', tools: 'none' };

let core: FakeCore | undefined;
afterEach(async () => {
  await core?.close();
  core = undefined;
});

async function ask(options: FakeCoreOptions, fields: AskFields = FIELDS) {
  core = await startFakeCore(options);
  const port = createCoreAskPort(() => core!.home, core.identity);
  const events: CoreAskEvent[] = [];
  const run = runCoreAsk(port, fields, (event) => events.push(event), { pollMs: 10 });
  return { run, events, outcome: await run.done };
}

describe('вопрос ядру', () => {
  it('ответ: число загрузки на просьбу, тело принято контрактом, текст хода — ответ', async () => {
    const { outcome, events } = await ask({
      turn: async ({ emit }) => {
        emit({ kind: 'assistant-text', data: { text: '4' } });
        emit({ kind: 'turn-end', data: { isError: false, numTurns: 1 } });
      },
    });
    expect(outcome).toEqual({ ok: true, reply: '4', actions: [] });
    expect(events).toEqual([
      { kind: 'text', text: '4' },
      { kind: 'done', reply: '4' },
    ]);
    expect(core!.asks).toEqual([FIELDS]);
    expect(core!.nonces).toEqual({ minted: 1, used: 1 });
  });

  it('отказ ядра — код и причины ядра словами, а не пустая ошибка', async () => {
    const { outcome } = await ask({
      refuse: { status: 422, code: 'ask-refused', error: 'Вопрос не принят', problems: ['p1'] },
    });
    expect(outcome).toMatchObject({
      ok: false,
      code: 'ask-refused',
      error: 'Вопрос не принят: p1',
    });
  });

  it('тело, которое ядро не примет, — отказ с полем, а не задача', async () => {
    const { outcome } = await ask({}, { ...FIELDS, tools: 'panel-bridge' });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('bad-ask');
    expect(outcome.error).toContain('panelBridge');
  });

  it('ядро не запущено — отказ с причиной, без сети', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'cc-no-core-'));
    try {
      const port = createCoreAskPort(() => empty);
      const outcome = await runCoreAsk(port, FIELDS, () => undefined).done;
      expect(outcome).toMatchObject({ ok: false, code: 'core-unreachable' });
      expect(outcome.error).toContain('core is not running');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('«Стоп» — команда cancel ядру своим числом загрузки; ход кончается после неё', async () => {
    core = await startFakeCore({
      turn: async ({ emit, cancelled }) => {
        emit({ kind: 'assistant-text', data: { text: 'думаю' } });
        await cancelled;
      },
    });
    const port = createCoreAskPort(() => core!.home, core.identity);
    const run = runCoreAsk(port, FIELDS, () => undefined, { pollMs: 10 });
    for (let i = 0; i < 100 && !run.taskId(); i += 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    run.stop();
    const outcome = await run.done;
    expect(outcome).toMatchObject({ ok: false, code: 'stopped' });
    expect(core.cancels).toEqual([run.taskId()]);
    expect(core.nonces).toEqual({ minted: 2, used: 2 });
  });

  it('инструмент не моста — обрыв с его именем и cancel ядру; поиск инструментов — служба', async () => {
    const { outcome, events } = await ask(
      {
        turn: async ({ emit, cancelled }) => {
          emit({ kind: 'tool-call', data: { toolUseId: 's', name: 'ToolSearch', input: {} } });
          emit({ kind: 'tool-call', data: { toolUseId: 'b', name: 'Bash', input: {} } });
          await cancelled;
        },
      },
      FIELDS,
    );
    expect(outcome).toMatchObject({ ok: false, code: 'extra-tool', error: 'Bash' });
    expect(events).toEqual([]);
    expect(core!.cancels).toHaveLength(1);
  });

  it('действия моста — в итоге хода, проваленное помечено', async () => {
    const { outcome, events } = await ask({
      turn: async ({ emit }) => {
        emit({
          kind: 'tool-call',
          data: { toolUseId: '1', name: 'mcp__panel-bridge__a', input: {} },
        });
        emit({ kind: 'tool-result', data: { toolUseId: '1', isError: false } });
        emit({
          kind: 'tool-call',
          data: { toolUseId: '2', name: 'mcp__panel-bridge__b', input: {} },
        });
        emit({ kind: 'tool-result', data: { toolUseId: '2', isError: true } });
        emit({ kind: 'assistant-text', data: { text: 'итог' } });
        emit({ kind: 'turn-end', data: { isError: false, numTurns: 1 } });
      },
    });
    expect(outcome).toEqual({ ok: true, reply: 'итог', actions: ['a', 'b (failed)'] });
    expect(events.filter((e) => e.kind === 'tool')).toEqual([
      { kind: 'tool', name: 'a' },
      { kind: 'tool', name: 'b' },
    ]);
  });

  it('сессия кончилась без конца хода — no-answer; ошибка сессии — её словами', async () => {
    const silent = await ask({ turn: async () => undefined });
    expect(silent.outcome).toMatchObject({ ok: false, code: 'no-answer' });
    await core!.close();
    core = undefined;
    const broken = await ask({
      turn: async ({ emit }) => emit({ kind: 'error', data: { code: 'exit', detail: 'CLI упал' } }),
    });
    expect(broken.outcome).toMatchObject({ ok: false, code: 'session-error', error: 'CLI упал' });
  });

  it('дорога отказала до сессии — причина шага ядра дословно, а не «сессии нет»', async () => {
    const reason = 'session road refused: compat refused: credential_absent';
    const { outcome } = await ask({ noSession: { reason } });
    expect(outcome).toMatchObject({ ok: false, code: 'no-session', error: reason });
  });

  it('ход с ошибкой: слова CLI дословно, без слов — своя строка с кодом для окна', async () => {
    const words = 'API Error: 400 qa-model: request refused by the stub';
    const said = await ask({
      turn: async ({ emit }) =>
        emit({ kind: 'turn-end', data: { isError: true, numTurns: 1, text: words } }),
    });
    expect(said.outcome).toMatchObject({ ok: false, code: 'session-error', error: words });
    expect(attachTextCodes({ message: words })).toEqual({ message: words });
    await core!.close();
    core = undefined;
    const mute = await ask({
      turn: async ({ emit }) => emit({ kind: 'turn-end', data: { isError: true, numTurns: 1 } }),
    });
    expect(mute.outcome.error).toBe(serverText('panel-agent-model-error'));
    expect(attachTextCodes({ message: mute.outcome.error })).toMatchObject({
      messageCode: 'panel-agent-model-error',
    });
  });
});
