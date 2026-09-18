import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store.ts';
import { SpendFlusher } from './spend-flush.ts';
import { checkPlatform } from '../check.ts';
import { OPENROUTER_MODELS } from '../drivers/conformance/catalog-shapes.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

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
  id: 'company-dev',
  title: 'Company · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 100,
  budgetSince: '',
  capabilities: [],
  targets: [],
  projectPaths: [],
  consumers: [],
  agents: [],
  toolShim: true,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
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
  model: 'company-corp-l',
  promptTokens: totalTokens,
  completionTokens: 0,
  totalTokens,
});

describe('SpendFlusher', () => {
  it('расход копится в памяти и на диск сразу НЕ уезжает', () => {
    vi.useFakeTimers();
    const flusher = new SpendFlusher({ store, flushMs: 5_000 });

    flusher.add('company-dev', delta());
    expect(store.getPlatformSpend()['company-dev']).toBeUndefined();

    vi.advanceTimersByTime(5_000);
    expect(store.getPlatformSpend()['company-dev']!.days[0]!.totalTokens).toBe(1_000);
  });

  it('за один сброс уезжает всё накопленное, а не последний ответ', () => {
    const flusher = new SpendFlusher({ store, flushMs: 5_000 });
    flusher.add('company-dev', delta(1_000));
    flusher.add('company-dev', delta(2_000));
    flusher.add('другой', delta(500));
    flusher.flush();

    const spend = store.getPlatformSpend();
    expect(spend['company-dev']!.days[0]!.totalTokens).toBe(3_000);
    expect(spend['company-dev']!.days[0]!.requests).toBe(2);
    expect(spend['другой']!.days[0]!.totalTokens).toBe(500);
  });

  it('ноль в задержке означает «сразу» — так учёт и проверяется прогоном', () => {
    const flusher = new SpendFlusher({ store, flushMs: 0 });
    flusher.add('company-dev', delta());
    expect(store.getPlatformSpend()['company-dev']!.days[0]!.totalTokens).toBe(1_000);
  });

  it('пустой расход не копится: лишний день означал бы «в этот день тратили»', () => {
    const flusher = new SpendFlusher({ store, flushMs: 0 });
    flusher.add('company-dev', delta(0));
    expect(store.getPlatformSpend()['company-dev']).toBeUndefined();
  });

  it('ответ, за который контур не прислал счёт, из учёта НЕ исчезает', () => {
    const flusher = new SpendFlusher({ store, flushMs: 0 });
    // Так у платформы компании приходит картинка: 200, ответ дошёл, `usage`
    // нет. Токенов у него нет и выдумывать их нельзя — но и молчать нельзя:
    // без этого счётчика полоса бюджета уверенно показывает цифру ниже
    // настоящей и ничем не выдаёт своей неполноты.
    flusher.add('company-dev', { ...delta(0), unreported: true });

    const day = store.getPlatformSpend()['company-dev']!.days[0]!;
    expect(day.unreportedAnswers).toBe(1);
    // Ничего выдуманного: ни токенов, ни денег, ни запроса в общем счёте.
    expect(day.totalTokens).toBe(0);
    expect(day.money.usd).toBe(0);
    expect(day.requests).toBe(0);
  });

  it('отказ 402 пишется НЕМЕДЛЕННО и уносит с собой накопленное', () => {
    vi.useFakeTimers();
    const flusher = new SpendFlusher({ store, flushMs: 5_000 });
    flusher.add('company-dev', delta());
    flusher.markExhausted('company-dev', new Date('2026-09-10T10:00:00.000Z'));

    const record = store.getPlatformSpend()['company-dev']!;
    expect(record.exhaustedAt).toBe('2026-09-10T10:00:00.000Z');
    // Накопленное не потеряно и не осталось ждать таймера.
    expect(record.days[0]!.totalTokens).toBe(1_000);
  });

  it('остановка шлюза дописывает хвост, а не выбрасывает его', () => {
    vi.useFakeTimers();
    const flusher = new SpendFlusher({ store, flushMs: 5_000 });
    flusher.add('company-dev', delta());
    flusher.stop();
    expect(store.getPlatformSpend()['company-dev']!.days[0]!.totalTokens).toBe(1_000);

    // Таймер снят: после остановки ничего больше не срабатывает.
    vi.advanceTimersByTime(60_000);
    expect(store.getPlatformSpend()['company-dev']!.days[0]!.requests).toBe(1);
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

    flusher.add('company-dev', delta(1_000));
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
    expect(save).toHaveBeenCalledTimes(1);

    // Диск отпустило — накопленное уезжает следующей пачкой целиком, вместе с
    // тем, что пришло после отказа.
    save.mockRestore();
    flusher.add('company-dev', delta(500));
    vi.advanceTimersByTime(5_000);
    const day = store.getPlatformSpend()['company-dev']!.days[0]!;
    expect(day.totalTokens).toBe(1_500);
    expect(day.requests).toBe(2);
  });

  // Тоже находка ревью: пачка живёт несколько секунд, и удаление успевает
  // случиться внутри неё. Идентификатор человек вправе занять заново, и новый
  // контур открылся бы с чужим расходом.
  it('удалённый контур пачкой не воскресает', () => {
    vi.useFakeTimers();
    const flusher = new SpendFlusher({ store, flushMs: 5_000 });
    flusher.add('company-dev', delta(1_000));

    store.updateSettings({ platforms: [] });
    vi.advanceTimersByTime(5_000);
    expect(store.getPlatformSpend()['company-dev']).toBeUndefined();
  });

  it('деньги считаются по ценам НА МОМЕНТ сброса, а не заведения счётчика', () => {
    const flusher = new SpendFlusher({
      store,
      flushMs: 0,
      lookup: () => ({
        entries: [
          {
            id: 'company-corp-l',
            label: 'Company L',
            price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          },
        ],
      }),
    });
    flusher.add('company-dev', delta(1_000_000));
    expect(store.getPlatformSpend()['company-dev']!.days[0]!.money.usd).toBe(3);
  });
});

