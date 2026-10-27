import { describe, expect, it } from 'vitest';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';
import type { DeliveryVerdict } from './split-conveyor.ts';
import type { MrReview } from '../../integrations/mr-review/mr-review.ts';
import { MrWatch } from '../mr-watch/mr-watch.ts';
import { harness } from './split-conveyor.escalation.fixture.ts';

/**
 * N3 (g5 25.10, MR !1101): наблюдатель MR передал группе красный конвейер, группа
 * ничего не поправила и не отправила («без лога нельзя ни починить, ни доказать»), и
 * через 20 секунд панель снова поставила ей «готово». Тот же конвейер второй раз не
 * судится — красный MR так и висел «готовым». Подменены только фордж и git-сверка;
 * наблюдатель, продолжение и конец хода — настоящие.
 */

const MR = 'https://git.example.com/team/app/-/merge_requests/1101';
const LINK: ChatLink = {
  parentChatId: 'родитель',
  createdAt: '',
  branch: 'feature/users',
  stage: 'work',
};
const settle = () => new Promise((done) => setTimeout(done, 5));
const red: MrReview = {
  state: 'open',
  author: 'rustam',
  threads: [],
  pipeline: {
    id: '11893',
    status: 'failed',
    failedJobs: [{ id: '217476', name: 'test-frontend', reason: 'script_failure' }],
  },
};

/** Группа доставлена с головой h1, наблюдатель передал ей красный конвейер. */
async function relayedRed(headAfter: string, later: DeliveryVerdict[] = []) {
  const h = harness(
    [{ missing: [], mr: MR, head: 'h1' }, { missing: [], mr: MR, head: headAfter }, ...later],
    { resume: 'sent' },
  );
  await h.start();
  h.conveyor.onChainEnded(LINK, { status: 'done' });
  await settle();
  expect(h.group()).toMatchObject({ status: 'done', mr: MR });

  const timers: (() => void)[] = [];
  const watch = new MrWatch({
    store: {
      get: (parent) => h.records.get(parent),
      set: (record) => void h.records.set(record.parentChatId, structuredClone(record)),
      all: () => Object.fromEntries(h.records),
    },
    read: async () => red,
    resume: (parent, index, prompt) => h.conveyor.resumeDelivered(parent, index, prompt),
    schedule: (run) => void timers.push(run),
    log: () => undefined,
  });
  watch.sync('родитель');
  timers.shift()?.();
  await settle();
  expect(h.words.map((word) => word.via)).toEqual(['continue']);
  expect(h.words[0]?.prompt).toContain('The MR pipeline failed: #11893');
  // Старт хода продолжения — как у настоящего прогона.
  h.conveyor.onChainResumed({ ...LINK }, h.group()?.chatId ?? 'new-0');
  return h;
}

describe('N3: красный конвейер после «готово» не починен — не «готово»', () => {
  it('ход кончился с той же головой — заметка человеку и ожидание человека, а не done', async () => {
    const h = await relayedRed('h1');
    const answer =
      'Причину падения test-frontend я не установил: лог джобы прочитать не удалось. ' +
      'Что нужно от человека: назвать пайплайн 11893 явно.';
    await h.round(answer);

    expect(h.group()).toMatchObject({ status: 'awaiting', waitingFor: 'mr-red' });
    expect(h.group()?.doneAt).toBeUndefined();
    const notice = h.notices.find(
      (event) => event.kind === 'notice' && event.code === 'mrWatchRed',
    );
    expect(notice).toMatchObject({
      textCode: 'split-mr-watch-red-unfixed-notice',
      textParams: { group: 'Пользователи', mr: MR, pipeline: '11893' },
    });
    expect(notice && 'text' in notice ? notice.text : '').toContain(MR);
    expect(notice && 'textParams' in notice ? notice.textParams?.answer : '').toContain(
      'назвать пайплайн 11893',
    );
  });

  it('группа отправила правку (новая голова) — обычное «готово», заметки нет', async () => {
    const h = await relayedRed('h2');
    await h.round('Починил тест, push в ту же ветку.');

    expect(h.group()?.status).toBe('done');
    expect(h.group()?.waitingFor).toBeUndefined();
    expect(h.notices.some((event) => event.kind === 'notice' && event.code === 'mrWatchRed')).toBe(
      false,
    );
    // Отметка передачи съедена этим ходом: следующее «готово» её уже не судит.
    expect(h.group()?.mrWatch?.redRelay).toBeUndefined();
  });
});

