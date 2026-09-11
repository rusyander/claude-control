import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform, PlatformApplyTarget } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store.ts';
import { buildPlatformApplyPlan, type ContourApplyDeps } from './plan.ts';
import { fingerprintOf } from './current.ts';
import { managedProfileId } from './profile.ts';

/**
 * Предпросмотр применения.
 *
 * Он существует ради одного обещания: показанное и есть то, что запишется.
 * Отсюда три свойства, которые здесь заперты, — занятое место названо ДО
 * записи, чужая правка после нас видна отдельно от «мы не писали», а секрет,
 * который стоит в чужом файле, наружу не уходит даже ради показа конфликта.
 */

const PLATFORM: Platform = {
  id: 'enterprise-platform-dev',
  title: 'EnterprisePlatform · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  projectPaths: [],
  consumers: [],
  agents: [],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  caCertPath: '',
};

let root: string;
let store: AppStore;
let settingsPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-contour-plan-'));
  mkdirSync(join(root, 'agentdeck'), { recursive: true });
  store = new AppStore(join(root, 'agentdeck'));
  settingsPath = join(root, 'settings.json');
  store.updateSettings({
    platforms: [PLATFORM],
    platformGateway: { enabled: true, port: 5179, forceStream: true },
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const deps = (gatewayRunning = true): ContourApplyDeps => ({
  store,
  paths: { claudeSettings: settingsPath },
  gatewayRunning,
});

const targetOf = (plan: { targets: PlatformApplyTarget[] }, id: string): PlatformApplyTarget => {
  const target = plan.targets.find((item) => item.targetId === id);
  if (!target) throw new Error(`нет цели ${id}`);
  return target;
};

describe('готовность', () => {
  it('шлюз не поднят — применять нечего, но предпросмотр остаётся на экране', () => {
    const plan = buildPlatformApplyPlan(deps(false), PLATFORM);
    expect(plan.ready).toBe(false);
    const claude = targetOf(plan, 'claude');
    expect(claude.supported).toBe(false);
    expect(claude.reason).toBe('gateway_down');
    // Строки плана никуда не делись: погашенный шлюз не отнимает у человека
    // возможность увидеть, что именно ему предлагают записать.
    expect(claude.plan.length).toBeGreaterThan(0);
  });

  it('выключенный контур считается так же', () => {
    store.updateSettings({ platforms: [{ ...PLATFORM, enabled: false }] });
    const plan = buildPlatformApplyPlan(deps(), { ...PLATFORM, enabled: false });
    expect(plan.ready).toBe(false);
  });

  it('свою причину прочерка «шлюз погашен» не перебивает', () => {
    const plan = buildPlatformApplyPlan(deps(false), PLATFORM);
    // У gemini беда не в шлюзе, и подменять причину значило бы отправить
    // человека поднимать шлюз ради цели, которая всё равно не заработает.
    expect(targetOf(plan, 'gemini').reason).toBe('gateway_dialect');
  });

  it('оба адреса шлюза и имя профиля названы', () => {
    const plan = buildPlatformApplyPlan(deps(), PLATFORM);
    expect(plan.profileId).toBe(managedProfileId(PLATFORM.id));
    expect(plan.baseUrl).toBe('http://127.0.0.1:5179/enterprise-platform-dev/v1');
    expect(plan.rootUrl).toBe('http://127.0.0.1:5179/enterprise-platform-dev');
  });

  it('шлюзу достался соседний порт — предпросмотр показывает его', () => {
    store.setPlatformGatewayPort(5181);
    const plan = buildPlatformApplyPlan(deps(), PLATFORM);
    // Иначе человек сверял бы с карточкой шлюза, где стоит доставшийся адрес,
    // строку плана с задуманным — и записал бы вторую.
    expect(plan.baseUrl).toBe('http://127.0.0.1:5181/enterprise-platform-dev/v1');
    expect(plan.rootUrl).toBe('http://127.0.0.1:5181/enterprise-platform-dev');
    expect(targetOf(plan, 'claude').plan[0]?.value).toContain('5181');
  });
});

describe('занятое место', () => {
  it('чужой адрес в переменной показан рядом с нашим', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://свой-шлюз.local' } }),
    );
    expect(targetOf(buildPlatformApplyPlan(deps(), PLATFORM), 'claude').conflicts).toEqual([
      {
        key: 'ANTHROPIC_BASE_URL',
        current: 'https://свой-шлюз.local',
        incoming: 'http://127.0.0.1:5179/enterprise-platform-dev',
      },
    ]);
  });

  it('совпадающее значение конфликтом не считается', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:5179/enterprise-platform-dev' } }),
    );
    // Это ровно то состояние, в которое приводит наше же применение: требовать
    // за него подтверждения значило бы поднимать тревогу на пустом месте.
    expect(targetOf(buildPlatformApplyPlan(deps(), PLATFORM), 'claude').conflicts).toEqual([]);
  });

  it('чужой КЛЮЧ под заглушкой уходит наружу только маской', () => {
    const secret = 'sk-настоящий-ключ-человека-9911';
    writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: secret } }));

    const conflicts = targetOf(buildPlatformApplyPlan(deps(), PLATFORM), 'claude').conflicts;
    const token = conflicts.find((item) => item.key === 'ANTHROPIC_AUTH_TOKEN');
    expect(token).toBeDefined();
    // Инвариант «панель не отдаёт секретов» сильнее удобства: под заглушкой
    // ключа стоит НАСТОЯЩИЙ ключ человека, и предпросмотр показывает маску.
    expect(token?.current).not.toBe(secret);
    expect(JSON.stringify(conflicts)).not.toContain(secret);
  });

  it('ассистент, смотрящий в чужой профиль, — тоже занятое место', () => {
    store.updateSettings({
      endpointProfiles: [
        {
          id: 'ep-1',
          name: 'Локальная модель',
          baseUrl: 'http://127.0.0.1:11434/v1',
          apiKind: 'openai-compat',
          model: '',
          writeToken: false,
          ownerPlatformId: '',
        },
      ],
      assistantEndpointId: 'ep-1',
    });
    expect(targetOf(buildPlatformApplyPlan(deps(), PLATFORM), 'assistant').conflicts).toEqual([
      { key: 'assistantEndpointId', current: 'Локальная модель', incoming: 'contour-enterprise-platform-dev' },
    ]);
  });
});

