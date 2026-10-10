import { describe, expect, it } from 'vitest';
import { keychainServiceNames } from './credentials.ts';

/**
 * Имя записи связки ключей macOS, под которым Claude Code держит вход. С
 * `CLAUDE_CONFIG_DIR` к имени дописаны 8 знаков sha256 от значения переменной в
 * NFC (сверено с бинарём 2.1.286). Векторы — литералы: формула, переписанная
 * заодно с тестом, иначе зеленела бы и неверной. Сам вызов `security` проверяется
 * только на маке (`credentials.test.ts`).
 */
const DEFAULT_ROOT = '/Users/me/.claude';
const PLAIN = ['Claude Code-credentials', 'Claude Code'];

describe('keychainServiceNames', () => {
  it('каталог по умолчанию и переменной нет — прежние имена без суффикса', () => {
    expect(keychainServiceNames(DEFAULT_ROOT, {}, DEFAULT_ROOT)).toEqual(PLAIN);
  });

  it('CLAUDE_CONFIG_DIR — сначала имя с хешем значения переменной', () => {
    const env = { CLAUDE_CONFIG_DIR: '/Users/me/claude-work' };
    expect(keychainServiceNames('/Users/me/claude-work', env, DEFAULT_ROOT)).toEqual([
      'Claude Code-credentials-cbe7f9b7',
      ...PLAIN,
    ]);
  });

  it('путь в NFD хешируется в NFC — как у Claude Code', () => {
    const env = { CLAUDE_CONFIG_DIR: '/Users/me/Café'.normalize('NFD') };
    expect(keychainServiceNames(DEFAULT_ROOT, env, DEFAULT_ROOT)[0]).toBe(
      'Claude Code-credentials-63a76eb4',
    );
  });

  it('каталог, выбранный в панели, тоже даёт кандидата', () => {
    expect(keychainServiceNames('/Users/me/claude-work', {}, DEFAULT_ROOT)).toEqual([
      'Claude Code-credentials-cbe7f9b7',
      ...PLAIN,
    ]);
  });

  it('CLAUDE_SECURESTORAGE_CONFIG_DIR перебивает; пустая — без суффикса', () => {
    const env = {
      CLAUDE_CONFIG_DIR: '/Users/me/other',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/Users/me/claude-work',
    };
    expect(keychainServiceNames('/Users/me/other', env, DEFAULT_ROOT)).toEqual([
      'Claude Code-credentials-cbe7f9b7',
      ...PLAIN,
    ]);
    expect(
      keychainServiceNames(
        '/Users/me/other',
        { ...env, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
        DEFAULT_ROOT,
      ),
    ).toEqual(PLAIN);
  });
});
