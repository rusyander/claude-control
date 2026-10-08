import { describe, it, expect } from 'vitest';
import {
  readAiderSetEnv,
  writeAiderSetEnv,
  readAiderReadList,
  writeAiderReadList,
  parseAiderDocument,
  UnrecognizedFormatError,
  EnvKeyNotEncodableError,
} from './aider-yaml.ts';

/**
 * Правка `~/.aider.conf.yml` через Document API пакета `yaml`.
 *
 * Главное, за чем следим: (1) ROUND-TRIP — комментарии, порядок и незатронутые
 * ключи переживают запись без единой потери; (2) FAIL-CLOSED — битый YAML,
 * корень-не-отображение и неожиданная форма `set-env` не дают писать вовсе;
 * (3) ключ, непредставимый в форме `КЛЮЧ=значение`, отклоняется ДО записи.
 */

/** Реалистичный конфиг: закомментированный образец из документации + живые ключи. */
const SAMPLE = `##########################################################
# Sample .aider.conf.yml
##########################################################

## Specify the model to use for the main chat
model: gpt-4o   # выбранная модель

## Set an environment variable (to control API settings)
set-env:
  - OPENAI_API_TYPE=azure
  - AIDER_VOICE_LANGUAGE=ru

## Список файлов-конвенций
read:
  - CONVENTIONS.md

# хвостовой комментарий
`;

describe('Aider ~/.aider.conf.yml: чтение set-env', () => {
  it('список строк читается как пары ключ→значение', () => {
    expect(readAiderSetEnv(SAMPLE)).toEqual([
      { key: 'OPENAI_API_TYPE', value: 'azure' },
      { key: 'AIDER_VOICE_LANGUAGE', value: 'ru' },
    ]);
  });

  it('краткая скалярная форма (одна переменная строкой) тоже читается', () => {
    expect(readAiderSetEnv('set-env: CI=1\n')).toEqual([{ key: 'CI', value: '1' }]);
  });

  it('значение со знаком «=» внутри не рвётся: делим по ПЕРВОМУ знаку', () => {
    expect(readAiderSetEnv('set-env:\n  - TOKEN=a=b=c\n')).toEqual([
      { key: 'TOKEN', value: 'a=b=c' },
    ]);
  });

  it('ключа нет — пустой список, а не ошибка', () => {
    expect(readAiderSetEnv('model: gpt-4o\n')).toEqual([]);
  });

  it('пустой файл и файл из одних комментариев валидны', () => {
    expect(readAiderSetEnv('')).toEqual([]);
    expect(readAiderSetEnv('# только комментарий\n')).toEqual([]);
  });

  it('BOM в начале файла не мешает разбору', () => {
    expect(readAiderSetEnv('\uFEFFset-env:\n  - CI=1\n')).toEqual([{ key: 'CI', value: '1' }]);
  });
});

describe('Aider: fail-closed на неожиданном содержимом', () => {
  it('битый YAML → UnrecognizedFormatError', () => {
    expect(() => readAiderSetEnv('model: [unclosed\n')).toThrow(UnrecognizedFormatError);
    expect(() => parseAiderDocument('a:\n b: 1\n c\n')).toThrow(UnrecognizedFormatError);
  });

  it('корень не отображение (список/скаляр) → UnrecognizedFormatError', () => {
    expect(() => readAiderSetEnv('- один\n- два\n')).toThrow(UnrecognizedFormatError);
    expect(() => readAiderSetEnv('просто строка\n')).toThrow(UnrecognizedFormatError);
  });

  it('set-env неожиданной формы (карта / список карт) → UnrecognizedFormatError', () => {
    expect(() => readAiderSetEnv('set-env:\n  CI: 1\n')).toThrow(UnrecognizedFormatError);
    expect(() => readAiderSetEnv('set-env:\n  - CI: 1\n')).toThrow(UnrecognizedFormatError);
  });

  it('элемент без «=» → UnrecognizedFormatError (форма не наша, не гадаем)', () => {
    expect(() => readAiderSetEnv('set-env:\n  - ПРОСТО_ИМЯ\n')).toThrow(UnrecognizedFormatError);
  });

  it('в битый файл НЕ пишем', () => {
    expect(() => writeAiderSetEnv('model: [unclosed\n', [{ key: 'CI', value: '1' }])).toThrow(
      UnrecognizedFormatError,
    );
  });

  it('существующий set-env непонятной формы НЕ перезаписываем вслепую', () => {
    expect(() => writeAiderSetEnv('set-env:\n  CI: 1\n', [{ key: 'X', value: '1' }])).toThrow(
      UnrecognizedFormatError,
    );
    expect(() => writeAiderSetEnv('set-env:\n  - БЕЗ_РАВНО\n', [{ key: 'X', value: '1' }])).toThrow(
      UnrecognizedFormatError,
    );
  });
});

