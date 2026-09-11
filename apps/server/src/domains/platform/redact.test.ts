import { describe, it, expect } from 'vitest';
import { foreignTail, redactSecrets, FOREIGN_TEXT_LIMIT } from './redact.ts';
import { assertToken } from './store.ts';

/**
 * Чистка чужого текста. Правило одно на три стороны — проба, агент,
 * эмбеддинги, — и цена ошибки у него одна: сервер контура вправе отразить
 * присланный ключ в теле ошибки («unknown api key sk-…»), а такой текст оседает
 * в `state.json` и уезжает экспортом настроек на другую машину.
 */

const TOKEN = 'sk-live-0123456789abcdef';

describe('redactSecrets', () => {
  it('свой ключ вырезается по значению, где бы он ни стоял', () => {
    const text = redactSecrets(`unknown api key ${TOKEN} rejected`, TOKEN);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('«ключ»');
  });

  it('чужой секрет — по форме: своего значения для него у панели нет', () => {
    const text = redactSecrets('use Authorization: Bearer eyJhbGciOiJIUzI1NiJ9', TOKEN);
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('короткий ключ по значению не ищется — и это не дыра', () => {
    // Подстрока в шесть символов резала бы куски осмысленного текста, поэтому
    // чистка по значению начинается с восьми. Дыры нет потому, что второй
    // порог — `MIN_KEY_LENGTH` в `store.ts` — такой ключ сохранить не даёт:
    // отражённого контуром ключа короче восьми не существует.
    expect(redactSecrets('ключ abc123 отклонён', 'abc123')).toBe('ключ abc123 отклонён');
    expect(() => assertToken('abc123')).toThrow(/короче/);
  });

  it('без ключа текст живёт: чистить по значению нечего', () => {
    expect(redactSecrets('обычная причина', undefined)).toBe('обычная причина');
    expect(redactSecrets('обычная причина', '')).toBe('обычная причина');
  });
});

describe('foreignTail', () => {
  it('сначала чистка, потом обрезка — половина ключа наружу это тот же ключ', () => {
    const tail = foreignTail(`${'ц'.repeat(FOREIGN_TEXT_LIMIT - 4)} ${TOKEN}`, TOKEN);
    expect(tail).toHaveLength(FOREIGN_TEXT_LIMIT);
    expect(tail).not.toContain('sk-live');
  });
});
