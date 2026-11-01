import { describe, expect, it } from 'vitest';
import {
  platformDeclaresAnonymization,
  platformDrivers,
  PLATFORM_PRESETS,
} from '@agentdeck/contracts/platform-presets';
import { allDrivers, driverFor } from '../drivers/index.ts';
import { declaresAnonymization } from './data-mask.ts';

/**
 * Два ответа на «объявляет ли контур подмену данных» обязаны совпадать: панель берёт строку
 * манифеста собранного драйвера (`declaresAnonymization`), ядро — факт контракта
 * (`platformDeclaresAnonymization`), потому что драйверов сервера не грузит. Разойдутся — маска
 * по умолчанию у карточки и у звена ядра станет разной, а человек этого не увидит.
 */

/** Переопределения карточки, которые трогают манифест драйвера (префикс, поле размышлений). */
const OVERRIDES = [
  undefined,
  { vendorPrefix: 'acme' },
  { thinkingField: '' },
  { thinkingField: 'enable_thinking', anthropicMessages: '', clientTools: 'native' as const },
];

describe('declaresAnonymization conformance: server driver manifest = contract fact', () => {
  it('every preset, with and without card overrides, answers the same in both places', () => {
    const rows = platformDrivers.flatMap((id) =>
      OVERRIDES.map((patch) => ({
        id,
        patch: JSON.stringify(patch ?? null),
        server: declaresAnonymization(driverFor(id, patch)),
        contract: platformDeclaresAnonymization(id),
      })),
    );
    expect(rows.filter((row) => row.server !== row.contract)).toEqual([]);
    // Предусловие: в выборке есть обе стороны, иначе совпадение ничего не доказывает.
    expect(rows.some((row) => row.contract)).toBe(true);
    expect(rows.some((row) => !row.contract)).toBe(true);
  });

  it('the registry has no driver outside the presets, and an unknown name declares nothing in both', () => {
    expect(allDrivers.map((driver) => driver.id).sort()).toEqual(
      Object.keys(PLATFORM_PRESETS).sort(),
    );
    expect(declaresAnonymization(driverFor('renamed-long-ago'))).toBe(false);
    expect(platformDeclaresAnonymization('renamed-long-ago')).toBe(false);
  });
});
