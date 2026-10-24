import { describe, expect, it } from 'vitest';
import { SPLIT_DEFAULTS_BUILTIN } from '@agentdeck/contracts/split-groups';
import {
  sendLoosens,
  settingsPatchLoosens,
  splitDefaultsLoosen,
  splitSettingsLoosen,
} from './levers.ts';

/** Рычаги: что ослабляет права всех будущих решений, а что — нет. */

const builtIn = SPLIT_DEFAULTS_BUILTIN.permissions;
const strict = Object.fromEntries(
  Object.keys(builtIn).map((id) => [id, 'human']),
) as typeof builtIn;

describe('settingsPatchLoosens', () => {
  const off = { chatAutoMode: false, autoApproveRules: { a: false } };
  it.each<[string, unknown, boolean]>([
    ['auto mode on', { chatAutoMode: true }, true],
    ['auto mode off', { chatAutoMode: false }, false],
    ['unrelated field', { theme: 'dark' }, false],
    ['empty rules object', { autoApproveRules: {} }, false],
  ])('%s → %s', (_name, patch, expected) => {
    expect(settingsPatchLoosens(off, patch)).toBe(expected);
  });

  it('a rule that turns on loosens, a rule that turns off does not', () => {
    const tight = {
      chatAutoMode: false,
      autoApproveRules: { externalWrite: false, gitWrite: false },
    };
    expect(settingsPatchLoosens(tight, { autoApproveRules: { filesDelete: true } })).toBe(true);
    expect(
      settingsPatchLoosens(tight, { autoApproveRules: { externalWrite: false, gitWrite: false } }),
    ).toBe(false);
    // Хранилище заменяет правила целиком: пропущенное правило вернётся к коробке (вкл.).
    expect(settingsPatchLoosens(tight, { autoApproveRules: {} })).toBe(true);
    expect(
      settingsPatchLoosens(
        { chatAutoMode: false, autoApproveRules: undefined },
        { autoApproveRules: { externalWrite: false } },
      ),
    ).toBe(false);
  });

  it('auto mode already on is not a loosening', () => {
    expect(settingsPatchLoosens({ ...off, chatAutoMode: true }, { chatAutoMode: true })).toBe(
      false,
    );
  });
});

describe('split rows', () => {
  it('shared defaults: a row looser than now loosens, stricter does not', () => {
    expect(splitDefaultsLoosen(strict, { permissions: strict }, builtIn)).toBe(false);
    expect(
      splitDefaultsLoosen(strict, { permissions: { ...strict, routine: 'auto' } }, builtIn),
    ).toBe(true);
    // Строки, не упомянутые в теле, маршрут берёт из коробки — она мягче строгих.
    expect(splitDefaultsLoosen(strict, {}, builtIn)).toBe(true);
    expect(splitDefaultsLoosen(builtIn, { permissions: strict }, builtIn)).toBe(false);
  });

  it('project rows: absent → unchanged, null → back to shared, own rows compared', () => {
    expect(splitSettingsLoosen(strict, builtIn, { deliver: true })).toBe(false);
    expect(splitSettingsLoosen(strict, builtIn, { permissions: null })).toBe(true);
    expect(splitSettingsLoosen(strict, strict, { permissions: null })).toBe(false);
    expect(splitSettingsLoosen(strict, strict, { permissions: { gitWrite: 'notify' } })).toBe(true);
    expect(splitSettingsLoosen(builtIn, builtIn, { permissions: { gitWrite: 'human' } })).toBe(
      false,
    );
  });
});

describe('sendLoosens', () => {
  const chat = (auto: boolean, bypass: boolean) => ({ autoMode: () => auto, bypass: () => bypass });
  it.each<[string, unknown, boolean, boolean, boolean]>([
    ['full access on a normal run', { chatId: 'c', fullAccess: true }, false, false, true],
    ['full access repeated on a bypass run', { chatId: 'c', fullAccess: true }, false, true, false],
    ['auto on a chat without auto mode', { chatId: 'c', autoApprove: true }, false, false, true],
    ['auto repeated on an auto chat', { chatId: 'c', autoApprove: true }, true, false, false],
    ['auto off', { chatId: 'c', autoApprove: false }, false, false, false],
    ['plain message', { chatId: 'c', prompt: 'hi' }, false, false, false],
  ])('%s → %s', (_name, body, auto, bypass, expected) => {
    expect(sendLoosens(body, chat(auto, bypass))).toBe(expected);
  });
});