describe('чужая правка после применения', () => {
  const applied = (fingerprint: string): void => {
    store.savePlatformApplied(PLATFORM.id, {
      platformId: PLATFORM.id,
      profileId: managedProfileId(PLATFORM.id),
      targets: [
        {
          targetId: 'claude',
          filePath: settingsPath,
          appliedAt: new Date().toISOString(),
          previous: [{ key: 'ANTHROPIC_BASE_URL' }],
          fingerprint,
        },
      ],
    });
  };

  it('файл тот же — расхождения нет', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    applied(fingerprintOf(settingsPath));
    const claude = targetOf(buildPlatformApplyPlan(deps(), PLATFORM), 'claude');
    expect(claude.applied).toBe(true);
    expect(claude.drifted).toBeUndefined();
  });

  it('дата применения приходит из следа — журнал раздела строится по ней', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    applied(fingerprintOf(settingsPath));

    const plan = buildPlatformApplyPlan(deps(), PLATFORM);
    const claude = targetOf(plan, 'claude');
    expect(claude.appliedAt).toBe(store.getPlatformApplied()[PLATFORM.id]!.targets[0]!.appliedAt);
    // У неприменённой цели даты нет вовсе: «применено неизвестно когда» —
    // худший вид журнала.
    expect(targetOf(plan, 'codex').appliedAt).toBeUndefined();
  });

  it('файл правили после нас — это видно отдельно от «не применяли»', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    applied(fingerprintOf(settingsPath));
    writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'своё' } }));

    const claude = targetOf(buildPlatformApplyPlan(deps(), PLATFORM), 'claude');
    // По времени изменения это не отличить: его меняет и наша собственная
    // запись. Отпечаток — единственный способ.
    expect(claude.drifted).toBe(true);
  });

  it('ассистента увели на чужой профиль — тоже расхождение', () => {
    store.savePlatformApplied(PLATFORM.id, {
      platformId: PLATFORM.id,
      profileId: managedProfileId(PLATFORM.id),
      targets: [
        {
          targetId: 'assistant',
          filePath: '',
          appliedAt: new Date().toISOString(),
          previous: [],
          fingerprint: '',
        },
      ],
    });
    store.updateSettings({ assistantEndpointId: 'ep-1' });
    expect(targetOf(buildPlatformApplyPlan(deps(), PLATFORM), 'assistant').drifted).toBe(true);
  });
});
