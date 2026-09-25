import { describe, it, expect } from 'vitest';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { RunFinished } from './ChatRunRegistry.ts';
import { missingDelivery } from '../project-git/delivery-facts.ts';
import { localizeText } from '../../lib/server-texts.ts';
import {
  DELIVERY_BLOCKED_PROBES,
  DELIVERY_RECHECK_MS,
  SplitConveyor,
  type DeliveryVerdict,
  type SplitDeliveryDeps,
} from './split-conveyor.ts';

/**
 * Причина сбоя группы и строки «чего не хватило до доставки» в пульте едут с
 * кодом: хаб показывает их на языке интерфейса, а не русской строкой сервера.
 * Код читается из самой сохранённой строки — запись с прошлых запусков,
 * написанная до кодов, получает его так же.
 */

const PROPOSAL = {
  shared: '',
  groups: [
    { title: 'Форма входа', branch: 'feature/login', tasks: ['поправить вход'] },
    { title: 'Шапка', branch: 'feature/header', tasks: ['выровнять шапку'] },
  ],
};

function triageDone(): RunFinished {
  return {
    chatId: 'triage',
    projectPath: 'C:/repo',
    text: 'Ничего не нашёл.',
    ok: true,
    startedAt: 1,
    options: { prompt: '', cwd: 'C:/repo' },
    contextTokens: 0,
  };
}

function build(options: { failLaunch?: number[]; delivery?: SplitDeliveryDeps } = {}) {
  const records = new Map<string, SplitPlanRecord>();
  let tick = 0;
  const conveyor = new SplitConveyor({
    store: {
      get: (parent) => records.get(parent),
      set: (record) => void records.set(record.parentChatId, structuredClone(record)),
      findByTriage: (ids) =>
        [...records.values()].find((record) => ids.includes(record.triageChatId ?? '')),
      all: () => Object.fromEntries(records),
    },
    launch: async (record, groups): Promise<TaskSplitResult> => ({
      chats: groups.map((index) => ({
        index,
        title: record.proposal.groups[index]?.title ?? '',
        branch: record.groups[index]?.branch ?? '',
        chatId: `new-${index}`,
        path: `C:/copies/${index}`,
        isWorktree: true,
        started: !(options.failLaunch ?? []).includes(index),
        prompt: '',
        ...(options.delivery ? { deliver: true } : {}),
      })),
      failures: [],
    }),
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    watchOverlap: () => undefined,
    ...(options.delivery ? { delivery: options.delivery } : {}),
    log: () => undefined,
    now: () => new Date(2026, 8, 25, 12, 0, (tick += 1)),
  });
  const wait = () => new Promise((done) => setTimeout(done, 5));
  const start = async () => {
    await conveyor.begin({
      parentChatId: 'родитель',
      projectPath: 'C:/repo',
      proposal: PROPOSAL,
      request: {},
    });
    conveyor.onTriageFinished(triageDone(), ['triage']);
    await wait();
  };
  const link: ChatLink = {
    parentChatId: 'родитель',
    createdAt: '',
    branch: 'feature/login',
    stage: 'work',
  };
  const view = () => conveyor.view(['родитель'])?.groups[0];
  return { conveyor, records, start, wait, link, view };
}

function deliveryHarness(answers: DeliveryVerdict[]) {
  const timers: (() => void)[] = [];
  const delivery: SplitDeliveryDeps = {
    facts: async () => answers.shift() ?? { missing: [] },
    // Напоминание не уходит — группа сдаётся сразу, без круга напоминаний.
    nudge: () => 'refused',
    schedule: (run) => void timers.push(run),
  };
  const fire = async (): Promise<void> => {
    timers.shift()?.();
    await new Promise((done) => setTimeout(done, 5));
  };
  return { delivery, timers, fire };
}

