import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskSplitProposal } from '@agentdeck/contracts/task-split';
import { splitTasks, type SplitGit, type SplitTasksInput } from './ChatSplit.ts';

/**
 * Защита от отката (этап 7 плана экономии): задание группы едет первым
 * сообщением и остаётся в контексте каждого её вызова до сжатия. Потолок — на
 * то, что дописывает сама панель: преамбулы копии, доставки, тикетов. Слова
 * человека в счёт не идут — задача здесь из одного ключа.
 */

const PROPOSAL: TaskSplitProposal = {
  groups: [
    { title: 'Форма входа', branch: 'feature/login', tasks: ['PROJ-1'] },
    { title: 'Шапка', branch: 'feature/header', tasks: ['PROJ-2'] },
  ],
};

const repo = mkdtempSync(join(tmpdir(), 'cc-split-ceiling-'));
mkdirSync(join(repo, 'e2e'));
writeFileSync(
  join(repo, 'e2e', 'package.json'),
  JSON.stringify({ scripts: { 'qa:shot': 'node ai-scripts/shot.mjs' } }),
);
afterAll(() => rmSync(repo, { recursive: true, force: true }));

/** Самая полная копия: зеркало, установка с откатом lock-файла, кит снимков. */
const git: SplitGit = {
  isRepo: () => true,
  takenBranches: async () => [],
  addWorktree: async (_dir, branch) => ({
    path: `/copies/${branch.replace(/\//g, '-')}`,
    mirror: 'Локальный слой: перенесено 3',
  }),
  bootstrap: async () => ({
    command: 'pnpm install --frozen-lockfile',
    status: 'ok',
    startedAt: '2026-10-17T10:00:00.000Z',
    finishedAt: '2026-10-17T10:01:00.000Z',
    exitCode: 0,
    logTail: 'Done',
    reverted: ['pnpm-lock.yaml'],
  }),
};

async function firstPrompt(options: Partial<SplitTasksInput>): Promise<string> {
  const prompts: string[] = [];
  await splitTasks({
    projectPath: repo,
    proposal: PROPOSAL,
    startRuns: true,
    git,
    claimBranch: () => undefined,
    deliver: true,
    ...options,
    start: ({ prompt }) => {
      prompts.push(prompt);
      return true;
    },
  });
  return prompts[0] ?? '';
}

/**
 * Пути машины (временный каталог, место панели) в задание входят как есть, а
 * длина их на CI другая — в счёт они идут одним словом.
 */
function panelText(prompt: string): string {
  const forward = repo.replace(/\\/g, '/');
  return prompt
    .split(forward)
    .join('<repo>')
    .replace(/"[^"]*review-pack\.mjs"/g, '"<panel>/review-pack.mjs"');
}

describe('потолок задания группы', () => {
  for (const [name, options] of [
    ['Claude', {}],
    ['чужой CLI', { foreign: true }],
    ['развилки человеку', { groupQuestions: 'human' }],
    ['чужой CLI, развилки человеку', { foreign: true, groupQuestions: 'human' }],
  ] as const) {
    /**
     * 6250 — редакция 17.10 (6235 знаков в самом длинном варианте: копия,
     * доставка, снимки 3.5, пакет ревью 5.3, тикеты); запас — на правку слова, не на новую фразу.
     * Новый абзац в каждое задание — сначала замер, что он окупается.
     */
    it(`доставляющая группа в копии, ${name}: не длиннее 6250 знаков`, async () => {
      const prompt = await firstPrompt(options);
      expect(prompt).toContain('PROJ-1');
      expect(prompt).toContain('npm run qa:shot');
      expect(prompt).toContain('review-pack.mjs');
      expect(prompt).toContain('<agentdeck:ticket>');
      expect(panelText(prompt).length).toBeLessThanOrEqual(6250);
    });
  }
});
