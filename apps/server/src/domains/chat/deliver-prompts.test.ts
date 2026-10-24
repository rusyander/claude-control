import { describe, it, expect } from 'vitest';
import { deliverStagePrompt, fixStagePrompt } from '@agentdeck/contracts/model-cascade';
import { deliveryPreamble } from '@agentdeck/contracts/task-split';
import { OWNER_PRECEDENCE_LINE } from '@agentdeck/contracts/quality-floor';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { asksDelivery, planCascadeStage } from './ChatCascadeStages/ChatCascadeStages.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';
import { CHILD_PROMPT } from './initiative/initiative.ts';
import {
  SplitConveyor,
  deliveryNudgePrompt,
  reportOnlyGaps,
  type SplitConveyorDeps,
} from './split-conveyor/split-conveyor.ts';

/**
 * Тексты доставки группы разделения (журнал 59d, 61b, 78): что звенья читают
 * про коммит, свежую основную ветку и право решать без человека.
 */

describe('правки группы с доставкой (журнал 59d)', () => {
  it('ограничение правок — про код: доставку оно не запрещает', () => {
    const prompt = fixStagePrompt(['поправь a.ts:1'], { branch: 'split/x', deliver: true });

    expect(prompt).not.toContain('Ничего сверх списка');
    expect(prompt).toContain('Do not rework code beyond the list');
    expect(prompt).toContain('commit, push and MR are not forbidden by it');
  });

  it('правки без доставки про доставку не говорят ничего (ревью по ссылке, Т7)', () => {
    const prompt = fixStagePrompt(['поправь a.ts:1'], { branch: 'split/x' });

    expect(prompt).not.toContain('MR');
  });

  it('правки без прохода проверки (ревью по ссылке, Т7) проверку не обещают', () => {
    expect(fixStagePrompt(['поправь a.ts:1'])).not.toContain('verification pass');
    expect(fixStagePrompt(['поправь a.ts:1'], { verify: true })).toContain(
      'the panel starts one verification pass',
    );
  });
});

