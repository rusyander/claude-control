import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from './app-store.ts';
import { telegramSettingsSchema, webhookSettingsSchema } from '@agentdeck/contracts';

/**
 * Сохранённое состояние прежних версий сторожа групп — после обновления.
 * Проверка идёт настоящей загрузкой: `state.json` во временном каталоге, затем
 * `new AppStore` — ровно то, что делает сервер на старте.
 *
 * - Подписка: событие `groupSignal` снято вместе с сигналами (этап 10, G14). Сохранённый
 *   список с ним читается без него — строгая схема иначе отбивала бы каждое сохранение
 *   настроек, а прежний перенос выключателя `groupWatch.telegram` его больше не дописывает.
 * - Сигналы сторожа сняты: прежние места хранения читаются и не переживают запись.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-gw-migr-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stateFile = (): string => join(dir, 'state.json');
const writeState = (state: unknown): void =>
  writeFileSync(stateFile(), JSON.stringify(state), 'utf8');
const readState = (): Record<string, unknown> =>
  JSON.parse(readFileSync(stateFile(), 'utf8')) as Record<string, unknown>;

const TELEGRAM = { enabled: true, chatId: '1', events: ['runError', 'testFailed'] };
const WEBHOOK = { enabled: true, url: 'https://hooks.example.com/x', events: ['runError'] };

function stored(groupWatch: unknown): Record<string, unknown> {
  return {
    settings: {
      ...(groupWatch === undefined ? {} : { groupWatch }),
      integrations: { telegram: TELEGRAM, webhook: WEBHOOK },
    },
  };
}

const telegramEvents = (store: AppStore): readonly string[] =>
  store.getSettings().integrations.telegram.events;

describe('снятое событие groupSignal в сохранённой подписке', () => {
  it('Telegram и вебхук читаются без него и проходят строгую схему', () => {
    writeState({
      settings: {
        integrations: {
          telegram: { ...TELEGRAM, events: ['runError', 'groupSignal', 'testFailed'] },
          webhook: { ...WEBHOOK, events: ['groupSignal', 'runError'] },
        },
      },
    });
    const store = new AppStore(dir);
    const { telegram, webhook } = store.getSettings().integrations;
    expect(telegram.events).toEqual(['runError', 'testFailed']);
    expect(webhook.events).toEqual(['runError']);
    expect(telegramSettingsSchema.safeParse(telegram).success).toBe(true);
    expect(webhookSettingsSchema.safeParse(webhook).success).toBe(true);
  });

  it('прежний выключатель сторожа событие не возвращает; без снятого — список как был', () => {
    writeState(stored({ telegram: true }));
    expect(telegramEvents(new AppStore(dir))).toEqual(['runError', 'testFailed']);
    writeState(stored(undefined));
    expect(telegramEvents(new AppStore(dir))).toEqual(['runError', 'testFailed']);
  });

  it('первая запись не повторяет снятое событие на диске', () => {
    writeState({
      settings: { integrations: { telegram: { ...TELEGRAM, events: ['groupSignal'] } } },
    });
    const store = new AppStore(dir);
    store.setCodeView('C:/repo', {
      file: 'a.ts',
      openDirs: [],
      showDiff: false,
      onlyChanged: false,
    });
    const saved = readState() as { settings: { integrations: { telegram: { events: string[] } } } };
    expect(saved.settings.integrations.telegram.events).toEqual([]);
  });
});

// Сигнал прежней формы — типа в контрактах больше нет.
const SIGNAL = {
  id: 'sig-1',
  rule: 'R1',
  severity: 'alert',
  groupIndex: 0,
  chatId: 'work-1',
  at: '2026-10-22T10:00:00.000Z',
  numbers: { idleMin: 21 },
  textKey: 'groupWatch.rule.R1',
};

/**
 * Сигналы сторожа сняты (этап 10, G14): писатель ушёл с проводкой сторожа групп
 * панели, читатели — остров, фишки, маршрут — вслед. `state.json` прежней версии
 * читается: сигналы в записи группы (старое место), срез групп и срез чатов
 * сняты, всё остальное на месте, и первой записью прежние ключи не повторены.
 */
describe('сигналы сторожа сняты: прежний state.json', () => {
  it('старое место, срез групп и срез чатов не мешают чтению и не переживают запись', () => {
    writeState({
      splitPlans: {
        parent: {
          parentChatId: 'parent',
          projectPath: 'C:/repo',
          createdAt: '2026-10-22T09:00:00.000Z',
          groups: [{ index: 0, title: 'g', status: 'started', watch: { signals: [SIGNAL] } }],
        },
      },
      groupWatchSignals: { parent: { '0': { signals: [SIGNAL] } } },
      chatWatchSignals: { solo: { signals: [{ ...SIGNAL, groupIndex: -1, chatId: 'solo' }] } },
      chatKeyAliases: { 'new-1': 's1' },
    });
    const store = new AppStore(dir);
    expect(store.getSplitPlan('parent')?.groups[0]).toMatchObject({ index: 0, title: 'g' });
    expect(store.getSplitPlan('parent')?.groups[0]).not.toHaveProperty('watch');

    store.setCodeView('C:/repo', {
      file: 'a.ts',
      openDirs: [],
      showDiff: false,
      onlyChanged: false,
    });
    const saved = readState() as {
      splitPlans: Record<string, { groups: Array<Record<string, unknown>> }>;
    } & Record<string, unknown>;
    expect(saved).not.toHaveProperty('groupWatchSignals');
    expect(saved).not.toHaveProperty('chatWatchSignals');
    expect(saved.splitPlans.parent?.groups[0]).not.toHaveProperty('watch');
    expect(saved.splitPlans.parent?.groups[0]?.title).toBe('g');
    expect(saved.chatKeyAliases).toEqual({ 'new-1': 's1' });
  });
});
