import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HANDOFF_BLOCK_LANG, HANDOFF_GROUP_MAX_CHAIN } from '@agentdeck/contracts/chat-handoff';
import { WARM_DELIVER_LINE } from '../../domains/chat/group-continuation/group-continuation.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { createHandoffPlanner, registerChatHandoffRoutes } from '../chat/handoff-routes.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { HandoffChains } from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { AUTONOMOUS_PERMISSION_MODE } from '../../domains/chat/ChatWorkspace/ChatWorkspace.ts';
import { ProviderChatService } from '../../domains/provider-chat/provider-chat.ts';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';

/**
 * Доставка группы разделения (журнал 55/57/58/59/65, 42/44/45): звено доставки
 * после правок и после чистого ревью, собственный блок продолжения группы без
 * тумблера и авторежим продолжения группы. Планировщик и реестр настоящие,
 * подменён только процесс CLI.
 */

const CWD = 'C:/work/проект-worktrees/rename';

const PROPOSAL = {
  done: 'правки по ревью сделаны',
  next: 'коммит, пуш, MR',
  checkpoint: '.agent/PROGRESS.md',
};

function handoffBlock(): string {
  return ['```' + HANDOFF_BLOCK_LANG, JSON.stringify(PROPOSAL), '```'].join('\n');
}

const WORK_LINK: ChatLink = {
  parentChatId: 'родитель',
  createdAt: '2026-09-07T10:00:00.000Z',
  title: 'Переименования',
  branch: 'split/rename',
  groupIndex: 0,
  model: 'sonnet',
  effort: 'medium',
  kind: 'mechanical',
  lowered: true,
  stage: 'work',
  ceilingModel: 'claude-opus-5',
  ceilingEffort: 'high',
};

const FIX_LINK: ChatLink = {
  ...WORK_LINK,
  stage: 'fix',
  workModel: 'sonnet',
  workEffort: 'medium',
};

const REVIEW_LINK: ChatLink = {
  ...WORK_LINK,
  stage: 'review',
  model: 'claude-opus-5',
  effort: 'high',
  lowered: false,
  workModel: 'sonnet',
  workEffort: 'medium',
};

interface Started {
  chatId: string;
  prompt: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  sessionId?: string;
  fork?: boolean;
  append?: string;
  wake?: boolean;
  runId?: string;
}

/** Окно у сжатия (150k из 200k): только с ним группе положена чистая сессия (E1). */
const FULL_WINDOW = 150_000;

/** Задание первого прогона: ему CLI отвечает `text`, всем звеньям за ним — «Готово.». */
const FIRST_PROMPT = 'задание звена';

function build(
  text: string,
  options: {
    delivers?: boolean;
    mtime?: number;
    every?: boolean;
    sieves?: (stage: string) => Promise<string>;
    /** Окно последнего шага каждого прогона (или по его заданию); пусто — расход не приходил. */
    context?: number | ((runOptions: { prompt: string }) => number);
    /** Порог окна человека (`handoffContextLimit`); пусто — выключен. */
    contextLimit?: number;
    /** Дерево на паузе: звенья ложатся в очередь (`deferred`), а не стартуют. */
    paused?: boolean;
    /** Ответ по параметрам прогона; пусто — правило `every`/`FIRST_PROMPT`. */
    answer?: (runOptions: { prompt: string; model?: string }) => string | undefined;
  } = {},
) {
  const chains = new HandoffChains();
  const registry = new ChatRunRegistry((): RunLike => ({
    start: async (runOptions, onEvent) => {
      const context =
        typeof options.context === 'function' ? options.context(runOptions) : options.context;
      if (context) {
        onEvent({
          kind: 'usage',
          input: context,
          output: 0,
          cacheRead: 0,
          cacheCreation: 0,
        });
      }
      onEvent({
        kind: 'text',
        text:
          options.answer?.(runOptions) ??
          (options.every || runOptions.prompt === FIRST_PROMPT ? text : 'Готово.'),
      });
      onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-звено' });
    },
    stop: () => undefined,
  }));
  const links = new Map<string, ChatLink>();
  const runs: Started[] = [];
  const deferred: Started[] = [];
  const ended: { stage?: string; status: string }[] = [];
  // Звенья, заведённые в одну миллисекунду, делят ключ `new-<ms>`: связь каждого — отсюда.
  const saved: ChatLink[] = [];
  const start = registry.start.bind(registry);
  registry.start = (chatId, opts, meta) => {
    runs.push({
      chatId,
      prompt: opts.prompt,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.fork ? { fork: true } : {}),
      ...(opts.appendSystemPrompt ? { append: opts.appendSystemPrompt } : {}),
      ...(opts.wake ? { wake: true } : {}),
      ...(opts.permissionPrompt ? { runId: opts.permissionPrompt.runId } : {}),
    });
    return start(chatId, opts, meta);
  };
  const planner = createHandoffPlanner({
    runs: registry,
    chains,
    session: new ChatSession(registry),
    selfBaseUrl: 'http://127.0.0.1:5178',
    ...(options.contextLimit ? { contextLimit: () => options.contextLimit as number } : {}),
    ...(options.paused
      ? {
          gate: {
            paused: () => true,
            defer: (_kind: string, chatId: string, opts: RunOptions) => {
              deferred.push({
                chatId,
                prompt: opts.prompt,
                ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
                ...(opts.fork ? { fork: true } : {}),
              });
              return true;
            },
          },
        }
      : {}),
    stat: () => options.mtime,
    carryLink: (from, to) => {
      const link = from.map((key) => links.get(key)).find(Boolean);
      if (link) links.set(to, link);
    },
    cascade: {
      linkOf: (aliases) => aliases.map((key) => links.get(key)).find(Boolean),
      saveLink: (chatId, link) => {
        links.set(chatId, link);
        saved.push(link);
      },
      markReviewed: () => undefined,
      hasWork: () => true,
      settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
      ...(options.sieves
        ? { sieves: (_cwd: string, _link: ChatLink, stage: string) => options.sieves!(stage) }
        : {}),
    },
    split: {
      onTriageFinished: () => undefined,
      onChainEnded: (link, outcome) =>
        void ended.push({ ...(link.stage ? { stage: link.stage } : {}), status: outcome.status }),
      identityOf: () => 'Group branch: split/rename. Group tasks: PROJ-7.',
      delivers: () => options.delivers ?? false,
    },
  });
  registry.setHandoffPlanner(planner);
  return { registry, planner, links, runs, deferred, ended, saved };
}

