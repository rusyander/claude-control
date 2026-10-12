import { describe, expect, it } from 'vitest';
import { buildHandoffPrompt } from '@agentdeck/contracts/chat-handoff';
import {
  deliverStagePrompt,
  fixStagePrompt,
  reviewLinkPrompt,
  reviewStagePrompt,
} from '@agentdeck/contracts/model-cascade';
import {
  grantsReviewPublish,
  labelledCut,
  NARROWING_PHRASES,
  OWNER_PRECEDENCE_LINE,
  SKILL_ROUTE_LINE,
} from '@agentdeck/contracts/quality-floor';
import {
  planStagePrompt,
  triageStagePrompt,
  workAfterPlanPrompt,
  raisedWorkPrompt,
} from '@agentdeck/contracts/split-plan';
import {
  buildGroupPrompt,
  parseSplitProposal,
  SPLIT_SYSTEM_PROMPT,
} from '@agentdeck/contracts/task-split';

/**
 * Нижняя планка заданий панели (владелец, 12.10.2026: «группа может только
 * ДОБАВИТЬ качество»). Одна таблица на все построители первых сообщений:
 *
 * - слова владельца доходят целиком — метка в 50 тыс. знаков стоит в задании
 *   без единой потери;
 * - ни одна фраза, которая однажды уже сузила работу (`NARROWING_PHRASES`), в
 *   обёртку панели не вернулась;
 * - строка старшинства стоит ровно один раз — вложенное задание группы её уже
 *   несёт, и построитель поверх не повторяет;
 * - ни одна длинная строка не повторена: повтор стоит токенов в каждом ходе.
 *
 * Новый построитель первого сообщения — новая строка таблицы; без неё он
 * планку не проходил.
 */

const OWNER = `OWNER-START ${'Сделай аккуратно, проверь всё. '.repeat(1_700)} OWNER-END`;
const OWNER_B = `SECOND-START ${'Проверь документацию и локали. '.repeat(400)} SECOND-END`;

const GROUP = { title: 'Группа', branch: 'feat/a', tasks: [OWNER, OWNER_B] };
const GROUP_TASK = buildGroupPrompt(GROUP, 'Общий контекст разделения.');
const HANDOFF = {
  done: 'Этап закрыт',
  next: 'Дальше — второй этап',
  checkpoint: '.agent/PROGRESS.md',
};

const BUILDERS: { name: string; prompt: string; owner: string[] }[] = [
  { name: 'buildGroupPrompt', prompt: GROUP_TASK, owner: [OWNER, OWNER_B] },
  {
    name: 'reviewStagePrompt',
    prompt: reviewStagePrompt({ task: OWNER, branch: 'feat/a' }),
    owner: [OWNER],
  },
  {
    name: 'fixStagePrompt',
    prompt: fixStagePrompt(['🟡 F-01 **Забыт await** — Где: src/a.ts:10-12'], {
      branch: 'feat/a',
      context: { task: OWNER },
    }),
    owner: [OWNER],
  },
  {
    name: 'deliverStagePrompt',
    prompt: deliverStagePrompt({ branch: 'feat/a', after: 'fix', context: { task: OWNER } }),
    owner: [OWNER],
  },
  {
    name: 'reviewLinkPrompt',
    prompt: reviewLinkPrompt({
      url: 'https://gitlab.example/x/-/merge_requests/1',
      branch: 'feat/a',
      tasks: [OWNER],
      shared: OWNER_B,
    }),
    owner: [OWNER, OWNER_B],
  },
  {
    name: 'reviewLinkPrompt (publish)',
    prompt: reviewLinkPrompt({
      url: 'https://gitlab.example/x/-/merge_requests/1',
      tasks: [OWNER],
      publish: true,
    }),
    owner: [OWNER],
  },
  {
    name: 'triageStagePrompt',
    prompt: triageStagePrompt({ shared: OWNER_B, groups: [GROUP] }),
    owner: [OWNER, OWNER_B],
  },
  {
    name: 'planStagePrompt',
    prompt: planStagePrompt({ title: 'Группа', task: GROUP_TASK, branch: 'feat/a' }),
    owner: [OWNER, OWNER_B],
  },
  {
    name: 'workAfterPlanPrompt',
    prompt: workAfterPlanPrompt({ task: GROUP_TASK, plan: '1. Шаг\n2. Шаг' }),
    owner: [OWNER, OWNER_B],
  },
  {
    name: 'workAfterPlanPrompt (no plan)',
    prompt: workAfterPlanPrompt({ task: GROUP_TASK }),
    owner: [OWNER, OWNER_B],
  },
  {
    name: 'raisedWorkPrompt',
    prompt: raisedWorkPrompt({
      task: GROUP_TASK,
      plan: '1. Шаг',
      report: 'Остановился: нужна миграция.',
    }),
    owner: [OWNER, OWNER_B],
  },
  {
    name: 'buildHandoffPrompt (group)',
    prompt: buildHandoffPrompt(HANDOFF, GROUP_TASK, { group: true }),
    owner: [OWNER, OWNER_B],
  },
  {
    name: 'buildHandoffPrompt',
    prompt: buildHandoffPrompt(HANDOFF, OWNER),
    owner: [OWNER],
  },
];