/**
 * Порог бюджета говорит наружу — ОДИН раз на переход (A-5).
 *
 * До этого порог считался и лежал в ответе, а читали его только карточка контура
 * и плитка «Обзор»: человек в чате узнавал о лимите из отказа 402. Здесь заперто
 * ровно то, чем это опасно чинить: повтор на каждый ответ модели.
 */
describe('SpendFlusher: порог бюджета наружу', () => {
  // Доллар за миллион входных токенов — цифра расхода считается сама, а не
  // подставляется в запись: порог обязан считаться от того же числа, что видит
  // карточка.
  const dollarPerMillion = () => ({
    entries: [
      {
        id: 'company-corp-l',
        label: 'Company L',
        price: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const flusherWith = (notices: unknown[]) =>
    new SpendFlusher({
      store,
      flushMs: 0,
      lookup: dollarPerMillion,
      notifyBudget: (notice) => notices.push(notice),
    });

  it('переход 85 % бюджета называется один раз, а не на каждый ответ', () => {
    const notices: unknown[] = [];
    const flusher = flusherWith(notices);

    // 80 $ из 100 — порог ещё не перейдён, и молчание здесь обязательно:
    // предупреждение до порога обесценивает сам порог.
    flusher.add('company-dev', delta(80_000_000));
    expect(notices).toEqual([]);

    // 86 $ — перешли.
    flusher.add('company-dev', delta(6_000_000));
    expect(notices).toEqual([
      { platformId: 'company-dev', platformTitle: 'Company · dev', level: 'near', share: 0.86 },
    ]);

    // Ещё три ответа внутри того же порога: повтор человек читает как сбой.
    flusher.add('company-dev', delta(1_000_000));
    flusher.add('company-dev', delta(1_000_000));
    flusher.add('company-dev', delta(1_000_000));
    expect(notices).toHaveLength(1);

    // Отметка лежит в ЗАПИСИ, а не в памяти процесса: перезапуск панели не
    // повод повторить сказанное.
    const saved = store.getPlatformSpend()['company-dev']!;
    expect(saved.announcedBudget).toEqual({ since: '', near: true });
    const afterRestart: unknown[] = [];
    flusherWith(afterRestart).add('company-dev', delta(1_000_000));
    expect(afterRestart).toEqual([]);
  });

  it('оценка дошла до бюджета — говорится отдельно от порога внимания', () => {
    const notices: unknown[] = [];
    const flusher = flusherWith(notices);
    flusher.add('company-dev', delta(90_000_000));
    flusher.add('company-dev', delta(15_000_000));

    expect(notices).toEqual([
      { platformId: 'company-dev', platformTitle: 'Company · dev', level: 'near', share: 0.9 },
      { platformId: 'company-dev', platformTitle: 'Company · dev', level: 'over', share: 1 },
    ]);
  });

  it('оба порога разом — одно сообщение про старший, отмечены оба', () => {
    const notices: Array<{ level: string }> = [];
    const flusher = flusherWith(notices as unknown[]);
    // Первый же ответ дороже всего бюджета: двух сообщений об одном событии
    // человек не ждёт, а «85 %» после «бюджет исчерпан» пугает задним числом.
    flusher.add('company-dev', delta(200_000_000));

    expect(notices).toEqual([
      { platformId: 'company-dev', platformTitle: 'Company · dev', level: 'over', share: 1 },
    ]);
    expect(store.getPlatformSpend()['company-dev']!.announcedBudget).toEqual({
      since: '',
      near: true,
      over: true,
    });
  });

  it('бюджет не введён — порога нет и сказать нечего', () => {
    store.updateSettings({ platforms: [{ ...PLATFORM, budgetUsd: 0 }] });
    const notices: unknown[] = [];
    flusherWith(notices).add('company-dev', delta(900_000_000));
    expect(notices).toEqual([]);
  });

  it('сменился период счёта — порог звучит заново', () => {
    const notices: Array<{ level: string }> = [];
    flusherWith(notices as unknown[]).add('company-dev', delta(90_000_000));
    expect(notices).toHaveLength(1);

    // Человек сдвинул начало периода: расход прежних дней в него уже не входит,
    // и отметка прошлого периода молчала бы про новый до самого отказа 402.
    store.updateSettings({ platforms: [{ ...PLATFORM, budgetSince: '2099-01-01' }] });
    const after: Array<{ level: string }> = [];
    const flusher = new SpendFlusher({
      store,
      flushMs: 0,
      lookup: dollarPerMillion,
      now: () => new Date('2099-01-02T10:00:00.000Z'),
      notifyBudget: (notice) => after.push(notice),
    });
    flusher.add('company-dev', delta(90_000_000));
    expect(after.map((notice) => notice.level)).toEqual(['near']);
  });

  it('запись не удалась — наружу не сказано: сказать и не запомнить значит повторить', () => {
    const notices: unknown[] = [];
    const flusher = flusherWith(notices);
    const save = vi.spyOn(store, 'savePlatformSpend').mockImplementation(() => {
      throw new Error('EPERM: rename state.json.tmp-1 -> state.json');
    });
    flusher.add('company-dev', delta(90_000_000));
    expect(notices).toEqual([]);

    // Диск отпустило — порог звучит со следующей пачкой, ровно один раз.
    save.mockRestore();
    flusher.add('company-dev', delta(1_000_000));
    expect(notices).toHaveLength(1);
  });
});

/**
 * Цена, опубликованная в каталоге шлюза (DRV-06). Путь настоящий от кнопки
 * «Проверить» до записи расхода: `checkPlatform` читает ответ формы OpenRouter и
 * кладёт каталог в хранилище, пачка берёт цену оттуда. Подменён только `fetch`.
 */
describe('SpendFlusher: цена из каталога шлюза', () => {
  const answer = () =>
    Promise.resolve(
      new Response(JSON.stringify(OPENROUTER_MODELS), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  const million = (model: string) => ({
    model,
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
    totalTokens: 2_000_000,
  });

  it('модель с опубликованной ценой считается по ней', async () => {
    await checkPlatform(store, dir, 'company-dev', answer);
    const flusher = new SpendFlusher({ store, flushMs: 0 });
    flusher.add('company-dev', million('openai/gpt-4o-mini'));

    const money = store.getPlatformSpend()['company-dev']!.days[0]!.money;
    // 0.15 $ за миллион входа + 0.6 $ за миллион выхода.
    expect(money.usd).toBe(0.75);
    expect(money.unpricedModels).toEqual([]);
  });

  it('своя цена человека перебивает опубликованную', async () => {
    await checkPlatform(store, dir, 'company-dev', answer);
    const flusher = new SpendFlusher({
      store,
      flushMs: 0,
      lookup: () => ({
        overrides: { 'gpt-4o-mini': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
      }),
    });
    flusher.add('company-dev', million('openai/gpt-4o-mini'));
    expect(store.getPlatformSpend()['company-dev']!.days[0]!.money.usd).toBe(2);
  });

  it('«-1» — цена неизвестна: токены без денег, модель названа', async () => {
    await checkPlatform(store, dir, 'company-dev', answer);
    const flusher = new SpendFlusher({ store, flushMs: 0 });
    flusher.add('company-dev', million('openrouter/auto'));
    const money = store.getPlatformSpend()['company-dev']!.days[0]!.money;
    expect(money.usd).toBe(0);
    expect(money.unpricedModels).toEqual(['openrouter/auto']);
  });

  it('цена одного контура не считает расход другого', async () => {
    await checkPlatform(store, dir, 'company-dev', answer);
    const flusher = new SpendFlusher({ store, flushMs: 0 });
    flusher.add('другой', million('openai/gpt-4o-mini'));
    expect(store.getPlatformSpend()['другой']!.days[0]!.money.unpricedModels).toEqual([
      'openai/gpt-4o-mini',
    ]);
  });
});
