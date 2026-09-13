import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import type { PlatformFetch } from './ca-fetch.ts';
import { applyContour } from './apply/apply.ts';
import type { ContourApplyDeps } from './apply/plan.ts';
import {
  activatePlatform,
  deactivatePlatform,
  reconcileActivePlatform,
  type ContourActivationDeps,
} from './activation.ts';
import { checkPlatform } from './check.ts';
import { readPlatforms, removePlatform, writePlatforms, writeToken } from './store.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Активация контура — транзакция, а не флаг (Р3, инвариант 1).
 *
 * Здесь заперты три обещания. Активных не бывает двое: включение второго
 * снимает применения первого и гасит его тумблер. Транзакция либо случается
 * целиком, либо не случается вовсе: сбой посередине оставляет хранилище ровно
 * таким, каким оно было. И красная проба активацию НЕ отменяет — иначе
 * молчаливый откат прятал бы диагноз.
 *
 * Пробный запрос через настоящий шлюз проверяется отдельно
 * (`activation.gateway.test.ts`): на подставленном транспорте он доказывал бы
 * работу подстановки, а не работу пути.
 */

const SECRET = 'contour-key-corporate-4f21';

const BASE: Platform = {
  id: 'first',
  title: 'Первый контур',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  projectPaths: [],
  // Активация снимает и накладывает применения к файлам, а оно с Т3 идёт
  // только при включённом потребителе «терминал».
  consumers: ['assistant', 'terminal'],
  agents: [],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

const SECOND: Platform = { ...BASE, id: 'second', title: 'Второй контур', enabled: false };

/** Контур, отвечающий списком моделей: удачная проба и только она. */
const modelsOk: PlatformFetch = () =>
  Promise.resolve(
    new Response(JSON.stringify({ data: [{ id: 'gpt-x' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

/** Контур, отклонивший ключ. Проба красная, активация — нет. */
const keyRejected: PlatformFetch = () =>
  Promise.resolve(
    new Response('{"error":"forbidden"}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  );

let root: string;
let appData: string;
let settingsPath: string;
let store: AppStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-activation-'));
  appData = join(root, 'agentdeck');
  settingsPath = join(root, 'claude', 'settings.json');
  mkdirSync(appData, { recursive: true });
  mkdirSync(join(root, 'claude'), { recursive: true });

  store = new AppStore(appData);
  writePlatforms(store, [BASE, SECOND]);
  writeToken(appData, BASE.id, SECRET);
  writeToken(appData, SECOND.id, SECRET);
  // Тумблер шлюза включён: без него применение не пишет в файлы CLI ни строки
  // (`plan.ts`: цель готова, только когда шлюз включён и поднят), и «активация
  // сняла применения прежнего» проверялось бы на пустом месте. Слушателя при
  // этом нет — пробный запрос честно отказывается, и так и проверяется ниже.
  store.updateSettings({ platformGateway: { enabled: true, port: 5179, forceStream: true } });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const deps = (fetchImpl: PlatformFetch = modelsOk): ContourActivationDeps => ({
  store,
  paths: { claudeSettings: settingsPath },
  backupDir: join(root, 'backups'),
  appDataDir: appData,
  probeFetch: fetchImpl,
  // Шлюз в этих проверках не поднят: пробный запрос честно отказывается с
  // причиной, и это его единственное поведение без слушателя.
});

const applyDeps = (): ContourApplyDeps => ({
  store,
  paths: { claudeSettings: settingsPath },
  backupDir: join(root, 'backups'),
  gatewayRunning: true,
});

const enabledIds = (): string[] =>
  store
    .getSettings()
    .platforms.filter((platform) => platform.enabled)
    .map((platform) => platform.id);

describe('активен ровно один контур', () => {
  it('активация записывает контур активным и гасит тумблеры остальных', async () => {
    const result = await activatePlatform(deps(), SECOND.id);

    expect(result.activePlatformId).toBe(SECOND.id);
    expect(store.getSettings().activePlatformId).toBe(SECOND.id);
    expect(enabledIds()).toEqual([SECOND.id]);
  });

  it('активация второго снимает применения первого одним действием', async () => {
    writeFileSync(settingsPath, JSON.stringify({ env: { EXISTING: 'keep-me' } }, null, 2));
    store.updateSettings({ activePlatformId: BASE.id });
    applyContour(applyDeps(), BASE, { targets: ['claude'], model: 'gpt-x' });
    expect(readFileSync(settingsPath, 'utf8')).toContain('ANTHROPIC_BASE_URL');

    const result = await activatePlatform(deps(), SECOND.id);

    expect(result.previousPlatformId).toBe(BASE.id);
    expect(result.rollback?.entries.map((entry) => entry.outcome)).toEqual(['restored']);
    // Файл вернулся ровно к тому, что в нём было: чужая переменная на месте,
    // наших нет.
    const claude = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      env: Record<string, string>;
    };
    expect(claude.env).toEqual({ EXISTING: 'keep-me' });
    expect(store.getPlatformApplied()[BASE.id]).toBeUndefined();
  });

  it('повторная активация того же контура ничего не откатывает', async () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {} }, null, 2));
    await activatePlatform(deps(), BASE.id);
    applyContour(applyDeps(), BASE, { targets: ['claude'], model: 'gpt-x' });

    const result = await activatePlatform(deps(), BASE.id);

    expect(result.previousPlatformId).toBe('');
    expect(result.rollback).toBeUndefined();
    // След применения на месте: человек нажал «активировать» ещё раз, а не
    // попросил всё снять.
    expect(store.getPlatformApplied()[BASE.id]).toBeDefined();
  });

  it('сбой посередине оставляет хранилище прежним', async () => {
    writeFileSync(settingsPath, JSON.stringify({ env: { EXISTING: 'keep-me' } }, null, 2));
    store.updateSettings({ activePlatformId: BASE.id });
    applyContour(applyDeps(), BASE, { targets: ['claude'], model: 'gpt-x' });
    const before = JSON.stringify(store.exportState());

    // Отказ ровно между откатом прежнего и записью активного: дальше первой
    // записи настроек транзакция не уйдёт.
    const original = store.updateSettings.bind(store);
    let writes = 0;
    store.updateSettings = ((patch) => {
      writes += 1;
      if (writes > 1) throw new Error('диск отказал');
      return original(patch);
    }) as typeof store.updateSettings;

    await expect(activatePlatform(deps(), SECOND.id)).rejects.toThrow('диск отказал');
    store.updateSettings = original;

    // Хранилище — байт в байт прежнее: и активный контур, и тумблеры, и след
    // применения, который откат успел стереть.
    expect(JSON.stringify(store.exportState())).toBe(before);
    expect(store.getSettings().activePlatformId).toBe(BASE.id);
    expect(store.getPlatformApplied()[BASE.id]).toBeDefined();
  });

  it('красная проба активацию не отменяет — причина видна, решает человек', async () => {
    const result = await activatePlatform(deps(keyRejected), SECOND.id);

    expect(result.probe.outcome).toBe('unauthorized');
    expect(store.getSettings().activePlatformId).toBe(SECOND.id);
    expect(enabledIds()).toEqual([SECOND.id]);
  });

  it('контура с таким идентификатором нет — отказ до единой записи', async () => {
    store.updateSettings({ activePlatformId: BASE.id });

    await expect(activatePlatform(deps(), 'нет-такого')).rejects.toThrow();
    expect(store.getSettings().activePlatformId).toBe(BASE.id);
  });
});

/**
 * Аудит DRV-10. Проба идёт до 15 с, а писала она контур, прочитанный ДО неё,
 * целиком: активация другого контура, правка названия или удаление, случившиеся
 * за это время, стирались, и включёнными оказывались два контура сразу.
 */
describe('проба не стирает то, что случилось, пока она шла', () => {
  /** Транспорт, который отвечает только по команде — окно гонки под контролем теста. */
  const held = (): { fetch: PlatformFetch; release: () => void } => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { fetch: async (...args) => (await gate, modelsOk(...args)), release };
  };

  it('проверка, начатая до активации другого контура, не включает свой обратно', async () => {
    await activatePlatform(deps(), BASE.id);
    const slow = held();
    const check = checkPlatform(store, appData, BASE.id, slow.fetch);

    await activatePlatform(deps(), SECOND.id);
    expect(enabledIds()).toEqual([SECOND.id]);

    slow.release();
    await check;
    expect(enabledIds()).toEqual([SECOND.id]);
    expect(store.getSettings().activePlatformId).toBe(SECOND.id);
  });

  it('правка названия во время пробы переживает её, а возможности записаны', async () => {
    const slow = held();
    const check = checkPlatform(store, appData, BASE.id, slow.fetch);
    writePlatforms(store, [{ ...BASE, title: 'Переименован во время пробы' }]);

    slow.release();
    await check;
    const after = readPlatforms(store).find((item) => item.id === BASE.id);
    expect(after?.title).toBe('Переименован во время пробы');
    expect(after?.capabilities).toContain('models');
  });

  it('контур, удалённый во время пробы, не воскресает', async () => {
    const slow = held();
    const check = checkPlatform(store, appData, SECOND.id, slow.fetch);
    removePlatform(store, appData, SECOND.id);

    slow.release();
    await check;
    expect(readPlatforms(store).map((item) => item.id)).toEqual([BASE.id]);
  });

  it('в возможности контура ложится подтверждённое ответом, а не известное заранее (аудит DRV-19)', async () => {
    // Поле обещает «что панель подтвердила пробой»; свойства платформы, которые
    // драйвер знает наперёд (гардрейлы, знания через владельца), пробой не
    // подтверждаются ничем и записанными туда выдавали бы себя за проверенные.
    await checkPlatform(store, appData, BASE.id, modelsOk);
    const after = readPlatforms(store).find((item) => item.id === BASE.id);
    expect(after?.capabilities).toContain('models');
    expect(after?.capabilities).not.toContain('guardrails');
    expect(after?.capabilities).not.toContain('knowledge');
  });
});

describe('возврат провайдера по умолчанию', () => {
  it('снимает применения, гасит тумблер и пустеет поле активного', async () => {
    writeFileSync(settingsPath, JSON.stringify({ env: { EXISTING: 'keep-me' } }, null, 2));
    await activatePlatform(deps(), BASE.id);
    applyContour(applyDeps(), BASE, { targets: ['claude'], model: 'gpt-x' });

    const result = deactivatePlatform(deps(), BASE.id);

    expect(result.entries.map((entry) => entry.outcome)).toEqual(['restored']);
    expect(store.getSettings().activePlatformId).toBe('');
    expect(enabledIds()).toEqual([]);
    const claude = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      env: Record<string, string>;
    };
    expect(claude.env).toEqual({ EXISTING: 'keep-me' });
  });

  it('возврат НЕ активного контура не трогает активный', async () => {
    await activatePlatform(deps(), BASE.id);

    deactivatePlatform(deps(), SECOND.id);

    expect(store.getSettings().activePlatformId).toBe(BASE.id);
    expect(enabledIds()).toEqual([BASE.id]);
  });
});

describe('перенос старых настроек', () => {
  it('несколько включённых: активным становится первый, остальные остаются настроенными', () => {
    writePlatforms(store, [
      { ...BASE, enabled: true },
      { ...SECOND, enabled: true },
    ]);

    reconcileActivePlatform(store);

    expect(store.getSettings().activePlatformId).toBe(BASE.id);
    expect(enabledIds()).toEqual([BASE.id]);
    // «Остаются настроенными» — это про настройку целиком: ключ, бюджет, адрес
    // на месте, гаснет только тумблер.
    const second = store.getSettings().platforms.find((item) => item.id === SECOND.id);
    expect(second?.baseUrl).toBe(SECOND.baseUrl);
    expect(store.getPlatformActivationNotice()).toEqual({
      activatedId: BASE.id,
      activatedTitle: BASE.title,
      others: [SECOND.title],
    });
  });

  it('один включённый: активным становится он, и рассказывать не о чем', () => {
    reconcileActivePlatform(store);

    expect(store.getSettings().activePlatformId).toBe(BASE.id);
    expect(store.getPlatformActivationNotice()).toBeUndefined();
  });

  // Расхождение «активен один, включён другой» приносят чужие писатели настроек
  // — импорт снимка и распаковка архива. До 11.09.2026 сведение отказывалось
  // работать при непустом поле активного контура, и расхождение переживало
  // перезапуск: панель называла контур выключенным, а шлюз его обслуживал.
  it('активный записан, а включён другой — тумблеры сводятся к активному', () => {
    store.updateSettings({ activePlatformId: SECOND.id });

    reconcileActivePlatform(store);

    expect(store.getSettings().activePlatformId).toBe(SECOND.id);
    expect(enabledIds()).toEqual([SECOND.id]);
    // Погашенный контур назван вслух: человек не выбирал гасить его.
    expect(store.getPlatformActivationNotice()).toEqual({
      activatedId: SECOND.id,
      activatedTitle: SECOND.title,
      others: [BASE.title],
    });
  });

  it('активный записан и он же включён — сведение не трогает ничего', () => {
    writePlatforms(store, [
      { ...BASE, enabled: false },
      { ...SECOND, enabled: true },
    ]);
    store.updateSettings({ activePlatformId: SECOND.id });

    reconcileActivePlatform(store);

    expect(store.getSettings().activePlatformId).toBe(SECOND.id);
    expect(enabledIds()).toEqual([SECOND.id]);
    expect(store.getPlatformActivationNotice()).toBeUndefined();
  });

  // Контур, названный активным, мог уехать из списка вместе с чужим снимком.
  it('активным назван контур, которого нет — поле чистится, включённый занимает его место', () => {
    writePlatforms(store, [{ ...BASE, enabled: true }]);
    store.updateSettings({ activePlatformId: 'контура-нет' });

    reconcileActivePlatform(store);

    expect(store.getSettings().activePlatformId).toBe(BASE.id);
    expect(enabledIds()).toEqual([BASE.id]);
  });

  it('включённых нет — это не перенос, а работа на провайдере по умолчанию', () => {
    writePlatforms(store, [{ ...BASE, enabled: false }]);

    reconcileActivePlatform(store);

    expect(store.getSettings().activePlatformId).toBe('');
    expect(store.getPlatformActivationNotice()).toBeUndefined();
  });
});

describe('пробный запрос без шлюза', () => {
  it('шлюз не поднят — отказ с причиной, а не тишина', async () => {
    const result = await activatePlatform(deps(), BASE.id);

    expect(result.smoke.ok).toBe(false);
    expect(result.smoke.detail).toContain('Шлюз не поднят');
    // Итог сохраняется: карточка показывает его после F5, как и итог пробы.
    expect(store.getPlatformSmoke()[BASE.id]?.detail).toBe(result.smoke.detail);
  });

  it('контур не назвал моделей — спрашивать нечем, и так и сказано', async () => {
    const noModels: PlatformFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const result = await activatePlatform(deps(noModels), BASE.id);

    expect(result.smoke.model).toBe('');
    expect(result.smoke.detail).toContain('ни одной модели');
  });
});