async function run(registry: ChatRunRegistry, chatId: string, permissionMode?: string) {
  registry.start(
    chatId,
    { prompt: FIRST_PROMPT, cwd: CWD, ...(permissionMode ? { permissionMode } : {}) },
    { projectPath: CWD },
  );
  await new Promise((done) => setTimeout(done, 20));
}

const stageRuns = (runs: Started[]) => runs.filter((item) => item.chatId.startsWith('new-'));

describe('звено доставки группы разделения', () => {
  it('правки группы с доставкой заводят звено доставки на модели работы', async () => {
    const { registry, links, runs, ended } = build('Поправил все три замечания.', {
      delivers: true,
    });
    links.set('чат-правки', FIX_LINK);

    await run(registry, 'чат-правки');

    const deliver = stageRuns(runs)[0];
    expect(links.get(deliver?.chatId ?? '')?.stage).toBe('deliver');
    expect(deliver?.model).toBe('sonnet');
    expect(deliver?.permissionMode).toBe(AUTONOMOUS_PERMISSION_MODE);
    // Ветка и задачи — первой строкой (журнал 98), дальше — шаги доставки.
    expect(deliver?.prompt.startsWith('Group branch: split/rename.')).toBe(true);
    expect(deliver?.prompt).toContain('git fetch');
    expect(deliver?.prompt).toContain('rebase');
    expect(deliver?.prompt).toContain('MR');
    // Итог группы сказал конец доставки, а не правок.
    expect(ended).toEqual([{ stage: 'deliver', status: 'done' }]);
  });

  // L3.2: ход кончился, а фоновая команда агента ещё идёт — это пауза, не итог
  // правок: доставка рано, группа стоит «в фоне» до хода пробуждения.
  it('конец хода правок при живом фоне не заводит доставку: группа ждёт фон', () => {
    const { planner, links, runs, ended } = build('', { delivers: true });
    links.set('чат-правки', FIX_LINK);
    const finished = {
      chatId: 'чат-правки',
      sessionId: 'sess-правки',
      projectPath: CWD,
      text: 'Проверка идёт в фоне, жду уведомление.',
      ok: true,
      startedAt: Date.now(),
      contextTokens: 0,
      options: { prompt: FIRST_PROMPT, cwd: CWD },
    };
    planner({ ...finished, background: true });
    expect(stageRuns(runs)).toEqual([]);
    expect(ended).toEqual([{ stage: 'fix', status: 'background' }]);

    // Ход пробуждения — уже без фона: он и есть итог правок, доставка заводится.
    planner(finished);
    expect(links.get(stageRuns(runs)[0]?.chatId ?? '')?.stage).toBe('deliver');
  });

  // Ревью сит, 28.09, п. 12: пути копии читаются асинхронно — git на большой копии
  // не держит сервер; звено стартует, когда абзац готов, и метки в задании нет.
  it('абзац сит приходит асинхронно: звено ждёт его, метка в задание не попадает', async () => {
    let release: (paragraph: string) => void = () => undefined;
    const asked: string[] = [];
    const { registry, links, runs } = build('Поправил все три замечания.', {
      delivers: true,
      sieves: (stage) => {
        asked.push(stage);
        return new Promise((done) => (release = done));
      },
    });
    links.set('чат-правки', FIX_LINK);

    await run(registry, 'чат-правки');
    expect(asked).toEqual(['deliver']);
    expect(stageRuns(runs)).toEqual([]);

    release('SIEVES-PARAGRAPH');
    await new Promise((done) => setTimeout(done, 20));
    const deliver = stageRuns(runs)[0];
    expect(deliver?.prompt).toContain('SIEVES-PARAGRAPH');
    expect(deliver?.prompt).not.toContain('agentdeck:sieve-slot');
  });

  it('пустой абзац сит уносит метку: задание без следа места под него', async () => {
    const { registry, links, runs } = build('Поправил.', {
      delivers: true,
      sieves: async () => '',
    });
    links.set('чат-правки', FIX_LINK);

    await run(registry, 'чат-правки');

    const deliver = stageRuns(runs)[0];
    expect(deliver?.prompt).toContain('git fetch');
    expect(deliver?.prompt).not.toContain('agentdeck:sieve-slot');
  });

  // Ревью сит 28.09, R4 minor 5: абзац обещает, что несданное сито держит «готово», —
  // а судит это только доставка группы. Каскадный чат без родителя его не получает.
  it('ревью каскада без родителя или без доставки — без абзаца сит; группы с доставкой — с ним', async () => {
    const asked: string[] = [];
    const sieves = async (stage: string) => {
      asked.push(stage);
      return 'SIEVES-PARAGRAPH';
    };
    const cases = [
      { link: { ...WORK_LINK, parentChatId: '' }, delivers: true },
      { link: WORK_LINK, delivers: false },
    ];
    for (const { link, delivers } of cases) {
      const alone = build('Сделал.', { delivers, sieves });
      alone.links.set('чат-каскада', link);

      await run(alone.registry, 'чат-каскада');

      const review = stageRuns(alone.runs)[0];
      expect(alone.saved[0]?.stage).toBe('review');
      expect(review?.prompt).not.toContain('SIEVES-PARAGRAPH');
      expect(review?.prompt).not.toContain('agentdeck:sieve-slot');
    }
    expect(asked).toEqual([]);

    // Контроль: то же звено в группе с доставкой абзац получает — отказ выше не пустышка.
    const group = build('Сделал.', { delivers: true, sieves });
    group.links.set('чат-группы', WORK_LINK);
    await run(group.registry, 'чат-группы');
    expect(asked).toEqual(['review']);
    expect(stageRuns(group.runs)[0]?.prompt).toContain('SIEVES-PARAGRAPH');
  });

  it('чистое ревью группы с доставкой тоже заводит доставку', async () => {
    const verdict = ['```agentdeck:review', '{"findings":[]}', '```'].join('\n');
    const { registry, links, runs, ended } = build(`Проверил.\n${verdict}`, { delivers: true });
    links.set('чат-ревью', REVIEW_LINK);

    await run(registry, 'чат-ревью');

    const deliver = stageRuns(runs)[0];
    expect(links.get(deliver?.chatId ?? '')).toMatchObject({ stage: 'deliver', model: 'sonnet' });
    expect(ended).toEqual([{ stage: 'deliver', status: 'done' }]);
  });

  // E2 (замер 29.09–20.10): доставка с чистого листа — 23 % траты деревьев, почти
  // вся на то, чтобы заново узнать ветку, задачи и итоги проверок.
  describe('доставка продолжает тёплую сессию группы (E2)', () => {
    const WORK_APPEND = 'ДОПИСКА-РАБОТЫ';
    const FIX_APPEND = 'ДОПИСКА-ПРАВОК';

    function start(
      registry: ChatRunRegistry,
      chatId: string,
      extra: { model?: string; effort?: string; appendSystemPrompt?: string; wake?: boolean },
    ) {
      registry.start(chatId, { prompt: FIRST_PROMPT, cwd: CWD, ...extra }, { projectPath: CWD });
      return new Promise((done) => setTimeout(done, 40));
    }

    it('правки → доставка: ответвление той же сессии, та же дописка, модель работы', async () => {
      const { registry, links, runs, ended } = build('Поправил все три замечания.', {
        delivers: true,
        context: 30_000,
      });
      links.set('чат-правки', FIX_LINK);

      // Ход правок разбужен фоном (`wake`): флаг его одного, доставке он не достаётся.
      await start(registry, 'чат-правки', {
        model: 'sonnet',
        effort: 'medium',
        appendSystemPrompt: FIX_APPEND,
        wake: true,
      });

      const deliver = stageRuns(runs)[0];
      expect(links.get(deliver?.chatId ?? '')?.stage).toBe('deliver');
      expect(deliver).toMatchObject({
        sessionId: 'sess-звено',
        fork: true,
        model: 'sonnet',
        effort: 'medium',
        append: FIX_APPEND,
        permissionMode: AUTONOMOUS_PERMISSION_MODE,
      });
      expect(deliver?.wake).toBeUndefined();
      // Ветка и задачи — всё так же первой строкой (журнал 98), шаги доставки — целиком.
      expect(deliver?.prompt.startsWith('Group branch: split/rename.')).toBe(true);
      expect(deliver?.prompt).toContain(WARM_DELIVER_LINE);
      expect(deliver?.prompt).toContain('git fetch');
      expect(ended).toEqual([{ stage: 'deliver', status: 'done' }]);
    });

    it('работа → чистое ревью → доставка: ревью свежее, доставка — из сессии работы', async () => {
      const verdict = ['```agentdeck:review', '{"findings":[]}', '```'].join('\n');
      const { registry, links, runs, ended } = build('Готово, переименовал.', {
        delivers: true,
        context: 30_000,
        answer: (runOptions) =>
          runOptions.model === 'claude-opus-5' ? `Проверил.\n${verdict}` : undefined,
      });
      links.set('чат-работа', WORK_LINK);

      await start(registry, 'чат-работа', {
        model: 'sonnet',
        effort: 'medium',
        appendSystemPrompt: WORK_APPEND,
      });

      const [review, deliver] = stageRuns(runs);
      expect(links.get(review?.chatId ?? '')?.stage).toBe('review');
      // Ревью — независимый взгляд: ни сессии работы, ни её дописки.
      expect(review?.sessionId).toBeUndefined();
      expect(review?.append ?? '').not.toContain(WORK_APPEND);
      expect(links.get(deliver?.chatId ?? '')?.stage).toBe('deliver');
      expect(deliver).toMatchObject({ sessionId: 'sess-звено', fork: true, append: WORK_APPEND });
      expect(ended).toEqual([{ stage: 'deliver', status: 'done' }]);
    });

    // Ревью 20.10: звено на паузе дерева стартует по «Продолжить всё», часто через
    // часы, — ответвление тогда переписало бы в кэш всё окно работы заново.
    it('дерево на паузе — доставка в очередь с чистого листа, не ответвлением', async () => {
      const { registry, links, runs, deferred } = build('Поправил.', {
        delivers: true,
        context: 30_000,
        paused: true,
      });
      links.set('чат-правки', FIX_LINK);

      await start(registry, 'чат-правки', {
        model: 'sonnet',
        effort: 'medium',
        appendSystemPrompt: FIX_APPEND,
      });

      expect(stageRuns(runs)).toHaveLength(0);
      const [deliver] = deferred;
      expect(links.get(deliver?.chatId ?? '')?.stage).toBe('deliver');
      expect(deliver?.sessionId).toBeUndefined();
      expect(deliver?.fork).toBeUndefined();
      expect(deliver?.prompt).not.toContain(WARM_DELIVER_LINE);
    });

    it('окно у сжатия — доставка с чистого листа, как раньше', async () => {
      const { registry, links, runs } = build('Поправил.', {
        delivers: true,
        context: FULL_WINDOW,
      });
      links.set('чат-правки', FIX_LINK);

      await start(registry, 'чат-правки', {
        model: 'sonnet',
        effort: 'medium',
        appendSystemPrompt: FIX_APPEND,
      });

      const deliver = stageRuns(runs)[0];
      expect(links.get(deliver?.chatId ?? '')?.stage).toBe('deliver');
      expect(deliver?.sessionId).toBeUndefined();
      expect(deliver?.fork).toBeUndefined();
      expect(deliver?.append ?? '').not.toContain(FIX_APPEND);
      expect(deliver?.prompt).not.toContain(WARM_DELIVER_LINE);
    });

    it('другая модель у тёплой сессии — свой кэш не тот: доставка с чистого листа', async () => {
      const { registry, links, runs } = build('Поправил.', { delivers: true, context: 30_000 });
      links.set('чат-правки', FIX_LINK);

      await start(registry, 'чат-правки', { model: 'haiku', effort: 'medium' });

      const deliver = stageRuns(runs)[0];
      expect(deliver).toMatchObject({ model: 'sonnet' });
      expect(deliver?.sessionId).toBeUndefined();
    });
  });

  it('правки группы с доставкой знают, что доставка идёт следом (журнал 59d)', async () => {
    const verdict = ['```agentdeck:review', '{"findings":["поправь a.ts:1"]}', '```'].join('\n');
    const { registry, links, runs, saved } = build(`Проверил.\n${verdict}`, { delivers: true });
    links.set('чат-ревью', REVIEW_LINK);

    await run(registry, 'чат-ревью');

    const fix = stageRuns(runs)[0];
    expect(saved[0]?.stage).toBe('fix');
    expect(fix?.prompt).toContain('commit, push and MR are not forbidden by it');
  });

  it('конец доставки — конец цепочки: итог уходит конвейеру, звеньев больше нет', async () => {
    // Даже блок вердикта в ответе доставки правок не заводит: звено конечно.
    const verdict = ['```agentdeck:review', '{"findings":["ещё одно"]}', '```'].join('\n');
    const { registry, links, runs, ended } = build(
      `MR: https://git/x/-/merge_requests/9\n${verdict}`,
      {
        delivers: true,
      },
    );
    links.set('чат-доставка', { ...FIX_LINK, stage: 'deliver' });

    await run(registry, 'чат-доставка');

    expect(stageRuns(runs)).toEqual([]);
    expect(ended).toEqual([{ stage: 'deliver', status: 'done' }]);
  });

  // U6 (владелец, 12.10.2026): ревью — после КАЖДОЙ работы. Раньше работа на
  // потолке шла сразу в доставку (M8), и «готово» значило «никто не смотрел».
  it('работа на потолке группы с доставкой идёт в ревью, а не сразу в доставку', async () => {
    const { registry, links, runs, saved } = build('Сделал.', { delivers: true });
    links.set('чат-работы', { ...WORK_LINK, lowered: false });

    await run(registry, 'чат-работы');

    const review = stageRuns(runs)[0];
    expect(saved[0]?.stage).toBe('review');
    expect(links.get('чат-работы')?.deliveredAt).toBeUndefined();
    expect(links.get(review?.chatId ?? '')).toMatchObject({ stage: 'review' });
  });

  it('работа на потолке группы без доставки тоже получает ревью', async () => {
    const { registry, links, runs, ended } = build('Сделал.', { delivers: false });
    links.set('чат-работы', { ...WORK_LINK, lowered: false });

    await run(registry, 'чат-работы');

    expect(stageRuns(runs)).toHaveLength(1);
    // Ревью ответило без блока итога: своя работа группу этим не держит (L110).
    expect(ended).toEqual([{ stage: 'review', status: 'done' }]);
  });

  it('группа без доставки после правок кончается, как раньше', async () => {
    const { registry, links, runs, ended } = build('Поправил.', { delivers: false });
    links.set('чат-правки', FIX_LINK);

    await run(registry, 'чат-правки');

    expect(stageRuns(runs)).toEqual([]);
    expect(ended).toEqual([{ stage: 'fix', status: 'done' }]);
  });
});

