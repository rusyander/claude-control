import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InstructionNameRefusedError,
  projectInstructionTarget,
  readInstructionFilesChoiceFor,
  resolveInstructionTarget,
  userInstructionTarget,
  type InstructionFilesMode,
} from './instruction-files.ts';

/**
 * Имя файла инструкций как РЕШЕНИЕ, а не константа (П2.7).
 *
 * Всё — на живых файлах во временном каталоге: резолвер спрашивает диск, и
 * рукотворная структура, поданная прямо в него, доказала бы таблицу, а не
 * систему. Четыре режима × три раскладки на диске, и в каждой клетке проверяется
 * то, что решает исход: какой файл панель ПРАВИТ и какой при этом читает CLI.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'instruction-files-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Раскладка на диске: какие файлы инструкций в корне лежат. */
type Layout = 'claude' | 'agents' | 'both' | 'empty';

function layout(kind: Layout): void {
  if (kind === 'claude' || kind === 'both') {
    writeFileSync(join(root, 'CLAUDE.md'), '# правила CLAUDE\n');
  }
  if (kind === 'agents' || kind === 'both') {
    writeFileSync(join(root, 'AGENTS.md'), '# правила AGENTS\n');
  }
}

/**
 * Файл настроек в том виде, в каком ключ читает CLI: опция встроенного плагина
 * `agents-md`, а не поле в корне. Написание взято из сборки 2.1.278.
 */
function settings(mode: string, key = 'instructionFiles'): string {
  return JSON.stringify({ pluginConfigs: { 'agents-md@builtin': { options: { [key]: mode } } } });
}

function target(mode: InstructionFilesMode | undefined, requested?: string) {
  const choice =
    mode === undefined
      ? ({ mode: 'claude-md-or-agents-md', source: 'default' } as const)
      : ({ mode, source: 'instructionFiles' } as const);
  return resolveInstructionTarget(root, choice, requested);
}

describe('resolveInstructionTarget: четыре режима × три раскладки', () => {
  const cases: Array<{
    mode: InstructionFilesMode;
    disk: Layout;
    fileName: string;
    read: string[];
    ignored: string[];
  }> = [
    // claude-md: `AGENTS.md` не читается никогда, но правится — иначе человек
    // не увидит и не поправит файл, который у него есть.
    { mode: 'claude-md', disk: 'claude', fileName: 'CLAUDE.md', read: ['CLAUDE.md'], ignored: [] },
    { mode: 'claude-md', disk: 'agents', fileName: 'AGENTS.md', read: [], ignored: ['AGENTS.md'] },
    {
      mode: 'claude-md',
      disk: 'both',
      fileName: 'CLAUDE.md',
      read: ['CLAUDE.md'],
      ignored: ['AGENTS.md'],
    },

    // Умолчание: `AGENTS.md` берётся там, где своего `CLAUDE.md` нет.
    {
      mode: 'claude-md-or-agents-md',
      disk: 'claude',
      fileName: 'CLAUDE.md',
      read: ['CLAUDE.md'],
      ignored: [],
    },
    {
      mode: 'claude-md-or-agents-md',
      disk: 'agents',
      fileName: 'AGENTS.md',
      read: ['AGENTS.md'],
      ignored: [],
    },
    // Оговорка, решающая всё: оставшийся рядом `CLAUDE.md` молча побеждает.
    {
      mode: 'claude-md-or-agents-md',
      disk: 'both',
      fileName: 'CLAUDE.md',
      read: ['CLAUDE.md'],
      ignored: ['AGENTS.md'],
    },

    // Оба сразу: читаются два файла, правится первый в порядке чтения CLI.
    {
      mode: 'claude-md-and-agents-md',
      disk: 'both',
      fileName: 'CLAUDE.md',
      read: ['CLAUDE.md', 'AGENTS.md'],
      ignored: [],
    },
    {
      mode: 'claude-md-and-agents-md',
      disk: 'agents',
      fileName: 'AGENTS.md',
      read: ['AGENTS.md'],
      ignored: [],
    },
    {
      mode: 'claude-md-and-agents-md',
      disk: 'claude',
      fileName: 'CLAUDE.md',
      read: ['CLAUDE.md'],
      ignored: [],
    },

    // managed-only: CLI не читает НИЧЕГО своего — но файл человека остаётся виден.
    {
      mode: 'managed-only',
      disk: 'claude',
      fileName: 'CLAUDE.md',
      read: [],
      ignored: ['CLAUDE.md'],
    },
    {
      mode: 'managed-only',
      disk: 'agents',
      fileName: 'AGENTS.md',
      read: [],
      ignored: ['AGENTS.md'],
    },
    {
      mode: 'managed-only',
      disk: 'both',
      fileName: 'CLAUDE.md',
      read: [],
      ignored: ['CLAUDE.md', 'AGENTS.md'],
    },
  ];

  for (const one of cases) {
    it(`${one.mode} + ${one.disk} → правим ${one.fileName}`, () => {
      layout(one.disk);
      const resolved = target(one.mode);
      expect(resolved.fileName).toBe(one.fileName);
      expect(resolved.filePath).toBe(join(root, one.fileName));
      expect(resolved.proposed).toBe(false);
      expect(resolved.view.read.map((entry) => entry.fileName)).toEqual(one.read);
      expect(resolved.view.ignored.map((entry) => entry.fileName)).toEqual(one.ignored);
    });
  }
});

