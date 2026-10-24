import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GroupSignal } from '@agentdeck/contracts/group-watch';
import { AppStore } from './app-store.ts';
import { GROUP_SIGNAL_TELEGRAM_MIGRATION } from './state-file.ts';

/**
 * Сохранённое состояние прежних версий сторожа групп — после обновления.
 * Проверка идёт настоящей загрузкой: `state.json` во временном каталоге, затем
 * `new AppStore` — ровно то, что делает сервер на старте.
 *
 * - Подписка Telegram: прежде сигналы включал выключатель `groupWatch.telegram`
 *   (по умолчанию включён), теперь — событие `groupSignal` в списке Telegram.
 *   Сохранённый список перекрывает умолчания, и без переноса сигналы молча
 *   пропали бы (ревью W2).
 * - Срез сигналов (F-42): сигналы, лежавшие в записи разделения, переезжают в
 *   свой срез.
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

describe('перенос подписки Telegram на сигналы сторожа групп', () => {
  it('включённый прежний выключатель — groupSignal в списке Telegram; вебхук не трогается', () => {
    writeState(stored({ telegram: true }));
    const store = new AppStore(dir);
    expect(telegramEvents(store)).toEqual(['runError', 'testFailed', 'groupSignal']);
    expect(store.getSettings().integrations.webhook.events).toEqual(['runError']);
  });

  it('блок сторожа без выключателя — прежнее умолчание «включён»', () => {
    writeState(stored({ stallMinutes: 30 }));
    expect(telegramEvents(new AppStore(dir))).toContain('groupSignal');
  });

  it('выключенный выключатель и состояние без блока сторожа — список как был', () => {
    writeState(stored({ telegram: false }));
    expect(telegramEvents(new AppStore(dir))).toEqual(['runError', 'testFailed']);
    writeState(stored(undefined));
    expect(telegramEvents(new AppStore(dir))).toEqual(['runError', 'testFailed']);
  });

  it('один раз: снятая потом галочка не возвращается на следующем старте', () => {
    writeState(stored({ telegram: true }));
    const store = new AppStore(dir);
    store.saveGroupWatchSignals();
    const saved = readState();
    expect(saved.doneMigrations).toEqual([GROUP_SIGNAL_TELEGRAM_MIGRATION]);
    // Человек снял галочку: на диске список без groupSignal, блок сторожа без выключателя.
    const settings = saved.settings as { integrations: { telegram: { events: string[] } } };
    settings.integrations.telegram.events = ['runError'];
    writeState(saved);
    expect(telegramEvents(new AppStore(dir))).toEqual(['runError']);
  });
});

const SIGNAL: GroupSignal = {
  id: 'sig-1',
  rule: 'R1',
  severity: 'alert',
  groupIndex: 0,
  chatId: 'work-1',
  at: '2026-10-22T10:00:00.000Z',
  numbers: { idleMin: 21 },
  textKey: 'groupWatch.rule.R1',
};

describe('сигналы сторожа из записи разделения — в свой срез (F-42)', () => {
  const plan = (watch: unknown) => ({
    parentChatId: 'parent',
    projectPath: 'C:/repo',
    createdAt: '2026-10-22T09:00:00.000Z',
    groups: [{ index: 0, title: 'g', status: 'started', ...(watch ? { watch } : {}) }],
  });

  it('сигналы переезжают в срез, из записи группы уходят; на диске — так же после записи', () => {
    writeState({ splitPlans: { parent: plan({ signals: [SIGNAL] }) } });
    const store = new AppStore(dir);
    expect(store.getGroupWatchSignals('parent', 0)?.signals).toEqual([SIGNAL]);
    expect(store.getSplitPlan('parent')?.groups[0]?.watch).toBeUndefined();
    store.saveGroupWatchSignals();
    const saved = readState() as {
      splitPlans: Record<string, { groups: Array<Record<string, unknown>> }>;
      groupWatchSignals: unknown;
    };
    expect(saved.splitPlans.parent?.groups[0]).not.toHaveProperty('watch');
    expect(saved.groupWatchSignals).toEqual({ parent: { '0': { signals: [SIGNAL] } } });
  });

  it('срез уже знает группу — его блок остаётся; битые сигналы старого места — мимо', () => {
    const newer = { ...SIGNAL, id: 'sig-2' };
    writeState({
      splitPlans: { parent: plan({ signals: [null, SIGNAL] }) },
      groupWatchSignals: { parent: { '0': { signals: [newer] } } },
    });
    const store = new AppStore(dir);
    expect(store.getGroupWatchSignals('parent', 0)?.signals).toEqual([newer]);
    writeState({ splitPlans: { parent: plan({ signals: [null, SIGNAL] }) } });
    expect(new AppStore(dir).getGroupWatchSignals('parent', 0)?.signals).toEqual([SIGNAL]);
  });

  it('сигналы едут с записью к продолжению родителя', () => {
    writeState({ splitPlans: { parent: plan({ signals: [SIGNAL] }) } });
    const store = new AppStore(dir);
    expect(store.moveSplitPlan(['parent'], 'parent-2')).toBe(true);
    expect(store.getGroupWatchSignals('parent-2', 0)?.signals).toEqual([SIGNAL]);
    // Ход, начатый до переезда, читает по прежнему ключу — по цепочке переездов.
    expect(store.getGroupWatchSignals('parent', 0)?.signals).toEqual([SIGNAL]);
  });

  it('запись разделения вытеснена потолком — её сигналы уходят вместе с ней', () => {
    writeState({ splitPlans: { parent: plan({ signals: [SIGNAL] }) } });
    const store = new AppStore(dir);
    expect(store.getGroupWatchSignals('parent', 0)?.signals).toEqual([SIGNAL]);
    // Пятьдесят записей новее: самая старая (`parent`) вытесняется.
    for (let n = 0; n < 50; n += 1) {
      store.setSplitPlan({
        ...plan(undefined),
        parentChatId: `newer-${n}`,
        createdAt: `2026-10-23T09:${String(n).padStart(2, '0')}:00.000Z`,
      } as Parameters<AppStore['setSplitPlan']>[0]);
    }
    expect(store.getSplitPlan('parent')).toBeUndefined();
    expect(store.getAllGroupWatchSignals()).not.toHaveProperty('parent');
  });
});
