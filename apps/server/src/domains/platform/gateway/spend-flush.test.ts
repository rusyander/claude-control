import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store.ts';
import { SpendFlusher } from './spend-flush.ts';

/**
 * Запись расхода пачкой.
 *
 * `AppStore.persist` пишет весь `state.json` синхронно, а расход считается после
 * КАЖДОГО ответа модели — поэтому он копится в памяти и уезжает на диск раз в
 * несколько секунд. Здесь проверено, что это именно откладывание, а не потеря:
 * накопленное дописывается и по таймеру, и на остановке шлюза, а отказ 402
 * (единственный точный факт о чужом бюджете) уезжает немедленно.
 */

const PLATFORM: Platform = {
  id: 'enterprise-platform-dev',
  title: 'EnterprisePlatform · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 100,
  budgetSince: '',
  capabilities: [],
  targets: [],
  projectPaths: [],
  agents: [],
  caCertPath: '',
};

let dir: string;
let store: AppStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-spend-'));
  store = new AppStore(dir);
  // Контуры настоящие: расход пишется только тем, кто есть в настройках —
  // удалённый не воскресает пачкой, собранной до удаления.
  store.updateSettings({
    platforms: [PLATFORM, { ...PLATFORM, id: 'другой', title: 'Второй' }],
  });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const delta = (totalTokens = 1_000) => ({
  model: 'enterprise-platform-corp-l',
  promptTokens: totalTokens,
  completionTokens: 0,
  totalTokens,
});

describe('SpendFlusher', () => {
  it('расход копится в памяти и на диск сразу НЕ уезжает', () => {
    vi.useFakeTimers();
    const flusher = new SpendFlusher({ store, flushMs: 5_000 });

    flusher.add('enterprise-platform-dev', delta());
    expect(store.getPlatformSpend()['enterprise-platform-dev']).toBeUndefined();

    vi.advanceTimersByTime(5_000);
    expect(store.getPlatformSpend()['enterprise-platform-dev']!.days[0]!.totalTokens).toBe(1_000);
  });

  it('за один сброс уезжает всё накопленное, а не последний ответ', () => {
    const flusher = new SpendFlusher({ store, flushMs: 5_000 });
    flusher.add('enterprise-platform-dev', delta(1_000));
    flusher.add('enterprise-platform-dev', delta(2_000));
    flusher.add('другой', delta(500));
    flusher.flush();

    const spend = store.getPlatformSpend();
    expect(spend['enterprise-platform-dev']!.days[0]!.totalTokens).toBe(3_000);
    expect(spend['enterprise-platform-dev']!.days[0]!.requests).toBe(2);
    expect(spend['другой']!.days[0]!.totalTokens).toBe(500);
  });

  it('ноль в задержке означает «сразу» — так учёт и проверяется прогоном', () => {
    const flusher = new SpendFlusher({ store, flushMs: 0 });
    flusher.add('enterprise-platform-dev', delta());
    expect(store.getPlatformSpend()['enterprise-platform-dev']!.days[0]!.totalTokens).toBe(1_000);
  });

  it('пустой расход не копится: лишний день означал бы «в этот день тратили»', () => {
    const flusher = new SpendFlusher({ store, flushMs: 0 });
    flusher.add('enterprise-platform-dev', delta(0));
    expect(store.getPlatformSpend()['enterprise-platform-dev']).toBeUndefined();
  });

  it('отказ 402 пишется НЕМЕДЛЕННО и уносит с собой накопленное', () => {
    vi.useFakeTimers();
    const flusher = new SpendFlusher({ store, flushMs: 5_000 });
    flusher.add('enterprise-platform-dev', delta());
    flusher.markExhausted('enterprise-platform-dev', new Date('2026-09-10T10:00:00.000Z'));

    const record = store.getPlatformSpend()['enterprise-platform-dev']!;
    expect(record.exhaustedAt).toBe('2026-09-10T10:00:00.000Z');
    // Накопленное не потеряно и не осталось ждать таймера.
    expect(record.days[0]!.totalTokens).toBe(1_000);
  });

  it('остановка шлюза дописывает хвост, а не выбрасывает его', () => {
    vi.useFakeTimers();
    const flusher = new SpendFlusher({ store, flushMs: 5_000 });
    flusher.add('enterprise-platform-dev', delta());
    flusher.stop();
    expect(store.getPlatformSpend()['enterprise-platform-dev']!.days[0]!.totalTokens).toBe(1_000);

    // Таймер снят: после остановки ничего больше не срабатывает.
    vi.advanceTimersByTime(60_000);
    expect(store.getPlatformSpend()['enterprise-platform-dev']!.days[0]!.requests).toBe(1);
  });

  it('нечего сбрасывать — файл не трогаем вовсе', () => {
    const flusher = new SpendFlusher({ store, flushMs: 0 });
    flusher.flush();
    expect(store.getPlatformSpend()).toEqual({});
  });

  // Найдено враждебным ревью Т8. Запись `state.json` идёт через временный файл и
  // переименование, а оно на Windows отбивается антивирусом или индексатором —
  // и этот отказ уходил наружу из колбэка таймера, где его некому поймать:
  // процесс панели падал целиком, а очередь к тому моменту была уже очищена.
  it('отказ диска не роняет процесс и не теряет накопленное', () => {
    vi.useFakeTimers();
    const flusher = new SpendFlusher({ store, flushMs: 5_000 });
    const save = vi.spyOn(store, 'savePlatformSpend').mockImplementation(() => {
      throw new Error('EPERM: rename state.json.tmp-1 -> state.json');
    });

    flusher.add('enterprise-platform-dev', delta(1_000));
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
    expect(save).toHaveBeenCalledTimes(1);

    // Диск отпустило — накопленное уезжает следующей пачкой целиком, вместе с
    // тем, что пришло после отказа.
    save.mockRestore();
    flusher.add('enterprise-platform-dev', delta(500));
    vi.advanceTimersByTime(5_000);
    const day = store.getPlatformSpend()['enterprise-platform-dev']!.days[0]!;
    expect(day.totalTokens).toBe(1_500);
    expect(day.requests).toBe(2);
  });

  // Тоже находка ревью: пачка живёт несколько секунд, и удаление успевает
  // случиться внутри неё. Идентификатор человек вправе занять заново, и новый
  // контур открылся бы с чужим расходом.
  it('удалённый контур пачкой не воскресает', () => {
    vi.useFakeTimers();
    const flusher = new SpendFlusher({ store, flushMs: 5_000 });
    flusher.add('enterprise-platform-dev', delta(1_000));

    store.updateSettings({ platforms: [] });
    vi.advanceTimersByTime(5_000);
    expect(store.getPlatformSpend()['enterprise-platform-dev']).toBeUndefined();
  });

  it('деньги считаются по ценам НА МОМЕНТ сброса, а не заведения счётчика', () => {
    const flusher = new SpendFlusher({
      store,
      flushMs: 0,
      lookup: () => ({
        entries: [
          {
            id: 'enterprise-platform-corp-l',
            label: 'EnterprisePlatform L',
            price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          },
        ],
      }),
    });
    flusher.add('enterprise-platform-dev', delta(1_000_000));
    expect(store.getPlatformSpend()['enterprise-platform-dev']!.days[0]!.money.usd).toBe(3);
  });
});
