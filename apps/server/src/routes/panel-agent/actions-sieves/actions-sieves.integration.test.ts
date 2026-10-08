import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BUILTIN_SIEVES, type SievesView } from '@agentdeck/contracts/sieves';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { SieveStore } from '../../../domains/chat/sieve-store/sieve-store.ts';
import { registerSieveRoutes } from '../../sieve-routes.ts';
import { HARNESS_ORIGIN, manageHarness, type ManageHarness } from '../manage-test-harness.ts';

/**
 * Сита перед MR через агента панели — настоящие маршруты `sieve-routes.ts` и
 * настоящий `sieves.json` во временном каталоге данных. Выученное сито пишет
 * хранилище тем же путём, что конвейер разделения (`learn` с пересланной
 * ссылкой треда), — подменён только клик человека по карточке.
 */

const MR = 'https://tracker.example.com/app/-/merge_requests/7';
const LEAKED = 'sk-ant-api03-LEAKEDLEAKEDLEAKEDLEAKEDLEAKED0000';

describe('panel-agent actions: pre-MR sieves', () => {
  let base: string;
  let appData: string;
  let h: ManageHarness;

  const onDisk = (): SievesView =>
    JSON.parse(readFileSync(join(appData, 'sieves.json'), 'utf8')) as SievesView;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'cc-agent-sieves-'));
    appData = join(base, '.claude', 'agentdeck');
    mkdirSync(appData, { recursive: true });
    new SieveStore(appData).learn({
      rows: [
        {
          thread: `${MR}#note_5`,
          class: 'contract',
          scope: 'project',
          trigger: 'a handler status code changes',
          check: `curl the endpoint on the branch stand with key ${LEAKED} and compare with docs`,
        },
      ],
      relayed: [`${MR}#note_5`],
      projectPath: '/repo',
      mr: MR,
    });
    const ctx = {
      store: new AppStore(appData),
      location: { paths: { appData }, source: 'default', isValid: true, missing: [] },
    } as unknown as ServerContext;
    h = await manageHarness(ctx, (app) => registerSieveRoutes(app, ctx));
  });

  afterEach(async () => {
    await h.close();
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('чтение: встроенные, выученное и счёт; ключ в тексте сита до модели не доходит', async () => {
    // Ключ правда лежит в файле — иначе «не дошёл» проверял бы пустоту.
    expect(JSON.stringify(onDisk())).toContain(LEAKED);
    const read = await h.call('read_sieves', {});
    expect(read.outcome).toBe('done');
    const view = read.result as {
      builtIn: { id: string }[];
      learned: { id: string; class: string; seen: number; check: string }[];
      tally: SievesView['tally'];
    };
    expect(view.builtIn.map((sieve) => sieve.id)).toEqual(BUILTIN_SIEVES.map((s) => s.id));
    expect(view.learned).toHaveLength(1);
    expect(view.learned[0]).toMatchObject({ class: 'contract', seen: 1 });
    expect(JSON.stringify(read)).not.toContain(LEAKED);
    expect(Object.values(view.tally)[0]).toEqual({ contract: { escaped: 1, caught: 0 } });
  });

  it('убрать сито — карточкой; отказ ничего не трогает, счёт остаётся', async () => {
    const id = onDisk().learned[0]?.id ?? '';
    const rejected = await h.decided('delete_learned_sieve', { id }, 'reject');
    expect(rejected.result.outcome).toBe('rejected');
    expect(onDisk().learned).toHaveLength(1);

    const { card, result } = await h.decided('delete_learned_sieve', { id });
    expect(result.outcome).toBe('done');
    expect(card.risk).toBe('danger');
    expect(card.preview.summaryCode).toBe('summary-delete-learned-sieve');
    expect(JSON.stringify(card)).not.toContain(LEAKED);
    expect(onDisk().learned).toEqual([]);
    expect(Object.keys(onDisk().tally)).toHaveLength(1);
  });

  it('предложенное сито принимает только человек; агент видит статус', async () => {
    const id = onDisk().learned[0]?.id ?? '';
    const before = (await h.call('read_sieves', {})).result as {
      learned: { status: string }[];
    };
    expect(before.learned[0]?.status).toBe('proposed');
    // Ни одно действие агента не ведёт на маршрут принятия.
    expect(JSON.stringify(await h.pendingCards())).not.toContain('accept');

    const accepted = await h.app.inject({
      method: 'POST',
      url: `/api/sieves/learned/${id}/accept`,
      headers: { origin: HARNESS_ORIGIN },
      payload: { scope: 'global' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(onDisk().learned[0]).toMatchObject({ status: 'active', scope: 'global' });

    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/sieves/learned/nope/accept',
      headers: { origin: HARNESS_ORIGIN },
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ messageCode: 'sieve-not-found' });
  });

  it('неизвестное сито — отказ до карточки', async () => {
    const missing = await h.call('delete_learned_sieve', { id: 'nope' });
    expect(missing.outcome).toBe('failed');
    expect(missing.message).toContain('read_sieves');
    expect(await h.pendingCards()).toEqual([]);
  });
});
