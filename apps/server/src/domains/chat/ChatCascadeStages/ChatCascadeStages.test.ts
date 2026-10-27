import { existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { planCascadeStage, stageAppendPrompt, stagesAhead } from './ChatCascadeStages.ts';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';

/**
 * Конвейер «работа → ревью → фикс»: что заводится после прогона и что НЕ
 * заводится. Второе тут важнее первого — цепочка, которая не умеет
 * останавливаться, тратит окно запросов сама на себя, а замечает это человек уже
 * по счётчику.
 */

/** Связь понижённого ребёнка разделения — то, что пишет `split-routes`. */
function workLink(patch: Partial<ChatLink> = {}): ChatLink {
  return {
    parentChatId: 'parent',
    createdAt: '2026-09-07T10:00:00.000Z',
    title: 'Переименования',
    branch: 'split/rename',
    model: 'sonnet',
    effort: 'medium',
    kind: 'mechanical',
    lowered: true,
    stage: 'work',
    ceilingModel: 'claude-opus-5',
    ceilingEffort: 'high',
    ...patch,
  };
}

const REVIEW_BLOCK = (body: string): string =>
  ['Проверил дифф.', '```agentdeck:review', body, '```'].join('\n');

function plan(input: Partial<Parameters<typeof planCascadeStage>[0]> = {}) {
  return planCascadeStage({
    link: workLink(),
    ok: true,
    text: '',
    task: 'Переименуй foo в bar по всем файлам',
    hasWork: () => true,
    now: () => new Date('2026-09-07T12:00:00.000Z'),
    ...input,
  });
}

describe('planCascadeStage: после работы', () => {
  it('понижённая работа получает ревью на потолке', () => {
    const staged = plan();

    expect(staged?.stage).toBe('review');
    expect(staged?.model).toBe('claude-opus-5');
    expect(staged?.effort).toBe('high');
    expect(staged?.prompt).toContain('Переименуй foo в bar');
    // Модель работы едет в связь ревью: по ней вернутся правки.
    expect(staged?.link.workModel).toBe('sonnet');
    expect(staged?.link.workEffort).toBe('medium');
    // Ветвь дерева та же: три разговора одной группы висят под одним родителем.
    expect(staged?.link.parentChatId).toBe('parent');
    expect(staged?.link.branch).toBe('split/rename');
  });

  // 5.3 плана экономии + владелец 23.10: пакет ревью едет ревьюерам звена ревью
  // доставляющей группы — настоящий скрипт панели по абсолютному пути.
  it('ревью доставляющей группы несёт пакет ревью; обычный каскад — нет', () => {
    const staged = plan({ deliver: true });
    const command = /`node "([^"]+review-pack\.mjs)" --plan /.exec(staged?.prompt ?? '');

    expect(staged?.stage).toBe('review');
    expect(command?.[1] && existsSync(command[1])).toBe(true);
    expect(staged?.prompt).toContain('instead of running git diff or git show');
    // g8 26.10 (P2): deep-review уже пишет свой pack.diff, а строка велела собрать ещё и
    // review-pack.md (241 тыс. знаков того же диффа) — полосы 6 вызовами читали его шапку.
    // Пакет панели теперь — только запасной путь ревью без навыка.
    expect(staged?.prompt).toContain('only for a review WITHOUT the deep-review skill');
    expect(staged?.prompt).toContain('hand its lanes no second copy of the diff');
    expect(staged?.prompt).not.toMatch(/before spawning them, build the review package/);
    expect(plan()?.prompt).not.toContain('review-pack.mjs');
    // Полный гейт ревью не гонит: он один, в доставке.
    expect(staged?.prompt).toContain('the full project checks belong to a later stage');
  });

  it('работа на потолке тоже получает ревью (U6): свежая сессия на той же модели', () => {
    const staged = plan({ link: workLink({ lowered: false }) });

    expect(staged?.stage).toBe('review');
    expect(staged?.model).toBe('claude-opus-5');
    expect(staged?.link.ceilingModel).toBe('claude-opus-5');
  });

  it('работа на потолке без записанного потолка читается своей же моделью', () => {
    const ceiling = workLink({ lowered: false, model: 'claude-opus-5', effort: 'xhigh' });
    delete ceiling.ceilingModel;
    delete ceiling.ceilingEffort;
    const staged = plan({ link: ceiling });

    expect(staged?.stage).toBe('review');
    expect(staged?.model).toBe('claude-opus-5');
    expect(staged?.effort).toBe('xhigh');
    // Записан потолком связи ревью: им же пойдёт проход проверки правок.
    expect(staged?.link).toMatchObject({ ceilingModel: 'claude-opus-5', ceilingEffort: 'xhigh' });
  });

  /**
   * Отметка одноразовая. Без неё второе сообщение человека в тот же чат заводило
   * бы ещё одну проверку — и так на каждый ход.
   */
  it('второе ревью той же работе не заводится', () => {
    expect(plan({ link: workLink({ reviewedAt: '2026-09-07T11:00:00.000Z' }) })).toBeUndefined();
  });

  it('пустой дифф работы на потолке проверять незачем', () => {
    expect(plan({ link: workLink({ lowered: false }), hasWork: () => false })).toBeUndefined();
  });

  /**
   * Понижённой работе обещано: упрёшься — остановись, работа продолжится на
   * модели сильнее (F4, 12.10.2026). Продолжения не было: пустой дифф кончал
   * цепочку «готово». Понижаются только механика, реализация и тесты — их итог
   * всегда дифф, и ход без единой правки и есть остановка.
   */
  it('понижённая работа без единой правки поднимается на потолок — один раз (F4)', () => {
    const staged = plan({
      link: workLink({ groupTask: 'Переименуй foo в bar по всем файлам' }),
      hasWork: () => false,
      text: 'Нужна миграция БД — это не механика, останавливаюсь.',
    });

    expect(staged?.stage).toBe('work');
    expect(staged?.model).toBe('claude-opus-5');
    expect(staged?.effort).toBe('high');
    expect(staged?.prompt).toContain('Переименуй foo в bar по всем файлам');
    expect(staged?.prompt).toContain('Нужна миграция БД');
    // Поднятая работа идёт на потолке: «ниже» и планка сдачи к ней не относятся.
    expect(staged?.link.lowered).toBeUndefined();
    expect(staged?.link.model).toBe('claude-opus-5');
    expect(staged?.link.stage).toBe('work');

    // Отметка «заведено» держит подъём одноразовым.
    expect(
      plan({ link: workLink({ plannedAt: '2026-09-07T11:00:00.000Z' }), hasWork: () => false }),
    ).toBeUndefined();
  });

  it('прогон кончился ошибкой — проверять нечего', () => {
    expect(plan({ ok: false })).toBeUndefined();
  });

  /**
   * Связь старше конвейера: потолка в ней нет, и завести проверку «на чём
   * придётся» нельзя — проверка слабее работы это не проверка.
   */
  it('без записанного потолка ревью не заводится', () => {
    const older = workLink();
    delete older.ceilingModel;

    expect(plan({ link: older })).toBeUndefined();
  });

  // U6: работа на потолке группы с доставкой идёт в ревью, доставку заводит его круг.
  it('работа на потолке группы с доставкой идёт в ревью, а не мимо него', () => {
    const staged = plan({ link: workLink({ lowered: false }), deliver: true });

    expect(staged?.stage).toBe('review');
    expect(staged?.link).toMatchObject({ stage: 'review', parentChatId: 'parent' });
  });

  it('связь без потолка у группы с доставкой тоже идёт в доставку', () => {
    const older = workLink();
    delete older.ceilingModel;
    const staged = plan({ link: older, deliver: true });

    expect(staged?.stage).toBe('deliver');
    expect(staged?.model).toBe('sonnet');
    expect(staged?.prompt).toContain('it has no separate review');
  });

  it('пустую работу, паузу и второй круг без просьбы не доставляем; ревью — само доведёт', () => {
    const ceiling = workLink();
    delete ceiling.ceilingModel;
    expect(plan({ link: ceiling, deliver: true, hasWork: () => false })).toBeUndefined();
    expect(plan({ link: ceiling, deliver: true, paused: true })).toBeUndefined();
    const delivered = { ...ceiling, deliveredAt: '2026-09-07T11:00:00.000Z' };
    expect(plan({ link: delivered, deliver: true })).toBeUndefined();
    expect(plan({ link: delivered, deliver: true, redeliver: true })?.stage).toBe('deliver');
    // Ревью уже заведено на эту работу — доставку заводит его круг, не работа.
    const reviewed = workLink({ reviewedAt: '2026-09-07T11:00:00.000Z' });
    expect(plan({ link: reviewed, deliver: true })).toBeUndefined();
    // Понижённая работа по-прежнему идёт в ревью, а не мимо него.
    expect(plan({ deliver: true })?.stage).toBe('review');
  });

  // L7.13: дельту против опубликованной ветки считает `readReviewDelta` (там же
  // путь инцидента на настоящем git); здесь — что планировщик с ней делает.
  it('пустой rebase: ревью нет, незапушенную голову отправит доставка', () => {
    const ceiling = workLink({ lowered: false });
    const none = (published: boolean) => () =>
      ({ kind: 'none', from: 'abc123', published }) as const;
    expect(plan({ link: ceiling, deliver: true, reviewDelta: none(true) })).toBeUndefined();
    expect(plan({ link: ceiling, deliver: true, reviewDelta: none(false) })?.stage).toBe('deliver');
    expect(plan({ link: ceiling, reviewDelta: none(false) })).toBeUndefined();
    // Всю работу — как раньше, без рамки дельты.
    const whole = plan({ link: ceiling, reviewDelta: () => ({ kind: 'whole' }) });
    expect(whole?.stage).toBe('review');
    expect(whole?.prompt).not.toContain('Review ONLY');
  });

  it('обычный чат вне разделения конвейера не знает', () => {
    expect(planCascadeStage({ ok: true, text: '', task: '', hasWork: () => true })).toBeUndefined();
  });
});

describe('planCascadeStage: после ревью', () => {
  const reviewLink = (patch: Partial<ChatLink> = {}): ChatLink =>
    workLink({
      stage: 'review',
      model: 'claude-opus-5',
      effort: 'high',
      lowered: false,
      workModel: 'sonnet',
      workEffort: 'medium',
      ...patch,
    });

  it('замечания заводят правки на модели работы', () => {
    const staged = plan({
      link: reviewLink(),
      text: REVIEW_BLOCK('{"findings":["ChatSplit.ts:88 — потеряна ошибка"]}'),
    });

    expect(staged?.stage).toBe('fix');
    expect(staged?.model).toBe('sonnet');
    expect(staged?.effort).toBe('medium');
    expect(staged?.findings).toEqual(['ChatSplit.ts:88 — потеряна ошибка']);
    expect(staged?.prompt).toContain('1. ChatSplit.ts:88 — потеряна ошибка');
  });

  // Сосед RF-BGCD-06: доставка круга уже заведена и человек не просил снова —
  // второй не будет, обещание «полный прогон сделает доставка» врало бы.
  // RC-D-01: связь правок — новое звено без `deliveredAt` (F-110), и за ними
  // доставка приходит и после доставки круга. Обещание в задании правок должно
  // совпадать с тем, что конвейер заведёт: проверка → доставка.
  it('правки после доставки круга обещают доставку — она за ними и придёт', () => {
    const text = REVIEW_BLOCK('{"findings":["ChatSplit.ts:88 — потеряна ошибка"]}');
    const deliveredAt = '2026-09-07T11:00:00.000Z';
    const ahead = plan({ link: reviewLink(), text, deliver: true });
    expect(ahead?.prompt).toContain('in the delivery stage after your turn');
    expect(ahead?.prompt).toContain('a rule asking for them is met by that run');

    const done = plan({ link: reviewLink({ deliveredAt }), text, deliver: true });
    expect(done?.stage).toBe('fix');
    expect(done?.link.deliveredAt).toBeUndefined();
    expect(done?.prompt).toContain('in the delivery stage after your turn');
    expect(done?.prompt).toContain('a rule asking for them is met by that run');

    // Что придёт за этими правками на самом деле.
    const verify = plan({ link: done!.link, text: 'Исправил.', deliver: true });
    expect(verify?.stage).toBe('review');
    const after = plan({
      link: verify!.link,
      text: REVIEW_BLOCK('{"findings":[]}'),
      deliver: true,
    });
    expect(after?.stage).toBe('deliver');
  });

  it('пустой список закрывает цепочку', () => {
    expect(plan({ link: reviewLink(), text: REVIEW_BLOCK('{"findings":[]}') })).toBeUndefined();
  });

  /**
   * Ревьюер не отчитался в понятном виде. Заводить по такому ответу правки
   * нельзя: списка замечаний нет, и заданием станет пустота.
   */
  it('без блока вердикта правки не заводятся', () => {
    expect(plan({ link: reviewLink(), text: 'Всё хорошо, замечаний нет.' })).toBeUndefined();
  });

  it('правки — конец цепочки: второго круга ревью не бывает', () => {
    const staged = plan({
      link: reviewLink({ stage: 'fix' }),
      text: REVIEW_BLOCK('{"findings":["ещё одно"]}'),
    });

    expect(staged).toBeUndefined();
  });

  /**
   * Ревью чужого MR по ссылке (Т7) — не звено этого конвейера. Заведи он правки
   * сам, панель молча начала бы править чужую ветку по замечаниям, которых
   * человек ещё не видел. Решение там принимается кнопкой (`split-review.ts`).
   */
  it('ревью чужого MR по ссылке правок не заводит: там решает человек', () => {
    const staged = plan({
      link: reviewLink({ review: { url: 'https://gitlab.com/team/app/-/merge_requests/42' } }),
      text: REVIEW_BLOCK('{"findings":["src/a.ts:10 — забыт await"]}'),
    });

    expect(staged).toBeUndefined();
  });
});

/**
 * Проход проверки правок (U6, deep-review §7): один на круг, повтор
 * доказательства каждого замечания; его итог правок не заводит — открытое едет
 * в доставку и в MR.
 */
describe('planCascadeStage: проверка правок (U6)', () => {
  const FINDINGS = ['a.ts:3 — off by one', 'b.ts:9 — забыт await'];
  const fixLink = (patch: Partial<ChatLink> = {}): ChatLink =>
    workLink({
      stage: 'fix',
      workModel: 'sonnet',
      workEffort: 'medium',
      fixFindings: FINDINGS,
      ...patch,
    });

  it('правки несут замечания в связь — по ним пойдёт проверка', () => {
    const fix = plan({
      link: workLink({ stage: 'review', model: 'claude-opus-5', workModel: 'sonnet' }),
      text: REVIEW_BLOCK(JSON.stringify({ findings: FINDINGS })),
    });

    expect(fix?.stage).toBe('fix');
    expect(fix?.link.fixFindings).toEqual(FINDINGS);
    expect(fix?.link.ceilingModel).toBe('claude-opus-5');
  });

  it('конец правок заводит ОДИН проход проверки на ревьюере, а не доставку', () => {
    const verify = plan({ link: fixLink(), text: 'Поправил оба.', deliver: true });

    expect(verify?.stage).toBe('review');
    expect(verify?.model).toBe('claude-opus-5');
    expect(verify?.effort).toBe('high');
    expect(verify?.prompt).toContain('VERIFYING those fixes');
    expect(verify?.prompt).toContain('Attempted is not fixed');
    expect(verify?.prompt).toContain('1. a.ts:3 — off by one');
    expect(verify?.prompt).toContain('2. b.ts:9 — забыт await');
    expect(verify?.prompt).toContain('Поправил оба.');
    expect(verify?.link).toMatchObject({
      stage: 'review',
      fixFindings: FINDINGS,
      workModel: 'sonnet',
      parentChatId: 'parent',
    });
  });

  it('проверка уже заведена — второй не будет, и доставку правки не заводят', () => {
    const reviewed = fixLink({ reviewedAt: '2026-09-07T11:00:00.000Z' });

    expect(plan({ link: reviewed, deliver: true })).toBeUndefined();
  });

  it('ход правок с вопросом — ни проверки, ни доставки', () => {
    expect(plan({ link: fixLink(), deliver: true, paused: true })).toBeUndefined();
  });

  it('связь правок до U6 (без замечаний) — в доставку, как раньше', () => {
    const legacy = fixLink();
    delete legacy.fixFindings;

    expect(plan({ link: legacy, deliver: true })?.stage).toBe('deliver');
  });

  it('замечания без записанного ревьюера — проверять некем: сразу в доставку', () => {
    const orphan = fixLink();
    delete orphan.ceilingModel;
    delete orphan.ceilingEffort;

    expect(plan({ link: orphan, deliver: true })?.stage).toBe('deliver');
  });

  const verifyLink = (): ChatLink =>
    workLink({
      stage: 'review',
      model: 'claude-opus-5',
      lowered: false,
      workModel: 'sonnet',
      fixFindings: FINDINGS,
    });

  it('открытое после проверки едет в доставку как открытое, правок не заводит', () => {
    const staged = plan({
      link: verifyLink(),
      text: REVIEW_BLOCK('{"findings":["b.ts:9 — await всё ещё забыт"]}'),
      deliver: true,
    });

    expect(staged?.stage).toBe('deliver');
    expect(staged?.model).toBe('sonnet');
    expect(staged?.prompt).toContain('verification pass re-checked them');
    expect(staged?.prompt).toContain('1. b.ts:9 — await всё ещё забыт');
    // g5 25.10 (P3): заголовок открытого — на языке MR, не английской строкой в русском MR.
    expect(staged?.prompt).toContain('under a heading in the language of the MR');
    expect(staged?.prompt).toContain('a Russian MR gets a Russian heading, never an English one');
    expect(staged?.prompt).not.toContain('Open after verification');
    // g5 25.10 (P4): мелочь в файлах группы чинится до единственного прогона проверок.
    expect(staged?.prompt).not.toContain('Do not fix them in this stage');
    expect(staged?.prompt).toContain(
      'Before the checks of step 6 (so its one full run covers them), fix the ones that lie in ' +
        'the files of this group and are a comment, a literal or a one-line change',
    );
  });

  // g5 25.10 (P5): MR открыт без проверки доставки — пробелы пришли после «готово».
  it('доставка гоняет проверку доставки панели по черновику ДО создания MR', () => {
    const staged = plan({
      link: verifyLink(),
      text: REVIEW_BLOCK('{"findings":[]}'),
      deliver: true,
    });
    const prompt = staged?.prompt ?? '';
    const check = prompt.indexOf(' delivery --project . --answer <sieves file> --mr-description');
    expect(check).toBeGreaterThan(0);
    expect(prompt).toMatch(/node "[^"]*[\\/]tools[\\/]tests-cli\.mjs" delivery --project \./);
    expect(check).toBeLessThan(prompt.indexOf('Open the MR by the delivery skill'));
    expect(prompt).toContain('Before you create or update the MR');
  });

  it('всё подтверждено — доставка без раздела открытого', () => {
    const staged = plan({
      link: verifyLink(),
      text: REVIEW_BLOCK('{"findings":[]}'),
      deliver: true,
    });

    expect(staged?.stage).toBe('deliver');
    expect(staged?.prompt).toContain('verification pass re-checked them');
    expect(staged?.prompt).not.toContain('stay open after verification');
    expect(staged?.prompt).not.toContain('NOT verified');
  });

  it('проверка без блока итога — доставка говорит в MR, что правки не проверены', () => {
    const staged = plan({ link: verifyLink(), text: 'Вроде всё ок.', deliver: true });

    expect(staged?.stage).toBe('deliver');
    expect(staged?.prompt).toContain('the review fixes were NOT verified');
  });

  it('без доставки проверка кончает цепочку: второго круга правок нет', () => {
    expect(
      plan({ link: verifyLink(), text: REVIEW_BLOCK('{"findings":["ещё открыто"]}') }),
    ).toBeUndefined();
  });

  it('правкам обещана проверка, а не «тебя никто не проверит»', () => {
    const settings = { taskSplitInitiative: true, handoffInitiative: true };
    const fix = plan({
      link: workLink({ stage: 'review', model: 'claude-opus-5', workModel: 'sonnet' }),
      text: REVIEW_BLOCK(JSON.stringify({ findings: FINDINGS })),
    });
    const append = fix ? stageAppendPrompt(fix, settings) : '';

    expect(append).toContain('one verification pass over your fixes');
    expect(append).not.toContain('nobody checks it but you');
    expect(fix?.prompt).toContain('the panel starts one verification pass');
  });

  // Аудит g9 27.10 (R7): перепроверка искала свои R-1..R-3 по старому транскрипту.
  it('находки уходят файлом: правки — R-n, открытое после проверки — V-n, путь в задании', () => {
    const FILE = '.agent/run/review-findings.agent.md';
    const calls: [string, readonly string[]][] = [];
    const findingsFile = (kind: 'fix' | 'open', findings: readonly string[]) => {
      calls.push([kind, findings]);
      return FILE;
    };
    const fix = plan({
      link: workLink({ stage: 'review', model: 'claude-opus-5', workModel: 'sonnet' }),
      text: REVIEW_BLOCK(JSON.stringify({ findings: FINDINGS })),
      findingsFile,
    });
    expect(calls).toEqual([['fix', FINDINGS]]);
    expect(fix?.prompt).toContain(
      `The panel keeps this list in ${FILE} as R-1…R-2, in the same order: cite a point by ` +
        'that id in notes, answers and the MR description',
    );
    expect(fix?.prompt.indexOf(FILE)).toBeGreaterThan(fix?.prompt.indexOf('2. b.ts:9') ?? 0);

    const open = plan({
      link: fixLink({ stage: 'review', model: 'claude-opus-5' }),
      text: REVIEW_BLOCK('{"findings":["b.ts:9 — await всё ещё забыт"]}'),
      deliver: true,
      findingsFile,
    });
    expect(open?.stage).toBe('deliver');
    expect(calls[1]).toEqual(['open', ['b.ts:9 — await всё ещё забыт']]);
    expect(open?.prompt).toContain(
      `The panel keeps this list in ${FILE} as V-1, in the same order`,
    );

    // Всё подтверждено — открытого нет, файл не трогается.
    plan({
      link: fixLink({ stage: 'review', model: 'claude-opus-5' }),
      text: REVIEW_BLOCK('{"findings":[]}'),
      deliver: true,
      findingsFile,
    });
    expect(calls).toHaveLength(2);

    // Файл не записан — задание о нём молчит.
    const silent = plan({
      link: workLink({ stage: 'review', model: 'claude-opus-5', workModel: 'sonnet' }),
      text: REVIEW_BLOCK(JSON.stringify({ findings: FINDINGS })),
      findingsFile: () => undefined,
    });
    expect(silent?.prompt).not.toContain('The panel keeps this list');
  });
});

describe('stageAppendPrompt', () => {
  const settings = { taskSplitInitiative: true, handoffInitiative: true };

  /**
   * Копировать дописку закончившегося прогона нельзя: у работы в ней лежит
   * планка сдачи «тебя ведёт модель ниже потолка», и в ревью эта строка сказала
   * бы проверяющему ровно обратное тому, зачем его завели.
   */
  it('ревью не получает планку сдачи, правки получают', () => {
    const review = plan();
    const fix = plan({
      link: workLink({ stage: 'review', workModel: 'sonnet', workEffort: 'medium' }),
      text: REVIEW_BLOCK('{"findings":["поправь"]}'),
    });

    expect(review && stageAppendPrompt(review, settings)).not.toContain('BELOW the ceiling');
    expect(fix && stageAppendPrompt(fix, settings)).toContain('BELOW the ceiling');
  });

  /**
   * TQ-10 (12.10.2026): задание правок само определяет проверки проекта, и
   * планка сдачи того же прогона повторяла определение слово в слово.
   */
  it('правки: определение проверок проекта в прогоне один раз, планка ссылается на задание', () => {
    const fix = plan({
      link: workLink({ stage: 'review', workModel: 'sonnet', workEffort: 'medium' }),
      text: REVIEW_BLOCK('{"findings":["поправь"]}'),
    });
    const run = `${fix ? stageAppendPrompt(fix, settings) : ''}\n${fix?.prompt ?? ''}`;

    expect(run.split('run the project checks its rules name').length - 1).toBe(1);
    expect(run).toContain('run the checks your task names, at the scope and moment it names');
  });

  it('делить звено дальше не предлагается: чат уже выделен под одну группу', () => {
    const review = plan();

    expect(review && stageAppendPrompt(review, settings)).not.toContain('agentdeck:split');
  });
});

/**
 * Уровни разделения (Т1): после плана заводится работа — единственное звено,
 * которое стартует и после неудачи; разбор звеньев не заводит вовсе.
 */
describe('planCascadeStage: после плана и разбора', () => {
  const PLAN_BLOCK = (body: string): string =>
    ['Изучил.', '```agentdeck:plan', body, '```'].join('\n');

  const planLink = (patch: Partial<ChatLink> = {}): ChatLink =>
    workLink({
      stage: 'plan',
      model: 'claude-opus-5',
      effort: 'high',
      workModel: 'sonnet',
      workEffort: 'medium',
      lowered: true,
      task: 'Переименуй foo в bar',
      owns: ['src/rename'],
      notes: 'api.ts — у соседей',
      ...patch,
    });

  // Владелец 12.10.2026: ревью, правки и доставка сверяют работу с планом и
  // заданием — огрызок в 4k без критериев приёмки сверять не с чем.
  it('длинный план и задание доходят до следующих звеньев целиком', () => {
    const longPlan = `${'1. Шаг с проверкой после него.\n'.repeat(400)}## Критерии приёмки\n- всё зелёное`;
    const longTask = `${'Переименуй foo в bar везде. '.repeat(1_000)}ХВОСТ ЗАДАНИЯ`;
    const staged = plan({ link: planLink({ task: longTask }), text: PLAN_BLOCK(longPlan) });

    expect(staged?.link.planSummary).toBe(longPlan);
    expect(staged?.link.task).toBe(longTask);
    expect(staged?.prompt).toContain('## Критерии приёмки');
    expect(staged?.prompt).toContain('ХВОСТ ЗАДАНИЯ');
  });

  it('план кончился — работа на подобранной модели с планом, границами и заметками', () => {
    const staged = plan({ link: planLink(), text: PLAN_BLOCK('## Шаги\n1. Найти foo') });

    expect(staged?.stage).toBe('work');
    expect(staged?.model).toBe('sonnet');
    expect(staged?.effort).toBe('medium');
    expect(staged?.planMissing).toBeUndefined();
    expect(staged?.prompt).toContain('Переименуй foo в bar');
    expect(staged?.prompt).toContain('1. Найти foo');
    expect(staged?.prompt).toContain('src/rename');
    expect(staged?.prompt).toContain('api.ts — у соседей');
    // Связь работы: понижена, с потолком и задачей — ревью после неё идёт как обычно.
    expect(staged?.link).toMatchObject({
      stage: 'work',
      model: 'sonnet',
      effort: 'medium',
      lowered: true,
      ceilingModel: 'claude-opus-5',
      owns: ['src/rename'],
    });
  });

  it('план без блока или упавший — работа всё равно стартует, с пометкой planMissing', () => {
    const noBlock = plan({ link: planLink(), text: 'Ничего не понял.' });
    const failed = plan({ link: planLink(), ok: false, text: '' });

    expect(noBlock?.stage).toBe('work');
    expect(noBlock?.planMissing).toBe(true);
    expect(noBlock?.prompt).toContain('The panel did not receive');
    expect(failed?.stage).toBe('work');
    expect(failed?.planMissing).toBe(true);
  });

  it('план на потолке — работа не понижена и планки сдачи не получает', () => {
    const staged = plan({
      link: planLink({ workModel: 'claude-opus-5', workEffort: 'high', lowered: false }),
      text: PLAN_BLOCK('план'),
    });

    expect(staged?.link.lowered).toBeUndefined();
    expect(
      staged && stageAppendPrompt(staged, { taskSplitInitiative: true, handoffInitiative: true }),
    ).not.toContain('BELOW the ceiling');
  });

  it('понижённая работа после плана получает планку сдачи', () => {
    const staged = plan({ link: planLink(), text: PLAN_BLOCK('план') });

    expect(
      staged && stageAppendPrompt(staged, { taskSplitInitiative: true, handoffInitiative: true }),
    ).toContain('BELOW the ceiling');
  });

  it('план отработан один раз: с отметкой plannedAt вторая работа не заводится', () => {
    expect(
      plan({ link: planLink({ plannedAt: '2026-09-09T10:00:00.000Z' }), text: PLAN_BLOCK('п') }),
    ).toBeUndefined();
  });

  it('разбор (уровень 1) звеньев не заводит: его итог применяет конвейер', () => {
    expect(plan({ link: workLink({ stage: 'triage' }), text: 'что угодно' })).toBeUndefined();
  });
});

/**
 * Аудит 25.09, L238: чат группы перенаправляется на звено, и ревью, правки и
 * доставка начинали с нуля — без задания, плана и итога прошлого звена.
 */
describe('planCascadeStage: контекст следующего звена', () => {
  const PLAN = '## Шаги\n1. Найти foo\n2. Заменить на bar';

  it('план кладёт выжимку в связь работы, и она едет до ревью', () => {
    const afterPlan = plan({
      link: workLink({ stage: 'plan', lowered: true, workModel: 'sonnet', task: 'Переименуй foo' }),
      text: ['```agentdeck:plan', PLAN, '```'].join('\n'),
    });
    expect(afterPlan?.link.planSummary).toContain('1. Найти foo');

    const review = plan({
      link: afterPlan!.link,
      text: 'Сделал: переименовал в 12 файлах.',
    });
    expect(review?.stage).toBe('review');
    expect(review?.prompt).toContain('1. Найти foo');
    expect(review?.prompt).toContain('переименовал в 12 файлах');
    expect(review?.link).toMatchObject({
      task: 'Переименуй foo',
      planSummary: afterPlan!.link.planSummary,
    });
  });

  it('правки получают задание, план, ветку и замечания — без хвоста ответа ревью (L2.2)', () => {
    const staged = plan({
      link: workLink({
        stage: 'review',
        model: 'claude-opus-5',
        lowered: false,
        workModel: 'sonnet',
        task: 'Переименуй foo в bar',
        planSummary: PLAN,
      }),
      text: [
        'Ревьюер: переименование неполное.',
        '```agentdeck:review',
        '{"findings":["b.ts:3 — остался foo"]}',
        '```',
      ].join('\n'),
      deliver: true,
    });
    expect(staged?.stage).toBe('fix');
    expect(staged?.prompt).toContain('Group task:');
    expect(staged?.prompt).toContain('Переименуй foo в bar');
    expect(staged?.prompt).toContain('2. Заменить на bar');
    expect(staged?.prompt).toContain('Group branch: split/rename.');
    // Замечание — карточкой в задании; слова ревьюера вокруг блока не едут.
    expect(staged?.prompt).toContain('1. b.ts:3 — остался foo');
    expect(staged?.prompt).not.toContain('Outcome of the previous stage');
    expect(staged?.prompt).not.toContain('переименование неполное');
    expect(staged?.link).toMatchObject({ task: 'Переименуй foo в bar', planSummary: PLAN });
    // Аудит 25.09, L258: не воспроизвелось — не повод тянуть инфраструктуру.
    expect(staged?.prompt).toContain('is no reason to change infrastructure');
  });

  it('доставка после правок знает задание и итог правок и перечитывает обсуждения MR', () => {
    const staged = plan({
      link: workLink({ stage: 'fix', task: 'Переименуй foo в bar', planSummary: PLAN }),
      text: 'Поправил b.ts, тесты зелёные.',
      deliver: true,
    });
    expect(staged?.stage).toBe('deliver');
    expect(staged?.prompt).toContain('Переименуй foo в bar');
    expect(staged?.prompt).toContain('Outcome of the previous stage (fixes):');
    expect(staged?.prompt).toContain('Поправил b.ts');
    // Аудит 25.09, L199: «готово» по MR — только после всех его обсуждений.
    expect(staged?.prompt).toContain('re-read ALL unresolved discussions of the MR');
    // Аудит 25.09, L163: дифф сверяется с заданием, шаг за его границу — вопросом.
    expect(staged?.prompt).toContain('Compare the diff of the branch against main');
    expect(staged?.prompt).toContain('a step beyond the tasks of the group');
    // Контекст есть — «контекста у тебя нет» задание не говорит.
    expect(staged?.prompt).not.toContain('you have no context of the previous stages');
  });
});

describe('planCascadeStage: сита перед MR', () => {
  const SIEVES = (body: string): string => ['```agentdeck:sieves', body, '```'].join('\n');
  const calls: { stage: string; done: string[] }[] = [];
  const sieves = (stage: 'review' | 'deliver', done: readonly { id: string }[]): string => {
    calls.push({ stage, done: done.map((row) => row.id) });
    return `SIEVES-${stage.toUpperCase()}`;
  };

  it('ревью получает абзац своих сит, строки работы едут в связь ревью', () => {
    calls.length = 0;
    const staged = plan({
      text: `Сделал.\n${SIEVES('{"sieves":[{"id":"merge-tree","status":"pass","evidence":"git merge-tree → clean"}]}')}`,
      sieves,
    });
    expect(staged?.stage).toBe('review');
    expect(staged?.prompt).toContain('SIEVES-REVIEW');
    expect(calls).toEqual([{ stage: 'review', done: ['merge-tree'] }]);
    expect(staged?.link.sieveRows?.map((row) => row.id)).toEqual(['merge-tree']);
  });

  it('правки несут строки ревью дальше, доставка видит все и получает свой абзац', () => {
    calls.length = 0;
    const review = [
      'Проверил дифф.',
      '```agentdeck:review',
      '{"findings":["a.ts:3 — off by one"]}',
      '```',
      SIEVES(
        '{"sieves":[{"id":"contract-by-request","status":"pass","evidence":"curl /api/x → 404 as in docs"}]}',
      ),
    ].join('\n');
    const fix = plan({
      link: workLink({
        stage: 'review',
        workModel: 'sonnet',
        sieveRows: [{ id: 'merge-tree', status: 'pass', evidence: 'git merge-tree → clean' }],
      }),
      text: review,
      deliver: true,
      sieves,
    });
    expect(fix?.stage).toBe('fix');
    expect(fix?.link.sieveRows?.map((row) => row.id)).toEqual([
      'merge-tree',
      'contract-by-request',
    ]);
    if (!fix) return;
    // За правками — проход проверки (U6); строки едут и через него.
    const verify = plan({ link: fix.link, text: 'Поправил a.ts.', deliver: true, sieves });
    expect(verify?.stage).toBe('review');
    expect(verify?.link.sieveRows).toHaveLength(2);
    if (!verify) return;
    const deliver = plan({
      link: verify.link,
      text: REVIEW_BLOCK('{"findings":[]}'),
      deliver: true,
      sieves,
    });
    expect(deliver?.stage).toBe('deliver');
    expect(deliver?.prompt).toContain('SIEVES-DELIVER');
    expect(calls.at(-1)).toEqual({
      stage: 'deliver',
      done: ['merge-tree', 'contract-by-request'],
    });
    expect(deliver?.link.sieveRows).toHaveLength(2);
  });

  it('без поставщика сит задание звена прежнее', () => {
    expect(plan()?.prompt).not.toContain('SIEVES-');
  });
});

describe('planCascadeStage: доставка на Sonnet (рычаг экономии групп)', () => {
  /** Группа без потолка с доставкой — сразу в доставку (как выше). */
  function deliverLink(patch: Partial<ChatLink>): ChatLink {
    const link = workLink(patch);
    delete link.ceilingModel;
    return link;
  }

  it('Opus с глубиной xhigh — доставка на Sonnet с high, модель работы в связи остаётся', () => {
    const link = deliverLink({ model: 'claude-opus-5', effort: 'xhigh' });
    const staged = plan({ link, deliver: true, cheapDeliver: true });

    expect(staged?.stage).toBe('deliver');
    expect(staged?.model).toBe('sonnet');
    expect(staged?.effort).toBe('high');
    expect(staged?.link).toMatchObject({ model: 'sonnet', effort: 'high' });
  });

  it('глубина ниже high не поднимается', () => {
    const link = deliverLink({ model: 'opus', effort: 'medium' });
    const staged = plan({ link, deliver: true, cheapDeliver: true });

    expect(staged?.model).toBe('sonnet');
    expect(staged?.effort).toBe('medium');
  });

  it('только вниз: Sonnet и Haiku — как были', () => {
    const sonnet = plan({
      link: deliverLink({ effort: 'max' }),
      deliver: true,
      cheapDeliver: true,
    });
    expect(sonnet?.model).toBe('sonnet');
    expect(sonnet?.effort).toBe('max');
    const haiku = plan({
      link: deliverLink({ model: 'haiku' }),
      deliver: true,
      cheapDeliver: true,
    });
    expect(haiku?.model).toBe('haiku');
  });

  it('рычаг выключен — доставка на модели работы', () => {
    const link = deliverLink({ model: 'claude-opus-5', effort: 'xhigh' });
    const staged = plan({ link, deliver: true });

    expect(staged?.model).toBe('claude-opus-5');
    expect(staged?.effort).toBe('xhigh');
  });

  it('ревью рычаг не трогает: оно на потолке', () => {
    const staged = plan({ deliver: true, cheapDeliver: true });

    expect(staged?.stage).toBe('review');
    expect(staged?.model).toBe('claude-opus-5');
  });
});

describe('stagesAhead (L3)', () => {
  it('работа с потолком — ревью; группа с доставкой — доставка', () => {
    expect(stagesAhead(workLink(), true)).toEqual({ review: true, deliver: true });
    expect(stagesAhead(workLink(), false)).toEqual({ review: true, deliver: false });
  });

  it('понижённая работа без потолка — ревью не будет; на потолке своей моделью — будет', () => {
    expect(stagesAhead(workLink({ ceilingModel: undefined }), false).review).toBe(false);
    expect(stagesAhead(workLink({ ceilingModel: undefined, lowered: false }), false).review).toBe(
      true,
    );
  });

  it('само ревью и доставка свои навыки не теряют; правки — ревью только с проверкой правок', () => {
    expect(stagesAhead(workLink({ stage: 'review' }), true)).toEqual({
      review: false,
      deliver: true,
    });
    expect(stagesAhead(workLink({ stage: 'deliver' }), true)).toEqual({
      review: false,
      deliver: false,
    });
    expect(stagesAhead(workLink({ stage: 'fix' }), false).review).toBe(false);
    expect(stagesAhead(workLink({ stage: 'fix', fixFindings: ['F1'] }), false).review).toBe(true);
  });
});

/**
 * Найденное ревью вне охвата группы (владелец 26.10, замечание 4): «было до группы» —
 * не её работа. Правкам не уходит никогда, едет связью по цепочке до доставки, а та
 * называет его в MR. Охват группы — пакет ревью от коммита начала.
 */
describe('planCascadeStage: охват группы и «было до группы»', () => {
  const START = '0123456789abcdef0123456789abcdef01234567';
  const OLD = '🟡 1. **давний таймаут** old.ts:5-6';
  const NEW = '🟡 2. **забыт await** a.ts:1-2';
  const reviewLink = (patch: Partial<ChatLink> = {}) =>
    workLink({
      stage: 'review',
      model: 'claude-opus-5',
      workModel: 'sonnet',
      startSha: START,
      ...patch,
    });

  it('замечания — в правки, «было до группы» — только в связь; правки знают начало', () => {
    const fix = plan({
      link: reviewLink(),
      text: REVIEW_BLOCK(JSON.stringify({ findings: [NEW], preExisting: [OLD] })),
      deliver: true,
    });
    expect(fix?.stage).toBe('fix');
    expect(fix?.findings).toEqual([NEW]);
    expect(fix?.link.fixFindings).toEqual([NEW]);
    expect(fix?.prompt).not.toContain('давний таймаут');
    expect(fix?.prompt).toContain(`This group started at commit ${START.slice(0, 12)}`);
    expect(fix?.link).toMatchObject({ preExisting: [OLD], startSha: START });

    // Проход проверки правок кончился — доставка называет «было до группы» в MR.
    const verifyEnd = plan({
      link: workLink({ ...fix?.link, stage: 'review', fixFindings: [NEW] }),
      text: REVIEW_BLOCK(JSON.stringify({ findings: [] })),
      deliver: true,
    });
    expect(verifyEnd?.stage).toBe('deliver');
    expect(verifyEnd?.prompt).toContain('pre-existing, NOT fixed by this group');
    expect(verifyEnd?.prompt).toContain(`1. ${OLD}`);
  });

  it('чистое ревью с одним «было до группы» — сразу доставка, а не правки', () => {
    const deliver = plan({
      link: reviewLink(),
      text: REVIEW_BLOCK(JSON.stringify({ findings: [], preExisting: [OLD] })),
      deliver: true,
    });
    expect(deliver?.stage).toBe('deliver');
    expect(deliver?.prompt).toContain(`1. ${OLD}`);
    expect(deliver?.link.preExisting).toEqual([OLD]);
    expect(deliver?.prompt).toContain(`\`git log --first-parent ${START.slice(0, 12)}..HEAD\``);
  });

  it('пакет ревью группы — от коммита начала, а не от основной', () => {
    const staged = plan({
      deliver: true,
      link: workLink({ startSha: START }),
      reviewDelta: () => ({
        kind: 'commits',
        from: START.slice(0, 12),
        commits: [{ sha: 'aaa111aaa111', subject: 'group: fix', type: 'commit' }],
        dirty: false,
      }),
    });
    expect(staged?.prompt).toMatch(/review-pack\.mjs" --base 0123456789ab --plan /);
    expect(plan({ deliver: true })?.prompt).not.toContain('--base');
  });

  it('пустой охват группы — ревью не заводится, доставка называет причину', () => {
    const next = plan({
      deliver: true,
      link: workLink({ startSha: START }),
      reviewDelta: () => ({
        kind: 'none',
        from: START.slice(0, 12),
        published: false,
        group: true,
      }),
    });
    expect(next?.stage).toBe('deliver');
    expect(next?.prompt).toContain('the panel skipped its review');
    expect(next?.prompt).toContain(`since its start commit ${START.slice(0, 12)}`);
  });
});

/**
 * «Ревью после работы» — свой тумблер проекта рядом с подбором (Telegram R3(d), 26.10).
 * Раньше снять ревью можно было только выключив подбор целиком — вместе с дешёвыми
 * моделями. Флаг снят на связь при запуске; выключенный ведёт работу в доставку с
 * причиной, не трогая подбор, подъём на потолок и проверку правок.
 */
describe('planCascadeStage: «Ревью после работы» выключено (R3(d))', () => {
  const off = (patch: Partial<ChatLink> = {}) => workLink({ reviewAfterWork: false, ...patch });
  /** План и сколько раз планировщик отметил «ревью выключено» (строка ленты). */
  const planned = (input: Parameters<typeof plan>[0] = {}) => {
    let noted = 0;
    const next = plan({ ...input, noteReviewOff: () => (noted += 1) });
    return { next, noted };
  };

  it('выключено — доставка с причиной, без звена ревью и без ревьюера на потолке', () => {
    const { next, noted } = planned({ link: off(), deliver: true });

    expect(next?.stage).toBe('deliver');
    expect(noted).toBe(1);
    // Доставка — на модели работы, а не на потолке ревьюера.
    expect(next?.model).toBe('sonnet');
    expect(next?.link.stage).toBe('deliver');
    expect(next?.prompt).toContain(
      'the panel skipped its review: the human turned «review after work» off for this project',
    );
  });

  it('включено (умолчание) — ревью на потолке, как раньше; отметки о пропуске нет', () => {
    const { next, noted } = planned({ link: workLink(), deliver: true });

    expect(next?.stage).toBe('review');
    expect(next?.model).toBe('claude-opus-5');
    expect(noted).toBe(0);
  });

  it('подбор выключен (связь без назначения и потолка) — как было: ни ревью, ни отметки', () => {
    // Ровно то, что пишет `linkRecord` без подбора: ни модели, ни стадии, ни потолка.
    const bare: ChatLink = {
      parentChatId: 'parent',
      createdAt: '2026-09-07T10:00:00.000Z',
      title: 'Переименования',
      branch: 'split/rename',
      task: 'Переименуй foo в bar',
    };
    const { next, noted } = planned({ link: bare, deliver: true });

    expect(next?.stage).not.toBe('review');
    expect(noted).toBe(0);
    // Подбор выключен, но работа на потолке своей моделью — ревью как раньше.
    const ceilingWork = planned({ link: { ...bare, model: 'claude-opus-5' }, deliver: true });
    expect(ceilingWork.next?.stage).toBe('review');
    expect(ceilingWork.noted).toBe(0);
  });

  it('без доставки — цепочка кончается работой: ревью не заводится, отметка есть', () => {
    const { next, noted } = planned({ link: off() });

    expect(next).toBeUndefined();
    expect(noted).toBe(1);
  });

  it('понижённая работа без правок по-прежнему поднимается на потолок, флаг едет дальше', () => {
    const raised = plan({ link: off(), hasWork: () => false, deliver: true });

    expect(raised?.stage).toBe('work');
    expect(raised?.model).toBe('claude-opus-5');
    expect(raised?.link.reviewAfterWork).toBe(false);
  });

  it('работа после плана несёт флаг; планка сдачи не обещает ревью, но обещает подъём', () => {
    const work = plan({
      link: off({ stage: 'plan', model: 'claude-opus-5', workModel: 'sonnet', workEffort: 'low' }),
      text: '',
    });
    const settings = { taskSplitInitiative: true, handoffInitiative: true };
    const append = work ? stageAppendPrompt(work, settings) : '';

    expect(work?.stage).toBe('work');
    expect(work?.link.reviewAfterWork).toBe(false);
    expect(append).toContain('The panel will not start a review of this work');
    expect(append).toContain('the panel re-runs the task on the ceiling model');
    expect(append).not.toContain('starts a review of your diff');
  });

  it('звено работы знает, что ревью за ним не будет (L3)', () => {
    expect(stagesAhead(off(), true)).toEqual({ review: false, deliver: true });
    expect(stagesAhead(workLink(), true)).toEqual({ review: true, deliver: true });
  });
});
