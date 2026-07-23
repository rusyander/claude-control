import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scaffoldPlugin, pluginSlug } from './plugins.ts';
import type { PluginScaffoldComponents } from '@claude-control/contracts';

/**
 * Тесты скаффолдера плагина. Проверяем, что каркас раскладывается по формату
 * Claude Code, манифест валиден, а повторный запуск не затирает готовый плагин.
 * Каждый тест пишет в свой временный каталог и убирает его за собой.
 */
describe('scaffoldPlugin', () => {
  let dir: string;

  const all: PluginScaffoldComponents = {
    commands: true,
    agents: true,
    skills: true,
    hooks: true,
  };
  const none: PluginScaffoldComponents = {
    commands: false,
    agents: false,
    skills: false,
    hooks: false,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-scaffold-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('создаёт манифест и выбранные части каркаса', () => {
    const result = scaffoldPlugin({ dir, name: 'My Plugin', components: all });

    expect(result.ok).toBe(true);
    const root = join(dir, 'my-plugin');
    expect(result.path).toBe(root);

    for (const file of [
      '.claude-plugin/plugin.json',
      'README.md',
      'commands/example.md',
      'agents/example.md',
      'skills/my-plugin/SKILL.md',
      'hooks/hooks.json',
    ]) {
      expect(existsSync(join(root, ...file.split('/'))), file).toBe(true);
    }
  });

  it('манифест — валидный JSON с именем-слагом и версией', () => {
    scaffoldPlugin({
      dir,
      name: 'My Plugin',
      description: 'Описание',
      author: 'Автор',
      components: none,
    });

    const manifest = JSON.parse(
      readFileSync(join(dir, 'my-plugin', '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(manifest.name).toBe('my-plugin');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.description).toBe('Описание');
    expect(manifest.author).toEqual({ name: 'Автор' });
  });

  it('без выбранных частей пишет только манифест и README', () => {
    scaffoldPlugin({ dir, name: 'bare', components: none });
    const root = join(dir, 'bare');

    expect(existsSync(join(root, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(root, 'README.md'))).toBe(true);
    expect(existsSync(join(root, 'commands'))).toBe(false);
    expect(existsSync(join(root, 'hooks'))).toBe(false);
  });

  it('hooks.json — валидный JSON с секцией hooks', () => {
    scaffoldPlugin({ dir, name: 'hooked', components: { ...none, hooks: true } });
    const parsed = JSON.parse(readFileSync(join(dir, 'hooked', 'hooks', 'hooks.json'), 'utf8'));
    expect(parsed.hooks.PreToolUse).toBeDefined();
  });

  it('не перезаписывает существующий плагин без force', () => {
    scaffoldPlugin({ dir, name: 'dup', components: none });
    const second = scaffoldPlugin({ dir, name: 'dup', components: none });

    expect(second.ok).toBe(false);
    expect(second.error).toBeTruthy();
  });

  it('force перезаписывает существующий плагин', () => {
    scaffoldPlugin({ dir, name: 'dup', components: none });
    const second = scaffoldPlugin({ dir, name: 'dup', components: all, force: true });
    expect(second.ok).toBe(true);
  });

  it('отклоняет имя из одних недопустимых символов', () => {
    const result = scaffoldPlugin({ dir, name: '🎉🎉🎉', components: none });
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, '🎉🎉🎉'))).toBe(false);
  });

  it('отклоняет относительный каталог — файлы не создаются', () => {
    const result = scaffoldPlugin({ dir: 'relative/path', name: 'x', components: none });
    expect(result.ok).toBe(false);
  });

  it('отклоняет несуществующий каталог', () => {
    const result = scaffoldPlugin({ dir: join(dir, 'nope'), name: 'x', components: none });
    expect(result.ok).toBe(false);
  });

  it('слаг не даёт вырваться из выбранного каталога', () => {
    // Имя с разделителями схлопывается в дефисы, а не в путь наверх.
    const result = scaffoldPlugin({ dir, name: '../../evil', components: none });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(dir, 'evil'));
    expect(existsSync(join(dir, 'evil'))).toBe(true);
    // Ничего не создано за пределами выбранного каталога.
    expect(existsSync(join(dir, '..', 'evil'))).toBe(false);
  });
});

describe('pluginSlug', () => {
  it('приводит имя к формату Claude Code', () => {
    expect(pluginSlug('My Cool Plugin')).toBe('my-cool-plugin');
    expect(pluginSlug('  Trim__me  ')).toBe('trim-me');
  });

  it('возвращает undefined для имени без допустимых символов', () => {
    expect(pluginSlug('🎉')).toBeUndefined();
    expect(pluginSlug('   ')).toBeUndefined();
  });
});

// mkdirSync используется в отдельном тесте на непустой каталог назначения.
describe('scaffoldPlugin в непустой каталог', () => {
  it('создаёт плагин рядом с чужими файлами', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-scaffold-busy-'));
    try {
      mkdirSync(join(dir, 'unrelated'));
      const result = scaffoldPlugin({
        dir,
        name: 'side',
        components: { commands: false, agents: false, skills: false, hooks: false },
      });
      expect(result.ok).toBe(true);
      expect(existsSync(join(dir, 'unrelated'))).toBe(true);
      expect(existsSync(join(dir, 'side', '.claude-plugin', 'plugin.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
