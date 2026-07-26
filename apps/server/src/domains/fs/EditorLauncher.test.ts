import { describe, it, expect } from 'vitest';
import {
  KNOWN_EDITORS,
  commandExists,
  detectEditors,
  resolveEditorCommand,
} from './EditorLauncher.ts';

/**
 * Тесты запуска редактора. Проверяем безопасность (команда — одно слово без
 * метасимволов, иначе её нельзя пускать в оболочку) и структуру списка. Реальную
 * доступность редактора не проверяем: на разных машинах установлено разное.
 * Тест-кейсы см. .agent/TEST-CASES.md → «Редактор кода».
 */
describe('commandExists — безопасность команды', () => {
  it('небезопасную команду с метасимволами сразу отвергает (без запуска)', () => {
    expect(commandExists('code; rm -rf /')).toBe(false);
    expect(commandExists('code && calc')).toBe(false);
    expect(commandExists('$(evil)')).toBe(false);
    expect(commandExists('')).toBe(false);
  });
});

// Обнаружение спрашивает систему про КАЖДЫЙ известный редактор (`where`/`which`
// синхронным запуском). На Windows под полной нагрузкой набора это не
// укладывается в дефолтные 5 секунд — отсюда свой запас времени.
describe('detectEditors', { timeout: 30_000 }, () => {
  it('возвращает все известные редакторы с флагом доступности', () => {
    const editors = detectEditors();
    expect(editors).toHaveLength(KNOWN_EDITORS.length);
    for (const editor of editors) {
      expect(typeof editor.id).toBe('string');
      expect(typeof editor.name).toBe('string');
      expect(typeof editor.available).toBe('boolean');
    }
    // VS Code в списке есть всегда.
    expect(editors.some((editor) => editor.command === 'code')).toBe(true);
  });
});

describe('resolveEditorCommand', () => {
  it('небезопасную предпочтительную команду не возвращает', () => {
    expect(resolveEditorCommand('evil; rm -rf')).not.toBe('evil; rm -rf');
  });

  it('несуществующую команду игнорирует', () => {
    // Заведомо отсутствующий редактор → берётся системный или undefined,
    // но никогда сам этот вымышленный идентификатор.
    expect(resolveEditorCommand('nosucheditor12345')).not.toBe('nosucheditor12345');
  });
});
