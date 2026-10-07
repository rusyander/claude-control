import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';
import { classify, describe as describeText, kitFiles } from './items.ts';

/**
 * Что считается элементом набора и какой строкой он описан на странице.
 * Разбор — на настоящем каталоге набора в приложении и на строках-образцах.
 */

describe('classify: элемент набора — один файл известного вида', () => {
  it('навык, команда, правило и хук узнаются по пути', () => {
    expect(classify('skills/read-before-edit/SKILL.md')).toEqual({
      id: 'skills/read-before-edit/SKILL.md',
      kind: 'skill',
      name: 'read-before-edit',
    });
    expect(classify('commands/bugfix.md')).toMatchObject({ kind: 'command', name: 'bugfix' });
    expect(classify('rules/local.md')).toMatchObject({ kind: 'rule', name: 'local' });
    expect(classify('hooks/guard-destructive.mjs')).toMatchObject({
      kind: 'hook',
      name: 'guard-destructive.mjs',
    });
    expect(classify('hooks/hooks.json')).toMatchObject({ kind: 'hook', name: 'hooks.json' });
  });

  it('манифест, соседние файлы навыка и чужие расширения элементами не считаются', () => {
    expect(classify('.claude-plugin/plugin.json')).toBeNull();
    expect(classify('skills/read-before-edit/reference.md')).toBeNull();
    expect(classify('skills/a/b/SKILL.md')).toBeNull();
    expect(classify('commands/nested/x.md')).toBeNull();
    expect(classify('hooks/notes.txt')).toBeNull();
    expect(classify('README.md')).toBeNull();
  });
});

describe('kitFiles: настоящий набор в приложении', () => {
  it('каждый SKILL.md, команда, правило и хук каталога — ровно одной строкой, без манифеста', () => {
    const dir = builtinKitDir();
    const files = kitFiles(dir);
    const byKind = (kind: string) =>
      files.filter((file) => file.kind === kind).map((file) => file.name);
    // Состав набора растёт с версией панели: сверяется с самим каталогом, а не со списком.
    const skillDirs = readdirSync(join(dir, 'skills')).filter((name) =>
      existsSync(join(dir, 'skills', name, 'SKILL.md')),
    );
    expect(byKind('skill').sort()).toEqual(skillDirs.sort());
    const mdIn = (sub: string) =>
      readdirSync(join(dir, sub))
        .filter((name) => name.endsWith('.md'))
        .map((name) => name.replace(/\.md$/, ''));
    expect(byKind('command').sort()).toEqual(mdIn('commands').sort());
    expect(byKind('rule').sort()).toEqual(mdIn('rules').sort());
    // То, на что опираются режимы и хуки: без них набор в прогоне не работает.
    expect(byKind('skill')).toEqual(
      expect.arrayContaining(['read-before-edit', 'verify-by-running']),
    );
    expect(byKind('rule')).toEqual(expect.arrayContaining(['local', 'standard']));
    expect(byKind('hook')).toEqual(
      expect.arrayContaining(['guard-destructive.mjs', 'hooks.json', 'session-rules.mjs']),
    );
    expect(files.some((file) => file.id.includes('plugin.json'))).toBe(false);
    expect(new Set(files.map((file) => file.id)).size).toBe(files.length);
  });

  it('несуществующий каталог — пустой список, а не исключение', () => {
    expect(kitFiles('Z:/нет/такого/каталога')).toEqual([]);
  });
});

describe('describe: строка описания на странице', () => {
  it('description из шапки', () => {
    expect(
      describeText('---\nname: x\ndescription:  Делай так.  \n---\n\n# Заголовок\nТело\n'),
    ).toBe('Делай так.');
    expect(describeText('---\r\ndescription: CRLF тоже\r\n---\r\nТело\r\n')).toBe('CRLF тоже');
  });

  it('кавычки YAML снимаются, внутренние остаются', () => {
    expect(describeText('---\ndescription: "Use when «x» — y"\n---\n')).toBe('Use when «x» — y');
    expect(describeText("---\ndescription: 'single'\n---\n")).toBe('single');
    expect(describeText('---\ndescription: say "hi" here\n---\n')).toBe('say "hi" here');
    expect(describeText('---\ndescription: "unbalanced\n---\n')).toBe('"unbalanced');
  });

  it('без description — первая строка тела, а не ключ шапки', () => {
    expect(describeText('---\nname: commit-message\n---\n\n# Заголовок\n\nПервая строка.\n')).toBe(
      'Первая строка.',
    );
  });

  it('правило: заголовки пропускаются, маркер списка снимается', () => {
    expect(describeText('# agentdeck kit rules\n\n- Read the code first.\n- Second.\n')).toBe(
      'Read the code first.',
    );
  });

  it('скрипт хука: первый комментарий после шебанга', () => {
    expect(describeText('#!/usr/bin/env node\n// PreToolUse: guard.\nimport x from "y";\n')).toBe(
      'PreToolUse: guard.',
    );
  });

  it('JSON — без описания: синтаксис файла строкой описания не показывается', () => {
    expect(describeText('{\n  "hooks": {\n    "SessionStart": []\n  }\n}\n')).toBe('');
  });

  it('пустой текст — пустая строка', () => {
    expect(describeText('')).toBe('');
  });
});
