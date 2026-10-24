import { describe, it, expect } from 'vitest';
import type { RunOptions } from '../ChatRunner/ChatRunner.ts';
import type { RunFinished, RunMeta } from '../ChatRunRegistry/ChatRunRegistry.ts';
import type { TreePauseRecord } from '../../../lib/app-store/app-store.types.ts';
import { TreePause } from '../tree-pause/tree-pause.ts';
import type { PlanAnswer } from './group-questions.ts';
import {
  GroupWaitResume,
  WAIT_RESUME_MAX,
  awaitsAnswer,
  ownDecisions,
  waitResumePrompt,
} from './group-wait.ts';
import { RBAC_WAIT_TAIL, RBAC_WAIT_TEXT } from './group-wait.fixture.ts';

/**
 * Ожидание ответа, написанное текстом, у группы «по плану»: панель продолжает
 * ту же сессию сама; повтор — с решениями поимённо; предел подряд.
 */
describe('ожидание ответа текстом: узнаётся', () => {
  it('живой хвост группы RBAC — и целиком, и одним последним абзацем', () => {
    expect(awaitsAnswer(RBAC_WAIT_TEXT)).toBe(true);
    expect(awaitsAnswer(RBAC_WAIT_TAIL)).toBe(true);
  });

  it('ru/en формы: «нужно ваше решение», «after your answer», «waiting for your»', () => {
    expect(awaitsAnswer('Сделал этап A.\n\nДля этапа B нужно ваше решение по схеме.')).toBe(true);
    expect(awaitsAnswer('Stage A done.\n\nI will start stage B after your answer.')).toBe(true);
    expect(awaitsAnswer('Waiting for your decision on the schema.\n\nStage A is done.')).toBe(true);
    expect(awaitsAnswer('Stage A done.\n\nOpen questions are listed in PROGRESS.md.')).toBe(true);
  });

  it('отчёт без ожидания — не ожидание', () => {
    expect(awaitsAnswer('Этапы D и E сделаны.\n\nMR: https://x.example/-/merge_requests/7')).toBe(
      false,
    );
    expect(awaitsAnswer('Готово. Ответь, если нужно ещё.')).toBe(false);
    expect(awaitsAnswer('Жду ревью: MR открыт.')).toBe(false);
    expect(awaitsAnswer('```\nжду ответа?\n```\nВсё сделано.')).toBe(false);
    expect(awaitsAnswer('')).toBe(false);
  });
});

describe('решения из рекомендаций агента', () => {
  it('живой список: четыре вопроса, рекомендуемый — первый', () => {
    const decisions = ownDecisions(RBAC_WAIT_TEXT);
    expect(decisions.map((decision) => decision.label.slice(0, 30))).toEqual([
      'Оставлять блок и писать в нём ',
      'Оставлять её и сразу перечитыв',
      'Кодом, как сейчас (versions:wr',
      'Только экран отказа для «Хуков',
    ]);
    expect(decisions[0]?.question).toMatch(/^Чужой блок внутри карточки/);
    expect(decisions.every((decision) => !decision.free)).toBe(true);
  });

  it('пункты отчёта без вариантов — не вопросы; метка рекомендации главнее порядка', () => {
    const text = '1. Сделал миграцию.\n2. Какой путь?\n   - Узкий\n   - Широкий (рекомендую)\n';
    expect(ownDecisions(text).map((decision) => decision.label)).toEqual(['Широкий (рекомендую)']);
  });

  it('первое продолжение — свои рекомендации; повтор — решения поимённо', () => {
    const decisions = ownDecisions(RBAC_WAIT_TEXT);
    const first = waitResumePrompt(decisions, 1);
    expect(first).toMatch(/^\[Autonomous mode\]/);
    expect(first).toContain('Apply your own recommendations to every open question');
    expect(first).toContain('Record each decision and its reason in the MR description');
    expect(first).not.toMatch(/\p{Script=Cyrillic}/u);
    const second = waitResumePrompt(decisions, 2);
    expect(second).toContain('ended waiting for an answer again');
    expect(second).toContain('1. "Чужой блок внутри карточки');
    expect(second).toContain('4. "Что взять в эту задачу');
    expect(waitResumePrompt([], 2)).toContain('take the option you recommended');
  });
});

