import { describe, it, expect } from 'vitest';
import type { ProviderDetection, ProviderDetectResponse } from '@claude-control/contracts';
import {
  detectionBadge,
  findDetection,
  installedProviders,
  recommendedProviderId,
  activeCliHint,
} from './detection';

/**
 * Вид детекта провайдеров (Ф7). Сценарий из задачи: claude установлен и с
 * конфигом, gemini — только конфиг, codex — ничего. Проверяем бейджи, подсказку
 * при не-установленном активном и рекомендацию дефолта.
 */
function detection(overrides: Partial<ProviderDetection> & { id: string }): ProviderDetection {
  return {
    name: overrides.id,
    status: 'experimental',
    cliCommand: overrides.id,
    cliInstalled: false,
    configPresent: false,
    configPaths: [],
    ...overrides,
  };
}

const claudeInstalled = detection({
  id: 'claude',
  name: 'Claude Code',
  status: 'verified',
  cliCommand: 'claude.cmd',
  cliInstalled: true,
  configPresent: true,
});
const geminiConfigOnly = detection({ id: 'gemini', name: 'Gemini CLI', configPresent: true });
const codexNothing = detection({ id: 'codex', name: 'Codex (OpenAI)' });

const data: ProviderDetectResponse = {
  active: 'claude',
  providers: [claudeInstalled, codexNothing, geminiConfigOnly],
};

describe('detectionBadge: установлен / конфиг найден / не найден', () => {
  it('бинарь в PATH → «установлен» (success)', () => {
    expect(detectionBadge(claudeInstalled)).toEqual({
      kind: 'installed',
      key: 'providerDetect.installed',
      tone: 'success',
    });
  });

  it('бинаря нет, но конфиг есть → «конфиг найден» (info)', () => {
    expect(detectionBadge(geminiConfigOnly)?.kind).toBe('configOnly');
    expect(detectionBadge(geminiConfigOnly)?.key).toBe('providerDetect.configOnly');
  });

  it('ничего не найдено → «не найден» (neutral, не алармирующий тон)', () => {
    expect(detectionBadge(codexNothing)?.kind).toBe('missing');
    expect(detectionBadge(codexNothing)?.tone).toBe('neutral');
  });

  it('установленный CLI важнее конфига: бейдж один, «установлен»', () => {
    const both = detection({ id: 'x', cliInstalled: true, configPresent: true });
    expect(detectionBadge(both)?.kind).toBe('installed');
  });

  it('детект не загружен → бейджа нет (не мигаем ложным «не найден»)', () => {
    expect(detectionBadge(undefined)).toBeUndefined();
  });
});

describe('findDetection / installedProviders', () => {
  it('находит детект по id, отсутствующий → undefined', () => {
    expect(findDetection(data, 'gemini')?.name).toBe('Gemini CLI');
    expect(findDetection(data, 'нет-такого')).toBeUndefined();
    expect(findDetection(undefined, 'claude')).toBeUndefined();
  });

  it('в список обнаруженных попадают только установленные CLI', () => {
    expect(installedProviders(data).map((item) => item.id)).toEqual(['claude']);
    expect(installedProviders(undefined)).toEqual([]);
  });
});

describe('recommendedProviderId: дефолт остаётся claude', () => {
  it('claude установлен → рекомендуем claude', () => {
    expect(recommendedProviderId(data)).toBe('claude');
  });

  it('claude НЕ установлен → первый установленный (без автопереключения)', () => {
    const noClaude: ProviderDetectResponse = {
      active: 'claude',
      providers: [
        detection({ id: 'claude', cliInstalled: false, configPresent: true }),
        detection({ id: 'codex', cliInstalled: true }),
        detection({ id: 'gemini', cliInstalled: true }),
      ],
    };
    expect(recommendedProviderId(noClaude)).toBe('codex');
    // Активный провайдер при этом НЕ меняется — рекомендация только подсказка.
    expect(noClaude.active).toBe('claude');
  });

  it('ничего не установлено → рекомендовать нечего', () => {
    const nothing: ProviderDetectResponse = { active: 'claude', providers: [codexNothing] };
    expect(recommendedProviderId(nothing)).toBeUndefined();
    expect(recommendedProviderId(undefined)).toBeUndefined();
  });
});

describe('activeCliHint: подсказка при не-установленном активном', () => {
  it('активный CLI найден → подсказки нет', () => {
    expect(activeCliHint(data)).toBeUndefined();
  });

  it('активный CLI не найден → подсказка с именем провайдера и командой', () => {
    const hint = activeCliHint({ ...data, active: 'gemini' });
    expect(hint?.key).toBe('providerDetect.activeMissing');
    expect(hint?.params).toEqual({ provider: 'Gemini CLI', command: 'gemini' });
  });

  it('детект не загружен → подсказки нет', () => {
    expect(activeCliHint(undefined)).toBeUndefined();
  });
});
