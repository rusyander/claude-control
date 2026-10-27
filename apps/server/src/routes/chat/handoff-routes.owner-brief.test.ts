import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerRequestBlock } from '@agentdeck/contracts/quality-floor';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { HandoffChains } from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { OWNER_BRIEF } from '../../domains/chat/owner-brief/owner-brief.ts';
import { createHandoffPlanner } from './handoff-routes.ts';

/**
 * Живая группа 26.10 (стадия правок): после сжатия группа искала дословную
 * просьбу владельца и номера `owner-N` в своём транскрипте — 7 вызовов, 2,5
 * минуты. Теперь старт звена кладёт их файлом в копию. Планировщик сдачи и реестр
 * прогонов настоящие, диск настоящий; снаружи — только процесс CLI.
 */
const OWNER = 'Доска PROJ: возьми фронтовые задачи, глубокое ревью, MR без мержа.';
const GROUP_TASK = `${ownerRequestBlock([OWNER])}\n\nЗадачи группы:\n- PROJ-1`;

const roots: string[] = [];
const stopLater: ChatRunRegistry[] = [];
afterEach(() => {
  stopLater.splice(0).forEach((run) => run.stopAll());
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const workLink = (): ChatLink => ({
  parentChatId: 'родитель',
  groupIndex: 0,
  createdAt: '2026-10-26T09:00:00.000Z',
  title: 'Доки',
  branch: 'feature/docs',
  model: 'claude-opus-5',
  effort: 'high',
  kind: 'mechanical',
  lowered: false,
  stage: 'work',
  task: GROUP_TASK,
  groupTask: GROUP_TASK,
  sieveRows: [{ id: 'owner-1', status: 'pass', evidence: 'npx vitest → 78 passed' }],
});

/** Работа кончилась отчётом с ещё одной строкой; планировщик заводит ревью. */
async function finishWork(cwd: string, delivers = true): Promise<string[]> {
  const answer =
    'Сделал PROJ-1.\n\n```agentdeck:sieves\n' +
    '{"sieves":[{"id":"owner-2","status":"n/a","evidence":"other group: API"}]}\n```';
  const registry = new ChatRunRegistry((): RunLike => ({
    start: async (_options, onEvent) => {
      onEvent({ kind: 'text', text: answer });
      onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-работы' });
    },
    stop: () => undefined,
  }));
  stopLater.push(registry);
  const links = new Map<string, ChatLink>([['chat-0', workLink()]]);
  const prompts: string[] = [];
  const start = registry.start.bind(registry);
  registry.start = (chatId, opts, meta) => {
    prompts.push(opts.prompt);
    return start(chatId, opts, meta);
  };
  registry.setHandoffPlanner(
    createHandoffPlanner({
      runs: registry,
      chains: new HandoffChains(),
      session: new ChatSession(registry),
      selfBaseUrl: 'http://127.0.0.1:5178',
      stat: () => Date.now(),
      cascade: {
        linkOf: (aliases) => aliases.map((key) => links.get(key)).find(Boolean),
        saveLink: (chatId, link) => void links.set(chatId, link),
        markReviewed: () => undefined,
        hasWork: () => true,
        settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
        sieves: async () => '1. [browser-focus] проверить фокус живьём',
      },
      split: {
        onTriageFinished: () => undefined,
        onChainEnded: () => undefined,
        delivers: () => delivers,
      },
    }),
  );
  registry.start('chat-0', { prompt: 'работа', cwd }, { projectPath: cwd });
  await new Promise((done) => setTimeout(done, 40));
  return prompts;
}

describe('старт звена кладёт слова владельца и сданные строки файлом в копию', () => {
  it('ревью после работы: дословная просьба, owner-1 прошлого звена, owner-2 этой работы, сита звена', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'owner-brief-handoff-'));
    roots.push(cwd);
    const prompts = await finishWork(cwd);
    // Звено ревью действительно стартовало — файл пишет его старт, а не что-то ещё.
    expect(prompts).toHaveLength(2);

    const text = readFileSync(join(cwd, OWNER_BRIEF), 'utf8');
    expect(text).toContain(OWNER);
    expect(text).toContain('Requirement trace');
    expect(text).toContain('- owner-1 pass — npx vitest → 78 passed');
    expect(text).toContain('- owner-2 n/a — other group: API');
    expect(text).toContain('[browser-focus]');
    expect(text).not.toContain('Задачи группы');
  });

  it('звено без абзаца сит (группа без доставки): файл со строками пишется и так', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'owner-brief-handoff-'));
    roots.push(cwd);
    expect(await finishWork(cwd, false)).toHaveLength(2);

    const text = readFileSync(join(cwd, OWNER_BRIEF), 'utf8');
    expect(text).toContain(OWNER);
    expect(text).toContain('- owner-2 n/a — other group: API');
    expect(text).not.toContain('Sieves of the current stage');
  });
});