describe('GroupWaitResume', () => {
  const GROUP = { parentChatId: 'p', groupIndex: 0 };
  const finished = (text: string, extra: Partial<RunFinished> = {}): RunFinished =>
    ({
      chatId: 'child',
      sessionId: 'sess',
      ok: true,
      text,
      options: {
        prompt: 'задача',
        cwd: '/w',
        name: 'группа',
        permissionPrompt: { runId: 'new-1', baseUrl: '' },
      },
      projectPath: '/w',
      ...extra,
    }) as unknown as RunFinished;

  const harness = (group: typeof GROUP | null = GROUP) => {
    const starts: { chatId: string; options: RunOptions; meta: RunMeta }[] = [];
    const notices: PlanAnswer[][] = [];
    const resume = new GroupWaitResume({
      groupOf: () => group ?? undefined,
      start: (chatId, options, meta) => {
        starts.push({ chatId, options, meta });
        resume.started([chatId, meta.sessionId ?? '']);
        return true;
      },
      bridge: (runId) => ({ runId, baseUrl: 'http://127.0.0.1:5178' }),
      notice: (_group, answers) => notices.push(answers),
      schedule: (run) => run(),
      log: () => undefined,
    });
    return { resume, starts, notices };
  };

  it('живой хвост: та же сессия, ответ панели, мост к себе, отметка в хаб', () => {
    const { resume, starts, notices } = harness();
    expect(resume.finished(finished(RBAC_WAIT_TEXT))).toBe(true);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.chatId).toBe('child');
    expect(starts[0]?.options).toMatchObject({ sessionId: 'sess', fork: false });
    expect(starts[0]?.options.name).toBeUndefined();
    expect(starts[0]?.options.prompt).toMatch(/^\[Autonomous mode\]/);
    expect(starts[0]?.options.permissionPrompt).toEqual({
      runId: 'child',
      baseUrl: 'http://127.0.0.1:5178',
    });
    expect(notices[0]).toHaveLength(4);
  });

  it('петля: повтор — решения поимённо, после предела — обычный путь', () => {
    const { resume, starts } = harness();
    for (let turn = 0; turn < WAIT_RESUME_MAX; turn += 1) {
      expect(resume.finished(finished(RBAC_WAIT_TEXT))).toBe(true);
    }
    expect(resume.finished(finished(RBAC_WAIT_TEXT))).toBe(false);
    expect(starts).toHaveLength(WAIT_RESUME_MAX);
    expect(starts[1]?.options.prompt).toContain('1. "Чужой блок внутри карточки');
  });

  it('ход без ожидания снимает счёт; слово человека — тоже', () => {
    const { resume, starts } = harness();
    resume.finished(finished(RBAC_WAIT_TEXT));
    resume.finished(finished('Сделано.\n\nMR: https://x.example/-/merge_requests/1'));
    expect(resume.finished(finished(RBAC_WAIT_TEXT))).toBe(true);
    expect(starts[1]?.options.prompt).toContain('Apply your own recommendations');
    resume.started(['child', 'sess']);
    resume.finished(finished(RBAC_WAIT_TEXT));
    expect(starts[2]?.options.prompt).toContain('Apply your own recommendations');
  });

  it('не группа «по плану», упавший, фоновый или прерванный ход — не трогаем', () => {
    expect(harness(null).resume.finished(finished(RBAC_WAIT_TEXT))).toBe(false);
    const { resume, starts } = harness();
    expect(resume.finished(finished(RBAC_WAIT_TEXT, { ok: false }))).toBe(false);
    expect(resume.finished(finished(RBAC_WAIT_TEXT, { background: true }))).toBe(false);
    expect(resume.finished(finished(RBAC_WAIT_TEXT, { interrupted: true }))).toBe(false);
    expect(resume.finished(finished(RBAC_WAIT_TEXT, { sessionId: undefined }))).toBe(false);
    expect(starts).toHaveLength(0);
  });

  it('вопрос инструментом остался без ответа (`asked`) — тоже продолжение', () => {
    const { resume, starts } = harness();
    expect(resume.finished(finished('Отправил вопросы.', { asked: true }))).toBe(true);
    expect(starts).toHaveLength(1);
  });
});

