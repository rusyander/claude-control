import { describe, it, expect } from 'vitest';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { ChildStageGroup } from '../ui/ChildStages.types';
import { mergeSplitGroups } from './mergeSplitGroups';
import { splitGroupKey } from './splitGroupKey';
import { hubCardKey } from './hubCardKey';

type Group = SplitPlanView['groups'][number];

const group = (index: number, extra: Partial<Group> = {}): Group => ({
  index,
  title: `Группа ${index}`,
  branch: `agent/g${index}`,
  after: [],
  status: 'pending',
  ...extra,
});

const plan = (groups: Group[], extra: Partial<SplitPlanView> = {}): SplitPlanView => ({
  parentChatId: 'parent',
  triage: { at: '2026-09-25T10:00:00.000Z', received: true, repairs: [], conflicts: [] },
  order: groups.map((item) => item.index),
  groups,
  ...extra,
});

const chatRow = (index: number, isRunning: boolean): [string, ChildStageGroup] => [
  splitGroupKey({ groupIndex: index, id: `c${index}` }),
  { chatId: `c${index}`, title: `Группа ${index}`, stages: ['work'], isRunning },
];

/**
 * Кнопка управления группой в строке хаба (журнал 81, 89). Проверяется то, чем
 * строка может соврать: кнопка не того действия, её нет у той, кому она нужна,
 * или срок сброса лимита не у той группы.
 */
