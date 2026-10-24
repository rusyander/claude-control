import { describe, expect, it } from 'vitest';
import { DEFAULT_MASCOT_PREFS, parseMascotPrefs } from './prefs';
import { TIP_KEYS, pickTip, tipScope } from './tips';
import {
  CAMEO_APPEAR_MS,
  CAMEO_LINE_MS,
  CAMEO_LONG_MS,
  CAMEO_VERY_LONG_MS,
  cameoLine,
} from './cameo';
import { mascotRu } from '../../config/i18n/mascot/ru';

describe('parseMascotPrefs', () => {
  it('nothing stored or garbage → defaults (mascot on, chatty, not greeted)', () => {
    expect(parseMascotPrefs(null)).toEqual(DEFAULT_MASCOT_PREFS);
    expect(parseMascotPrefs('{oops')).toEqual(DEFAULT_MASCOT_PREFS);
    expect(parseMascotPrefs('42')).toEqual(DEFAULT_MASCOT_PREFS);
  });

  it('keeps recognised flags, ignores wrongly typed ones', () => {
    expect(parseMascotPrefs('{"enabled":false,"chatty":"no","greeted":true}')).toEqual({
      enabled: false,
      chatty: true,
      greeted: true,
      reactions: true,
    });
  });

  it('reactions: on by default (old stored prefs included), off only when saved off', () => {
    expect(DEFAULT_MASCOT_PREFS.reactions).toBe(true);
    expect(parseMascotPrefs('{"enabled":true,"chatty":true,"greeted":true}').reactions).toBe(true);
    expect(parseMascotPrefs('{"reactions":false}').reactions).toBe(false);
  });
});

describe('tips', () => {
  it('scope by route: chat, settings, everything else', () => {
    expect(tipScope('/chat')).toBe('chat');
    expect(tipScope('/settings')).toBe('settings');
    expect(tipScope('/chatty')).toBe('any');
    expect(tipScope('/rules')).toBe('any');
  });

  it('never repeats the tip that was just shown', () => {
    for (const scope of ['chat', 'settings', 'any'] as const) {
      for (const previous of TIP_KEYS[scope]) {
        for (const roll of [0, 0.5, 0.9999]) {
          const next = pickTip(scope, previous, () => roll);
          expect(next).not.toBe(previous);
          expect(TIP_KEYS[scope]).toContain(next);
        }
      }
    }
  });

  it('every tip key has a text — a key without one would print its own name', () => {
    const keys = new Set(Object.values(TIP_KEYS).flat());
    for (const key of keys) expect(mascotRu.tips).toHaveProperty(key);
  });
});

describe('cameoLine', () => {
  it('a short turn does not call Decky at all', () => {
    expect(cameoLine(CAMEO_APPEAR_MS - 1, true)).toEqual({ visible: false });
  });

  it('appears with a line, then works silently until the next minute', () => {
    expect(cameoLine(CAMEO_APPEAR_MS, true)).toEqual({ visible: true, key: 'working' });
    expect(cameoLine(CAMEO_APPEAR_MS + CAMEO_LINE_MS, true)).toEqual({ visible: true });
    expect(cameoLine(CAMEO_APPEAR_MS + 60_000, true)).toEqual({ visible: true, key: 'working' });
  });

  it('long and very long turns change the line', () => {
    expect(cameoLine(CAMEO_LONG_MS + CAMEO_APPEAR_MS - (CAMEO_LONG_MS % 60_000), true).key).toBe(
      'long',
    );
    expect(cameoLine(CAMEO_VERY_LONG_MS + CAMEO_APPEAR_MS, true).key).toBe('veryLong');
  });

  it('without remarks Decky still shows up, but silent', () => {
    expect(cameoLine(CAMEO_APPEAR_MS, false)).toEqual({ visible: true });
  });
});