/** Обёртка панели без слов владельца: сужение ищется только в её строках. */
function panelPart(prompt: string, owner: readonly string[]): string {
  return owner.reduce((text, words) => text.split(words).join(' '), prompt);
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('планка заданий панели', () => {
  describe.each(BUILDERS)('$name', ({ prompt, owner }) => {
    it('слова владельца доходят целиком', () => {
      for (const words of owner) expect(prompt).toContain(words);
      expect(prompt).not.toContain('cut by the panel');
    });

    it('обёртка не сужает задание', () => {
      const panel = panelPart(prompt, owner);
      const hits = NARROWING_PHRASES.filter((phrase) => phrase.test(panel)).map(String);
      expect(hits).toEqual([]);
    });

    it('строка старшинства — ровно одна', () => {
      expect(count(prompt, OWNER_PRECEDENCE_LINE)).toBe(1);
    });

    it('строка навыков — не больше одной', () => {
      expect(count(prompt, SKILL_ROUTE_LINE)).toBeLessThanOrEqual(1);
    });

    it('ни одна длинная строка не повторена', () => {
      const lines = panelPart(prompt, owner)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length >= 60);
      const repeated = lines.filter((line, index) => lines.indexOf(line) !== index);
      expect(repeated).toEqual([]);
    });
  });

  it('задание группы называет навык по роду работы — над строкой старшинства (U12)', () => {
    expect(count(GROUP_TASK, SKILL_ROUTE_LINE)).toBe(1);
    expect(GROUP_TASK.indexOf(SKILL_ROUTE_LINE)).toBeLessThan(
      GROUP_TASK.indexOf(OWNER_PRECEDENCE_LINE),
    );
    for (const skill of [
      'deep-review',
      'resolving-merge-conflicts',
      'unit-integration-tests',
      'log-forensics',
    ]) {
      expect(SKILL_ROUTE_LINE).toContain(skill);
    }
  });

  it('системная инструкция разделения не сужает задание', () => {
    const hits = NARROWING_PHRASES.filter((phrase) => phrase.test(SPLIT_SYSTEM_PROMPT));
    expect(hits).toEqual([]);
  });

  it('разбор предложения разделения не режет задачу и общий контекст', () => {
    const parsed = parseSplitProposal({
      shared: OWNER_B,
      groups: [
        { title: 'Раз', tasks: [OWNER] },
        { title: 'Два', tasks: ['коротко'] },
      ],
    });
    expect(parsed?.shared).toBe(OWNER_B);
    expect(parsed?.groups[0]?.tasks[0]).toBe(OWNER);
  });
});

describe('обрезка с меткой', () => {
  it('в пределах потолка текст не трогается', () => {
    expect(labelledCut(OWNER, OWNER.length)).toBe(OWNER);
  });

  it('сверх потолка — метка с обоими числами, а не молчание', () => {
    const cut = labelledCut('абвгд', 3);
    expect(cut.startsWith('абв')).toBe(true);
    expect(cut).toContain('cut by the panel at 3 of 5 chars');
  });
});

describe('разрешение владельца на публикацию ревью', () => {
  it.each([
    'отпиши ревью в MR',
    'посмотри MR и опубликуй замечания',
    'запиши в мр что нашёл',
    'оставь комментарии по коду',
    'review it and publish the findings',
    'post the review when done',
    'post the findings in the merge request',
    'напиши замечания в MR',
    'оставь треды в MR',
    'post comments to MR',
    'leave comments on the MR',
    'Замечания отпиши в MR',
  ])('«%s» — разрешение', (text) => {
    expect(grantsReviewPublish(text)).toBe(true);
  });

  it.each([
    'не публикуй ничего, только посмотри',
    'без публикации, просто ревью',
    "don't publish anything",
    'never post the review',
    'посмотри MR и скажи, что думаешь',
    'отпиши мне итог в чат',
    'отпиши мне ревью сюда',
    'напиши тесты на расчёт',
    'напиши комментарии к функции',
    '',
  ])('«%s» — не разрешение', (text) => {
    expect(grantsReviewPublish(text)).toBe(false);
  });

  it.each([
    'Сделай ревью MR, но в MR ничего не публикуй — отпиши мне итог в чат',
    'отпиши ревью в MR. Хотя нет, в MR ничего не пиши',
    'publish nothing yet; post the review to me here',
    'не надо публиковать, просто оставь замечания',
  ])('запрет владельца сильнее разрешения в той же реплике: «%s»', (text) => {
    expect(grantsReviewPublish(text)).toBe(false);
  });

  it('разрешение где-то в тексте считается, даже если рядом есть отказ про другое', () => {
    expect(grantsReviewPublish('не трогай код. Отпиши ревью в MR.')).toBe(true);
    expect(grantsReviewPublish('не пиши тесты, отпиши ревью в MR')).toBe(true);
  });
});