describe('mergeSplitGroups — управление группой', () => {
  it('работающая группа — «Пауза», адрес — родитель и номер', () => {
    const rows = mergeSplitGroups(
      new Map([chatRow(0, true)]),
      plan([group(0, { status: 'started' })]),
    );
    expect(rows[0]?.control).toEqual({ parentChatId: 'parent', index: 0, actions: ['pause'] });
    expect(rows[0]?.isPaused).toBeUndefined();
  });

  it('остановленная группа — метка паузы и «Продолжить»', () => {
    const rows = mergeSplitGroups(
      new Map([chatRow(1, false)]),
      plan([group(1, { status: 'paused', pausedAt: '2026-09-25T10:05:00.000Z' })]),
    );
    expect(rows[0]?.isPaused).toBe(true);
    expect(rows[0]?.control?.actions).toEqual(['resume', 'drop']);
  });

  it('группа ждёт лимита — срок сброса её собственный', () => {
    const rows = mergeSplitGroups(
      new Map([chatRow(2, false)]),
      plan(
        [group(2, { status: 'awaiting', waitingFor: 'limit', limitUntil: '2026-09-25T15:00:00Z' })],
        { limitUntil: '2026-09-25T18:00:00Z' },
      ),
    );
    expect(rows[0]?.control).toEqual({
      parentChatId: 'parent',
      index: 2,
      actions: ['pause'],
      limitUntil: '2026-09-25T15:00:00Z',
    });
  });

  it('ждущая места без чата — «Запустить сейчас» со сроком лимита очереди и «Пауза»', () => {
    const rows = mergeSplitGroups(
      new Map(),
      plan([group(3)], { limitUntil: '2026-09-25T18:00:00Z' }),
    );
    expect(rows[0]?.pending).toBe('queued');
    expect(rows[0]?.control).toEqual({
      parentChatId: 'parent',
      index: 3,
      actions: ['start', 'pause'],
      limitUntil: '2026-09-25T18:00:00Z',
    });
  });

  it('до итога разбора, у стоящей по вопросу и у оборванной — кнопки нет', () => {
    const beforeTriage = mergeSplitGroups(new Map(), { ...plan([group(4)]), triage: undefined });
    expect(beforeTriage[0]?.control).toBeUndefined();

    const held = mergeSplitGroups(
      new Map(),
      plan([group(5, { status: 'held', hold: 'Какую ветку?' })]),
    );
    expect(held[0]?.control).toBeUndefined();

    const interrupted = mergeSplitGroups(
      new Map([chatRow(6, false)]),
      plan([
        group(6, {
          status: 'awaiting',
          waitingFor: 'interrupted',
          interruptedAt: '2026-09-25T10:00:00.000Z',
        }),
      ]),
    );
    expect(interrupted[0]?.control).toBeUndefined();
    expect(interrupted[0]?.interrupted?.index).toBe(6);
  });

  it('пауза до своего чата — метка и «Продолжить»; из очереди — с пометкой', () => {
    const queued = mergeSplitGroups(new Map(), plan([group(8, { status: 'paused' })]));
    expect(queued[0]?.pending).toBe('paused');
    expect(queued[0]?.control).toEqual({
      parentChatId: 'parent',
      index: 8,
      actions: ['resume', 'drop'],
      fromQueue: true,
    });

    // Остановлена во время подготовки ДО записи копии: пути нет, а место
    // группа держит — это решает сервер (`seated`), не догадка по `path`.
    const setup = mergeSplitGroups(new Map(), plan([group(9, { status: 'paused', seated: true })]));
    expect(setup[0]?.control?.fromQueue).toBeUndefined();
    expect(setup[0]?.control?.actions).toEqual(['resume', 'drop']);
  });

  it('чат группы ещё не доехал до списка — не «подготовка» и не «оборвана до чата»', () => {
    const started = mergeSplitGroups(
      new Map(),
      plan([group(11, { status: 'started', chatId: 'c-11' })]),
    );
    expect(started[0]?.pending).toBe('pending');
    const cut = mergeSplitGroups(
      new Map(),
      plan([group(12, { status: 'awaiting', waitingFor: 'interrupted', chatId: 'c-12' })]),
    );
    expect(cut[0]?.pending).toBe('pending');
    expect(cut[0]?.control).toBeUndefined();
  });

  it('стартовала, чата ещё нет — подготовка копии видна, её можно поставить на паузу', () => {
    const rows = mergeSplitGroups(new Map(), plan([group(10, { status: 'started' })]));
    expect(rows[0]?.pending).toBe('setup');
    expect(rows[0]?.control?.actions).toEqual(['pause']);
  });

  it('оборвалась до своего чата — «Завести заново» и «Убрать», а не тупик', () => {
    const rows = mergeSplitGroups(
      new Map(),
      plan([
        group(11, {
          status: 'awaiting',
          waitingFor: 'interrupted',
          interruptedAt: '2026-09-29T07:37:44.000Z',
        }),
      ]),
    );
    expect(rows[0]?.pending).toBe('interrupted');
    expect(rows[0]?.control?.actions).toEqual(['restart', 'drop']);
  });

  it('убранная без чата группа с копией — кнопка уборки копии', () => {
    const rows = mergeSplitGroups(
      new Map(),
      plan([group(12, { status: 'failed', path: 'C:/copies/12', error: 'x' })]),
    );
    expect(rows[0]?.copy).toEqual({ index: 12 });
    expect(rows[0]?.control).toBeUndefined();
  });

  it('закрытая группа — кнопки нет', () => {
    const rows = mergeSplitGroups(
      new Map([chatRow(7, false)]),
      plan([group(7, { status: 'done' })]),
    );
    expect(rows[0]?.control).toBeUndefined();
  });

  it('сдавшаяся группа с разговором и копией — «Продолжить» (владелец 05.10)', () => {
    const rows = mergeSplitGroups(
      new Map([chatRow(8, false)]),
      plan([group(8, { status: 'failed', path: 'C:/copies/8', error: 'Not logged in' })]),
    );
    expect(rows[0]?.control?.actions).toEqual(['continue']);
  });

  it('ход без итога ревью — «Продолжить» и «Пауза»', () => {
    const rows = mergeSplitGroups(
      new Map([chatRow(9, false)]),
      plan([group(9, { status: 'awaiting', waitingFor: 'review-missing', path: 'C:/copies/9' })]),
    );
    expect(rows[0]?.control?.actions).toEqual(['continue', 'pause']);
  });

  it('продолжать негде — убранная копия, отменённый план, нет копии', () => {
    const cleaned = mergeSplitGroups(
      new Map([chatRow(10, false)]),
      plan([
        group(10, {
          status: 'failed',
          path: 'C:/copies/10',
          cleaned: { at: '2026-10-05T10:00:00Z' } as Group['cleaned'],
        }),
      ]),
    );
    expect(cleaned[0]?.control?.actions ?? []).not.toContain('continue');
    const cancelled = mergeSplitGroups(
      new Map([chatRow(11, false)]),
      plan([group(11, { status: 'failed', path: 'C:/copies/11' })], {
        cancelledAt: '2026-10-05T10:00:00Z',
      }),
    );
    expect(cancelled[0]?.control?.actions ?? []).not.toContain('continue');
    const noCopy = mergeSplitGroups(
      new Map([chatRow(13, false)]),
      plan([group(13, { status: 'failed' })]),
    );
    expect(noCopy[0]?.control?.actions ?? []).not.toContain('continue');
  });

  it('убранная «Убрать» группа — без «Продолжить»: убрана без возврата (ревью R3)', () => {
    const rows = mergeSplitGroups(
      new Map([chatRow(14, false)]),
      plan([
        group(14, {
          status: 'failed',
          path: 'C:/copies/14',
          droppedAt: '2026-10-05T10:00:00Z',
        }),
      ]),
    );
    expect(rows[0]?.control?.actions ?? []).not.toContain('continue');
  });
});