describe('собственный блок продолжения группы (журнал 42c, 44)', () => {
  it('группа разделения продолжается по своему блоку без тумблера автомата', async () => {
    const { registry, links, runs, ended } = build(`Правки сделал.\n\n${handoffBlock()}`, {
      mtime: Date.now() + 60_000,
      context: FULL_WINDOW,
    });
    links.set('чат-работа', { ...WORK_LINK, lowered: false });

    await run(registry, 'чат-работа');

    const next = stageRuns(runs)[0];
    expect(next?.prompt).toContain('коммит, пуш, MR');
    // Продолжение идёт авторежимом группы, даже если прогон режим потерял.
    expect(next?.permissionMode).toBe(AUTONOMOUS_PERMISSION_MODE);
    expect(links.get(next?.chatId ?? '')?.parentChatId).toBe('родитель');
    // Конец продолжения — конец работы: за ним ревью (U6), и цепочку закрывает
    // уже оно — ровно один раз.
    expect(stageRuns(runs)).toHaveLength(2);
    expect(links.get(stageRuns(runs)[1]?.chatId ?? '')?.stage).toBe('review');
    expect(ended).toEqual([{ stage: 'review', status: 'done' }]);
  });

  it('план группы с блоком продолжения — всё равно работа, а не продолжение плана', async () => {
    const { registry, links, runs, saved } = build(`План готов.\n\n${handoffBlock()}`, {
      mtime: Date.now() + 60_000,
    });
    links.set('чат-план', { ...WORK_LINK, stage: 'plan', workModel: 'sonnet', task: 'задача' });

    await run(registry, 'чат-план');

    expect(saved[0]?.stage).toBe('work');
    // Первым пошло звено работы, а не чистая сессия по блоку плана.
    expect(stageRuns(runs)[0]?.prompt).not.toContain('коммит, пуш, MR');
  });

  // Живой прогон 25.09.2026: группа доделала свою функцию на первом ходе, а
  // продолжения по её же блокам («перейти к группам sum и isWeekend») чинили
  // чужие файлы и коммитили — задание группы шло в промпт «для ориентира».
  it('продолжение группы держит задание границей и кончается на потолке группы', async () => {
    const { registry, links, runs, ended } = build(
      `Правки сделал.

${handoffBlock()}`,
      {
        mtime: Date.now() + 60_000,
        every: true,
        context: FULL_WINDOW,
      },
    );
    links.set('чат-работа', { ...WORK_LINK, lowered: false });

    await run(registry, 'чат-работа');
    await new Promise((done) => setTimeout(done, 100));

    const hops = stageRuns(runs);
    // Продолжения до потолка группы, за ними — ревью работы (U6).
    expect(hops).toHaveLength(HANDOFF_GROUP_MAX_CHAIN + 1);
    expect(links.get(hops.at(-1)?.chatId ?? '')?.stage).toBe('review');
    const prompt = hops[0]?.prompt ?? '';
    expect(prompt.startsWith('This is a new session of a split group')).toBe(true);
    expect(prompt).toContain('do not take tasks of other groups');
    expect(prompt).toContain('answer with a short summary without a continuation block');
    // Задание группы — целиком и после предложения прошлой сессии.
    expect(
      prompt.indexOf(`Group task:
${FIRST_PROMPT}`),
    ).toBeGreaterThan(prompt.indexOf('коммит, пуш, MR'));
    // За потолком ход группы кончился, и дальше её ведёт конвейер — один раз.
    expect(ended).toHaveLength(1);
  });

  // E1 (замер 29.09–20.10): 24 чистые сессии групп — 13 % траты деревьев, и каждая
  // ~13 вызовов перечитывала то, что прежняя держала в окне, далеко от сжатия.
  it('группа с окном далеко от сжатия продолжает той же сессией, а не чистой (E1)', async () => {
    const { registry, links, runs, ended } = build(`Правки сделал.\n\n${handoffBlock()}`, {
      mtime: Date.now() + 60_000,
      context: 30_000,
    });
    links.set('чат-работа', { ...WORK_LINK, lowered: false });

    await run(registry, 'чат-работа');
    await new Promise((done) => setTimeout(done, 50));

    const same = runs.filter((item) => item.chatId === 'чат-работа');
    expect(same).toHaveLength(2);
    // Тот же разговор и та же сессия CLI — то, что в окне, остаётся в окне.
    expect(same[1]?.sessionId).toBe('sess-звено');
    expect(same[1]?.permissionMode).toBe(AUTONOMOUS_PERMISSION_MODE);
    const prompt = same[1]?.prompt ?? '';
    expect(prompt.startsWith('Continue in this same session')).toBe(true);
    expect(prompt).toContain('Next: коммит, пуш, MR');
    // Новой сессии продолжения не было: первым новым разговором пошло ревью.
    expect(stageRuns(runs)).toHaveLength(1);
    expect(links.get(stageRuns(runs)[0]?.chatId ?? '')?.stage).toBe('review');
    expect(ended).toEqual([{ stage: 'review', status: 'done' }]);
  });

  // Ревью 20.10: флаги одного хода (`wake` — разбудить по фону, `hold` — придержать)
  // ехали в параметрах прогона дальше и доставались каждому ходу той же сессией.
  it('ход той же сессией не наследует флаг разбудившего хода', async () => {
    const { registry, links, runs } = build(`Правки сделал.\n\n${handoffBlock()}`, {
      mtime: Date.now() + 60_000,
      context: 30_000,
    });
    links.set('чат-работа', { ...WORK_LINK, lowered: false });

    registry.start(
      'чат-работа',
      { prompt: FIRST_PROMPT, cwd: CWD, wake: true },
      { projectPath: CWD },
    );
    await new Promise((done) => setTimeout(done, 70));

    const same = runs.filter((item) => item.chatId === 'чат-работа');
    expect(same[0]?.wake).toBe(true);
    expect(same[1]?.sessionId).toBe('sess-звено');
    expect(same[1]?.wake).toBeUndefined();
  });

  // Ревью 20.10: брокер прав ищет ход по ключу запуска. Первый ход группы идёт под
  // временным `new-…`, ход той же сессией — под ключом сессии, и вопрос человеку
  // с прежним ключом получал бы отказ «прогон неизвестен».
  it('ход той же сессией спрашивает права под своим ключом, а не временным', async () => {
    const { registry, links, runs } = build(`Правки сделал.\n\n${handoffBlock()}`, {
      mtime: Date.now() + 60_000,
      context: 30_000,
    });
    links.set('new-1', { ...WORK_LINK, lowered: false });

    registry.start(
      'new-1',
      {
        prompt: FIRST_PROMPT,
        cwd: CWD,
        permissionPrompt: { runId: 'new-1', baseUrl: 'http://127.0.0.1:5178' },
      },
      { projectPath: CWD },
    );
    await new Promise((done) => setTimeout(done, 70));

    const resumed = runs.find((item) => item.sessionId === 'sess-звено');
    expect(resumed?.chatId).toBe('sess-звено');
    expect(resumed?.runId).toBe('sess-звено');
  });

  // Ревью 20.10: порог окна человека (не предложение агента) у группы вёл в ту же
  // сессию, окно за порогом не уменьшалось, и порог срабатывал на каждом ходу до
  // потолка цепочки — три пустых хода, а ревью за ними наследовало потолок.
  it('порог окна человека ведёт группу в чистую сессию один раз, а не в ту же по кругу', async () => {
    const { registry, links, runs, ended } = build(
      'Готово, переименовал. Обновил .agent/PROGRESS.md.',
      {
        mtime: Date.now() + 60_000,
        every: true,
        contextLimit: 100_000,
        context: (runOptions) => (runOptions.prompt === FIRST_PROMPT ? 110_000 : 30_000),
      },
    );
    links.set('чат-работа', { ...WORK_LINK, lowered: false });

    await run(registry, 'чат-работа');
    await new Promise((done) => setTimeout(done, 100));

    expect(runs.filter((item) => item.chatId === 'чат-работа')).toHaveLength(1);
    expect(runs.some((item) => item.prompt.startsWith('Continue in this same session'))).toBe(
      false,
    );
    const [fresh, review] = stageRuns(runs);
    expect(fresh?.sessionId).toBeUndefined();
    expect(links.get(review?.chatId ?? '')?.stage).toBe('review');
    expect(ended).toEqual([{ stage: 'review', status: 'done' }]);
  });

  it('продолжение той же сессией держит тот же потолок цепочки группы', async () => {
    const { registry, links, runs, ended } = build(`Правки сделал.\n\n${handoffBlock()}`, {
      mtime: Date.now() + 60_000,
      every: true,
      context: 30_000,
    });
    links.set('чат-работа', { ...WORK_LINK, lowered: false });

    await run(registry, 'чат-работа');
    await new Promise((done) => setTimeout(done, 150));

    // Первый ход и продолжения до потолка — все в той же сессии, дальше ревью.
    expect(runs.filter((item) => item.chatId === 'чат-работа')).toHaveLength(
      HANDOFF_GROUP_MAX_CHAIN + 1,
    );
    expect(stageRuns(runs)).toHaveLength(1);
    expect(links.get(stageRuns(runs)[0]?.chatId ?? '')?.stage).toBe('review');
    expect(ended).toHaveLength(1);
  });

  it('прямой ход планировщика той же сессией говорит об этом в ленте', async () => {
    const { planner, links } = build('', { mtime: Date.now() + 60_000 });
    links.set('чат-работа', { ...WORK_LINK, lowered: false });

    const event = planner({
      chatId: 'чат-работа',
      sessionId: 'sess-работа',
      projectPath: CWD,
      text: `Правки сделал.\n\n${handoffBlock()}`,
      ok: true,
      startedAt: Date.now() - 1_000,
      contextTokens: 42_400,
      options: { prompt: FIRST_PROMPT, cwd: CWD },
    });

    expect(event).toMatchObject({
      kind: 'notice',
      code: 'groupSameSession',
      textCode: 'group-same-session-notice',
      textParams: { tokens: '42', window: '200' },
    });
  });

  // «/clear, затем продолжай по PROGRESS.md» у группы — привычка глобального
  // правила: чистую сессию она не заводит (E1). Но и не глохнет — иначе
  // недоделанная работа ушла бы прямо в ревью. Окно у сжатия здесь нарочно:
  // проза группы идёт той же сессией всегда, сжатие CLI сделает сам.
  const PROSE = 'Этап закрыт. Перезапустите сессию. Новый прогон читает .agent/PROGRESS.md.';

  it('просьба словами у группы разделения — продолжение той же сессией, даже у сжатия', async () => {
    const { registry, links, runs, ended } = build(PROSE, {
      mtime: Date.now() + 60_000,
      context: FULL_WINDOW,
    });
    links.set('чат-работа', { ...WORK_LINK, lowered: false });

    await run(registry, 'чат-работа');
    await new Promise((done) => setTimeout(done, 50));

    const same = runs.filter((item) => item.chatId === 'чат-работа');
    expect(same).toHaveLength(2);
    expect(same[1]?.sessionId).toBe('sess-звено');
    const prompt = same[1]?.prompt ?? '';
    expect(prompt.startsWith('Continue in this same session')).toBe(true);
    expect(prompt).toContain('.agent/PROGRESS.md');
    // Чистой сессии продолжения не было: первым новым разговором пошло ревью.
    expect(stageRuns(runs)).toHaveLength(1);
    expect(links.get(stageRuns(runs)[0]?.chatId ?? '')?.stage).toBe('review');
    expect(ended).toEqual([{ stage: 'review', status: 'done' }]);
  });

  it('просьба словами у группы без известной сессии не значит ничего: дальше ревью', async () => {
    const { planner, links, runs } = build('', { mtime: Date.now() + 60_000 });
    links.set('чат-работа', { ...WORK_LINK, lowered: false });

    planner({
      chatId: 'чат-работа',
      projectPath: CWD,
      text: PROSE,
      ok: true,
      startedAt: Date.now() - 1_000,
      contextTokens: 30_000,
      options: { prompt: FIRST_PROMPT, cwd: CWD },
    });
    await new Promise((done) => setTimeout(done, 20));

    expect(runs.filter((item) => item.chatId === 'чат-работа')).toHaveLength(0);
    expect(stageRuns(runs)).toHaveLength(1);
    expect(links.get(stageRuns(runs)[0]?.chatId ?? '')?.stage).toBe('review');
  });

  it('обычный разговор без тумблера по блоку не продолжается', async () => {
    const { registry, runs } = build(`Готово.\n\n${handoffBlock()}`, {
      mtime: Date.now() + 60_000,
    });

    await run(registry, 'обычный');

    expect(stageRuns(runs)).toEqual([]);
  });

  it('группа без права правок продолжается без него', async () => {
    const { registry, links, runs } = build(`Дальше.\n\n${handoffBlock()}`, {
      mtime: Date.now() + 60_000,
    });
    links.set('чат-работа', { ...WORK_LINK, lowered: false });

    await run(registry, 'чат-работа', 'default');

    expect(stageRuns(runs)[0]?.permissionMode).toBe('default');
  });
});

