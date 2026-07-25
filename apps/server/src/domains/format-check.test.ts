import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FORMAT_CHECK_REGISTRY,
  FormatCheckStore,
  runFormatCheck,
  schemaHasPath,
} from './format-check.ts';

/**
 * Сверка форматов чужих CLI со схемами (IDEA-3).
 *
 * Настоящая сеть здесь не трогается ни разу: `fetch` подменён. Проверяем то,
 * ради чего сверка и делалась, — что расхождение ЗАМЕЧАЕТСЯ, что отсутствие
 * схемы называется отсутствием схемы (а не «всё хорошо»), и что ни один отказ
 * сети не роняет ни остальных провайдеров, ни панель.
 */

const dir = (): string => mkdtempSync(join(tmpdir(), 'format-check-'));

const jsonResponse = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;

/** Схема OpenCode в том виде, в каком панель ожидает её увидеть. */
const goodSchema = {
  type: 'object',
  properties: {
    mcp: { type: 'object' },
    permission: { type: 'object' },
    plugin: { type: 'array' },
    experimental: { type: 'object', properties: { hook: { type: 'object' } } },
  },
};

const at = (iso: string) => (): Date => new Date(iso);

describe('schemaHasPath: поиск ключа в JSON Schema', () => {
  it('находит вложенный путь через properties', () => {
    expect(schemaHasPath(goodSchema, 'experimental.hook')).toBe(true);
    expect(schemaHasPath(goodSchema, 'mcp')).toBe(true);
  });

  it('не находит того, чего в схеме нет', () => {
    expect(schemaHasPath(goodSchema, 'experimental.plugin')).toBe(false);
    expect(schemaHasPath(goodSchema, 'выдуманное')).toBe(false);
  });

  it('раскрывает локальные $ref', () => {
    const schema = {
      properties: { experimental: { $ref: '#/$defs/Exp' } },
      $defs: { Exp: { properties: { hook: {} } } },
    };
    expect(schemaHasPath(schema, 'experimental.hook')).toBe(true);
  });

  it('заглядывает в ветви allOf/anyOf/oneOf', () => {
    const schema = { anyOf: [{ properties: { a: { allOf: [{ properties: { b: {} } }] } } }] };
    expect(schemaHasPath(schema, 'a.b')).toBe(true);
  });

  it('свободная карта (additionalProperties) принимает любой ключ', () => {
    const schema = { properties: { mcp: { additionalProperties: { properties: { type: {} } } } } };
    expect(schemaHasPath(schema, 'mcp.любойСервер.type')).toBe(true);
  });

  it('циклическая ссылка не подвешивает обход', () => {
    const schema: Record<string, unknown> = { $defs: {} };
    const node: Record<string, unknown> = { $ref: '#/$defs/Self' };
    (schema.$defs as Record<string, unknown>).Self = node;
    schema.properties = { root: node };
    expect(schemaHasPath(schema, 'root.нет')).toBe(false);
  });

  it('не схема — ключ считается ненайденным, а не «всё хорошо»', () => {
    expect(schemaHasPath(null, 'mcp')).toBe(false);
    expect(schemaHasPath('строка', 'mcp')).toBe(false);
  });
});

