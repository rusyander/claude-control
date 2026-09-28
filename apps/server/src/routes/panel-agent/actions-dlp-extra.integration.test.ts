import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DlpJournalEntry, DlpRule } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { saveRules, type DlpProxy } from '../../domains/dlp.ts';
import { appendJournal, readJournal } from '../../domains/dlp/journal.ts';
import { registerDlpRoutes } from '../dlp-routes.ts';
import { manageHarness, type ManageHarness } from './manage-test-harness.ts';

/**
 * Проба текста правилами и журнал прокси защиты данных — настоящими маршрутами
 * раздела. Журнал пишет та же функция, что и прокси (`appendJournal`); очистка
 * доказывается файлом журнала, прочитанным мимо маршрута. Сам прокси подменён:
 * эти действия его не трогают.
 */
const rule: DlpRule = {
  id: 'name',
  name: 'Имя',
  enabled: true,
  kind: 'terms',
  terms: ['Урманов'],
  pattern: '',
  action: 'mask',
  label: 'ИМЯ',
};

const entry = (at: string): DlpJournalEntry => ({
  at,
  path: '/v1/messages',
  apiKind: 'anthropic',
  decision: 'masked',
  bytes: 120,
  hits: [{ ruleId: 'name', ruleName: 'Имя', action: 'mask', placeholder: '[ИМЯ_1]', count: 2 }],
});

describe('panel-agent actions: dlp extra', () => {
  let root: string;
  let appData: string;
  let h: ManageHarness;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-agent-dlp-x-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    const store = new AppStore(appData);
    saveRules(appData, [rule]);
    const proxy = {
      running: false,
      status: () => ({
        running: false,
        address: '',
        upstream: '',
        requests: 0,
        masked: 0,
        blocked: 0,
      }),
      start: async () => {},
      stop: async () => {},
    } as unknown as DlpProxy;
    const ctx = { location: { paths: { root, appData } }, store } as unknown as ServerContext;
    h = await manageHarness(ctx, (app) => registerDlpRoutes(app, ctx, proxy));
  });

  afterEach(async () => {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  });

  const call = (name: string, input: unknown) => h.call(name, input);
  const decided = (name: string, input: unknown, decision?: 'approve' | 'reject') =>
    h.decided(name, input, decision);

  it('проба: сохранённое правило маскирует имя, исходного значения в ответе нет', async () => {
    const out = await call('dlp_preview', { text: 'Отчёт подписал Урманов, затем снова Урманов.' });
    expect(out.outcome).toBe('done');
    const result = out.result as {
      blocked: boolean;
      masked: string;
      hits: { rule: string; count: number }[];
    };
    expect(result.blocked).toBe(false);
    expect(result.masked).not.toContain('Урманов');
    expect(result.masked).toContain('[ИМЯ_1]');
    expect(result.hits).toEqual([expect.objectContaining({ rule: 'Имя', count: 2 })]);

    // Пустой текст — отказ схемы, до маршрута.
    expect((await call('dlp_preview', { text: '' })).outcome).toBe('invalid');
  });

  it('журнал: записи прокси по порядку, с правилами и счётчиками; предел вне схемы — отказ', async () => {
    appendJournal(appData, entry('2026-09-28T10:00:00.000Z'));
    appendJournal(appData, entry('2026-09-28T11:00:00.000Z'));
    const out = await call('dlp_journal', {});
    expect(out.outcome).toBe('done');
    const result = out.result as { count: number; entries: { rules: string[] }[] };
    expect(result.count).toBe(2);
    expect(result.entries[0]!.rules).toEqual(['Имя ×2']);

    expect((await call('dlp_journal', { limit: 0 })).outcome).toBe('invalid');
  });

  it('очистка журнала: карточка называет число записей, одобрение опустошает файл', async () => {
    appendJournal(appData, entry('2026-09-28T10:00:00.000Z'));
    appendJournal(appData, entry('2026-09-28T11:00:00.000Z'));
    const { card, result } = await decided('clear_dlp_journal', {});
    expect(card.risk).toBe('danger');
    expect(card.preview.fields.map((field) => field.value)).toContain('2');
    expect(result.outcome).toBe('done');
    expect(readJournal(appData)).toEqual([]);
  });

  it('очистка журнала: отказ человека оставляет записи; пустой журнал — отказ до карточки', async () => {
    appendJournal(appData, entry('2026-09-28T10:00:00.000Z'));
    const { result } = await decided('clear_dlp_journal', {}, 'reject');
    expect(result.outcome).toBe('rejected');
    expect(readJournal(appData)).toHaveLength(1);

    appendJournal(appData, entry('2026-09-28T12:00:00.000Z'));
    // Запись, пришедшая между карточкой и кликом, — устаревшая карточка, не очистка.
    const running = h.call('clear_dlp_journal', {});
    let [card] = await h.pendingCards();
    for (let attempt = 0; !card && attempt < 500; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
      [card] = await h.pendingCards();
    }
    appendJournal(appData, entry('2026-09-28T13:00:00.000Z'));
    await h.app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card!.id}`,
      headers: { origin: 'http://localhost:8888' },
      payload: { decision: 'approve' },
    });
    const stale = await running;
    expect(stale.outcome).toBe('failed');
    expect(stale.messageCode).toBe('stale_preview');
    expect(readJournal(appData)).toHaveLength(3);

    await decided('clear_dlp_journal', {});
    const empty = await call('clear_dlp_journal', {});
    expect(empty.outcome).toBe('failed');
    expect(empty.message).toContain('already empty');
    expect(await h.pendingCards()).toEqual([]);
  });
});
