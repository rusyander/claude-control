import { describe, expect, it } from 'vitest';
import type { ChatLink, SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { matchText, serverText } from '../../../lib/server-texts/server-texts.ts';
import {
  corruptObjectStore,
  DELIVERY_BUSY_RECHECK_MS,
  DELIVERY_BUSY_RECHECKS,
  DELIVERY_RETRY_MS,
} from './split-conveyor.ts';
import { harness, NO_MR } from './split-conveyor.escalation.fixture.ts';

/**
 * Остановки доставки, которые агенты снимают сами (трасса автономии 24.10, §2):
 * занятый разговор группы — сверка снова, а не сдача; копия не прочлась или
 * встал разбор — повтор панели через срок; повтор пережил перезапуск; удалённый
 * ответил — ждущие и сданные на сверке читаются сразу. И одна, которую не снять
 * никому, кроме человека: повреждённое хранилище объектов git (INST-D).
 */

const MR = 'https://git.example.com/team/app/-/merge_requests/7';
const LINK: ChatLink = {
  parentChatId: 'родитель',
  createdAt: '',
  branch: 'feature/users',
  stage: 'work',
};
const codeOf = (line: string | undefined) => matchText(line ?? '')?.messageCode;
const settle = () => new Promise((done) => setTimeout(done, 5));
const same = { missing: [NO_MR], head: 'h1' };

/** Запись группы 0 после правки — как её оставил бы прежний процесс. */
function patch(
  h: ReturnType<typeof harness>,
  edit: (group: SplitPlanRecord['groups'][number]) => void,
  parent = 'родитель',
): void {
  const record = h.records.get(parent) as SplitPlanRecord;
  const group = record.groups[0] as SplitPlanRecord['groups'][number];
  edit(group);
  h.records.set(parent, record);
}

describe('разговор группы занят в миг новой доставки', () => {
  it('busy — сверка снова через срок, без сдачи; разговор освободился — новая доставка ушла', async () => {
    const h = harness([same, same, same], { stage: 'review', fresh: ['busy', 'sent'] });
    await h.start();
    await h.round();

    expect(h.group()).toMatchObject({ status: 'awaiting', waitingFor: 'delivery' });
    expect(h.group()?.deliveryMissing).toEqual([NO_MR]);
    expect(h.timers.map((timer) => timer.ms)).toEqual([DELIVERY_BUSY_RECHECK_MS]);
    // Занятому не слали ничего — ни слова, ни счёта напоминаний.
    expect(h.words).toEqual([]);
    expect(h.group()?.deliveryNudges).toBeUndefined();

    await h.fire();
    expect(h.words.map((word) => word.via)).toEqual(['deliver']);
    expect(h.group()?.status).not.toBe('failed');
  });

  it(`занят ${DELIVERY_BUSY_RECHECKS} сверок подряд — причина пунктом и повтор панели, а не вечное ожидание`, async () => {
    const answers = Array.from({ length: 2 + DELIVERY_BUSY_RECHECKS }, () => same);
    const h = harness(answers, { stage: 'review', fresh: ['busy'] });
    await h.start();
    await h.round();
    for (let recheck = 0; recheck < DELIVERY_BUSY_RECHECKS; recheck += 1) {
      expect(h.group()?.status).toBe('awaiting');
      await h.fire();
    }

    // Сдача без причины читалась «пробелы закроет агент», хотя слово не ушло ни разу.
    expect(h.group()).toMatchObject({ status: 'awaiting', waitingFor: 'delivery' });
    const missing = h.group()?.deliveryMissing ?? [];
    expect(missing.slice(0, 2).map(codeOf)).toEqual([
      'split-delivery-retry',
      'split-delivery-busy',
    ]);
    expect(missing.slice(2)).toEqual([NO_MR]);
    expect(h.group()?.deliveryRetry).toMatchObject({ count: 1, kind: 'verify' });
    expect(h.timers.map((timer) => timer.ms)).toEqual([DELIVERY_RETRY_MS]);
  });
});

describe('повтор панели вместо сдачи', () => {
  it('копия не прочлась — ждёт повтора; повтор нашёл доставку — done, счёт повторов снят', async () => {
    const h = harness([
      { missing: [], failed: 'EBUSY: resource busy or locked, open index.lock' },
      { missing: [], mr: MR },
    ]);
    await h.start();
    h.conveyor.onChainEnded(LINK, { status: 'done' });
    await settle();

    expect(h.group()).toMatchObject({ status: 'awaiting', waitingFor: 'delivery' });
    expect(h.group()?.deliveryRetry).toMatchObject({ count: 1, kind: 'verify' });
    expect(codeOf(h.group()?.deliveryMissing?.[0])).toBe('split-delivery-retry');
    expect(codeOf(h.group()?.deliveryMissing?.[1])).toBe('split-delivery-local-failed');
    expect(h.timers.map((timer) => timer.ms)).toEqual([DELIVERY_RETRY_MS]);

    await h.fire();
    expect(h.group()).toMatchObject({ status: 'done', mr: MR });
    expect(h.group()?.deliveryRetry).toBeUndefined();
    expect(h.group()?.deliveryMissing).toBeUndefined();
    expect(h.words).toEqual([]);
  });

  it('ждёт повтора — «Продолжить» сразу: срок виден пульту, повтор после слова человека молчит', async () => {
    const h = harness(
      [
        { missing: [], failed: 'EBUSY: resource busy or locked, open index.lock' },
        { missing: [], mr: MR },
      ],
      { resume: 'sent' },
    );
    await h.start();
    h.conveyor.onChainEnded(LINK, { status: 'done' });
    await settle();
    const at = h.group()?.deliveryRetry?.at;
    expect(at).toBeDefined();
    expect(h.conveyor.view(['родитель'])?.groups[0]?.deliveryRetryAt).toBe(at);

    // Час ожидания повтора — не повод держать человека: слово уходит сразу.
    expect(h.conveyor.continueGroup('родитель', 0, true)).toBe('sent');
    expect(h.group()?.deliveryRetry).toBeUndefined();
    expect(h.conveyor.view(['родитель'])?.groups[0]?.deliveryRetryAt).toBeUndefined();
    // Таймер повтора пережил слово, но сверку второй раз не заводит.
    await h.fire();
    expect(h.group()?.status).not.toBe('done');
  });

  it('повтор разбора — разбор заново с журналом кругов, а не ещё одно напоминание', async () => {
    const h = harness(Array.from({ length: 9 }, () => same));
    await h.start();
    await h.round();
    h.conveyor.onChainResumed({ ...LINK }, 'new-0');
    await h.round();
    h.conveyor.onChainResumed({ ...LINK, stage: 'deliver' }, 'new-escalate');
    await h.round();
    expect(h.group()?.deliveryRetry).toMatchObject({ count: 1, kind: 'escalate' });
    expect(h.words.map((word) => word.via)).toEqual(['nudge', 'escalate']);

    await h.fire();
    expect(h.words.map((word) => word.via)).toEqual(['nudge', 'escalate', 'escalate']);
    // Разбор — с потолком напоминаний (повтор ставит счёт на потолок), не «встало».
    expect(h.group()?.deliveryEscalatedAt).toBeDefined();
    expect(h.group()?.deliveryRetry).toEqual({ count: 1, kind: 'escalate' });
  });
});

describe('хранилище объектов git повреждено (INST-D)', () => {
  it('git сказал «bad object» — стоп сразу пунктом «нужен человек» с git fsck, без повторов', async () => {
    const h = harness([{ missing: [], failed: 'fatal: bad object HEAD' }]);
    await h.start();
    h.conveyor.onChainEnded(LINK, { status: 'done' });
    await settle();

    expect(h.group()?.status).toBe('failed');
    const [line] = h.group()?.deliveryMissing ?? [];
    expect(matchText(line ?? '')).toMatchObject({
      messageCode: 'delivery-human-corrupt-store',
      params: { path: 'C:/copies/0', what: 'fatal: bad object HEAD' },
    });
    expect(line).toContain('git fsck --full');
    expect(h.timers).toEqual([]);
    expect(h.group()?.deliveryRetry).toBeUndefined();
  });

  it('то же из ответа удалённого (unresolved deltas) — тоже стоп, а не ожидание сети', async () => {
    const h = harness([
      { missing: [], unreachable: 'fatal: pack has 3 unresolved deltas\nfatal: index-pack failed' },
    ]);
    await h.start();
    h.conveyor.onChainEnded(LINK, { status: 'done' });
    await settle();

    expect(h.group()?.status).toBe('failed');
    expect(codeOf(h.group()?.deliveryMissing?.[0])).toBe('delivery-human-corrupt-store');
    expect(h.timers).toEqual([]);
  });

  it('эхо команды с «bad tree» в аргументе — не поломка: обычный повтор сверки', () => {
    expect(
      corruptObjectStore('Command failed: git log bad tree/x\nfatal: not a git repository'),
    ).toBe(false);
    expect(corruptObjectStore('error: object file .git/objects/ab/cd is empty')).toBe(true);
    expect(corruptObjectStore('fatal: loose object 0123abcd (stored in x) is corrupt')).toBe(true);
    expect(corruptObjectStore('Could not resolve host: git.example.com')).toBe(false);
  });
});

describe('повтор и сданные на сверке после перезапуска панели', () => {
  it('ждал повтора сверки — сверяется сразу, а не через полчаса после старта', async () => {
    const h = harness([{ missing: [], mr: MR }]);
    await h.start();
    patch(h, (group) => {
      group.status = 'awaiting';
      group.waitingFor = 'delivery';
      group.deliveryRetry = { count: 1, at: '2099-01-01T00:00:00.000Z', kind: 'verify' };
    });

    h.conveyor.recoverDeliveryChecks();
    await settle();
    expect(h.group()).toMatchObject({ status: 'done', mr: MR });
    expect(h.timers).toEqual([]);
  });

  it('ждал повтора разбора — таймер на остаток срока, разбор не заводится при старте', async () => {
    const h = harness([same, same]);
    await h.start();
    const at = new Date(2026, 9, 23, 12, 10, 0).toISOString();
    patch(h, (group) => {
      group.status = 'awaiting';
      group.waitingFor = 'delivery';
      group.deliveryRetry = { count: 1, at, kind: 'escalate' };
    });

    h.conveyor.recoverDeliveryChecks();
    await settle();
    expect(h.words).toEqual([]);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.ms).toBeGreaterThan(9 * 60_000);
    expect(h.timers[0]?.ms).toBeLessThanOrEqual(10 * 60_000);

    await h.fire();
    expect(h.words.map((word) => word.via)).toEqual(['escalate']);
  });

  it('сдана на сверке — проба фактов: доставка лежит — done; не лежит — тишина, без слов', async () => {
    const h = harness([{ missing: [], mr: MR }]);
    await h.start();
    patch(h, (group) => {
      group.status = 'failed';
      group.error = serverText('split-delivery-unverifiable', { checks: 20, reason: 'HTTP 502' });
    });
    h.conveyor.recoverDeliveryChecks();
    await settle();
    expect(h.group()).toMatchObject({ status: 'done', mr: MR });

    const quiet = harness([same]);
    await quiet.start();
    patch(quiet, (group) => {
      group.status = 'failed';
      group.deliveryRetry = { count: 2, kind: 'verify' };
      group.deliveryMissing = ['панель повторила доставку сама (повторов: 2)', NO_MR];
    });
    quiet.conveyor.recoverDeliveryChecks();
    await settle();
    expect(quiet.group()?.status).toBe('failed');
    expect(quiet.group()?.deliveryMissing).toEqual([
      'панель повторила доставку сама (повторов: 2)',
      NO_MR,
    ]);
    expect(quiet.words).toEqual([]);
  });

  it('сдана на пробелах (разбор встал) — не проба: продолжает её только человек', async () => {
    const h = harness([{ missing: [], mr: MR }]);
    await h.start();
    patch(h, (group) => {
      group.status = 'failed';
      group.deliveryRetry = { count: 2, kind: 'escalate' };
    });
    h.conveyor.recoverDeliveryChecks();
    await settle();
    expect(h.group()?.status).toBe('failed');
  });
});