describe('runFormatCheck: обход реестра', () => {
  it('все ключи на месте → ok, и сходили ровно за одной схемой', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(goodSchema));
    const report = await runFormatCheck(at('2026-07-25T10:00:00.000Z'), fetchImpl as never);

    const opencode = report.providers.find((row) => row.providerId === 'opencode');
    expect(opencode?.state).toBe('ok');
    expect(opencode?.keys.map((key) => key.path)).toEqual(['mcp', 'permission', 'plugin']);
    // `experimental.hook` в реестре нет намеренно: сверка сама нашла, что ключ
    // исчез из схемы, и панель перестала его писать — писать перестали, значит и
    // сверять нечего.
    expect(opencode?.keys.some((key) => key.path.startsWith('experimental'))).toBe(false);
    expect(opencode?.keys.every((key) => key.present)).toBe(true);

    // В сеть ходим только к тем, у кого адрес схемы задокументирован.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(report.checkedAt).toBe('2026-07-25T10:00:00.000Z');
  });

  it('ключ пропал из схемы → drift, и видно КАКОЙ именно', async () => {
    // Ровно та ситуация, ради которой сверка и делалась: схема разошлась с тем,
    // что панель пишет. Здесь её изображает схема без ключа `plugin`.
    const withoutPlugin = { properties: { mcp: {}, permission: {} } };
    const report = await runFormatCheck(at('2026-07-25T10:00:00.000Z'), (async () =>
      jsonResponse(withoutPlugin)) as never);

    const opencode = report.providers.find((row) => row.providerId === 'opencode');
    expect(opencode?.state).toBe('drift');
    expect(opencode?.keys.filter((key) => !key.present).map((key) => key.path)).toEqual(['plugin']);
  });

  it('схема не скачалась → unavailable у одного провайдера, остальные целы', async () => {
    const report = await runFormatCheck(at('2026-07-25T10:00:00.000Z'), (async () => {
      throw new Error('нет сети');
    }) as never);

    const opencode = report.providers.find((row) => row.providerId === 'opencode');
    expect(opencode?.state).toBe('unavailable');
    expect(opencode?.note).toContain('нет сети');
    // Отказ сети не должен превращать «схемы нет» в «не проверено».
    expect(report.providers.filter((row) => row.state === 'no-schema')).toHaveLength(
      FORMAT_CHECK_REGISTRY.filter((spec) => !spec.schemaUrl).length,
    );
  });

  it('ответ не JSON Schema → unavailable, а не ложное «сходится»', async () => {
    const report = await runFormatCheck(at('2026-07-25T10:00:00.000Z'), (async () => ({
      ok: true,
      json: async () => 'страница логина',
    })) as never);
    expect(report.providers.find((row) => row.providerId === 'opencode')?.state).toBe(
      'unavailable',
    );
  });

  it('HTTP-ошибка → unavailable с кодом в пояснении', async () => {
    const report = await runFormatCheck(at('2026-07-25T10:00:00.000Z'), (async () => ({
      ok: false,
      status: 404,
    })) as never);
    const opencode = report.providers.find((row) => row.providerId === 'opencode');
    expect(opencode?.state).toBe('unavailable');
    expect(opencode?.note).toContain('404');
  });

  it('у кого схема не публикуется — так и сказано, и в сеть за ним не ходим', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(goodSchema));
    const report = await runFormatCheck(at('2026-07-25T10:00:00.000Z'), fetchImpl as never);

    for (const id of ['codex', 'gemini', 'qwen', 'continue', 'goose', 'kimi', 'cursor', 'aider']) {
      const row = report.providers.find((item) => item.providerId === id);
      expect(row?.state).toBe('no-schema');
      expect(row?.note).toMatch(/не публикуется/);
      expect(row?.schemaUrl).toBeUndefined();
      expect(row?.keys).toEqual([]);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('реестр сверки', () => {
  it('адреса схем — только https и по одному на провайдера', () => {
    const ids = FORMAT_CHECK_REGISTRY.map((spec) => spec.providerId);
    expect(new Set(ids).size).toBe(ids.length);

    for (const spec of FORMAT_CHECK_REGISTRY) {
      if (spec.schemaUrl) expect(spec.schemaUrl.startsWith('https://')).toBe(true);
      // Без схемы ключей быть не должно: иначе карточка обещала бы проверку,
      // которой нет.
      else expect(spec.keys).toEqual([]);
    }
  });

  it('у провайдера без схемы есть объяснение, у провайдера со схемой — ключи', () => {
    for (const spec of FORMAT_CHECK_REGISTRY) {
      if (spec.schemaUrl) expect(spec.keys.length).toBeGreaterThan(0);
      else expect(spec.noSchemaNote).toBeTruthy();
    }
  });
});

describe('FormatCheckStore: кэш на диске', () => {
  it('первый запуск: отчёта нет, результат считается устаревшим', () => {
    const store = new FormatCheckStore(dir());
    expect(store.current()).toBeUndefined();
    expect(store.isStale()).toBe(true);
  });

  it('refresh пишет кэш, а следующий запуск его поднимает', async () => {
    const appData = dir();
    const store = new FormatCheckStore(appData);
    await store.refresh(at('2026-07-25T10:00:00.000Z'), (async () =>
      jsonResponse(goodSchema)) as never);

    const cacheFile = join(appData, 'format-check.json');
    expect(existsSync(cacheFile)).toBe(true);
    expect(JSON.parse(readFileSync(cacheFile, 'utf8')).checkedAt).toBe('2026-07-25T10:00:00.000Z');

    const restored = new FormatCheckStore(appData);
    expect(restored.current()?.checkedAt).toBe('2026-07-25T10:00:00.000Z');
    // Свежий результат — в сеть не идём.
    expect(restored.isStale(at('2026-07-26T10:00:00.000Z'))).toBe(false);
    expect(restored.isStale(at('2026-08-25T10:00:00.000Z'))).toBe(true);
  });

  it('битый кэш не роняет старт: считаем, что сверки не было', () => {
    const appData = dir();
    writeFileSync(join(appData, 'format-check.json'), '{ это не json', 'utf8');
    const store = new FormatCheckStore(appData);
    expect(store.current()).toBeUndefined();
    expect(store.isStale()).toBe(true);
  });

  it('параллельные обновления делят один поход в сеть', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(goodSchema));
    const store = new FormatCheckStore(dir());
    await Promise.all([
      store.refresh(at('2026-07-25T10:00:00.000Z'), fetchImpl as never),
      store.refresh(at('2026-07-25T10:00:00.000Z'), fetchImpl as never),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refreshIfStale молчит на свежем кэше и не ждёт сеть на устаревшем', async () => {
    const appData = dir();
    const fetchImpl = vi.fn(async () => jsonResponse(goodSchema));
    const store = new FormatCheckStore(appData);
    await store.refresh(at('2026-07-25T10:00:00.000Z'), fetchImpl as never);

    store.refreshIfStale(at('2026-07-26T10:00:00.000Z'), fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    store.refreshIfStale(at('2026-08-25T10:00:00.000Z'), fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('фоновое обновление без сети не бросает наружу и честно пишет «не проверено»', async () => {
    const store = new FormatCheckStore(dir());
    store.refreshIfStale(at('2026-08-25T10:00:00.000Z'), (() => {
      throw new Error('сети нет');
    }) as never);

    // `refreshIfStale` ничего не ждёт — даём микрозадаче доехать.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const opencode = store.current()?.providers.find((row) => row.providerId === 'opencode');
    // Ключевое: недоступная схема — это `unavailable`, а НЕ «сходится».
    expect(opencode?.state).toBe('unavailable');
  });
});
