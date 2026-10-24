import { describe, it, expect } from 'vitest';
import {
  ECONOMY_NOTE_CODES,
  GROUP_ECONOMY_LEVERS,
  LEVER_SUPPORT_VALUES,
  groupEconomySupportSchema,
  leverWorks,
} from '@agentdeck/contracts/group-economy-support';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import { describeProviders, listProviders, type SettingsSource } from './registry.ts';

/**
 * @covers packages/contracts/src/group-economy-support.ts, providers/registry.ts
 * @scenario каталог каждого CLI объявляет, где действует каждый рычаг экономии
 *   групп; сервер отдаёт это в `/api/providers`, и опечатка в каталоге не проходит.
 */

const STORE: SettingsSource = { getSettings: () => ({ provider: 'claude' }) };

describe('group-economy-support', () => {
  it('schema accepts every lever and rejects unknown', () => {
    const full = Object.fromEntries(
      GROUP_ECONOMY_LEVERS.map((lever, index) => [
        lever,
        { support: LEVER_SUPPORT_VALUES[index % LEVER_SUPPORT_VALUES.length] },
      ]),
    );
    expect(groupEconomySupportSchema.parse(full)).toEqual(full);
    // Неполная карта — допустима: рычаг без отметки страница не рисует.
    expect(groupEconomySupportSchema.parse({ workHabits: { support: 'emulated' } })).toEqual({
      workHabits: { support: 'emulated' },
    });
    expect(
      groupEconomySupportSchema.safeParse({ keepWarmPings: { support: 'native' } }).success,
    ).toBe(false);
    expect(groupEconomySupportSchema.safeParse({ cacheTtl: { support: 'maybe' } }).success).toBe(
      false,
    );
    // Условие у действующего рычага — допустимо.
    expect(
      groupEconomySupportSchema.safeParse({
        cacheTtl: { support: 'native', note: 'economy-note-anthropic-only' },
      }).success,
    ).toBe(true);
    // Причина — код текста сервера, не произвольная фраза.
    expect(
      groupEconomySupportSchema.safeParse({
        cacheTtl: { support: 'impossible', note: 'у CLI нет ключа' },
      }).success,
    ).toBe(false);
  });

  it('every lever is a GroupEconomy key, keepWarmPings has no chip', () => {
    // Равенство, не вхождение: новый рычаг в GroupEconomy без отметки «Где действует»
    // остался бы на странице без строки ни у одного CLI.
    const keys = Object.keys(GROUP_ECONOMY_DEFAULTS).filter((key) => key !== 'keepWarmPings');
    expect([...keys].sort()).toEqual([...GROUP_ECONOMY_LEVERS].sort());
    expect(GROUP_ECONOMY_LEVERS).not.toContain('keepWarmPings');
  });

  it('leverWorks: только родной ключ и работа панели', () => {
    expect(leverWorks({ support: 'native' })).toBe(true);
    expect(leverWorks({ support: 'emulated' })).toBe(true);
    for (const support of ['meaningless', 'impossible', 'disproportionate'] as const) {
      expect(leverWorks({ support }), support).toBe(false);
    }
    expect(leverWorks(undefined)).toBe(false);
  });
});

describe('registry', () => {
  it('providers expose groupEconomy', () => {
    const declared = listProviders().filter((provider) => provider.groupEconomy);
    expect(declared.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(['claude', 'codex']),
    );
    for (const provider of declared) {
      const support = provider.groupEconomy!.support;
      expect(groupEconomySupportSchema.parse(support), provider.id).toEqual(support);
      for (const entry of Object.values(support)) {
        // Недействующий рычаг объясняется всегда; действующий — по желанию, условием.
        if (!leverWorks(entry)) expect(entry.note, provider.id).toBeDefined();
        if (entry.note !== undefined) expect(ECONOMY_NOTE_CODES, provider.id).toContain(entry.note);
      }
    }
    const info = describeProviders(STORE).providers;
    for (const provider of declared) {
      expect(info.find((item) => item.id === provider.id)?.groupEconomy).toEqual(
        provider.groupEconomy!.support,
      );
    }
    // Канал прогона — внутреннее дело сервера, наружу уходят только отметки.
    expect(JSON.stringify(info)).not.toContain('"channel"');
  });

  it('claude: every lever native, no channel', () => {
    const claude = listProviders().find((provider) => provider.id === 'claude')!;
    expect(claude.groupEconomy?.channel).toBeUndefined();
    for (const lever of GROUP_ECONOMY_LEVERS) {
      expect(claude.groupEconomy?.support[lever], lever).toEqual({ support: 'native' });
    }
  });

  it('codex: решения плана по каждому рычагу', () => {
    const codex = listProviders().find((provider) => provider.id === 'codex')!;
    expect(codex.groupEconomy?.channel).toBe('codex');
    const support = codex.groupEconomy!.support;
    expect(
      Object.fromEntries(Object.entries(support).map(([lever, entry]) => [lever, entry.support])),
    ).toEqual({
      compactWindow: 'native',
      bashOutputChars: 'native',
      readOutputTokens: 'native',
      cacheTtl: 'impossible',
      detachIde: 'meaningless',
      sonnetDeliver: 'emulated',
      freshOnColdResume: 'emulated',
      keepWarm: 'disproportionate',
      workHabits: 'emulated',
    });
  });
});
