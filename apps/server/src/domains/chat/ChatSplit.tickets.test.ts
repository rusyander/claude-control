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
      expect(prompt).toContain('тикет в трекере не заводи');
      expect(prompt).toContain(`<${SPLIT_HUMAN_TAG}>`);
      expect(prompt).toContain('«Сделать человеку»');
      // Последний абзац: задачи и доставка — выше, блоки панели их не разрывают.
      expect(prompt.trimEnd().endsWith(`</${SPLIT_HUMAN_TAG}>`)).toBe(true);
    }
  });

  it('без записи разделения абзаца нет — блок было бы некуда положить', async () => {
    const seen = await prompts(false);

    expect(seen).toHaveLength(2);
    for (const prompt of seen) expect(prompt).not.toContain(SPLIT_TICKET_TAG);
  });
});