describe('Aider: запись set-env с сохранением комментариев (round-trip)', () => {
  it('комментарии, порядок и прочие ключи целы', () => {
    const next = writeAiderSetEnv(SAMPLE, [
      { key: 'OPENAI_API_TYPE', value: 'azure' },
      { key: 'AIDER_VOICE_LANGUAGE', value: 'en' },
    ]);

    // Комментарии на месте — все три вида: шапка, инлайновый, хвостовой.
    expect(next).toContain('# Sample .aider.conf.yml');
    expect(next).toContain('## Specify the model to use for the main chat');
    expect(next).toContain('# выбранная модель');
    expect(next).toContain('## Set an environment variable (to control API settings)');
    expect(next).toContain('## Список файлов-конвенций');
    expect(next).toContain('# хвостовой комментарий');

    // Незатронутые ключи целы по значениям.
    const parsed = parseAiderDocument(next).toJS() as Record<string, unknown>;
    expect(parsed.model).toBe('gpt-4o');
    expect(parsed.read).toEqual(['CONVENTIONS.md']);

    // Изменилось ровно то, что просили.
    expect(readAiderSetEnv(next)).toEqual([
      { key: 'OPENAI_API_TYPE', value: 'azure' },
      { key: 'AIDER_VOICE_LANGUAGE', value: 'en' },
    ]);
  });

  it('повторная запись того же набора стабильна (read→write→read)', () => {
    const vars = readAiderSetEnv(SAMPLE);
    const once = writeAiderSetEnv(SAMPLE, vars);
    const twice = writeAiderSetEnv(once, readAiderSetEnv(once));
    expect(twice).toBe(once);
    expect(readAiderSetEnv(twice)).toEqual(vars);
  });

  it('ключа не было — добавляется, остальной файл не трогается', () => {
    const next = writeAiderSetEnv('## модель\nmodel: gpt-4o\n', [{ key: 'CI', value: '1' }]);
    expect(next).toContain('## модель');
    expect(readAiderSetEnv(next)).toEqual([{ key: 'CI', value: '1' }]);
    expect((parseAiderDocument(next).toJS() as Record<string, unknown>).model).toBe('gpt-4o');
  });

  it('пустой набор удаляет ключ (дефолт молча не пишем), прочее цело', () => {
    const next = writeAiderSetEnv(SAMPLE, []);
    expect(readAiderSetEnv(next)).toEqual([]);
    expect(next).not.toContain('OPENAI_API_TYPE');
    expect((parseAiderDocument(next).toJS() as Record<string, unknown>).model).toBe('gpt-4o');
    expect(next).toContain('## Список файлов-конвенций');
  });

  it('пустой файл → создаётся конфиг с одним set-env', () => {
    const next = writeAiderSetEnv('', [{ key: 'CI', value: '1' }]);
    expect(readAiderSetEnv(next)).toEqual([{ key: 'CI', value: '1' }]);
  });

  it('длинное значение не переносится по строкам', () => {
    const long = 'x'.repeat(300);
    const next = writeAiderSetEnv('', [{ key: 'LONG', value: long }]);
    expect(readAiderSetEnv(next)).toEqual([{ key: 'LONG', value: long }]);
  });

  it('русские значения и пробелы переживают round-trip', () => {
    const next = writeAiderSetEnv(SAMPLE, [{ key: 'ПРИВЕТ', value: 'мир и пробелы' }]);
    expect(readAiderSetEnv(next)).toEqual([{ key: 'ПРИВЕТ', value: 'мир и пробелы' }]);
  });
});

describe('Aider: ключ, непредставимый в форме КЛЮЧ=значение', () => {
  it('ключ со знаком «=» отклоняется ДО записи', () => {
    expect(() => writeAiderSetEnv(SAMPLE, [{ key: 'A=B', value: '1' }])).toThrow(
      EnvKeyNotEncodableError,
    );
  });

  it('пустой ключ и ключ с переводом строки отклоняются', () => {
    expect(() => writeAiderSetEnv(SAMPLE, [{ key: '   ', value: '1' }])).toThrow(
      EnvKeyNotEncodableError,
    );
    expect(() => writeAiderSetEnv(SAMPLE, [{ key: 'A\nB', value: '1' }])).toThrow(
      EnvKeyNotEncodableError,
    );
  });
});

/**
 * AIDER-1: список ССЫЛОК на файлы инструкций (`read`).
 *
 * Следим за тем же, что и у `set-env`: обе задокументированные формы списка
 * читаются, порядок значим, комментарии и прочие ключи переживают запись, а
 * неожиданная форма значения не даёт писать вовсе.
 */
