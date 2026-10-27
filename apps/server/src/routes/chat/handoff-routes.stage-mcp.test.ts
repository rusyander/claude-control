import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPLIT_MCP_TAG } from '@agentdeck/contracts/split-tickets';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import type { ChainOutcome } from '../../domains/chat/split-conveyor/split-conveyor.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { HandoffChains } from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { createHandoffPlanner, type SplitStageDeps } from './handoff-routes.ts';

/**
 * N8 (живая группа g8 26.10): правки и проверка правок идут без MCP. Звено правок,
 * которому сервер всё же нужен, просит его блоком `mcp` — и раньше планировщик тут
 * же заводил проверку, а просьба уходила в никуда: конец цепочки читал ответ уже
 * проверки. Планировщик и реестр прогонов настоящие; снаружи — процесс CLI и
 * конвейер разделения (его `resumesWithMcp` — в `split-conveyor.mcp.test.ts`).
 */

const roots: string[] = [];
const stopLater: ChatRunRegistry[] = [];
afterEach(() => {
  stopLater.splice(0).forEach((run) => run.stopAll());
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FIX_LINK: ChatLink = {
  parentChatId: 'родитель',
  groupIndex: 0,
  createdAt: '2026-10-26T02:00:00.000Z',
  title: 'Документация',
  branch: 'feature/docs',
  model: 'claude-sonnet-5',
  effort: 'high',
  ceilingModel: 'claude-opus-5',
  ceilingEffort: 'high',
  task: 'Задачи группы:\n- PROJ-8 тексты страниц',
  groupTask: 'Задачи группы:\n- PROJ-8 тексты страниц',
  stage: 'fix',
  lowered: true,
  fixFindings: ['🟡 F-1 docs/a.md:3 — подпись'],
};

const ASK = `Нужен тикет PROJ-8.\n<${SPLIT_MCP_TAG}>\nserver: atlassian-work\nwhy: критерии тикета\n</${SPLIT_MCP_TAG}>`;

/** Звено правок кончилось ответом `answer`: что завёл планировщик и что узнал конвейер. */
async function afterFix(answer: string, split: Partial<SplitStageDeps> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'stage-mcp-'));
  roots.push(cwd);
  const registry = new ChatRunRegistry((): RunLike => ({
    start: async (_options, onEvent) => {
      onEvent({ kind: 'text', text: answer });
      onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-правок' });
    },
    stop: () => undefined,
  }));
  stopLater.push(registry);
  const links = new Map<string, ChatLink>([['chat-0', FIX_LINK]]);
  const prompts: string[] = [];
  const ended: ChainOutcome[] = [];
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
        saveLink: (chatId, saved) => void links.set(chatId, saved),
        markReviewed: () => undefined,
        hasWork: () => true,
        settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
      },
      split: {
        onTriageFinished: () => undefined,
        onChainEnded: (_link, outcome) => void ended.push(outcome),
        delivers: () => false,
        // Как конвейер: новая просьба в ходе, который кончился «готово».
        resumesWithMcp: (_link, outcome) =>
          outcome.status === 'done' && (outcome.mcpRequests ?? []).length > 0,
        ...split,
      },
    }),
  );
  registry.start('chat-0', { prompt: 'правки', cwd }, { projectPath: cwd });
  await new Promise((done) => setTimeout(done, 40));
  return { next: prompts[1], ended };
}

describe('просьба о сервере посреди цепочки (N8)', () => {
  it('правки попросили сервер — проверка не заводится, конец цепочки получает просьбу', async () => {
    const { next, ended } = await afterFix(ASK);
    expect(next).toBeUndefined();
    expect(ended).toHaveLength(1);
    expect(ended[0]?.mcpRequests).toEqual(['atlassian-work']);
  });

  it('контроль: правки без просьбы — проверка заводится, как прежде', async () => {
    const { next, ended } = await afterFix('Исправил все пункты.');
    expect(next).toContain('VERIFYING those fixes');
    // Конец цепочки здесь — уже хода проверки (тот же ответ заглушки), без просьб.
    expect(ended.every((outcome) => !outcome.mcpRequests)).toBe(true);
  });

  it('конвейер не продолжит сессию (отказ, нет зависимости) — проверка заводится', async () => {
    const refused = await afterFix(ASK, { resumesWithMcp: () => false });
    expect(refused.next).toContain('VERIFYING those fixes');
    const absent = await afterFix(ASK, { resumesWithMcp: undefined });
    expect(absent.next).toContain('VERIFYING those fixes');
  });
});