describe('звено доставки (журнал 59a, 61b)', () => {
  const prompt = deliverStagePrompt({ branch: 'fix-PROJ-7', after: 'fix' });

  // Владелец 19.10 (MUST #1): основную догоняют только при конфликте с ней —
  // без него брокер откажет, и задание «догони» стоило бы хода и гейта заново.
  it('основная до пуша: fetch, проверка конфликта, rebase только при нём', () => {
    expect(prompt).toContain('git fetch origin');
    // Без `--quiet`: группа #0 23.10 получила код 0 при семи конфликтах.
    expect(prompt).toContain('git merge-tree --write-tree HEAD origin/<main>` (without `--quiet`');
    expect(prompt).not.toContain('--write-tree --quiet');
    expect(prompt).toContain('exit 1 or any CONFLICT line = a real conflict');
    expect(prompt).toContain('stay on the current base, never rebase');
    expect(prompt).not.toContain('pushed but behind the main branch');
    // Отправленную отставшую — тоже, но пуш только с арендой (W3-3); `--force` — никогда.
    expect(prompt).toContain('force-push without a lease (`--force`) is always forbidden');
  });

  it('конфликт с решением за человеком — вопрос инструментом, а не отчёт', () => {
    expect(prompt).toContain('AskUserQuestion');
  });

  it('группа без звена доставки (работа на потолке) тоже сверяет конфликт до пуша', () => {
    const preamble = deliveryPreamble({ branch: 'fix-PROJ-7' });

    expect(preamble).toContain('git fetch origin');
    expect(preamble).toContain('= a real conflict');
    expect(preamble).not.toContain('has fallen behind main');
  });

  // Владелец 18–20.10: полные проверки один раз на задачу, в доставке.
  it('полные проверки — один раз: преамбула велит узкие между правками', () => {
    const preamble = deliveryPreamble({ branch: 'fix-PROJ-7' });

    expect(preamble).toContain('run ONCE on the final tree right before the push');
    expect(prompt).toContain('ONCE on this final tree');
    // Ложное «прошлые звенья гнали только узкие» снято: звено доставки — единственный полный прогон.
    expect(prompt).not.toContain('the earlier stages ran only narrow ones');
    expect(prompt).toContain("it is the group's one full run");
  });

  // Владелец 23.10: один полный гейт на группу, в доставке. Замер 23.10 — звенья
  // работы гнали гейт 113 раз за день по заданию «проверки проекта, пуш, MR, ревью».
  it('работа перед звеном доставки: правка и коммит, узкие проверки, без гейта, пуша, MR и ревью', () => {
    const work = deliveryPreamble({
      branch: 'fix-PROJ-7',
      reviewPack: 'node "/p/tools/review-pack.mjs"',
      deliverLater: true,
    });

    expect(work).toContain('commits it on this branch');
    expect(work).toContain('no full project gate, no push, no MR and no review pass of your own');
    // Правило проекта «полные проверки перед “готово”» выполняет прогон доставки.
    expect(work).toContain('that run is what satisfies a project rule asking for full checks');
    expect(work).toContain('fix-PROJ-7');
    expect(work).toContain('ONE branch and ONE MR');
    expect(work).toContain('recommended option');
    for (const gone of [
      'review-pack.mjs',
      'merge-tree',
      'force-with-lease',
      'ONCE on the final tree right before the push',
      'The last line of your answer is the MR link',
    ])
      expect(work, gone).not.toContain(gone);
    expect(
      deliveryPreamble({ branch: 'b', mergeRequest: 'https://x/mr/1', deliverLater: true }),
    ).toContain('The MR already exists: https://x/mr/1; the delivery stage pushes to its branch.');
  });

  // F-125: ту же преамбулу читает звено плана под «EDIT NOTHING» — правку и
  // коммит строка поручает звену работы, а плану велит только учесть.
  it('преамбула работы не велит звену плана править и коммитить', () => {
    const work = deliveryPreamble({ branch: 'fix-PROJ-7', deliverLater: true });

    expect(work).not.toContain('Your stage is the work');
    expect(work).toContain('The work stage makes the change and commits it');
    expect(work).toContain('The plan stage only takes this section into account in the plan');
  });

  // Строка старшинства отдавала охват правилам проекта — и звено читало в ней
  // «гейт проекта перед “готово” — в каждом звене». Когда идёт полный гейт, решает панель.
  it('старшинство правил проекта не переносит полный гейт в каждое звено', () => {
    expect(OWNER_PRECEDENCE_LINE).toContain(
      "except WHEN the full project checks run: that is the panel's schedule (once per group, at delivery)",
    );
    expect(OWNER_PRECEDENCE_LINE).not.toContain('\n');
  });

  it('пуш своей ветки обычным push, MR и ссылка последней строкой', () => {
    expect(prompt).toContain('git push -u origin fix-PROJ-7');
    expect(prompt).toContain('The last line of the answer is the link to the MR');
  });
});

describe('группа решает сама (журнал 78, T24)', () => {
  it('правила ребёнка велят брать рекомендуемый вариант и называть его', () => {
    expect(CHILD_PROMPT).toContain('recommended option');
    expect(CHILD_PROMPT).toContain('irreversible');
  });

  it('доставка группы не останавливается на «неясно, чего хотят», если есть рекомендация', () => {
    const preamble = deliveryPreamble({ branch: 'fix-PROJ-7' });

    expect(preamble).toContain('recommended option');
    expect(preamble).not.toContain('unclear what is wanted) — a question to the human');
  });
});

describe('SplitConveyor.delivers', () => {
  function conveyorWith(record: SplitPlanRecord): SplitConveyor {
    return new SplitConveyor({
      store: {
        get: (parent: string) => (parent === record.parentChatId ? record : undefined),
        set: () => undefined,
        findByTriage: () => undefined,
        all: () => ({ [record.parentChatId]: record }),
      },
      log: () => undefined,
    } as unknown as SplitConveyorDeps);
  }

  const record = {
    parentChatId: 'родитель',
    projectPath: 'C:/repo',
    createdAt: '2026-09-24T00:00:00.000Z',
    order: [0, 1],
    request: {},
    proposal: { groups: [] },
    groups: [
      { index: 0, branch: 'fix-PROJ-7', status: 'started', deliver: true },
      { index: 1, branch: 'fix-PROJ-8', status: 'started' },
    ],
  } as unknown as SplitPlanRecord;

  it('группа с доставкой — да, без неё и без записи — нет', () => {
    const conveyor = conveyorWith(record);

    expect(conveyor.delivers({ parentChatId: 'родитель', createdAt: '', groupIndex: 0 })).toBe(
      true,
    );
    expect(conveyor.delivers({ parentChatId: 'родитель', createdAt: '', groupIndex: 1 })).toBe(
      false,
    );
    expect(
      conveyor.delivers({ parentChatId: 'родитель', createdAt: '', branch: 'fix-PROJ-7' }),
    ).toBe(true);
    expect(conveyor.delivers({ parentChatId: 'чужой', createdAt: '', groupIndex: 0 })).toBe(false);
  });
});