/**
 * «Перепроверить MR» (владелец 05.10): кнопка есть только у доставленной группы
 * с MR и копией; зелёная отметка — время последней проверки, «перепроверяется»
 * — пока ход идёт.
 */
describe('mergeSplitGroups — перепроверка MR', () => {
  const delivered = (extra: Partial<Group> = {}): Group =>
    group(4, {
      status: 'done',
      deliver: true,
      mr: 'https://tracker.example.com/mr/4',
      path: 'C:/copies/4',
      chatId: 'c4',
      ...extra,
    });

  it('до первой проверки — кнопка без отметок', () => {
    const rows = mergeSplitGroups(new Map([chatRow(4, false)]), plan([delivered()]));
    expect(rows[0]?.recheck).toEqual({ parentChatId: 'parent', index: 4 });
  });

  it('проверка идёт — «перепроверяется» и во время хода', () => {
    const rows = mergeSplitGroups(
      new Map([chatRow(4, true)]),
      plan([delivered({ status: 'started', recheckRequestedAt: '2026-10-05T11:00:00Z' })]),
    );
    expect(rows[0]?.recheck?.requestedAt).toBe('2026-10-05T11:00:00Z');
  });

  it('закрытый MR — кнопка есть (его могут открыть), строка несёт состояние', () => {
    const rows = mergeSplitGroups(
      new Map([chatRow(4, false)]),
      plan([delivered({ mrClosed: 'closed' })]),
    );
    expect(rows[0]?.recheck).toBeDefined();
    expect(rows[0]?.mrClosed).toBe('closed');
  });

  it('проверка кончилась доставкой — время последней проверки', () => {
    const rows = mergeSplitGroups(
      new Map([chatRow(4, false)]),
      plan([delivered({ recheckedAt: '2026-10-05T11:30:00Z' })]),
    );
    expect(rows[0]?.recheck).toEqual({
      parentChatId: 'parent',
      index: 4,
      checkedAt: '2026-10-05T11:30:00Z',
    });
  });

  it('кнопки нет: другая работа идёт, нет MR, копия убрана, план отменён, не доставка', () => {
    const cases: Array<[Group, boolean, Partial<SplitPlanView>]> = [
      [delivered(), true, {}],
      [delivered({ mr: undefined }), false, {}],
      [delivered({ cleaned: { at: 'x' } as Group['cleaned'] }), false, {}],
      [delivered(), false, { cancelledAt: '2026-10-05T10:00:00Z' }],
      [delivered({ deliver: undefined }), false, {}],
      // Влитой MR перепроверять нечего — сервер откажет на каждое нажатие (ревью R4).
      [delivered({ mrClosed: 'merged' }), false, {}],
      [delivered({ chatId: undefined }), false, {}],
      // Ревью по ссылке смотрит чужой MR — сервер отказал бы всегда (ревью Q1).
      [delivered({ review: true }), false, {}],
    ];
    for (const [item, running, extra] of cases) {
      const rows = mergeSplitGroups(new Map([chatRow(4, running)]), plan([item], extra));
      expect(rows[0]?.recheck).toBeUndefined();
    }
  });
});

