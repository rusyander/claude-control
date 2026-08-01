import { describe, it, expect } from 'vitest';
import type { SlashCommand } from '@claude-control/contracts';
import {
  buildCommandRows,
  builtinRows,
  filterCommands,
  countBySource,
  type CommandRow,
} from './commandView';
import { BUILTIN_COMMANDS } from './builtinCommands';

/**
 * Список команд склеивается из двух половин, и обе имеют право соврать
 * по-своему: встроенная может перекрыть одноимённую пользовательскую (тогда
 * человек пойдёт править не то), а семья — собраться из одной команды (подпись
 * «в семье» без семьи). Проверяем ровно эти места.
 */

const disk = (overrides: Partial<SlashCommand>): SlashCommand => ({
  id: 'x',
  invocation: '/x',
  name: 'x',
  source: 'skill',
  description: '',
  isEnabled: true,
  aliases: [],
  related: [],
  target: 'none',
  ...overrides,
});

const find = (rows: CommandRow[], invocation: string): CommandRow | undefined =>
  rows.find((row) => row.invocation === invocation);

describe('buildCommandRows', () => {
  it('встроенные добавляются к прочитанным с диска', () => {
    const rows = buildCommandRows(
      [disk({ invocation: '/deep-review', name: 'deep-review' })],
      'ru',
    );

    expect(find(rows, '/deep-review')?.isBuiltin).toBe(false);
    expect(find(rows, '/clear')?.isBuiltin).toBe(true);
  });

  /** Свой файл главнее: правят именно его, и показывать надо его. */
  it('одноимённая команда с диска перекрывает встроенную', () => {
    const rows = buildCommandRows(
      [disk({ invocation: '/doctor', name: 'doctor', description: 'мой доктор' })],
      'ru',
    );

    const doctors = rows.filter((row) => row.invocation === '/doctor');
    expect(doctors).toHaveLength(1);
    expect(doctors[0]).toMatchObject({ isBuiltin: false, description: 'мой доктор' });
  });

  it('семья считается по общему префиксу имени', () => {
    const rows = buildCommandRows([], 'ru');

    expect(find(rows, '/design-sync')?.family).toContain('/design-login');
  });

  it('команды одного плагина — одна семья, даже если имена разные', () => {
    const rows = buildCommandRows(
      [
        disk({ invocation: '/p:commit', name: 'commit', source: 'plugin', owner: 'p@market' }),
        disk({ invocation: '/p:push', name: 'push', source: 'plugin', owner: 'p@market' }),
      ],
      'ru',
      false,
    );

    expect(find(rows, '/p:commit')?.family).toEqual(['/p:push']);
  });

  it('одиночная команда семьёй не считается', () => {
    const rows = buildCommandRows([disk({ invocation: '/solo', name: 'solo' })], 'ru', false);

    expect(rows[0]?.family).toEqual([]);
    expect(rows[0]?.familyKey).toBeUndefined();
  });

  it('убранная из CLI команда помечена, а не выброшена', () => {
    const rows = buildCommandRows([], 'ru');

    expect(find(rows, '/vim')).toMatchObject({ isRemoved: true, isEnabled: false });
  });
});

describe('каталог встроенных', () => {
  it('у каждой команды есть описание на обоих языках', () => {
    const empty = BUILTIN_COMMANDS.filter((command) => !command.ru.trim() || !command.en.trim());
    expect(empty).toEqual([]);
  });

  it('имена не повторяются', () => {
    const names = BUILTIN_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('язык интерфейса выбирает язык описания', () => {
    const ru = builtinRows('ru').find((row) => row.invocation === '/clear')?.description;
    const en = builtinRows('en').find((row) => row.invocation === '/clear')?.description;

    expect(ru).not.toBe(en);
    expect(ru).toMatch(/[а-яё]/i);
  });
});

describe('поиск', () => {
  const rows = buildCommandRows(
    [disk({ invocation: '/deep-review', name: 'deep-review', description: 'разбор кода' })],
    'ru',
  );

  it('ищет по имени, описанию и другому имени той же команды', () => {
    expect(filterCommands(rows, 'разбор')[0]?.invocation).toBe('/deep-review');
    expect(filterCommands(rows, 'quit')[0]?.invocation).toBe('/exit');
  });

  it('слэш в запросе не мешает — команду набирают именно так', () => {
    expect(filterCommands(rows, '/deep-rev')[0]?.invocation).toBe('/deep-review');
  });

  it('пустой запрос ничего не отсеивает', () => {
    expect(filterCommands(rows, '   ')).toHaveLength(rows.length);
  });
});

describe('счётчики источников', () => {
  it('считают каждый источник отдельно и всё вместе', () => {
    const rows = buildCommandRows(
      [
        disk({ invocation: '/a', name: 'a', source: 'skill' }),
        disk({ invocation: '/b', name: 'b', source: 'command' }),
      ],
      'ru',
      false,
    );

    expect(countBySource(rows)).toMatchObject({ all: 2, skill: 1, command: 1, builtin: 0 });
  });
});
