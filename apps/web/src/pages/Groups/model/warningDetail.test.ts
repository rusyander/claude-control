import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@shared/config/i18n';
import { warningDetailText } from './warningDetail';

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

const t = (key: string, params?: Record<string, unknown>): string => i18n.t(key, params);

describe('причина в предупреждении копии — словами (F-212)', () => {
  it('вид участника, путь проекта и нет файла — не код сервера', () => {
    expect(warningDetailText('permission', t)).toBe(
      'участник вида «разрешение» в общие не переносится',
    );
    expect(warningDetailText('group', t)).toContain('вложенная группа');
    expect(warningDetailText('project-relative', t)).toContain('путь внутри проекта');
    expect(warningDetailText('missing', t)).toBe('файла нет');
  });

  it('исход переноса к чужому CLI — словами паспорта среды', () => {
    expect(warningDetailText('not_transferable', t)).toBe('не переносится');
    expect(warningDetailText('refused_by_target', t)).toBe('цель не принимает');
  });

  it('текст ошибки записи идёт как есть', () => {
    expect(warningDetailText('EACCES: permission denied', t)).toBe('EACCES: permission denied');
  });

  it('английский интерфейс получает английские слова', async () => {
    await i18n.changeLanguage('en');
    try {
      expect(warningDetailText('missing', t)).toBe('the file is missing');
      expect(warningDetailText('permission', t)).toContain('permission');
    } finally {
      await i18n.changeLanguage('ru');
    }
  });
});
