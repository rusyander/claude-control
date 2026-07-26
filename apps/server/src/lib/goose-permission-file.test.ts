import { describe, it, expect } from 'vitest';
import { readGooseToolPermissions } from './goose-permission-file.ts';

/**
 * Пофайловые разрешения Goose читаются, но НЕ пишутся: формата этого файла в
 * документации нет. Значит и требования к читателю особые — он обязан быть
 * неразрушающим и молчаливым: незнакомая форма не должна ни ронять раздел прав
 * (режим живёт в другом файле), ни выдавать мусор за настройку человека.
 */
describe('Goose permission.yaml: чтение разрешений инструментов', () => {
  it('читает три списка раздела user', () => {
    const permissions = readGooseToolPermissions(
      [
        'user:',
        '  always_allow:',
        '    - developer__shell',
        '    - developer__text_editor',
        '  ask_before:',
        '    - computercontroller__web_scrape',
        '  never_allow:',
        '    - developer__rm',
      ].join('\n'),
    );

    expect(permissions).toEqual({
      alwaysAllow: ['developer__shell', 'developer__text_editor'],
      askBefore: ['computercontroller__web_scrape'],
      neverAllow: ['developer__rm'],
    });
  });

  it('кеш решений LLM (smart_approve) настройкой человека не считается', () => {
    const permissions = readGooseToolPermissions(
      ['smart_approve:', '  always_allow:', '    - developer__list_files'].join('\n'),
    );

    expect(permissions).toBeUndefined();
  });

  it('пустой, битый и чужой по форме файл — просто «показывать нечего»', () => {
    expect(readGooseToolPermissions('')).toBeUndefined();
    expect(readGooseToolPermissions('   \n')).toBeUndefined();
    expect(readGooseToolPermissions('user: [не отображение]\n: :')).toBeUndefined();
    expect(readGooseToolPermissions('user: строка')).toBeUndefined();
    expect(readGooseToolPermissions('- список в корне')).toBeUndefined();
  });

  it('нестроковые элементы списка отбрасываются, остальное читается', () => {
    const permissions = readGooseToolPermissions(
      ['user:', '  always_allow:', '    - developer__shell', '    - 42', '    - ""'].join('\n'),
    );

    expect(permissions).toEqual({
      alwaysAllow: ['developer__shell'],
      askBefore: [],
      neverAllow: [],
    });
  });

  it('раздел user есть, но пуст — показывать нечего', () => {
    expect(readGooseToolPermissions('user:\n  always_allow: []\n')).toBeUndefined();
  });
});