/**
 * «Перевести задачи» (G4): кнопка группы — когда сервер назвал её задачи; MR
 * не нужен, и без Jira она видна (владелец 06.10) — окно говорит, где подключить.
 */
describe('mergeSplitGroups — перевод задач', () => {
  const withTasks = (extra: Partial<Group> = {}): Group =>
    group(4, { mr: 'https://tracker.example.com/mr/4', taskKeys: ['PROJ-1', 'PROJ-2'], ...extra });

  it('задачи есть и Jira подключена — кнопка с ключами группы', () => {
    const rows = mergeSplitGroups(
      new Map([chatRow(4, true)]),
      plan([withTasks()], { jiraTasks: true }),
    );
    expect(rows[0]?.taskMove).toEqual({ index: 4, keys: ['PROJ-1', 'PROJ-2'], connected: true });
  });

  it('Jira не подключена — кнопка есть, но помечена: окно поведёт в «Интеграции»', () => {
    const off = mergeSplitGroups(new Map([chatRow(4, false)]), plan([withTasks()]));
    expect(off[0]?.taskMove).toEqual({ index: 4, keys: ['PROJ-1', 'PROJ-2'], connected: false });
  });

  it('кнопки нет, когда у группы нет задач трекера', () => {
    const none = mergeSplitGroups(
      new Map([chatRow(4, false)]),
      plan([withTasks({ taskKeys: [] })], { jiraTasks: true }),
    );
    expect(none[0]?.taskMove).toBeUndefined();
  });
});

describe('mergeSplitGroups — очередь слияния (G3)', () => {
  it('строка группы с чатом несёт своё место в очереди, без MR — нет', () => {
    const mr = (index: number) => `https://forge.example.com/mr/${index}`;
    const rows = mergeSplitGroups(
      new Map([chatRow(0, false), chatRow(1, false), chatRow(2, false)]),
      plan([
        group(0, { status: 'done', mr: mr(0), after: [1] }),
        group(1, { status: 'done', mr: mr(1) }),
        group(2, { status: 'started' }),
      ]),
    );
    expect(rows.map((row) => [row.title, row.mergeOrder])).toEqual([
      ['Группа 0', { position: 2, total: 2, before: ['Группа 1'] }],
      ['Группа 1', { position: 1, total: 2, before: [] }],
      ['Группа 2', undefined],
    ]);
  });
});

describe('hubCardKey — ключ карточки хаба (наблюдатель WR-9)', () => {
  it('группы без чата получают разные ключи, даже с одинаковым именем', () => {
    const key = splitGroupKey({ groupIndex: 0, id: '' });
    const merged = mergeSplitGroups(
      new Map<string, ChildStageGroup>([
        [key, { chatId: 'c0', title: 'Группа 0', stages: ['work'], isRunning: true }],
      ]),
      plan([
        group(0, { status: 'started', chatId: 'c0' }),
        group(1, { title: 'Тесты' }),
        group(2, { title: 'Тесты', after: [1] }),
      ]),
    );
    const keys = merged.map(hubCardKey);

    expect(merged.filter((item) => !item.chatId)).toHaveLength(2);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('c0');
  });
});
