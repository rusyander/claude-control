import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { GROUP_ECONOMY_DEFAULTS, type GroupEconomy } from '@agentdeck/contracts/group-economy';
import { groupEconomySupportSchema } from '@agentdeck/contracts/group-economy-support';
import { qwenProvider } from '../../../providers/catalog/qwen.ts';
import {
  writeQwenLimits,
  writeQwenMcpExcluded,
  writeQwenQuietRun,
  writeQwenSystemNote,
} from '../system-note/system-note.ts';
import { economyRunEnv } from './economy-run.ts';
import { qwenAuthType, qwenEconomyEnv, qwenEconomyLayersRoot } from './qwen.ts';

/**
 * @covers economy-run/qwen.ts, providers/catalog/qwen.ts (groupEconomy)
 * @scenario рычаги экономии группы доходят до Qwen Code одним слоем системных
 *   настроек на прогон: доля окна для автосжатия (окно локальной модели или
 *   облачной из каталога), предел ответа инструментов, отвязка редактора, срок
 *   кэша — только при входе через Anthropic. Слой ложится поверх выбранного файла
 *   и один на разговор: тот же вход — тот же файл, начало запроса не меняется.
 *   Что Qwen эти ключи читает — проба живьём (`tools/qa/check-qwen-group-economy.mjs`).
 */

const SETTINGS = 'QWEN_CODE_SYSTEM_SETTINGS_PATH';