describe('POST /api/chat/handoff: продолжение группы разделения (журнал 44)', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let store: AppStore;
  let started: { chatId: string; permissionMode?: string }[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-deliver-'));
    project = mkdtempSync(join(tmpdir(), 'cc-deliver-proj-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    started = [];
    const registry = new ChatRunRegistry((): RunLike => ({
      start: async (options) => {
        started.push({
          chatId: options.permissionPrompt?.runId ?? '',
          ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
        });
      },
      stop: () => undefined,
    }));
    store = new AppStore(join(root, 'agentdeck'));
    store.setSplitPlan({
      parentChatId: 'parent-1',
      projectPath: project,
      createdAt: '2026-09-24T00:00:00.000Z',
      order: [0],
      request: { allowEdits: true },
      proposal: { groups: [] },
      groups: [],
    });
    store.setChatLink('sess-группа', {
      parentChatId: 'parent-1',
      title: 'Форма входа',
      createdAt: '2026-09-24T10:00:00.000Z',
      branch: 'fix-PROJ-1115',
      groupIndex: 0,
      model: 'sonnet',
    });
    const ctx = {
      location: {
        paths: {
          root,
          appData: join(root, 'agentdeck'),
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatHandoffRoutes(app, ctx, {
      runs: registry,
      chains: new HandoffChains(),
      providerChats: new ProviderChatService(),
      session: new ChatSession(registry),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('продолжение группы с правом правок идёт авторежимом, а не default', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: { projectPath: project, chatId: 'sess-группа', proposal: PROPOSAL },
    });

    expect(response.statusCode).toBe(200);
    expect(started[0]?.permissionMode).toBe(AUTONOMOUS_PERMISSION_MODE);
  });

  it('обычный разговор с правом правок продолжается в авторежиме чата', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: { projectPath: project, chatId: 'обычный', proposal: PROPOSAL, allowEdits: true },
    });

    expect(started[0]?.permissionMode).toBe(AUTONOMOUS_PERMISSION_MODE);
  });

  it('авторежим выключен глобально — продолжение обычного разговора в acceptEdits', async () => {
    store.updateSettings({ chatAutoMode: false });
    await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: { projectPath: project, chatId: 'обычный', proposal: PROPOSAL, allowEdits: true },
    });

    expect(started[0]?.permissionMode).toBe('acceptEdits');
  });

  it('группа, заведённая без права правок, его не получает', async () => {
    store.setSplitPlan({ ...store.getSplitPlan('parent-1')!, request: {} });

    await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: { projectPath: project, chatId: 'sess-группа', proposal: PROPOSAL },
    });

    expect(started[0]?.permissionMode).toBe('default');
  });
});