describe('доставка раз на круг (W3-3)', () => {
  it('просьба человека — повелительное «доставь», «доведи до MR», «повтори доставку»', () => {
    expect(asksDelivery('Доставь ещё раз: MR не обновился')).toBe(true);
    expect(asksDelivery('доведи до MR, пожалуйста')).toBe(true);
    expect(asksDelivery('Повтори доставку')).toBe(true);
    expect(asksDelivery('please deliver again')).toBe(true);
  });

  it('задания панели и рассказ про MR повтором не считаются', () => {
    expect(asksDelivery(deliveryNudgePrompt('fix-PROJ-7', ['нет MR']))).toBe(false);
    expect(asksDelivery(fixStagePrompt(['a.ts:1'], { deliver: true }))).toBe(false);
    expect(asksDelivery(deliverStagePrompt({ branch: 'fix-PROJ-7', after: 'fix' }))).toBe(false);
    expect(asksDelivery('А тесты точно прошли? MR уже открыт?')).toBe(false);
    expect(asksDelivery('доставка сломалась?')).toBe(false);
  });

  it('чистое ревью, после которого доставка уже заведена, второй не заводит', () => {
    const verdict = ['```agentdeck:review', '{"findings":[]}', '```'].join('\n');
    const link = {
      parentChatId: 'родитель',
      createdAt: '2026-09-25T10:00:00.000Z',
      stage: 'review',
      model: 'claude-opus-5',
      workModel: 'sonnet',
      deliveredAt: '2026-09-25T11:00:00.000Z',
    };
    const input = { link, ok: true, text: verdict, task: '', hasWork: () => true, deliver: true };

    expect(planCascadeStage(input)).toBeUndefined();
    expect(planCascadeStage({ ...input, redeliver: true })?.stage).toBe('deliver');
  });
});

/**
 * L7.3 плана экономии групп (19.10 01:46): доставленной группе не хватало
 * только блока отчёта и записи прогона, а напоминание велело «commit, push,
 * update the MR» — группа сделала fetch, rebase, три гейта заново и
 * переотправила ветку MR, стоявшего на ревью.
 */
describe('напоминание о доставке, когда не хватает только отчёта', () => {
  const unreported = serverText('sieve-gap-unreported', {
    sieve: 'project-checks',
    lang: 'agentdeck-sieves',
  });
  const owner = serverText('delivery-gap-owner-unreported', { lang: 'agentdeck-sieves' });
  const tests = serverText('tests-gap-word-only', {
    cases: 'auth-001',
    command: 'node tests-cli.mjs run --project . --case auth:auth-001',
  });

  it('только отчёт и прогон — без git: не коммитить, не отправлять, MR не трогать', () => {
    const prompt = deliveryNudgePrompt('fix-PROJ-7', [unreported, owner, tests]);
    expect(reportOnlyGaps([unreported, owner, tests])).toBe(true);
    expect(prompt).toContain('Do not commit, push, rebase or touch the MR');
    expect(prompt).not.toContain('commit the work');
    expect(prompt).toContain('--case auth:auth-001');
  });

  it('есть пробел git или чужая строка — прежнее напоминание о доставке целиком', () => {
    const dirty = serverText('delivery-gap-dirty', { files: 'a.ts' });
    expect(deliveryNudgePrompt('b', [unreported, dirty])).toContain(
      'commit the work, push the branch b',
    );
    expect(reportOnlyGaps([unreported, 'нет MR'])).toBe(false);
    expect(reportOnlyGaps([serverText('tests-gap-failed', { cases: 'auth-001' })])).toBe(false);
    expect(reportOnlyGaps([])).toBe(false);
  });
});
