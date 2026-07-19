import { describe, it, expect } from 'vitest';
// Без расширения: во фронте модули резолвит Vite, и `allowImportingTsExtensions`
// здесь не включён — в отличие от сервера, где TypeScript исполняется напрямую.
import { envToText, textToEnv, parseArgs, formatArgs } from './env-text';

/**
 * Тесты текстового представления переменных окружения (KEY=VALUE по строке)
 * и разбора аргументов команды с кавычками. Логика чистая — без файлов и сети.
 *
 * Важная особенность формата: textToEnv НЕ снимает кавычки со значений
 * (кавычки — часть значения), их обрабатывает только parseArgs для строки
 * запуска команды. Это закреплено отдельными тестами, чтобы не «починить»
 * то, что работает намеренно.
 */

describe('textToEnv (парсинг текста в объект)', () => {
  it('разбирает простые пары KEY=VALUE', () => {
    expect(textToEnv('A=1\nB=2')).toEqual({ A: '1', B: '2' });
  });

  it('пропускает комментарии (# в начале строки) и пустые строки', () => {
    const text = ['# заголовок файла', '', 'A=1', '   ', '# ещё коммент', 'B=2'].join('\n');
    expect(textToEnv(text)).toEqual({ A: '1', B: '2' });
  });

  it('сохраняет всё после ПЕРВОГО «=» — значения с «=» внутри не рвутся', () => {
    expect(textToEnv('URL=postgres://u:p@h:5432/db?sslmode=require')).toEqual({
      URL: 'postgres://u:p@h:5432/db?sslmode=require',
    });
    expect(textToEnv('KEY=a=b=c')).toEqual({ KEY: 'a=b=c' });
  });

  it('обрезает пробелы вокруг «=» и по краям', () => {
    expect(textToEnv('  KEY   =   value  ')).toEqual({ KEY: 'value' });
  });

  it('строка без «=» игнорируется', () => {
    expect(textToEnv('JUST_A_KEY_NO_EQUALS')).toEqual({});
  });

  it('пустой ключ (строка начинается с «=») игнорируется', () => {
    expect(textToEnv('=value')).toEqual({});
  });

  it('пустое значение допустимо', () => {
    expect(textToEnv('EMPTY=')).toEqual({ EMPTY: '' });
  });

  it('пустой ввод и ввод из одних пробелов дают пустой объект', () => {
    expect(textToEnv('')).toEqual({});
    expect(textToEnv('   \n\t\n   ')).toEqual({});
  });

  it('переносы строк Windows (CRLF) обрабатываются как обычные', () => {
    expect(textToEnv('A=1\r\nB=2')).toEqual({ A: '1', B: '2' });
  });

  it('дубликат ключа — побеждает последнее значение', () => {
    expect(textToEnv('A=1\nA=2')).toEqual({ A: '2' });
  });

  it('символ «#» внутри значения остаётся частью значения', () => {
    expect(textToEnv('COLOR=#ff0000')).toEqual({ COLOR: '#ff0000' });
  });

  it('кавычки вокруг значения НЕ снимаются (являются частью значения)', () => {
    // Осознанное поведение формата: кавычки не трогаем.
    expect(textToEnv('KEY="value"')).toEqual({ KEY: '"value"' });
    expect(textToEnv("KEY='value'")).toEqual({ KEY: "'value'" });
  });
});

describe('envToText (сериализация объекта в текст)', () => {
  it('склеивает пары KEY=VALUE через перевод строки', () => {
    expect(envToText({ A: '1', B: '2' })).toBe('A=1\nB=2');
  });

  it('пустой объект даёт пустую строку', () => {
    expect(envToText({})).toBe('');
  });

  it('сохраняет порядок вставки ключей', () => {
    expect(envToText({ Z: '1', A: '2', M: '3' })).toBe('Z=1\nA=2\nM=3');
  });

  it('значения с пробелами и спецсимволами не экранируются', () => {
    expect(envToText({ CMD: 'a b c', PATH: 'C:\\Program Files' })).toBe(
      'CMD=a b c\nPATH=C:\\Program Files',
    );
  });
});

describe('round-trip (parse ↔ serialize)', () => {
  it('textToEnv(envToText(obj)) возвращает исходный объект', () => {
    const obj = { NODE_ENV: 'production', TOKEN: 'glpat-xyz', DIR: '/a/b/c' };
    expect(textToEnv(envToText(obj))).toEqual(obj);
  });

  it('envToText(textToEnv(text)) стабилен для канонического текста', () => {
    const canonical = 'A=1\nB=two\nC=3';
    expect(envToText(textToEnv(canonical))).toBe(canonical);
  });

  it('после разбора «шумного» текста повторный round-trip идемпотентен', () => {
    const noisy = ['# comment', '', '  A  =  1  ', 'B=x=y', '#end'].join('\n');
    const once = textToEnv(noisy); // { A: '1', B: 'x=y' }
    expect(once).toEqual({ A: '1', B: 'x=y' });
    // Прогон через сериализацию и обратно не меняет данные.
    expect(textToEnv(envToText(once))).toEqual(once);
  });
});

describe('parseArgs (разбор аргументов команды с кавычками)', () => {
  it('делит по пробелам', () => {
    expect(parseArgs('a b c')).toEqual(['a', 'b', 'c']);
  });

  it('двойные кавычки сохраняют пробелы и снимаются', () => {
    expect(parseArgs('"a b" c')).toEqual(['a b', 'c']);
  });

  it('одинарные кавычки тоже сохраняют пробелы и снимаются', () => {
    expect(parseArgs("'a b' c")).toEqual(['a b', 'c']);
  });

  it('путь Windows с пробелами в кавычках остаётся одним аргументом', () => {
    expect(parseArgs('run "C:\\Program Files\\app" --flag')).toEqual([
      'run',
      'C:\\Program Files\\app',
      '--flag',
    ]);
  });

  it('пустой ввод и ввод из пробелов дают пустой массив', () => {
    expect(parseArgs('')).toEqual([]);
    expect(parseArgs('   ')).toEqual([]);
  });

  it('лишние пробелы между аргументами схлопываются', () => {
    expect(parseArgs('a    b')).toEqual(['a', 'b']);
  });
});

describe('formatArgs (сборка аргументов обратно в строку)', () => {
  it('склеивает аргументы через пробел', () => {
    expect(formatArgs(['a', 'b', 'c'])).toBe('a b c');
  });

  it('аргумент с пробелом оборачивается в двойные кавычки', () => {
    expect(formatArgs(['a b', 'c'])).toBe('"a b" c');
  });

  it('аргумент без пробела не оборачивается', () => {
    expect(formatArgs(['nospace'])).toBe('nospace');
  });

  it('пустой массив даёт пустую строку', () => {
    expect(formatArgs([])).toBe('');
  });

  it('round-trip parseArgs(formatArgs(args)) сохраняет аргументы', () => {
    const args = ['run', 'C:\\Program Files\\app', '--flag', 'value'];
    expect(parseArgs(formatArgs(args))).toEqual(args);
  });
});
