import { describe, it, expect } from 'vitest';
import { SPLIT_HUMAN_TAG, SPLIT_TICKET_TAG } from '@agentdeck/contracts/split-tickets';
import type { TaskSplitProposal } from '@agentdeck/contracts/task-split';
import { splitTasks, type SplitGit } from './ChatSplit.ts';

/**
 * Задание группы учит её блоку тикета (95b) — но только там, где блок есть
 * куда положить: запись разделения ведёт конвейер (`claimBranch`). Без неё
 * обещание «панель покажет» было бы неправдой, и абзаца в задании нет.
 */

const PROPOSAL: TaskSplitProposal = {
  groups: [
    { title: 'Форма входа', branch: 'feature/login', tasks: ['починить валидацию'] },
    { title: 'Шапка', branch: 'feature/header', tasks: ['убрать лишний отступ'] },
  ],
};

const git: SplitGit = {
  isRepo: () => true,
  takenBranches: async () => [],
  addWorktree: async (_dir, branch) => ({ path: `/copies/${branch.replace(/\//g, '-')}` }),
};

async function prompts(tracked: boolean): Promise<string[]> {
  const seen: string[] = [];
  await splitTasks({
    projectPath: '/repo',
    proposal: PROPOSAL,
    startRuns: true,
    git,
    deliver: true,
    ...(tracked ? { claimBranch: () => undefined } : {}),
    start: ({ prompt }) => {
      seen.push(prompt);
      return true;
    },
  });
  return seen;
}

describe('абзац о блоке тикета в задании группы', () => {
  it('разделение под конвейером: у каждой группы абзац с форматом блока, последним', async () => {
    const seen = await prompts(true);

    expect(seen).toHaveLength(2);
    for (const prompt of seen) {
      expect(prompt).toContain(`<${SPLIT_TICKET_TAG}>`);
      expect(prompt).toContain('title:');
      expect(prompt).toContain('where:');
      expect(prompt).toContain('why:');
      expect(prompt).toContain('do not file a tracker ticket');
      expect(prompt).toContain(`<${SPLIT_HUMAN_TAG}>`);
      expect(prompt).toContain('"For you to do"');
      // Последний абзац: задачи и доставка — выше, блоки панели их не разрывают.
      expect(prompt.trimEnd().endsWith(`</${SPLIT_HUMAN_TAG}>`)).toBe(true);
    }
  });

  /**
   * TQ-10 (12.10.2026): ревью по ссылке ничего не правит и не доставляет, а
   * получало «свои дефекты чини сам» и блок шага доставки — противоречие
   * своему же «ничего не правь».
   */
  it('ревью по ссылке: только блок тикета, без «чини своё» и шага доставки', async () => {
    const seen: string[] = [];
    await splitTasks({
      projectPath: '/repo',
      proposal: {
        groups: [
          { title: 'Форма входа', branch: 'feature/login', tasks: ['починить валидацию'] },
          {
            title: '!773',
            branch: 'feat/b',
            tasks: ['посмотри'],
            review: { url: 'https://git.example/p/-/merge_requests/773' },
          },
        ],
      },
      startRuns: true,
      git,
      deliver: true,
      claimBranch: () => undefined,
      resolveReview: async () => ({ branch: 'feat/b' }),
      start: ({ prompt }) => {
        seen.push(prompt);
        return true;
      },
    });

    const [work, review] = seen;
    expect(work).toContain('Fix defects of your own tasks yourself');
    expect(work).toContain(`<${SPLIT_HUMAN_TAG}>`);
    expect(review).toContain('EDIT NOTHING');
    expect(review).toContain(`<${SPLIT_TICKET_TAG}>`);
    expect(review).toContain('a finding of your review');
    expect(review).not.toContain('Fix defects of your own tasks yourself');
    expect(review).not.toContain(SPLIT_HUMAN_TAG);
    expect(review).not.toContain('"For you to do"');
  });

  it('без записи разделения абзаца нет — блок было бы некуда положить', async () => {
    const seen = await prompts(false);

    expect(seen).toHaveLength(2);
    for (const prompt of seen) expect(prompt).not.toContain(SPLIT_TICKET_TAG);
  });
});
