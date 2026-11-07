import { describe, expect, it } from 'vitest';
import { ru } from './i18n/ru';
import { en } from './i18n/en';
import { NAV_SECTIONS } from './navigation';

/**
 * Пункт бокового меню подписан ключом словаря. Ключа нет — меню показывает сырое «nav.…»:
 * так остался бы пункт «Чат через ядро» (`/core/chat`), когда экран свёрнут в `/chat` (W3-17a),
 * а его подписи ушли из словарей вместе с ним.
 */
const textAt = (dictionary: unknown, key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      dictionary,
    );

describe('боковое меню', () => {
  it('у каждого пункта и секции есть подпись в обоих словарях', () => {
    const labels = NAV_SECTIONS.flatMap((section) => [
      section.label,
      ...section.items.map((item) => item.label),
    ]);
    for (const label of labels) {
      expect(typeof textAt(ru, label), `ru ${label}`).toBe('string');
      expect(typeof textAt(en, label), `en ${label}`).toBe('string');
    }
  });

  it('старого адреса чата через ядро в меню нет — он только переводит в /chat', () => {
    const paths = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.path));
    expect(paths).toContain('/chat');
    expect(paths).not.toContain('/core/chat');
  });
});
