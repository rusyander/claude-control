import { describe, expect, it } from 'vitest';
import { OWNER_PRECEDENCE_LINE } from '@agentdeck/contracts/quality-floor';
import { SPLIT_TICKET_TAG } from '@agentdeck/contracts/split-tickets';
import type { TaskSplitProposal } from '@agentdeck/contracts/task-split';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import { planCascadeStage } from './ChatCascadeStages/ChatCascadeStages.ts';
import { splitTasks, type SplitGit } from './ChatSplit/ChatSplit.ts';

/**
 * Задание группы на поздних звеньях (TQ-01, 12.10.2026). Звенья — новые чаты, и
 * «задание, с которого началась работа» в них вкладывается целиком. Раньше туда
 * уезжал собранный промпт работы: преамбулы копии, доставки и тикета, строка
 * старшинства второй раз, а ревью «НИЧЕГО НЕ ПРАВЬ» читало «тебе разрешено
 * коммитить и пушить». Проверка идёт по настоящему пути: задание собирает
 * разделение, связь пишет оно же, звенья строит планировщик стадий.
 */

const OWNER = 'Починить расчёт скидки: тест на округление обязателен, e2e прогнать.';
const PROPOSAL: TaskSplitProposal = {
  shared: 'Общий контекст разделения.',
  groups: [{ title: 'Скидка', branch: 'fix/discount', tasks: [OWNER] }],
};
const git: SplitGit = {
  isRepo: () => true,
  takenBranches: async () => [],
  addWorktree: async (_dir, branch) => ({ path: `/copies/${branch.replace(/\//g, '-')}` }),
};
const DELIVERY_HEAD = "Delivering a ready MR is this group's duty";
const REVIEW_BLOCK = (body: string): string =>
  ['Проверил дифф.', '```agentdeck:review', body, '```'].join('\n');
const count = (text: string, part: string): number => text.split(part).length - 1;

async function launched(): Promise<{ prompt: string; groupTask?: string }> {
  const seen: { prompt: string; groupTask?: string }[] = [];
  await splitTasks({
    projectPath: '/repo',
    proposal: PROPOSAL,
    startRuns: true,
    git,
    deliver: true,
    claimBranch: () => undefined,
    start: ({ prompt, groupTask }) => {
      seen.push({ prompt, ...(groupTask ? { groupTask } : {}) });
      return true;
    },
  });
  return seen[0] as { prompt: string; groupTask?: string };
}

function workLink(prompt: string, groupTask: string | undefined): ChatLink {
  return {
    parentChatId: 'parent',
    createdAt: '2026-10-12T00:00:00.000Z',
    title: 'Скидка',
    branch: 'fix/discount',
    stage: 'work',
    model: 'sonnet',
    lowered: true,
    ceilingModel: 'opus',
    task: prompt,
    ...(groupTask ? { groupTask } : {}),
  };
}

describe('задание группы на поздних звеньях — без преамбул работы (TQ-01)', () => {
  it('ревью получает слова группы один раз, без доставки, тикета и второй строки старшинства', async () => {
    const { prompt, groupTask } = await launched();
    expect(prompt).toContain(DELIVERY_HEAD);
    const review = planCascadeStage({
      link: workLink(prompt, groupTask),
      ok: true,
      text: 'Сделано.',
      task: prompt,
      hasWork: () => true,
      deliver: true,
    });
    expect(review?.stage).toBe('review');
    const text = review?.prompt ?? '';
    expect(count(text, OWNER)).toBe(1);
    expect(count(text, OWNER_PRECEDENCE_LINE)).toBe(1);
    expect(text).not.toContain(DELIVERY_HEAD);
    expect(text).not.toContain(SPLIT_TICKET_TAG);
  });

  it('правки и доставка после ревью — то же задание группы, одна процедура доставки', async () => {
    const { prompt, groupTask } = await launched();
    const reviewLink = planCascadeStage({
      link: workLink(prompt, groupTask),
      ok: true,
      text: 'Сделано.',
      task: prompt,
      hasWork: () => true,
      deliver: true,
    })?.link as ChatLink;
    const fix = planCascadeStage({
      link: reviewLink,
      ok: true,
      text: REVIEW_BLOCK('{"findings":["src/a.ts:10 — забыт await"]}'),
      task: 'ревью',
      hasWork: () => true,
      deliver: true,
    });
    const deliver = planCascadeStage({
      link: reviewLink,
      ok: true,
      text: REVIEW_BLOCK('{"findings":[]}'),
      task: 'ревью',
      hasWork: () => true,
      deliver: true,
    });
    for (const stage of [fix, deliver]) {
      const text = stage?.prompt ?? '';
      expect(count(text, OWNER)).toBe(1);
      expect(count(text, OWNER_PRECEDENCE_LINE)).toBeLessThanOrEqual(1);
      expect(text).not.toContain(DELIVERY_HEAD);
      expect(text).not.toContain(SPLIT_TICKET_TAG);
    }
  });

  it('работа после плана по-прежнему получает задание целиком — с правом доставки', async () => {
    const { prompt, groupTask } = await launched();
    const work = planCascadeStage({
      link: { ...workLink(prompt, groupTask), stage: 'plan', workModel: 'sonnet' },
      ok: true,
      text: '```agentdeck:plan\n1. сделать\n```',
      task: 'план',
      hasWork: () => true,
      deliver: true,
    });
    expect(work?.stage).toBe('work');
    expect(work?.prompt).toContain(DELIVERY_HEAD);
    expect(work?.link.groupTask).toBe(groupTask);
  });
});
