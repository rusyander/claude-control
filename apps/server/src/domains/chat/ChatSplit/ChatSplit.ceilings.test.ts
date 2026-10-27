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
     * 6400 — 20.10: +~120 знаков «полные проверки один раз» и «основную — только
     * при конфликте». Окупается замером 19.10: каждая группа гнала полный гейт
     * трижды на MR (13–20 мин прогон) и тратила ход на отказ брокера в rebase.
     * 6600 — 26.10: +~575 знаков следа задач (`taskCoverageLine`). Окупается живым
     * аудитом 26.10: десять групп одного разделения сдали «готово» без части пунктов
     * тикетов (g9 отдала D1/D14/D15/D20 группе, у которой не было ни одного файла той
     * админки) — каждую дочищал человек.
     * 6700 — 26.10 (g0 F3): +~105 знаков — строка `task-N` цитирует пункт слово в слово, и
     * доставка сверяет цитату с тикетом, заданием и описанием MR. Окупается тем же аудитом:
     * строку task-1285 группа выдумала («правка с тестами» там, где кода не было), и без
     * цитаты доставка не могла этого увидеть.
     */
    it(`доставляющая группа в копии, ${name}: не длиннее 6700 знаков`, async () => {
      const prompt = await firstPrompt(options);
      expect(prompt).toContain('PROJ-1');
      expect(prompt).toContain('npm run qa:shot');
      // Владелец 23.10: доставку ведёт звено после работы — работе ни своего
      // ревью с пакетом, ни полного гейта, ни пуша.
      expect(prompt).not.toContain('review-pack.mjs');
      expect(prompt).toContain('no full project gate, no push, no MR');
      expect(prompt).toContain('<agentdeck:ticket>');
      expect(prompt).toContain('Task trace: first list every point of your tasks');
      expect(panelText(prompt).length).toBeLessThanOrEqual(6700);
    });
  }
});

/** След задач (26.10): метку `taskTrace` ставит тот, кто собрал задание, — по строке в нём. */
describe('след задач в задании группы', () => {
  async function launched(deliver: boolean) {
    const prompts: string[] = [];
    const result = await splitTasks({
      projectPath: repo,
      proposal: PROPOSAL,
      startRuns: true,
      git,
      claimBranch: () => undefined,
      deliver,
      start: ({ prompt }) => {
        prompts.push(prompt);
        return true;
      },
    });
    return { chat: result.chats[0], prompt: prompts[0] ?? '' };
  }

  it('с доставкой — строка следа в задании и метка у чата', async () => {
    const { chat, prompt } = await launched(true);
    expect(prompt).toContain('Task trace: first list every point of your tasks');
    expect(chat?.taskTrace).toBe(true);
  });

  it('без доставки — ни строки, ни метки: судить нечего', async () => {
    const { chat, prompt } = await launched(false);
    expect(prompt).not.toContain('Task trace:');
    expect(chat?.taskTrace).toBeUndefined();
  });
});
