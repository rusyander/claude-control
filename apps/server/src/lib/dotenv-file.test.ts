import { describe, it, expect } from 'vitest';
import {
  readDotenvVars,
  writeDotenvVars,
  UnrecognizedFormatError,
  EnvKeyNotEncodableError,
} from './dotenv-file.ts';
import { BOM_CHAR } from './text-form.ts';

/**
 * Построчная правка `.env` (GEMINI-3). Главное, что проверяем: панель не
 * пересобирает чужой файл, а меняет ровно нужные строки — комментарии, пустые
 * строки, порядок и написание нетронутых значений обязаны выживать. Всё, что
 * наша модель не разбирает, обязано приводить к отказу (fail-closed).
 */

// Реальный по духу файл: шапка-комментарий, группы, `export`, кавычки, коммент
// в конце строки, значение с пробелами и пустая строка в конце.
const SAMPLE = `# Ключи Gemini
# вторая строка шапки

GEMINI_API_KEY=abc123
export GOOGLE_CLOUD_PROJECT=my-project # рабочий проект

# Прокси
HTTPS_PROXY="http://127.0.0.1:8080"
GREETING='hello world'
EMPTY=
`;

describe('readDotenvVars: разбор .env', () => {
  it('читает простые, экспортируемые и закавыченные значения', () => {
    expect(readDotenvVars(SAMPLE)).toEqual([
      { key: 'GEMINI_API_KEY', value: 'abc123' },
      { key: 'GOOGLE_CLOUD_PROJECT', value: 'my-project' },
      { key: 'HTTPS_PROXY', value: 'http://127.0.0.1:8080' },
      { key: 'GREETING', value: 'hello world' },
      { key: 'EMPTY', value: '' },
    ]);
  });

  it('снимает BOM (Блокнот/PowerShell) — здоровый файл не уходит в read-only', () => {
    expect(readDotenvVars(`${BOM_CHAR}A=1\n`)).toEqual([{ key: 'A', value: '1' }]);
  });

  it('экранирование внутри двойных кавычек разбирается, внутри одинарных — нет', () => {
    expect(readDotenvVars('A="line1\\nline2"\nB=\'raw\\n\'\n')).toEqual([
      { key: 'A', value: 'line1\nline2' },
      { key: 'B', value: 'raw\\n' },
    ]);
  });

  it('дубликат ключа: побеждает последнее присваивание (как в dotenv)', () => {
    expect(readDotenvVars('A=1\nA=2\n')).toEqual([{ key: 'A', value: '2' }]);
  });

  it.each([
    ['строка без «=»', 'A=1\nпросто текст\n'],
    ['незакрытая двойная кавычка (многострочное значение)', 'A="незакрыто\n'],
    ['незакрытая одинарная кавычка', "A='незакрыто\n"],
    ['мусор после закрывающей кавычки', 'A="ok" мусор\n'],
    ['имя с дефисом (не наш формат)', 'MY-KEY=1\n'],
    ['имя, начинающееся с цифры', '1KEY=1\n'],
  ])('fail-closed: %s', (_name, text) => {
    expect(() => readDotenvVars(text)).toThrow(UnrecognizedFormatError);
  });
});

describe('writeDotenvVars: хирургическая запись', () => {
  it('меняет только строку затронутого ключа; комментарии, порядок и прочие строки целы', () => {
    const next = writeDotenvVars(SAMPLE, [
      { key: 'GEMINI_API_KEY', value: 'NEW' },
      { key: 'GOOGLE_CLOUD_PROJECT', value: 'my-project' },
      { key: 'HTTPS_PROXY', value: 'http://127.0.0.1:8080' },
      { key: 'GREETING', value: 'hello world' },
      { key: 'EMPTY', value: '' },
    ]);

    expect(next).toBe(`# Ключи Gemini
# вторая строка шапки

GEMINI_API_KEY=NEW
export GOOGLE_CLOUD_PROJECT=my-project # рабочий проект

# Прокси
HTTPS_PROXY="http://127.0.0.1:8080"
GREETING='hello world'
EMPTY=
`);
  });

  it('round-trip без изменений возвращает файл байт-в-байт', () => {
    expect(writeDotenvVars(SAMPLE, readDotenvVars(SAMPLE))).toBe(SAMPLE);
  });

  it('новый ключ дописывается в конец, завершающий перевод строки сохраняется', () => {
    const next = writeDotenvVars('# шапка\nA=1\n', [
      { key: 'A', value: '1' },
      { key: 'B', value: '2' },
    ]);
    expect(next).toBe('# шапка\nA=1\nB=2\n');
  });

  it('удалённый в панели ключ убирается, соседние строки не двигаются', () => {
    const next = writeDotenvVars('# шапка\nA=1\nB=2\n# хвост\n', [{ key: 'B', value: '2' }]);
    expect(next).toBe('# шапка\nB=2\n# хвост\n');
  });

  it('префикс export сохраняется при смене значения', () => {
    expect(writeDotenvVars('export A=1\n', [{ key: 'A', value: '2' }])).toBe('export A=2\n');
  });

  it('дубликаты схлопываются в действующее (последнее) присваивание', () => {
    expect(
      writeDotenvVars('A=1\nB=x\nA=2\n', [
        { key: 'A', value: '3' },
        { key: 'B', value: 'x' },
      ]),
    ).toBe('B=x\nA=3\n');
  });

  it('значение с пробелами/решёткой/кавычками кавычится и читается обратно', () => {
    const vars = [
      { key: 'A', value: 'два слова' },
      { key: 'B', value: 'знач # не комментарий' },
      { key: 'C', value: 'с "кавычками"' },
      { key: 'D', value: 'много\nстрок' },
    ];
    const next = writeDotenvVars('', vars);
    expect(readDotenvVars(next)).toEqual(vars);
  });

  it('пустой файл + пустой набор → пустой результат', () => {
    expect(writeDotenvVars('', [])).toBe('');
  });

  it('непредставимое имя переменной отклоняется ДО записи', () => {
    for (const key of ['', 'MY-KEY', '1KEY', 'A B', 'A=B']) {
      expect(() => writeDotenvVars('', [{ key, value: '1' }])).toThrow(EnvKeyNotEncodableError);
    }
  });

  it('нераспознанный файл не перезаписывается (fail-closed на входе)', () => {
    expect(() => writeDotenvVars('это не .env\n', [{ key: 'A', value: '1' }])).toThrow(
      UnrecognizedFormatError,
    );
  });
});