// F-67: ход «по плану» с меткой `HUMAN:` (то, что можно только человеку) и
// «once you confirm» в хвосте панель продолжала сама до трёх раз — конвейер не
// видел метки, пока не кончился предел.
describe('GroupWaitResume: метка HUMAN — человеку, а не ответ панели', () => {
  const finished = (text: string): RunFinished =>
    ({
      chatId: 'child',
      sessionId: 'sess',
      ok: true,
      text,
      options: { prompt: 'задача', cwd: '/w' },
    }) as unknown as RunFinished;

  it('хвост с HUMAN: merge и «once you confirm» — обычный путь, без продолжения', () => {
    const starts: string[] = [];
    const resume = new GroupWaitResume({
      groupOf: () => ({ parentChatId: 'p', groupIndex: 0 }),
      start: (chatId) => starts.push(chatId) > 0,
      notice: () => undefined,
      schedule: (run) => run(),
      log: () => undefined,
    });
    const text =
      'Ветка готова, MR открыт.\n\nHUMAN: merge — MR !12 must land first. Once you confirm I will push.';
    expect(awaitsAnswer(text)).toBe(true);
    expect(resume.finished(finished(text))).toBe(false);
    expect(starts).toEqual([]);
  });

  // Хвост ответа обрезан до 280 знаков спереди: метка длинной строки пропадала,
  // и панель отвечала за человека на то, что можно только ему.
  it('длинная строка HUMAN: с «once you confirm» — тоже без продолжения', () => {
    const starts: string[] = [];
    const resume = new GroupWaitResume({
      groupOf: () => ({ parentChatId: 'p', groupIndex: 0 }),
      start: (chatId) => starts.push(chatId) > 0,
      notice: () => undefined,
      schedule: (run) => run(),
      log: () => undefined,
    });
    const text =
      'Ветка готова, MR открыт.\n\nHUMAN: destructive — drop the legacy table users_old ' +
      'because the migration replaces it; '.repeat(8) +
      'Once you confirm I will run it.';
    expect(resume.finished(finished(text))).toBe(false);
    expect(starts).toEqual([]);
  });
});

// F-44: старт продолжения отложен, а `finished` уже сказал «продолжила» —
// отказ реестра оставлял группу без конца хода; «Остановить всё» продолжение
// обходило.
describe('GroupWaitResume: отказ старта и стоящее дерево', () => {
  const finished = {
    chatId: 'child',
    sessionId: 'sess',
    ok: true,
    text: RBAC_WAIT_TEXT,
    options: { prompt: 'задача', cwd: '/w' },
  } as unknown as RunFinished;

  it('реестр отказал в старте — конец хода идёт обычным путём', () => {
    const fallback: RunFinished[] = [];
    const resume = new GroupWaitResume({
      groupOf: () => ({ parentChatId: 'p', groupIndex: 0 }),
      start: () => false,
      refused: (run) => fallback.push(run),
      notice: () => undefined,
      schedule: (run) => run(),
      log: () => undefined,
    });
    expect(resume.finished(finished)).toBe(true);
    expect(fallback).toEqual([finished]);
  });

  // RF-EF-05: возврат попытки при отказе реестра не был закреплён — без него
  // три отказа подряд съедали предел, и ждущая группа больше не получала ответа.
  it('реестр отказал — попытка возвращается: отказы не съедают предел, следующий старт — первое продолжение', () => {
    const prompts: string[] = [];
    let accept = false;
    const resume = new GroupWaitResume({
      groupOf: () => ({ parentChatId: 'p', groupIndex: 0 }),
      start: (_chatId, options) => {
        prompts.push(options.prompt);
        return accept;
      },
      refused: () => undefined,
      notice: () => undefined,
      schedule: (run) => run(),
      log: () => undefined,
    });
    for (let at = 0; at < WAIT_RESUME_MAX; at += 1) expect(resume.finished(finished)).toBe(true);
    accept = true;
    expect(resume.finished(finished)).toBe(true);
    expect(prompts).toHaveLength(WAIT_RESUME_MAX + 1);
    // Каждое — первое продолжение: отказанные в счёт не пошли.
    for (const prompt of prompts) expect(prompt).toMatch(/Apply your own recommendations/);
  });

  it('дерево стоит — продолжение ложится в очередь паузы, а не стартует', () => {
    const starts: string[] = [];
    const deferred: { kind: string; chatId: string; prompt: string }[] = [];
    const resume = new GroupWaitResume({
      groupOf: () => ({ parentChatId: 'p', groupIndex: 0 }),
      start: (chatId) => starts.push(chatId) > 0,
      gate: {
        defer: (kind, chatId, options) =>
          deferred.push({ kind, chatId, prompt: options.prompt }) > 0,
      },
      notice: () => undefined,
      schedule: (run) => run(),
      log: () => undefined,
    });
    expect(resume.finished(finished)).toBe(true);
    expect(starts).toEqual([]);
    expect(deferred).toEqual([
      { kind: 'handoff', chatId: 'child', prompt: expect.stringMatching(/^\[Autonomous mode\]/) },
    ]);
  });
});

