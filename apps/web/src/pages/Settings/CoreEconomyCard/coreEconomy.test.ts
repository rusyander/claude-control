import { describe, expect, it } from 'vitest';
import { coreConfigSchema, type ConfigView } from '@agentdeck/contracts/core/config';
import { coreEconomyIssue, coreEconomyOf, withEconomyLever } from './coreEconomy';

/**
 * @covers pages/Settings/CoreEconomyCard/coreEconomy.ts
 * @scenario карточка «Экономия шагов задачи» читает раздел `economy` настройки ядра поверх
 *   умолчаний и пишет один рычаг: умолчание уходит из раздела, явный ноль остаётся, пустой раздел
 *   уходит из документа; чужие разделы и отпечаток едут как были. Всё, что пишется, схема ядра
 *   принимает.
 */

const view = (doc: ConfigView['doc'], issues: ConfigView['issues'] = []): ConfigView => ({
  doc,
  digest: 'd1',
  drift: null,
  issues,
});

describe('coreEconomy', () => {
  it('no section — the defaults the core itself applies', () => {
    expect(coreEconomyOf(view({}))).toEqual({
      compactWindow: 0,
      bashOutputChars: 8_000,
      readOutputTokens: 10_000,
      cacheTtl: '',
      detachIde: true,
      workHabits: true,
    });
    expect(coreEconomyOf(undefined).bashOutputChars).toBe(8_000);
  });

  it('a section field overrides its default, explicit zero and false stay', () => {
    const shown = coreEconomyOf(
      view({ economy: { compactWindow: 160_000, bashOutputChars: 0, workHabits: false } }),
    );
    expect(shown.compactWindow).toBe(160_000);
    expect(shown.bashOutputChars).toBe(0);
    expect(shown.workHabits).toBe(false);
    expect(shown.readOutputTokens).toBe(10_000);
  });

  it('writes one lever, keeps other sections and the digest', () => {
    const base = view({ cliPaths: { codex: 'C:/bin/codex.exe' }, economy: { cacheTtl: '1h' } });
    const out = withEconomyLever(base, 'bashOutputChars', 16_000);
    expect(out.baseDigest).toBe('d1');
    expect(out.doc).toEqual({
      cliPaths: { codex: 'C:/bin/codex.exe' },
      economy: { cacheTtl: '1h', bashOutputChars: 16_000 },
    });
    expect(base.doc.economy).toEqual({ cacheTtl: '1h' });
    expect(coreConfigSchema.safeParse(out.doc).success).toBe(true);
  });

  it('a value equal to the default leaves the section; the empty section leaves the doc', () => {
    const base = view({ economy: { bashOutputChars: 16_000 } });
    expect(withEconomyLever(base, 'bashOutputChars', 8_000).doc).toEqual({});
    expect(withEconomyLever(view({ economy: { cacheTtl: '5m' } }), 'cacheTtl', '').doc).toEqual({});
    expect(
      withEconomyLever(view({ economy: { compactWindow: 200_000 } }), 'compactWindow', 0).doc,
    ).toEqual({});
  });

  it('turning a lever off writes an explicit 0 / false the core schema accepts', () => {
    const off = withEconomyLever(view({}), 'readOutputTokens', 0).doc;
    expect(off).toEqual({ economy: { readOutputTokens: 0 } });
    expect(coreConfigSchema.safeParse(off).success).toBe(true);
    const habits = withEconomyLever(view({}), 'detachIde', false).doc;
    expect(habits).toEqual({ economy: { detachIde: false } });
    expect(coreConfigSchema.safeParse(habits).success).toBe(true);
  });

  it('names a rejected economy section, ignores issues of other sections', () => {
    expect(coreEconomyIssue(view({}, [{ section: 'routes', reason: 'x' }]))).toBeNull();
    expect(coreEconomyIssue(view({}, [{ section: 'economy', reason: 'too small' }]))).toBe(
      'too small',
    );
  });
});