describe('пустой корень: имя ПРЕДЛАГАЕТСЯ, а не находится', () => {
  it('умолчание предлагает AGENTS.md — общее имя четырёх CLI', () => {
    const resolved = target('claude-md-or-agents-md');
    expect(resolved.proposed).toBe(true);
    expect(resolved.fileName).toBe('AGENTS.md');
    expect(resolved.view.choices).toEqual(['CLAUDE.md', 'AGENTS.md']);
    // Ничего не создано: резолвер ТОЛЬКО отвечает, пишет вызывающий.
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
  });

  it('claude-md предлагает CLAUDE.md и другого имени не даёт — AGENTS.md там не прочтут', () => {
    const resolved = target('claude-md');
    expect(resolved.fileName).toBe('CLAUDE.md');
    expect(resolved.view.choices).toEqual(['CLAUDE.md']);
    expect(() => target('claude-md', 'AGENTS.md')).toThrow(InstructionNameRefusedError);
  });

  it('выбранное человеком имя уважается', () => {
    expect(target('claude-md-or-agents-md', 'CLAUDE.md').fileName).toBe('CLAUDE.md');
  });

  it('незнакомое имя — отказ, а не тихая запись не туда', () => {
    expect(() => target('claude-md-or-agents-md', 'НЕ-ТОТ.md')).toThrow(
      InstructionNameRefusedError,
    );
  });
});