/**
 * F2 (g1 26.10): группа ждала человека из-за красного конвейера, повторённое задание прошло
 * (тот же конвейер #11893 стал success), а группа ещё час числилась «ждёт красный MR».
 * Наблюдатель смотрит конвейер и в этом ожидании; зелёный — сверка доставки панелью, без
 * хода группы. Подменены фордж и git-сверка; наблюдатель и конвейер — настоящие.
 */
describe('F2: красный позеленел, пока группа ждала человека', () => {
  const unfixed = 'Причину не установил. Что нужно от человека: перезапустить задание 217476.';

  async function waitingRed(later: DeliveryVerdict[], pipeline: MrReview['pipeline']) {
    const h = await relayedRed('h1', later);
    await h.round(unfixed);
    expect(h.group()).toMatchObject({ status: 'awaiting', waitingFor: 'mr-red' });
    expect(h.group()?.mrWatch?.redSince).toBeTruthy();
    const timers: (() => void)[] = [];
    const watch = new MrWatch({
      store: {
        get: (parent) => h.records.get(parent),
        set: (record) => void h.records.set(record.parentChatId, structuredClone(record)),
        all: () => Object.fromEntries(h.records),
      },
      read: async () => ({ ...red, ...(pipeline ? { pipeline } : {}) }),
      resume: () => 'refused',
      settleGreen: (parent, index, id) => h.conveyor.pipelineGreen(parent, index, id),
      schedule: (run) => void timers.push(run),
      log: () => undefined,
    });
    watch.sync('родитель');
    expect(timers).toHaveLength(1);
    timers.shift()?.();
    await settle();
    return { h, timers };
  }

  it('конвейер стал success, доставка чиста — «готово» без хода группы, заметка человеку', async () => {
    const { h } = await waitingRed([{ missing: [], mr: MR, head: 'h1' }], {
      id: '11893',
      status: 'success',
    });
    expect(h.group()).toMatchObject({ status: 'done', mr: MR });
    expect(h.group()?.waitingFor).toBeUndefined();
    expect(h.group()?.mrWatch?.pipeline).toEqual({ id: '11893', status: 'success' });
    expect(h.group()?.mrWatch?.redSince).toBeUndefined();
    // Ходов группы — только переданный красный.
    expect(h.words.map((word) => word.via)).toEqual(['continue']);
    const notice = h.notices.find(
      (event) => event.kind === 'notice' && event.code === 'mrWatchGreen',
    );
    expect(notice).toMatchObject({
      textCode: 'split-mr-watch-green-notice',
      textParams: { group: 'Пользователи', mr: MR, pipeline: '11893' },
    });
  });

  it('конвейер зелёный, а у доставки пробелы — напоминание с ними, не «готово»', async () => {
    const gap = { missing: ['Описание MR не называет проверку'], mr: MR, head: 'h1' };
    const { h } = await waitingRed([gap, gap], { id: '11893', status: 'success' });
    await h.fire();
    expect(h.group()?.status).toBe('awaiting');
    expect(h.group()?.waitingFor).toBe('delivery');
    expect(h.words.at(-1)?.via).toBe('nudge');
    expect(h.words.at(-1)?.prompt).toContain('Описание MR не называет проверку');
  });

  it('конвейер ещё красный — ожидание человека остаётся, следующая проверка поставлена', async () => {
    const { h, timers } = await waitingRed([], red.pipeline);
    expect(h.group()).toMatchObject({ status: 'awaiting', waitingFor: 'mr-red' });
    expect(
      h.notices.some((event) => event.kind === 'notice' && event.code === 'mrWatchGreen'),
    ).toBe(false);
    expect(timers).toHaveLength(1);
    expect(h.words.map((word) => word.via)).toEqual(['continue']);
  });
});
