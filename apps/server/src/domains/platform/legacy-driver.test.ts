import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENTERPRISE_PLATFORM_DRIVER_ID,
  LEGACY_PLATFORM_DRIVER_ID,
  migrateLegacyPlatform,
  migrateLegacyPlatforms,
  normalizePlatformDriverId,
} from '@agentdeck/contracts/platform-legacy';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts';
import { platformSchema } from '../../providers/settings-validation.ts';
import { AppStore } from '../../lib/app-store.ts';
import { driverFor, driverOf } from './drivers/index.ts';
import { readPlatforms } from './store.ts';

/**
 * Переезд драйвера платформы компании на нейтральное имя: запись, сделанная до
 * переименования, читается нынешним драйвером и говорит с платформой прежними
 * полями. Живой путь (настоящий сервер на прежнем `state.json`) —
 * `tools/qa/check-platform-rename.mjs`.
 */

const legacy = LEGACY_PLATFORM_DRIVER_ID;

function storedContour(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'corp',
    title: 'Компания · dev',
    driver: legacy,
    baseUrl: 'https://platform.example.com',
    enabled: true,
    mode: 'required',
    capabilities: [],
    targets: [],
    consumers: [],
    projectPaths: [],
    agents: [],
    defaultModel: '',
    consumerModels: {},
    modelMap: {},
    rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
    caCertPath: '',
    transport: { authHeader: '', authScheme: '', version: 'auto', query: '', headers: '' },
    ...fields,
  };
}

describe('прежнее имя драйвера', () => {
  it('узнаётся ровно одно слово — то, под которым панель писала контуры', () => {
    // Записано иначе, чем в модуле (задом наперёд): литерала в дереве нет — историю
    // переписывают заменой слова, — а ошибку сборки имени тест обязан поймать.
    expect(LEGACY_PLATFORM_DRIVER_ID).toBe([...'anogrog'].reverse().join(''));
    expect(normalizePlatformDriverId(legacy)).toBe(ENTERPRISE_PLATFORM_DRIVER_ID);
    expect(normalizePlatformDriverId('openai-compat')).toBe('openai-compat');
  });

  it('запись переписывается на нынешнее имя, префикс полей — прежним словом', () => {
    const next = migrateLegacyPlatform(storedContour({ manifest: { thinkingField: 'x' } }));
    expect(next).toMatchObject({
      driver: 'enterprise-platform',
      manifest: { thinkingField: 'x', vendorPrefix: legacy },
    });
  });

  it('свой префикс человека не перетирается', () => {
    const next = migrateLegacyPlatform(storedContour({ manifest: { vendorPrefix: 'acme' } }));
    expect(next).toMatchObject({ manifest: { vendorPrefix: 'acme' } });
  });

  it('повторный проход ничего не меняет: та же ссылка, `changed` ложь', () => {
    const once = migrateLegacyPlatforms([storedContour()]);
    expect(once.changed).toBe(true);
    const twice = migrateLegacyPlatforms(once.platforms);
    expect(twice.changed).toBe(false);
    expect(twice.platforms).toBe(once.platforms);
    const other = { driver: 'vllm' };
    expect(migrateLegacyPlatform(other)).toBe(other);
  });

  it('дверь сохранения принимает прежнее имя и отдаёт нынешнее', () => {
    const parsed = platformSchema.parse(storedContour());
    expect(parsed.driver).toBe('enterprise-platform');
    expect(parsed.manifest).toMatchObject({ vendorPrefix: legacy });
    // Умолчания берутся по нынешнему типу: у платформы прослойка включена.
    expect(parsed.toolShim).toBe(true);
  });
});

describe('префикс вендорных полей', () => {
  it('нейтральный по умолчанию: кадр с прежним словом платформой не считается', () => {
    const driver = driverFor('enterprise-platform');
    expect(driver.vendorPrefix).toBe('platform');
    expect(driver.readFrame({ platform_status: 'inference' })).toMatchObject({ kind: 'status' });
    expect(driver.readFrame({ [`${legacy}_status`]: 'inference' })).toBeUndefined();
  });

  it('переопределение меняет кадры, поля цельного ответа и правила на проводе', () => {
    const driver = driverFor('enterprise-platform', { vendorPrefix: legacy });
    expect(driver.readFrame({ [`${legacy}_guardrails`]: { violations: [] } })).toMatchObject({
      kind: 'guardrails',
      field: `${legacy}_guardrails`,
    });
    expect(driver.vendorFields).toContain(`${legacy}_sanitized`);
    expect(driver.controls.map((control) => control.id)).toEqual(
      expect.arrayContaining([`${legacy}_tools`, `${legacy}_tool_mode`]),
    );
    expect(driver.controls.some((control) => control.id.startsWith('platform_'))).toBe(false);
    // Подписи правил остаются подписями драйвера.
    expect(driver.controls.find((control) => control.field === 'toolMode')?.streamless).toEqual([
      'single_turn',
    ]);
  });

  it('совместимому шлюзу префикс ничего не значит', () => {
    expect(driverFor('vllm', { vendorPrefix: 'acme' }).vendorPrefix).toBeUndefined();
  });
});

describe('загрузка state.json с контуром под прежним именем', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ad-legacy-driver-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('контур читается нынешним драйвером, файл переписан один раз', () => {
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({ settings: { platforms: [storedContour()] } }));

    const store = new AppStore(dir);
    const platform = readPlatforms(store)[0]!;
    expect(platform.driver).toBe('enterprise-platform');
    expect(driverOf(platform).vendorPrefix).toBe(legacy);
    expect(driverOf(platform).clientTools).toBe('shim');

    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.settings.platforms[0].driver).toBe('enterprise-platform');
    expect(onDisk.settings.platforms[0].manifest.vendorPrefix).toBe(legacy);

    const written = statSync(file).mtimeMs;
    const text = readFileSync(file, 'utf8');
    new AppStore(dir);
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(statSync(file).mtimeMs).toBe(written);
  });
});