// RF-EF-05, части 2–3: продолжение, отложенное паузой дерева, выходило из очереди
// чужим — слушатель стартов обнулял счёт, как от слова человека, а отказ реестра
// в старте из очереди никто не проводил. Очередь здесь настоящая (`TreePause`).
describe('GroupWaitResume под паузой дерева: «Продолжить всё» выпускает продолжение своим', () => {
  const finished = {
    chatId: 'child',
    sessionId: 'sess',
    ok: true,
    text: RBAC_WAIT_TEXT,
    options: { prompt: 'задача', cwd: '/w' },
  } as unknown as RunFinished;
  const FIRST = /Apply your own recommendations/;
  const SECOND = /1\. "Чужой блок внутри карточки/;

  const harness = () => {
    const records: Record<string, TreePauseRecord> = {};
    const running = new Set<string>();
    const prompts: string[] = [];
    const fallback: RunFinished[] = [];
    // Реестр: занятый разговор второму старту отказывает; принятый старт слышит слушатель.
    const start = (chatId: string, options: RunOptions, meta: RunMeta): boolean => {
      if (running.has(chatId)) return false;
      running.add(chatId);
      prompts.push(options.prompt);
      resume.started([chatId, meta.sessionId ?? '']);
      return true;
    };
    const tree = new TreePause({
      links: () => ({ child: { parentChatId: 'p', createdAt: '2026-10-24T00:00:00.000Z' } }),
      runs: {
        describe: () => undefined,
        stop: () => 'absent',
        isRunning: (chatId) => running.has(chatId),
        start,
      },
      store: {
        get: (root) => records[root],
        all: () => records,
        set: (record) => {
          records[record.root] = record;
        },
        clear: (root) => {
          delete records[root];
        },
      },
    });
    const resume: GroupWaitResume = new GroupWaitResume({
      groupOf: () => ({ parentChatId: 'p', groupIndex: 0 }),
      start,
      gate: tree,
      refused: (run) => fallback.push(run),
      notice: () => undefined,
      schedule: (run) => run(),
      log: () => undefined,
    });
    /** Ход кончился, разговор свободен — как у реестра после конца хода. */
    const end = (): boolean => {
      running.delete('child');
      return resume.finished(finished);
    };
    return { tree, resume, running, prompts, fallback, end };
  };

  it('выпущенное из очереди продолжение — своё: счёт не обнулён, следующее — с решениями поимённо', () => {
    const { tree, prompts, end } = harness();
    tree.pause('p');
    expect(end()).toBe(true);
    expect(prompts).toEqual([]);
    expect(tree.resume('p')).toMatchObject({ flushed: 1 });
    expect(end()).toBe(true);
    expect(prompts).toEqual([expect.stringMatching(FIRST), expect.stringMatching(SECOND)]);
  });

  it('реестр отказал старту из очереди — конец хода идёт обычным путём, попытка возвращена', () => {
    const { tree, running, prompts, fallback, end } = harness();
    tree.pause('p');
    expect(end()).toBe(true);
    running.add('child'); // за время паузы разговор занят — реестр откажет
    expect(tree.resume('p')).toMatchObject({ flushed: 0 });
    expect(fallback).toEqual([finished]);
    expect(end()).toBe(true);
    expect(prompts).toEqual([expect.stringMatching(FIRST)]);
  });

  it('слово человека за время паузы обнулило счёт — отказ из очереди его не воскрешает', () => {
    const { tree, resume, running, prompts, end } = harness();
    expect(end()).toBe(true); // первое продолжение — сразу
    tree.pause('p');
    expect(end()).toBe(true); // второе — в очередь
    resume.started(['child', 'sess']); // человек написал сам
    running.add('child');
    tree.resume('p');
    expect(end()).toBe(true);
    expect(prompts).toEqual([expect.stringMatching(FIRST), expect.stringMatching(FIRST)]);
  });
});
