import { describe, it, expect } from 'vitest';
import {
  CAPABILITIES,
  type Capability,
  type CapabilityStatus,
  type ProviderInfo,
  type ProvidersResponse,
} from '@claude-control/contracts';
import { activeProvider } from './gating';

/**
 * Разделы «Хуки» и «Плагины» роутятся по МОДЕЛИ провайдера (`hooksModel` /
 * `pluginsModel`), а не по его id — так же, как раздел инструкций
 * (`instructionsModel`). Этот тест фиксирует ровно одно, но главное: у Claude
 * модели остаются его собственными, значит `HooksSection`/`PluginsSection`
 * открывают ПРЕЖНИЕ страницы, и регресс невозможен по построению.
 *
 * Сами компоненты дёргают `activeProvider(...)?.hooksModel ?? 'claude'` и
 * `?.pluginsModel ?? 'panel'`, поэтому здесь проверяется этот же контракт:
 * значение по умолчанию (данные ещё не пришли) — claude-ветка.
 */
function caps(): Record<Capability, CapabilityStatus> {
  const map = {} as Record<Capability, CapabilityStatus>;
  for (const capability of CAPABILITIES) map[capability] = 'ready';
  return map;
}

function provider(overrides: Partial<ProviderInfo> & Pick<ProviderInfo, 'id'>): ProviderInfo {
  return {
    name: overrides.id,
    status: 'experimental',
    capabilities: caps(),
    instructionsModel: 'file',
    hooksModel: 'none',
    pluginsModel: 'none',
    skillsModel: 'none',
    ...overrides,
  };
}

const response: ProvidersResponse = {
  active: 'claude',
  providers: [
    provider({
      id: 'claude',
      status: 'verified',
      hooksModel: 'claude',
      pluginsModel: 'panel',
      skillsModel: 'claude',
    }),
    provider({ id: 'opencode', hooksModel: 'config', pluginsModel: 'files', skillsModel: 'files' }),
    provider({ id: 'codex' }),
  ],
};

/** Та же логика, что в `HooksSection` — держим её в одном месте, чтобы не разъехалась. */
const hooksBranch = (data: ProvidersResponse | undefined, active: string): string => {
  const model = activeProvider({ ...(data ?? response), active })?.hooksModel ?? 'claude';
  return model === 'config' ? 'provider' : 'claude';
};

/** Та же логика, что в `PluginsSection`. */
const pluginsBranch = (data: ProvidersResponse | undefined, active: string): string => {
  const model = activeProvider({ ...(data ?? response), active })?.pluginsModel ?? 'panel';
  return model === 'files' ? 'provider' : 'panel';
};

/** Та же логика, что в `SkillsSection` (OPENCODE-5). */
const skillsBranch = (data: ProvidersResponse | undefined, active: string): string => {
  const model = activeProvider({ ...(data ?? response), active })?.skillsModel ?? 'claude';
  return model === 'files' ? 'provider' : 'claude';
};

describe('OPENCODE-3/4/5: роутинг разделов «Хуки», «Плагины», «Скиллы» по модели', () => {
  it('claude открывает СВОИ страницы — регресс-ноль', () => {
    expect(hooksBranch(response, 'claude')).toBe('claude');
    expect(pluginsBranch(response, 'claude')).toBe('panel');
    expect(skillsBranch(response, 'claude')).toBe('claude');
  });

  it('opencode открывает универсальные страницы провайдера', () => {
    expect(hooksBranch(response, 'opencode')).toBe('provider');
    expect(pluginsBranch(response, 'opencode')).toBe('provider');
    expect(skillsBranch(response, 'opencode')).toBe('provider');
  });

  it('провайдер без модели не уводит с claude-ветки (fail-closed через гейт)', () => {
    // Модель `none` до страницы вообще не доходит: `RouteGate` вернёт заглушку,
    // потому что возможность у такого провайдера не `ready`. Но даже если бы
    // дошла — ветка остаётся claude-овской, а не «универсальной наугад».
    expect(hooksBranch(response, 'codex')).toBe('claude');
    expect(pluginsBranch(response, 'codex')).toBe('panel');
    expect(skillsBranch(response, 'codex')).toBe('claude');
  });

  it('данные ещё не пришли — ветка claude (дефолтный провайдер именно такой)', () => {
    expect(activeProvider(undefined)?.hooksModel ?? 'claude').toBe('claude');
    expect(activeProvider(undefined)?.pluginsModel ?? 'panel').toBe('panel');
    expect(activeProvider(undefined)?.skillsModel ?? 'claude').toBe('claude');
  });
});
