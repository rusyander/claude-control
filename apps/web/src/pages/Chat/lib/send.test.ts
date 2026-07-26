import { describe, it, expect } from 'vitest';
import { planSend, clearsComposer } from './send';
import { isSupportedUpload, unsupportedUploadNames } from './uploads';

/**
 * Отправка сообщения из поля ввода.
 *
 * Регрессии: (1) поле очищалось ДО запроса — отказ сервера стирал набранное
 * вместе с черновиком; (2) неподдерживаемое вложение отклонял только сервер, и
 * к моменту отказа композер уже снял чипы — файлы приходилось прикладывать
 * заново. Оба решения теперь принимаются здесь, до сети и до очистки.
 */
describe('planSend', () => {
  it('пустой текст (и пробелы) — ничего не отправляем', () => {
    expect(planSend('   ', [])).toEqual({ action: 'ignore' });
  });

  it('неподдерживаемое вложение — отказ ДО отправки, с именами файлов', () => {
    expect(planSend('разбери', [{ name: 'network.zip' }, { name: 'schema.sql' }])).toEqual({
      action: 'reject',
      names: ['network.zip', 'schema.sql'],
    });
  });

  it('поддерживаемые вложения — отправляем обрезанный текст', () => {
    expect(planSend('  привет  ', [{ name: 'ОТЧЁТ.PDF' }, { name: 'a.tsx' }])).toEqual({
      action: 'dispatch',
      prompt: 'привет',
    });
  });

  it('поле ввода очищается только при принятой отправке', () => {
    expect(clearsComposer({ ok: true })).toBe(true);
    expect(clearsComposer({ ok: false, code: 'run_busy', message: 'занят' })).toBe(false);
    expect(clearsComposer({ ok: false, message: 'нет связи' })).toBe(false);
  });
});

describe('белый список вложений', () => {
  it('регистр расширения не важен', () => {
    expect(isSupportedUpload('Снимок.PNG')).toBe(true);
    expect(isSupportedUpload('доклад.pdf')).toBe(true);
  });

  it('файл без расширения и точечное имя не проходят', () => {
    expect(isSupportedUpload('Dockerfile')).toBe(false);
    expect(isSupportedUpload('.gitignore')).toBe(false);
    expect(isSupportedUpload('archive.tar.gz')).toBe(false);
  });

  it('перечисляет ровно отклонённые имена', () => {
    expect(unsupportedUploadNames([{ name: 'a.md' }, { name: 'b.heic' }])).toEqual(['b.heic']);
  });
});
