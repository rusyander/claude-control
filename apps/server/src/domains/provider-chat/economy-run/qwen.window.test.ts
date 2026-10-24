import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GROUP_ECONOMY_DEFAULTS, type GroupEconomy } from '@agentdeck/contracts/group-economy';
import { qwenEconomyEnv } from './qwen.ts';

/**
 * @covers economy-run/qwen.ts (окно и доля автосжатия, вид входа по настройкам проекта)
 * @scenario доля автосжатия Qwen считается от того окна, на которое её умножит сам
 *   CLI: `model.generationConfig.contextWindowSize` его слитых настроек (системные →
 *   проекта → личные), затем окно каталога контура, затем каталог моделей по всем
 *   вендорам; доля — вниз до 4 знаков и только ниже порога, который действовал бы и
 *   без рычага. Вход через Anthropic виден и из настроек проекта, в порядке CLI.
 */

const SETTINGS = 'QWEN_CODE_SYSTEM_SETTINGS_PATH';

describe('economy-run/qwen window', () => {
  let appData: string;
  let home: string;
  let workdir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-qwen-window-'));
    home = join(appData, 'qwen-home');
    workdir = join(appData, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(workdir, '.qwen'), { recursive: true });
    // Файл машины подменён пустым: проверка не читает настроек этого компьютера.
    const machine = join(appData, 'machine.json');
    writeFileSync(machine, '{}');
    env = { QWEN_HOME: home, [SETTINGS]: machine };
  });

  afterEach(() => {
    rmSync(appData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const economy = (patch: Partial<GroupEconomy> = {}): GroupEconomy => ({
    ...GROUP_ECONOMY_DEFAULTS,
    ...patch,
  });
  interface SettingsTree {
    [key: string]: SettingsTree;
  }
  const settingsOf = (out: Record<string, string> | undefined): SettingsTree =>
    JSON.parse(readFileSync(out?.[SETTINGS] ?? '', 'utf8')) as SettingsTree;
  const seedCatalog = (models: { id: string; vendor: string; contextLimit?: number }[]): void => {
    writeFileSync(
      join(appData, 'models-cache.json'),
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        url: 'https://models.dev/api.json',
        models: models.map((m) => ({ ...m, name: m.id, family: m.vendor })),
        knownIds: [],
        newIds: [],
      }),
    );
  };
  const write = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value));
  const windowSetting = (size: number) => ({
    model: { generationConfig: { contextWindowSize: size } },
  });
  const threshold = (extra: Partial<Parameters<typeof qwenEconomyEnv>[0]> = {}): unknown =>
    settingsOf(
      qwenEconomyEnv({
        appData,
        env,
        economy: economy(),
        compactWindow: 100_000,
        workdir,
        ...extra,
      }),
    ).context?.autoCompactThreshold;

  it('window from merged Qwen settings beats the catalog: system → workspace → own', () => {
    // Каталог знает 1M, человек сказал CLI 131072 — Qwen умножит долю на 131072.
    seedCatalog([{ id: 'qwen3-coder-plus', vendor: 'alibaba', contextLimit: 1_000_000 }]);
    const run = { model: 'qwen3-coder-plus' };
    expect(threshold(run)).toBe(0.1);
    write(join(home, 'settings.json'), windowSetting(131_072));
    expect(threshold(run)).toBe(0.7629);
    // Настройки проекта главнее личных…
    write(join(workdir, '.qwen', 'settings.json'), windowSetting(200_000));
    expect(threshold(run)).toBe(0.5);
    // …а системные (файл прогона, у локальной модели его пишет слой окна) — главнее всех.
    write(env[SETTINGS] ?? '', windowSetting(400_000));
    expect(threshold(run)).toBe(0.25);
    // Проверка доверия включена — проект CLI может не прочитать, канал его не считает.
    write(env[SETTINGS] ?? '', { security: { folderTrust: { enabled: true } } });
    expect(threshold(run)).toBe(0.7629);
  });

  it('contour window (route.modelContext) when the settings carry none, before the catalog', () => {
    seedCatalog([{ id: 'contour-model', vendor: 'alibaba', contextLimit: 1_000_000 }]);
    expect(threshold({ model: 'contour-model', modelContext: 200_000 })).toBe(0.5);
    // Окно в настройках CLI главнее окна контура.
    write(join(home, 'settings.json'), windowSetting(125_000));
    expect(threshold({ model: 'contour-model', modelContext: 200_000 })).toBe(0.8);
  });

  it('catalog across all vendors, not only alibaba', () => {
    seedCatalog([
      { id: 'gpt-5', vendor: 'openai', contextLimit: 400_000 },
      { id: 'claude-sonnet-4-5', vendor: 'anthropic', contextLimit: 200_000 },
      { id: 'same-id', vendor: 'alibaba', contextLimit: 1_000_000 },
      { id: 'same-id', vendor: 'deepseek', contextLimit: 125_000 },
    ]);
    expect(threshold({ model: 'gpt-5' })).toBe(0.25);
    expect(threshold({ model: 'anthropic/claude-sonnet-4-5' })).toBe(0.5);
    // Имя с вендором выбирает его запись, а не первую с тем же id.
    expect(threshold({ model: 'deepseek/same-id' })).toBe(0.8);
    // Окна не знаем нигде — ключа нет, прочие рычаги слой везёт.
    expect(threshold({ model: 'unknown-model' })).toBeUndefined();
  });

  it('fraction floors to 4 decimals and stays below the threshold the CLI would use anyway', () => {
    seedCatalog([
      { id: 'big', vendor: 'alibaba', contextLimit: 1_000_000 },
      { id: 'local-ish', vendor: 'alibaba', contextLimit: 131_072 },
      { id: 'third', vendor: 'alibaba', contextLimit: 300_000 },
    ]);
    // 950k из 1M — 0,95 выше умолчания CLI 0,85: рычаг сжимал бы позже — ключа нет.
    expect(threshold({ model: 'big', compactWindow: 950_000 })).toBeUndefined();
    // 131070 из 131072 — округление вверх дало бы ровно 1; вниз — 0,9999, выше 0,85.
    expect(threshold({ model: 'local-ish', compactWindow: 131_070 })).toBeUndefined();
    // Вниз, а не к ближайшему: 2/3 → 0,6666.
    expect(threshold({ model: 'third', compactWindow: 200_000 })).toBe(0.6666);
    // Обычный случай пишется.
    expect(threshold({ model: 'big', compactWindow: 700_000 })).toBe(0.7);
    // Свой ключ человека дешевле (0,6) — 0,7 его не перекрывает.
    write(join(home, 'settings.json'), { context: { autoCompactThreshold: 0.6 } });
    expect(threshold({ model: 'big', compactWindow: 700_000 })).toBeUndefined();
    // Ключ человека выше умолчания (0,9) — 0,88 ниже него и пишется.
    write(join(home, 'settings.json'), { context: { autoCompactThreshold: 0.9 } });
    expect(threshold({ model: 'big', compactWindow: 880_000 })).toBe(0.88);
  });

  it('per-model window from modelProviders beats the top-level key, as Qwen applies it', () => {
    // Живая проба qwen 0.24.3 (Stop-хук, `context_limit`): окно записи модели главнее
    // ключа верхнего уровня; запись без окна — ключ верхнего уровня Qwen НЕ читает.
    const entry = (id: string, size?: number, extra: Record<string, unknown> = {}) => ({
      id,
      ...extra,
      ...(size ? { generationConfig: { contextWindowSize: size } } : { generationConfig: {} }),
    });
    const own = (providers: unknown, extra: Record<string, unknown> = {}) =>
      write(join(home, 'settings.json'), {
        security: { auth: { selectedType: 'openai' } },
        model: { name: 'm1', generationConfig: { contextWindowSize: 1_000_000 } },
        modelProviders: providers,
        ...extra,
      });
    own({ openai: [entry('m1', 200_000)] });
    expect(threshold()).toBe(0.5);
    // Запись есть, окна в ней нет — верхний ключ не в счёт: дальше окно контура…
    own({ openai: [entry('m1')] });
    expect(threshold({ modelContext: 400_000 })).toBe(0.25);
    // …а не знаем и его — ключа нет (таблицу окон самого Qwen канал не повторяет).
    expect(threshold()).toBeUndefined();
    // Запись другой модели — действует верхний ключ.
    own({ openai: [entry('other', 200_000)] });
    expect(threshold()).toBe(0.1);
    // Модель хода (флаг `--model`) главнее `model.name`.
    own({ openai: [entry('m2', 125_000)] });
    expect(threshold({ model: 'm2' })).toBe(0.8);
    // Свой id поставщика — по `providerProtocol`; без сопоставления он не openai.
    own({ mine: [entry('m1', 250_000)] }, { providerProtocol: { mine: 'openai' } });
    expect(threshold()).toBe(0.4);
    own({ mine: [entry('m1', 250_000)] });
    expect(threshold()).toBe(0.1);
    // `wireApi: responses` переводит вход openai → openai-responses, запись та же.
    own({ openai: [entry('m1', 160_000, { wireApi: 'responses' })] });
    expect(threshold()).toBe(0.625);
    // Две записи одной модели — выбирает сохранённый `model.baseUrl`.
    write(join(home, 'settings.json'), {
      security: { auth: { selectedType: 'openai' } },
      model: { name: 'm1', baseUrl: 'https://b.example' },
      modelProviders: {
        openai: [
          entry('m1', 500_000, { baseUrl: 'https://a.example' }),
          entry('m1', 200_000, { baseUrl: 'https://b.example' }),
        ],
      },
    });
    expect(threshold()).toBe(0.5);
    // `modelProviders` заменяется целиком старшим слоем, а не сливается.
    own({ openai: [entry('m1', 200_000)] });
    write(env[SETTINGS] ?? '', { modelProviders: { openai: [entry('other', 300_000)] } });
    expect(threshold()).toBe(0.1);
  });

  it('anthropic auth from workspace settings, in Qwen precedence', () => {
    const retention = (): unknown =>
      settingsOf(qwenEconomyEnv({ appData, env, workdir, economy: economy({ cacheTtl: '1h' }) }))
        .model?.generationConfig?.cacheRetention;
    const auth = (type: string) => ({ security: { auth: { selectedType: type } } });
    expect(retention()).toBeUndefined();
    // Вход выбран в настройках проекта — Anthropic.
    write(join(workdir, '.qwen', 'settings.json'), auth('anthropic'));
    expect(retention()).toBe('1h');
    // Проект главнее личных настроек.
    write(join(home, 'settings.json'), auth('openai'));
    expect(retention()).toBe('1h');
    // Системные главнее проекта.
    write(env[SETTINGS] ?? '', auth('openai'));
    expect(retention()).toBeUndefined();
    // Битый файл проекта не роняет рычаги: он просто не в счёт.
    write(env[SETTINGS] ?? '', {});
    writeFileSync(join(workdir, '.qwen', 'settings.json'), '{ "security": ');
    expect(retention()).toBeUndefined();
  });

  it('settings with comments count, as Qwen reads them (strip-json-comments)', () => {
    seedCatalog([{ id: 'qwen3-coder-plus', vendor: 'alibaba', contextLimit: 1_000_000 }]);
    const run = { model: 'qwen3-coder-plus', compactWindow: 200_000 };
    // Окно 128k и порог 0,5 человека: 200k из 128k — позже его порога, ключа нет.
    // Строгий разбор терял весь файл — окно бралось из каталога (1M) и писалось 0,2:
    // сжатие на 25,6k вместо 64k.
    writeFileSync(
      join(home, 'settings.json'),
      [
        '{',
        '  // свои заметки',
        '  "model": { "baseUrl": "http://127.0.0.1:1234/v1", /* адрес */',
        '    "generationConfig": { "contextWindowSize": 128000 } },',
        '  "context": { "autoCompactThreshold": 0.5 }',
        '}',
      ].join('\n'),
    );
    expect(threshold(run)).toBeUndefined();
    // Тот же файл с порогом выше доли — доля от окна 128k, а не от каталога.
    writeFileSync(
      join(home, 'settings.json'),
      '{ // окно\n "model": { "generationConfig": { "contextWindowSize": 400000 } } }',
    );
    expect(threshold(run)).toBe(0.5);
  });
});
