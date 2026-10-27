import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { HandoffChains } from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { createHandoffPlanner, type SplitStageDeps } from './handoff-routes.ts';

/**
 * Живая группа g8 26.10 (аудит правок, N2/N7/N9). Правки сочли «своими» страницы
 * по диффу ветки и завели 32 записи baseline, половина — на страницах самой
 * группы; проверка заново доказывала то, что правки уже убили мутантами; 21
 * замечание читалось окнами по 330 строк до сжатия. Планировщик сдачи и реестр
 * прогонов настоящие; снаружи — только процесс CLI. Проверяется задание, которое
 * звено действительно получает первым сообщением.
 */
const SCOPE = {
  own: ['inst-docs-ui/content/{ru,en,uz}/models/limits.mdx'],
  others: ['inst-docs-ui/content/{ru,en,uz}/agents/{builder,versions}.mdx'],
};

const roots: string[] = [];
const stopLater: ChatRunRegistry[] = [];
afterEach(() => {
  stopLater.splice(0).forEach((run) => run.stopAll());
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const groupLink = (patch: Partial<ChatLink>): ChatLink => ({
  parentChatId: 'родитель',
  groupIndex: 7,
  createdAt: '2026-10-26T02:00:00.000Z',
  title: 'Документация',
  branch: 'feature/docs',
  model: 'claude-opus-5',
  effort: 'high',
  ceilingModel: 'claude-opus-5',
  ceilingEffort: 'high',
  workModel: 'claude-sonnet-5',
  workEffort: 'high',
  kind: 'mechanical',
  task: 'Задачи группы:\n- PROJ-8 тексты страниц',
  groupTask: 'Задачи группы:\n- PROJ-8 тексты страниц',
  ...patch,
});

/** Звено `link` кончилось ответом `answer`; что получило следующее звено первой репликой. */
async function nextPrompt(
  link: ChatLink,
  answer: string,
  split: Partial<SplitStageDeps> = {},
): Promise<string | undefined> {
  const cwd = mkdtempSync(join(tmpdir(), 'stage-scope-'));
  roots.push(cwd);
  const registry = new ChatRunRegistry((): RunLike => ({
    start: async (_options, onEvent) => {
      onEvent({ kind: 'text', text: answer });
      onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-звена' });
    },
    stop: () => undefined,
  }));
  stopLater.push(registry);
  const links = new Map<string, ChatLink>([['chat-0', link]]);
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
        saveLink: (chatId, saved) => void links.set(chatId, saved),
        markReviewed: () => undefined,
        hasWork: () => true,
        settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
      },
      split: {
        onTriageFinished: () => undefined,
        onChainEnded: () => undefined,
        delivers: () => false,
        scopeOf: () => SCOPE,
        ...split,
      },
    }),
  );
  registry.start('chat-0', { prompt: 'звено', cwd }, { projectPath: cwd });
  await new Promise((done) => setTimeout(done, 40));
  return prompts[1];
}

const verdict = (findings: string[]): string =>
  ['Ревью готово.', '```agentdeck:review', JSON.stringify({ findings }), '```'].join('\n');

const FINDINGS = Array.from(
  { length: 16 },
  (_, index) => `🟡 F-${index + 1} inst-docs-ui/scripts/check_content.mjs:${100 + index} — подпись`,
);

describe('задание правок группы несёт её границы и меру длинного списка', () => {
  it('правки: чужие пути из плана, запрет baseline на своих, grep по замечанию при >15', async () => {
    const prompt = await nextPrompt(groupLink({ stage: 'review' }), verdict(FINDINGS));

    expect(prompt).toBeDefined();
    expect(prompt).toContain('This is a new session');
    expect(prompt).toContain('Owned by OTHER groups:');
    expect(prompt).toContain('- inst-docs-ui/content/{ru,en,uz}/agents/{builder,versions}.mdx');
    expect(prompt).toContain('- inst-docs-ui/content/{ru,en,uz}/models/limits.mdx');
    expect(prompt).toContain('your branch diff does not decide');
    expect(prompt).toMatch(/ONLY for a finding on a path owned by another group/);
    expect(prompt).toContain('never baselined');
    expect(prompt).toContain('This list is long (16 findings)');
    expect(prompt).toContain('targeted grep');
    // Проход проверки будет — правки обязаны сдать раздел доказанного.
    expect(prompt).toContain('`Proven:`');
  });

  it('короткий список — без строки о длинном; группа без плана границ — без абзаца границ', async () => {
    const prompt = await nextPrompt(
      groupLink({ stage: 'review' }),
      verdict(FINDINGS.slice(0, 15)),
      {
        scopeOf: () => undefined,
      },
    );

    expect(prompt).toContain('This is a new session');
    expect(prompt).not.toContain('This list is long');
    expect(prompt).not.toContain('Owned by OTHER groups');
  });
});

describe('задание проверки правок: доказанное правками не повторяется', () => {
  const FIX_ANSWER = [
    'Исправил все пункты.',
    '',
    'Proven:',
    '- F-08 mutant check_content.mjs:1263 killed by «labels > counts en bold»',
    '- F-09 verify-ledger reused green key 82bee40a (npx vitest run scripts)',
    '',
    'Готово.',
  ].join('\n');

  it('раздел Proven правок — списком «не повторять», дифф по --stat, без клона', async () => {
    const prompt = await nextPrompt(
      groupLink({ stage: 'fix', fixFindings: FINDINGS.slice(0, 3) }),
      FIX_ANSWER,
    );

    expect(prompt).toContain('VERIFYING those fixes');
    expect(prompt).toContain('Already proven by the fixes stage');
    expect(prompt).toContain(
      '- F-08 mutant check_content.mjs:1263 killed by «labels > counts en bold»',
    );
    expect(prompt).toContain(
      '- F-09 verify-ledger reused green key 82bee40a (npx vitest run scripts)',
    );
    expect(prompt).toContain('git diff --stat');
    expect(prompt).toContain('git worktree add');
    expect(prompt).toContain('content level');
    // Границы группы — и проверке: baseline на своей странице — регрессия правок.
    expect(prompt).toContain('Owned by OTHER groups:');
    expect(prompt).toMatch(
      /known-debt entry the fixes added on a path no other group owns is a regression/,
    );
  });

  it('правки без раздела Proven — абзаца доказанного нет, мера чтения диффа есть', async () => {
    const prompt = await nextPrompt(
      groupLink({ stage: 'fix', fixFindings: FINDINGS.slice(0, 3) }),
      'Исправил все пункты.',
    );

    expect(prompt).toContain('VERIFYING those fixes');
    expect(prompt).not.toContain('Already proven');
    expect(prompt).toContain('git diff --stat');
  });
});