describe('панель не переименовывает и не заводит второй файл', () => {
  it('имя, запрошенное рядом с существующим файлом, — отказ 409', () => {
    layout('agents');
    let thrown: unknown;
    try {
      target('claude-md-or-agents-md', 'CLAUDE.md');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InstructionNameRefusedError);
    expect((thrown as InstructionNameRefusedError).reason).toBe('file_exists');
    expect((thrown as InstructionNameRefusedError).statusCode).toBe(409);
    // Красное «до»: без проверки существования резолвер вернул бы путь к
    // `CLAUDE.md`, и первая же запись завела бы файл, который у CLI побеждает.
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('то же имя, что у найденного файла, отказом не считается', () => {
    layout('agents');
    expect(target('claude-md-or-agents-md', 'AGENTS.md').fileName).toBe('AGENTS.md');
  });
});

describe('заметки экрана: режим назван, а не показан пустотой', () => {
  it('managed-only называет себя', () => {
    layout('claude');
    expect(target('managed-only').view.notes).toContainEqual({ code: 'managed-only' });
  });

  it('устаревший ключ projectInstructions помечен', () => {
    layout('claude');
    const resolved = resolveInstructionTarget(root, {
      mode: 'claude-md',
      source: 'projectInstructions',
    });
    expect(resolved.view.notes).toContainEqual({ code: 'legacy-key' });
    expect(resolved.view.source).toBe('projectInstructions');
  });

  it('нераспознанное значение названо вместе с ним самим', () => {
    const resolved = resolveInstructionTarget(root, {
      mode: 'claude-md-or-agents-md',
      source: 'default',
      unrecognized: 'кривое-значение',
    });
    expect(resolved.view.notes).toContainEqual({
      code: 'unrecognized',
      value: 'кривое-значение',
    });
  });

  it('файл рядом, который CLI не читает, назван поимённо', () => {
    layout('both');
    expect(target('claude-md-or-agents-md').view.notes).toContainEqual({
      code: 'ignored-nearby',
      files: ['AGENTS.md'],
    });
  });
});

describe('ключ лежит там, где его читает CLI', () => {
  it('режим берётся из опций встроенного плагина agents-md', () => {
    const user = join(root, 'user-settings.json');
    writeFileSync(user, settings('claude-md'));
    const choice = readInstructionFilesChoiceFor([user]);
    expect(choice.mode).toBe('claude-md');
    expect(choice.source).toBe('instructionFiles');
  });

  // Красный до правки: панель читала ключ из корня `settings.json` и показывала
  // режим, которого у CLI нет. Сборка 2.1.278 верхнеуровневый ключ не читает и
  // даже не ругается на него — молчаливое расхождение, самое дорогое.
  it('верхнеуровневый instructionFiles не считается настройкой', () => {
    const user = join(root, 'user-settings.json');
    writeFileSync(user, JSON.stringify({ instructionFiles: 'claude-md' }));
    const choice = readInstructionFilesChoiceFor([user]);
    expect(choice.mode).toBe('claude-md-or-agents-md');
    expect(choice.source).toBe('default');
  });

  it('файл без ключа пропускается, а не обрывает поиск', () => {
    const empty = join(root, 'empty-settings.json');
    const user = join(root, 'user-settings.json');
    writeFileSync(empty, JSON.stringify({ env: {} }));
    writeFileSync(user, settings('claude-md'));
    expect(readInstructionFilesChoiceFor([empty, user]).mode).toBe('claude-md');
  });

  it('прежний ключ плагина читается и помечается устаревшим', () => {
    const user = join(root, 'user-settings.json');
    writeFileSync(user, settings('claude-md', 'projectInstructions'));
    const choice = readInstructionFilesChoiceFor([user]);
    expect(choice.mode).toBe('claude-md');
    expect(choice.source).toBe('projectInstructions');
  });
});

describe('два уровня спрашивают одно правило', () => {
  it('пользовательский уровень читает свой settings.json', () => {
    writeFileSync(join(root, 'settings.json'), settings('claude-md'));
    layout('agents');
    // Режим `claude-md`: `AGENTS.md` правится, но CLI его не читает — и это сказано.
    const resolved = userInstructionTarget(root);
    expect(resolved.fileName).toBe('AGENTS.md');
    expect(resolved.view.read).toEqual([]);
    expect(resolved.view.notes).toContainEqual({ code: 'ignored-nearby', files: ['AGENTS.md'] });
  });

  it('пользовательский settings.local.json на режим не влияет', () => {
    writeFileSync(join(root, 'settings.local.json'), settings('claude-md'));
    layout('agents');
    expect(userInstructionTarget(root).view.read.map((one) => one.fileName)).toEqual(['AGENTS.md']);
  });

  // Своего режима у проекта быть не может: `.claude/settings*.json` эту опцию не
  // задают («project settings are not read» — сообщение самой сборки).
  it('проектный .claude/settings.json на режим не влияет', () => {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), settings('claude-md-and-agents-md'));
    layout('both');
    const resolved = projectInstructionTarget(root);
    expect(resolved.view.read.map((entry) => entry.fileName)).toEqual(['CLAUDE.md']);
  });

  it('проект берёт режим из пользовательского settings.json', () => {
    const user = join(root, 'user-settings.json');
    writeFileSync(user, settings('claude-md-and-agents-md'));
    layout('both');
    expect(projectInstructionTarget(root, user).view.read.map((one) => one.fileName)).toEqual([
      'CLAUDE.md',
      'AGENTS.md',
    ]);
  });
});

describe('CLAUDE.local.md считается за свой CLAUDE.md', () => {
  // Красный до правки: имени не было в списке, и панель обещала чтение
  // `AGENTS.md` там, где CLI из-за локального файла его не читает.
  it('он отменяет чтение AGENTS.md рядом', () => {
    writeFileSync(join(root, 'CLAUDE.local.md'), '# локальные правила\n');
    layout('agents');
    const resolved = target('claude-md-or-agents-md');
    expect(resolved.view.read.map((one) => one.fileName)).toEqual(['CLAUDE.local.md']);
    expect(resolved.view.ignored.map((one) => one.fileName)).toEqual(['AGENTS.md']);
  });
});