describe('SplitConveyor: причина сбоя группы — с кодом', () => {
  it('прогон не запустился — код без подстановок, русская строка остаётся запасной', async () => {
    const { start, view } = build({ failLaunch: [0] });
    await start();

    expect(view()).toMatchObject({
      status: 'failed',
      error: 'прогон не запустился',
      errorCode: 'split-group-run-not-started',
    });
  });

  it('цепочка упала без своей причины — код общей причины', async () => {
    const { start, conveyor, link, view } = build();
    await start();

    conveyor.onChainEnded(link, { status: 'failed' });

    expect(view()).toMatchObject({ status: 'failed', errorCode: 'split-group-chain-failed' });
  });

  it('доставка не доведена — вложенные коды по каждому пробелу, и в причине, и в списке', async () => {
    const gaps = missingDelivery({ dirty: ['a.ts'], pushed: false }, 'feature/login');
    const h = deliveryHarness([{ missing: gaps }, { missing: gaps }]);
    const { start, conveyor, link, wait, view } = build({ delivery: h.delivery });
    await start();

    conveyor.onChainEnded(link, { status: 'done' });
    await wait();
    await h.fire();

    const group = view();
    expect(group?.status).toBe('failed');
    // Строка та же, что писалась до кодов: её читает и родитель, и чужой CLI.
    expect(group?.error).toBe(
      'доставка не доведена: незакоммиченные правки: a.ts; ' +
        'ветка feature/login не отправлена на удалённый (или отстаёт от HEAD копии); ' +
        'нет MR, чья голова — HEAD копии (ветка feature/login)',
    );
    expect(group?.errorCode).toBe('split-delivery-incomplete-3');
    expect(group?.errorParams).toEqual({
      first: { messageCode: 'delivery-gap-dirty', params: { files: 'a.ts' } },
      second: { messageCode: 'delivery-gap-not-pushed', params: { branch: 'feature/login' } },
      third: { messageCode: 'delivery-gap-no-mr', params: { branch: 'feature/login' } },
    });
    expect(group?.deliveryMissingCodes?.map((entry) => entry?.messageCode)).toEqual([
      'delivery-gap-dirty',
      'delivery-gap-not-pushed',
      'delivery-gap-no-mr',
    ]);
    expect(localizeText(group?.error ?? '', 'en')).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('много грязных файлов — «и ещё N» подстановкой, а не вплавленным текстом', () => {
    const dirty = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `${name}.ts`);
    const [gap] = missingDelivery({ dirty, pushed: true, mr: 'x' }, 'feature/login');

    expect(localizeText(gap ?? '', 'en')).not.toMatch(/[А-Яа-яЁё]/);
    expect(localizeText(gap ?? '', 'en')).toContain('2');
  });

  it('удалённый лежит — строка блокировки и итоговая причина с кодом', async () => {
    const down = { missing: [], unreachable: 'Could not resolve host' };
    const total = DELIVERY_RECHECK_MS.length + DELIVERY_BLOCKED_PROBES + 1;
    const h = deliveryHarness(Array.from({ length: total }, () => down));
    const { start, conveyor, link, wait, view } = build({ delivery: h.delivery });
    await start();

    conveyor.onChainEnded(link, { status: 'done' });
    await wait();
    expect(view()?.deliveryMissingCodes?.[0]).toMatchObject({
      messageCode: 'split-delivery-remote-silent',
      params: { reason: 'Could not resolve host' },
    });
    for (const _ms of DELIVERY_RECHECK_MS) await h.fire();
    expect(view()?.deliveryMissingCodes?.[0]?.messageCode).toBe('split-delivery-remote-down');

    while (h.timers.length > 0) await h.fire();
    expect(view()).toMatchObject({
      status: 'failed',
      errorCode: 'split-delivery-unverifiable',
      errorParams: { checks: String(total), reason: 'Could not resolve host' },
    });
  });

  it('запись с прошлого запуска, без кодов, получает код из своей строки', async () => {
    const { start, records, view } = build();
    await start();
    const record = records.get('родитель') as SplitPlanRecord;
    const group = record.groups[0] as SplitPlanRecord['groups'][number];
    group.status = 'failed';
    group.error = 'доставка не доведена: нет копии группы';
    records.set('родитель', record);

    expect(view()).toMatchObject({
      errorCode: 'split-delivery-incomplete',
      errorParams: { missing: { messageCode: 'delivery-gap-no-copy' } },
    });
  });

  it('чужая причина (текст ошибки запуска) кода не получает и едет как есть', async () => {
    const { start, records, view } = build();
    await start();
    const record = records.get('родитель') as SplitPlanRecord;
    const group = record.groups[0] as SplitPlanRecord['groups'][number];
    group.status = 'failed';
    group.error = 'spawn claude ENOENT';
    records.set('родитель', record);

    expect(view()?.error).toBe('spawn claude ENOENT');
    expect(view()?.errorCode).toBeUndefined();
  });
});
