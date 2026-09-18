import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HANDOFF_BLOCK_LANG } from '@agentdeck/contracts/chat-handoff';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import { ChatSession } from './ChatSession.ts';
import { HandoffChains } from './ChatHandoff.ts';
import { readLastAssistantTurn } from './ChatHistory.ts';
import { createHandoffPlanner } from '../../routes/chat/handoff-routes.ts';
import type { RunLedgerEntry } from './run-ledger.ts';

/**
 * Ответ усыновлённого прогона читается из транскрипта.
 *
 * Проверка идёт по НАСТОЯЩЕМУ пути: файл транскрипта лежит на диске, файл-опора
 * тоже, читает его тот же `readLastAssistantTurn`, что стоит в bootstrap, а
 * решение принимает настоящий планировщик продолжений. Собранная руками строка,
 * поданная прямо в разборщик, доказала бы разборщик, а не то, что панель
 * перестала выбрасывать ответ прогона, подхваченного после перезапуска.
 */

const SESSION_ID = 'sess-adopted-1';

function line(record: unknown): string {
  return JSON.stringify(record);
}

function assistant(id: string, blocks: unknown[]): string {
  return line({
    type: 'assistant',
    uuid: `${id}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    message: { id, role: 'assistant', model: 'claude-opus-5', content: blocks },
  });
}

function toolResult(id: string): string {
  return line({
    type: 'user',
    uuid: `res-${id}`,
    timestamp: new Date().toISOString(),
    toolUseResult: { stdout: '' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ок' }] },
  });
}

const PROPOSAL = {
  done: 'этап закрыт',
  next: 'дальше — документация',
  checkpoint: '.agent/PROGRESS.md',
};

const ANSWER = [
  'Работа закончена.',
  '```' + HANDOFF_BLOCK_LANG,
  JSON.stringify(PROPOSAL),
  '```',
].join('\n');

describe('усыновлённый прогон — ответ из транскрипта', () => {
  let root: string;
  let project: string;
  let started: { chatId: string; prompt: string }[];
  let registry: ChatRunRegistry;

  /** Записать транскрипт сессии так, как это делает Claude Code. */
  function writeTranscript(lines: string[]): void {
    const dir = join(root, 'projects', '-tmp-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n', 'utf8');
  }

  /** Живой CLI из журнала: процесс умирает, когда тест этого захочет. */
  function adopt(alive: { value: boolean }): void {
    const entry: RunLedgerEntry = {
      key: SESSION_ID,
      sessionId: SESSION_ID,
      cwd: project,
      projectPath: project,
      pid: 424242,
      startedAt: Date.now() - 1_000,
    };
    expect(
      registry.adopt(entry, { isAlive: () => alive.value, kill: () => undefined, pollMs: 5 }),
    ).toBe(true);
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-adopted-'));
    project = mkdtempSync(join(tmpdir(), 'cc-adopted-proj-'));
    // Файл-опора существует и записан ПОСЛЕ старта прогона: один из
    // предохранителей продолжения, и подменять его нечем — он настоящий.
    mkdirSync(join(project, '.agent'), { recursive: true });
    writeFileSync(join(project, '.agent', 'PROGRESS.md'), 'сделано: всё', 'utf8');

    started = [];
    registry = new ChatRunRegistry((): RunLike => ({
      start: async (options) => {
        started.push({ chatId: options.permissionPrompt?.runId ?? '', prompt: options.prompt });
      },
      stop: () => undefined,
    }));
    registry.setClosingTurnReader((chatId, sessionId) =>
      readLastAssistantTurn(join(root, 'projects'), sessionId ?? chatId),
    );
    registry.setHandoffPlanner(
      createHandoffPlanner({
        runs: registry,
        chains: new HandoffChains(() => true),
        session: new ChatSession(registry),
        selfBaseUrl: 'http://127.0.0.1:5178',
        contextLimit: () => 0,
      }),
    );
  });

  afterEach(() => {
    registry.stopAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('закрывающий ход с блоком продолжения заводит чистую сессию', async () => {
    writeTranscript([
      assistant('msg-1', [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }]),
      toolResult('tu-1'),
      assistant('msg-2', [{ type: 'text', text: ANSWER }]),
    ]);
    const alive = { value: true };
    adopt(alive);

    alive.value = false;
    await settle();

    expect(started).toHaveLength(1);
    expect(started[0]?.prompt).toContain(PROPOSAL.next);
    expect(started[0]?.prompt).toContain(PROPOSAL.checkpoint);
  });

  it('ход, оборванный на вызове инструмента, закрывающим не считается — молчим', async () => {
    writeTranscript([
      assistant('msg-1', [{ type: 'text', text: ANSWER }]),
      assistant('msg-1', [{ type: 'tool_use', id: 'tu-9', name: 'Bash', input: {} }]),
    ]);
    const alive = { value: true };
    adopt(alive);

    alive.value = false;
    await settle();

    expect(started).toEqual([]);
  });

  it('транскрипт, кончающийся результатом инструмента, закрывающего хода не даёт', async () => {
    writeTranscript([
      assistant('msg-1', [{ type: 'text', text: ANSWER }]),
      assistant('msg-1', [{ type: 'tool_use', id: 'tu-7', name: 'Bash', input: {} }]),
      toolResult('tu-7'),
    ]);
    const alive = { value: true };
    adopt(alive);

    alive.value = false;
    await settle();

    expect(started).toEqual([]);
  });

  it('транскрипта нет вовсе — прогон закрывается молча, ничего не падает', async () => {
    const alive = { value: true };
    adopt(alive);

    alive.value = false;
    await settle();

    expect(started).toEqual([]);
  });
});