describe('удалённый ответил — соседи по корню копий не ждут своего срока', () => {
  /** Второй план того же проекта: его группа 0 — в заданном состоянии. */
  function neighbour(
    h: ReturnType<typeof harness>,
    edit: (group: SplitPlanRecord['groups'][number]) => void,
  ): void {
    const copy = structuredClone(h.records.get('родитель') as SplitPlanRecord);
    copy.parentChatId = 'второй';
    copy.triageChatId = 'triage-2';
    h.records.set('второй', copy);
    patch(h, edit, 'второй');
  }

  it('ответ на сверке одной группы — сданная на сверке соседка читается пробой и доставлена', async () => {
    const h = harness([
      { missing: [], mr: MR },
      { missing: [], mr: `${MR}0` },
    ]);
    await h.start();
    neighbour(h, (group) => {
      group.status = 'failed';
      group.deliveryRetry = { count: 2, kind: 'verify' };
    });

    h.conveyor.onChainEnded(LINK, { status: 'done' });
    await settle();
    await settle();
    expect(h.group()).toMatchObject({ status: 'done', mr: MR });
    expect(h.records.get('второй')?.groups[0]).toMatchObject({ status: 'done', mr: `${MR}0` });
  });

  it('соседка ждёт повтора сверки — сверяется сейчас', async () => {
    const h = harness([
      { missing: [], mr: MR },
      { missing: [], mr: `${MR}0` },
    ]);
    await h.start();
    neighbour(h, (group) => {
      group.status = 'awaiting';
      group.waitingFor = 'delivery';
      group.deliveryRetry = { count: 1, at: '2099-01-01T00:00:00.000Z', kind: 'verify' };
    });

    h.conveyor.onChainEnded(LINK, { status: 'done' });
    await settle();
    await settle();
    expect(h.records.get('второй')?.groups[0]).toMatchObject({ status: 'done', mr: `${MR}0` });
  });

  it('удалённый молчит — соседей не будит', async () => {
    const h = harness([
      { missing: [], unreachable: 'Could not resolve host' },
      { missing: [], mr: MR },
    ]);
    await h.start();
    neighbour(h, (group) => {
      group.status = 'failed';
      group.deliveryRetry = { count: 2, kind: 'verify' };
    });

    h.conveyor.onChainEnded(LINK, { status: 'done' });
    await settle();
    expect(h.records.get('второй')?.groups[0]?.status).toBe('failed');
  });
});