describe('Aider: чтение списка read', () => {
  it('маркированный список читается по порядку', () => {
    expect(readAiderReadList(SAMPLE)).toEqual(['CONVENTIONS.md']);
  });

  it('inline-массив читается так же, порядок сохраняется', () => {
    expect(readAiderReadList('read: [CONVENTIONS.md, anotherfile.txt]\n')).toEqual([
      'CONVENTIONS.md',
      'anotherfile.txt',
    ]);
  });

  it('одиночная строка = список из одного элемента', () => {
    expect(readAiderReadList('read: CONVENTIONS.md\n')).toEqual(['CONVENTIONS.md']);
  });

  it('ключа нет — пустой список, а не ошибка', () => {
    expect(readAiderReadList('model: gpt-4o\n')).toEqual([]);
  });

  it('абсолютные пути и пути с пробелами читаются как есть', () => {
    expect(readAiderReadList('read:\n  - /home/me/docs/style guide.md\n')).toEqual([
      '/home/me/docs/style guide.md',
    ]);
  });

  it('чужая форма (карта, число, пустая строка) → fail-closed', () => {
    expect(() => readAiderReadList('read:\n  a: b\n')).toThrow(UnrecognizedFormatError);
    expect(() => readAiderReadList('read: 42\n')).toThrow(UnrecognizedFormatError);
    expect(() => readAiderReadList("read:\n  - ''\n")).toThrow(UnrecognizedFormatError);
  });

  it('битый YAML → fail-closed', () => {
    expect(() => readAiderReadList('read: [a\n  - b\n')).toThrow(UnrecognizedFormatError);
  });
});

describe('Aider: запись списка read', () => {
  it('добавление сохраняет комментарии, порядок ключей и set-env', () => {
    const next = writeAiderReadList(SAMPLE, ['CONVENTIONS.md', 'docs/style.md']);
    expect(readAiderReadList(next)).toEqual(['CONVENTIONS.md', 'docs/style.md']);
    // Всё, что не `read`, обязано остаться на месте — вместе с комментариями.
    expect(next).toContain('# Sample .aider.conf.yml');
    expect(next).toContain('## Specify the model to use for the main chat');
    expect(next).toContain('# хвостовой комментарий');
    expect(next).toContain('## Список файлов-конвенций');
    expect(readAiderSetEnv(next)).toEqual([
      { key: 'OPENAI_API_TYPE', value: 'azure' },
      { key: 'AIDER_VOICE_LANGUAGE', value: 'ru' },
    ]);
  });

  it('перестановка меняет ТОЛЬКО порядок записей', () => {
    const three = writeAiderReadList(SAMPLE, ['a.md', 'b.md', 'c.md']);
    const moved = writeAiderReadList(three, ['b.md', 'a.md', 'c.md']);
    expect(readAiderReadList(moved)).toEqual(['b.md', 'a.md', 'c.md']);
    expect(readAiderSetEnv(moved)).toEqual(readAiderSetEnv(three));
  });

  it('удаление всех записей убирает ключ целиком (пустой read: [] не пишем)', () => {
    const next = writeAiderReadList(SAMPLE, []);
    expect(readAiderReadList(next)).toEqual([]);
    expect(next).not.toContain('read:');
    expect(next).toContain('set-env:');
  });

  it('inline-форма конфига переживает правку без потери прочих ключей', () => {
    const source = 'model: gpt-4o\nread: [a.md, b.md]\nauto-commits: false\n';
    const next = writeAiderReadList(source, ['b.md']);
    expect(readAiderReadList(next)).toEqual(['b.md']);
    expect(parseAiderDocument(next).get('auto-commits')).toBe(false);
    expect(parseAiderDocument(next).get('model')).toBe('gpt-4o');
  });

  it('файла ещё нет (пустой текст) — создаётся конфиг с одним ключом read', () => {
    const next = writeAiderReadList('', ['CONVENTIONS.md']);
    expect(readAiderReadList(next)).toEqual(['CONVENTIONS.md']);
  });

  it('очень длинный путь не переносится по строкам', () => {
    const long = `${'d/'.repeat(120)}CONVENTIONS.md`;
    expect(readAiderReadList(writeAiderReadList('', [long]))).toEqual([long]);
  });

  it('существующий read неожиданной формы не перезаписывается вслепую', () => {
    expect(() => writeAiderReadList('read:\n  a: b\n', ['x.md'])).toThrow(UnrecognizedFormatError);
  });

  it('запись с переводом строки отклоняется ДО записи', () => {
    expect(() => writeAiderReadList(SAMPLE, ['a\nb.md'])).toThrow(UnrecognizedFormatError);
    expect(() => writeAiderReadList(SAMPLE, ['   '])).toThrow(UnrecognizedFormatError);
  });
});
