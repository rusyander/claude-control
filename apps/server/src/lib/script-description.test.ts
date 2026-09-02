import { describe, it, expect } from 'vitest';
import { describeScript } from './script-description.ts';

/**
 * Один разбор описания для страниц «Скрипты» и «Хуки». Каждый случай ниже —
 * реальное расхождение двух прежних разборов или форма шапки, которую один из
 * них не понимал.
 */
describe('describeScript — описание из шапки файла', () => {
  it('пропускает shebang и склеивает строки //', () => {
    expect(describeScript('#!/usr/bin/env node\n// Первая.\n// Вторая.\n\ncode();\n')).toBe(
      'Первая. Вторая.',
    );
  });

  it('блочный комментарий JS — без хвоста « /» от закрывающей строки', () => {
    const text =
      '#!/usr/bin/env node\n/**\n * Описание модуля.\n * Вторая строка.\n */\nimport x;\n';
    expect(describeScript(text)).toBe('Описание модуля. Вторая строка.');
  });

  it('однострочный блок и «//» после него не смешиваются', () => {
    expect(describeScript('/** Кратко. */\nconst a = 1;\n// не описание\n')).toBe('Кратко.');
  });

  it('PowerShell: блок <# … #> и строки #', () => {
    expect(describeScript('<#\nЧто делает скрипт.\n#>\nWrite-Host ok\n')).toBe(
      'Что делает скрипт.',
    );
    expect(describeScript('# Строка один.\n# Строка два.\n$x = 1\n')).toBe(
      'Строка один. Строка два.',
    );
  });

  it('служебная строка панели «Событие: …» описанием не считается', () => {
    expect(
      describeScript('// Событие: PreToolUse — создано Claude Control\n// Настоящее описание.\n'),
    ).toBe('Настоящее описание.');
  });

  it('файл без комментариев в шапке — undefined, а не пустая строка', () => {
    expect(describeScript('import x from "y";\nexport {};\n')).toBeUndefined();
    expect(describeScript('')).toBeUndefined();
  });
});