describe('economy-run/qwen', () => {
  let appData: string;
  let home: string;
  let env: Record<string, string>;

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-qwen-economy-'));
    home = join(appData, 'qwen-home');
    mkdirSync(home, { recursive: true });
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
  /** Файл слоя как дерево разделов: листья сравниваются `toBe`/`toEqual`, тип им не нужен. */
  interface SettingsTree {
    [key: string]: SettingsTree;
  }
  const settingsOf = (out: Record<string, string> | undefined): SettingsTree =>
    JSON.parse(readFileSync(out?.[SETTINGS] ?? '', 'utf8')) as SettingsTree;
  const seedCatalog = (models: { id: string; contextLimit?: number }[]): void => {
    writeFileSync(
      join(appData, 'models-cache.json'),
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        url: 'https://models.dev/api.json',
        models: models.map((m) => ({ ...m, name: m.id, family: 'qwen', vendor: 'alibaba' })),
        knownIds: [],
        newIds: [],
      }),
    );
  };

  it('threshold from local window', () => {
    const out = qwenEconomyEnv({
      appData,
      env,
      economy: economy(),
      compactWindow: 100_000,
      localContextWindow: 131_072,
    });
    const settings = settingsOf(out);
    expect(settings.context?.autoCompactThreshold).toBe(0.7629);
    // Слой — в своём корне, а не в корнях соседних слоёв.
    expect(dirname(dirname(out?.[SETTINGS] ?? ''))).toBe(qwenEconomyLayersRoot(appData));
  });

  it('threshold from the cloud window of the model catalog (contextLimit)', () => {
    seedCatalog([{ id: 'qwen3-coder-plus', contextLimit: 1_000_000 }]);
    const out = qwenEconomyEnv({
      appData,
      env,
      economy: economy(),
      compactWindow: 250_000,
      model: 'qwen3-coder-plus',
    });
    expect(settingsOf(out).context?.autoCompactThreshold).toBe(0.25);
    // Имя с префиксом провайдера находит ту же запись.
    const prefixed = qwenEconomyEnv({
      appData,
      env,
      economy: economy(),
      compactWindow: 250_000,
      model: 'alibaba/qwen3-coder-plus',
    });
    expect(settingsOf(prefixed).context?.autoCompactThreshold).toBe(0.25);
  });

  describe('CLI own model', () => {
    it("without the run model the CLI's own model decides the cloud window", () => {
      seedCatalog([
        { id: 'qwen-env-model', contextLimit: 400_000 },
        { id: 'qwen-settings-model', contextLimit: 200_000 },
      ]);
      const openai = {
        ...env,
        OPENAI_API_KEY: 'k',
        OPENAI_MODEL: 'qwen-env-model',
        OPENAI_BASE_URL: 'http://x',
      };
      const threshold = (runEnv: Record<string, string>) =>
        settingsOf(
          qwenEconomyEnv({ appData, env: runEnv, economy: economy(), compactWindow: 100_000 }),
        ).context?.autoCompactThreshold;
      // Переменная модели выбранного вида входа.
      expect(threshold(openai)).toBe(0.25);
      // `model.name` личных настроек главнее переменной.
      writeFileSync(
        join(home, 'settings.json'),
        JSON.stringify({ model: { name: 'qwen-settings-model' } }),
      );
      expect(threshold(openai)).toBe(0.5);
    });

    it('system model.name beats own settings and the env model', () => {
      seedCatalog([
        { id: 'qwen-env-model', contextLimit: 400_000 },
        { id: 'qwen-settings-model', contextLimit: 200_000 },
        { id: 'qwen-system-model', contextLimit: 125_000 },
      ]);
      const openai = {
        ...env,
        OPENAI_API_KEY: 'k',
        OPENAI_MODEL: 'qwen-env-model',
        OPENAI_BASE_URL: 'http://x',
      };
      writeFileSync(
        join(home, 'settings.json'),
        JSON.stringify({ model: { name: 'qwen-settings-model' } }),
      );
      // Системные настройки прогона (файл, выбранный до канала) главнее личных и переменной.
      writeFileSync(env[SETTINGS] ?? '', JSON.stringify({ model: { name: 'qwen-system-model' } }));
      const out = qwenEconomyEnv({
        appData,
        env: openai,
        economy: economy(),
        compactWindow: 100_000,
      });
      expect(settingsOf(out).context?.autoCompactThreshold).toBe(0.8);
    });
  });

  it('no threshold when window unknown or cw ≥ window', () => {
    seedCatalog([{ id: 'qwen-no-limit' }, { id: 'qwen-small', contextLimit: 128_000 }]);
    const cases = [
      { model: undefined },
      { model: 'not-in-catalog' },
      { model: 'qwen-no-limit' },
      { model: 'qwen-small', compactWindow: 128_000 },
      { model: 'qwen-small', compactWindow: 200_000 },
      { localContextWindow: 100_000, compactWindow: 100_000 },
    ];
    for (const extra of cases) {
      const out = qwenEconomyEnv({
        appData,
        env,
        economy: economy(),
        compactWindow: 160_000,
        ...extra,
      } as Parameters<typeof qwenEconomyEnv>[0]);
      // Прочие рычаги слой всё равно везёт — ключа сжатия в нём нет.
      expect(settingsOf(out).context?.autoCompactThreshold, JSON.stringify(extra)).toBeUndefined();
    }
  });

  it('tool output threshold = bashOutputChars (O2), editor off, nothing when levers are off', () => {
    const settings = settingsOf(qwenEconomyEnv({ appData, env, economy: economy() }));
    expect(settings.tools).toEqual({ truncateToolOutputThreshold: 8_000 });
    expect(settings.ide).toEqual({ enabled: false });
    expect(settings.model).toBeUndefined();
    const off = economy({ bashOutputChars: 0, detachIde: false, cacheTtl: '1h' });
    expect(qwenEconomyEnv({ appData, env, economy: off })).toBeUndefined();
    expect(qwenEconomyEnv({ appData, env, compactWindow: 160_000 })).toBeUndefined();
  });

  it('cacheRetention only with anthropic auth', () => {
    const lever = economy({ cacheTtl: '1h' });
    const retention = (runEnv: Record<string, string>) =>
      settingsOf(qwenEconomyEnv({ appData, env: runEnv, economy: lever })).model?.generationConfig
        ?.cacheRetention;
    // Вход не определён / OpenAI-совместимый / DashScope OAuth — ключа нет.
    expect(retention(env)).toBeUndefined();
    expect(
      retention({ ...env, OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm', OPENAI_BASE_URL: 'http://x' }),
    ).toBeUndefined();
    expect(retention({ ...env, QWEN_OAUTH: '1' })).toBeUndefined();
    // Anthropic переменными — '1h'.
    const anthropic = {
      ...env,
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_MODEL: 'claude',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    };
    expect(retention(anthropic)).toBe('1h');
    // '5m' — умолчание CLI: ключ не пишется даже при Anthropic.
    const fiveMin = qwenEconomyEnv({
      appData,
      env: anthropic,
      economy: economy({ cacheTtl: '5m' }),
    });
    expect(settingsOf(fiveMin).model).toBeUndefined();
    // Выбранный в личных настройках тип главнее переменных; системный — главнее личного.
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ security: { auth: { selectedType: 'anthropic' } } }),
    );
    expect(retention({ ...env, QWEN_OAUTH: '1' })).toBe('1h');
    expect(qwenAuthType(env, [{ security: { auth: { selectedType: 'openai' } } }])).toBe('openai');
  });

  it('layer merges previous system settings', () => {
    // Человеческий файл машины: его ключи и соседние ключи тех же разделов остаются.
    writeFileSync(
      env[SETTINGS] ?? '',
      JSON.stringify({
        admin: { keep: true },
        tools: { approvalMode: 'default' },
        context: { fileName: 'QWEN.md' },
        model: { generationConfig: { temperature: 0.1 } },
      }),
    );
    // Порядок прогона: окно локальной → снятые серверы → тишина → экономия → строка.
    let runEnv: Record<string, string> = { ...env };
    runEnv = {
      ...runEnv,
      ...writeQwenLimits({
        appData,
        env: runEnv,
        limits: { contextWindow: 131_072, timeoutMs: 600_000, idleMs: 600_000 },
      }),
    };
    runEnv = { ...runEnv, ...writeQwenMcpExcluded({ appData, env: runEnv, names: ['tg'] }) };
    runEnv = { ...runEnv, ...writeQwenQuietRun({ appData, env: runEnv, group: true }) };
    const economyEnv = economyRunEnv('qwen', {
      appData,
      env: runEnv,
      economy: economy({ cacheTtl: '1h' }),
      compactWindow: 100_000,
      localContextWindow: 131_072,
    });
    expect(Object.keys(economyEnv ?? {})).toEqual([SETTINGS]);
    runEnv = { ...runEnv, ...economyEnv };
    runEnv = { ...runEnv, ...writeQwenSystemNote({ appData, env: runEnv, note: 'каталог' }) };
    const final = settingsOf(runEnv);
    expect(final.admin).toEqual({ keep: true });
    expect(final.tools).toEqual({ approvalMode: 'default', truncateToolOutputThreshold: 8_000 });
    expect(final.context?.fileName).toBe('QWEN.md');
    expect(final.context?.autoCompactThreshold).toBe(0.7629);
    expect(final.context?.loadFromIncludeDirectories).toBe(true);
    expect(final.model?.generationConfig).toMatchObject({
      temperature: 0.1,
      contextWindowSize: 131_072,
    });
    // Вход не Anthropic — срока кэша нет и в итоговом файле.
    expect(final.model?.generationConfig?.cacheRetention).toBeUndefined();
    expect(final.mcp?.excluded).toEqual(['tg']);
    expect(final.ui?.enableFollowupSuggestions).toBe(false);
    expect(final.ide).toEqual({ enabled: false });
  });

  it('pinned economy gives one layer per conversation: same input — same file', () => {
    const input = {
      appData,
      env,
      economy: economy(),
      compactWindow: 100_000,
      localContextWindow: 131_072,
    };
    const first = qwenEconomyEnv(input)?.[SETTINGS];
    const firstText = readFileSync(first ?? '', 'utf8');
    const second = qwenEconomyEnv({ ...input, now: Date.now() + 60_000 })?.[SETTINGS];
    expect(second).toBe(first);
    expect(readFileSync(second ?? '', 'utf8')).toBe(firstText);
    // Другой рычаг — другой каталог: работающий CLI свой файл не теряет.
    const other = qwenEconomyEnv({ ...input, economy: economy({ bashOutputChars: 12_000 }) });
    expect(other?.[SETTINGS]).not.toBe(first);
    expect(existsSync(first ?? '')).toBe(true);
  });

  it('stale layers of the economy root are pruned, the current one stays', () => {
    const input = { appData, env, economy: economy() };
    const old = dirname(qwenEconomyEnv(input)?.[SETTINGS] ?? '');
    const week = 8 * 24 * 60 * 60 * 1000;
    const stamp = new Date(Date.now() - week);
    utimesSync(old, stamp, stamp);
    const current = dirname(
      qwenEconomyEnv({ ...input, economy: economy({ bashOutputChars: 9_000 }) })?.[SETTINGS] ?? '',
    );
    expect(existsSync(old)).toBe(false);
    expect(existsSync(current)).toBe(true);
  });

  it('support declaration: valid, channel qwen, dead cells carry a reason', () => {
    const declared = qwenProvider.groupEconomy;
    expect(declared?.channel).toBe('qwen');
    expect(groupEconomySupportSchema.safeParse(declared?.support).success).toBe(true);
    for (const lever of ['bashOutputChars', 'detachIde'] as const) {
      expect(declared?.support[lever], lever).toEqual({ support: 'native' });
    }
    // Порог сжатия — только когда окно модели известно (`qwenContextWindow`).
    expect(declared?.support.compactWindow).toEqual({
      support: 'native',
      note: 'economy-note-window-known-only',
    });
    // Действующие с условием — условие в подсказке: срок кэша только при входе через
    // Anthropic (`qwenEconomyPatch`), свежий разговор только у облачной модели (у
    // локальной `foreignColdPlan` всегда продолжает).
    expect(declared?.support.cacheTtl).toEqual({
      support: 'native',
      note: 'economy-note-anthropic-only',
    });
    expect(declared?.support.freshOnColdResume).toEqual({
      support: 'emulated',
      note: 'economy-note-cloud-only',
    });
    expect(declared?.support.workHabits).toEqual({ support: 'emulated' });
    // Недействующие рычаги объясняют почему.
    expect(declared?.support.sonnetDeliver).toEqual({
      support: 'impossible',
      note: 'economy-note-no-model-ladder',
    });
    expect(declared?.support.keepWarm).toEqual({
      support: 'disproportionate',
      note: 'economy-note-keep-warm-short-ttl',
    });
    expect(declared?.support.readOutputTokens).toEqual({
      support: 'impossible',
      note: 'economy-note-shared-tool-limit',
    });
  });
});
