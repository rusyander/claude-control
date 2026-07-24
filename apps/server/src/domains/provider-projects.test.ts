import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import {
  providerProjectSections,
  resolveProjectFile,
  resolveProviderProjectTarget,
  UnsafeProjectPathError,
} from './provider-projects.ts';
import { providerProjectBackupName, providerBackupName } from '../lib/safe-io.ts';
import { providerTrackedFiles } from './tracked-files.ts';

/** Фейковое хранилище настроек: отдаёт заданный id провайдера. */
function fakeStore(provider: string) {
  return { getSettings: () => ({ provider, claudeDirOverride: '' }) };
}

describe('provider-projects: безопасность путей', () => {
  // Диск здесь не нужен: проверяется чистая сборка пути, файлы не читаются.
  const root = resolve(join('/tmp', 'cc-safe-project'));

  it('обычный относительный путь собирается внутри проекта', () => {
    expect(resolveProjectFile(root, 'AGENTS.md')).toBe(join(root, 'AGENTS.md'));
    expect(resolveProjectFile(root, '.codex/config.toml')).toBe(
      join(root, '.codex', 'config.toml'),
    );
  });

  it('выход за пределы проекта запрещён (fail-closed)', () => {
    for (const evil of [
      '../evil.md',
      '../../etc/passwd',
      '.codex/../../evil.toml',
      'a/../../b.md',
      '/etc/passwd',
      '',
      '.',
    ]) {
      expect(() => resolveProjectFile(root, evil), evil).toThrow(UnsafeProjectPathError);
    }
  });

  it('копии проектных файлов не смешиваются с копиями глобальных', () => {
    const global = providerBackupName('codex', join('/home/u/.codex', 'config.toml'));
    const project = providerProjectBackupName('codex', join(root, '.codex', 'config.toml'));
    expect(global).toBe('codex-config.toml');
    expect(project).toBe('codex-project-config.toml');
    expect(project).not.toBe(global);
  });
});

describe('provider-projects: резолв цели по провайдеру', () => {
  const root = '/tmp/some-project';

  it('claude проектного уровня в этом разделе не имеет (у него свои богатые роуты)', () => {
    expect(resolveProviderProjectTarget(fakeStore('claude'), root)).toBeUndefined();
  });

  it('codex/opencode — инструкции + MCP, gemini ещё env и права, cursor — каталог правил + MCP', () => {
    const sections = (provider: string): string[] => {
      const target = resolveProviderProjectTarget(fakeStore(provider), root);
      expect(target, provider).toBeDefined();
      return providerProjectSections(target!);
    };
    expect(sections('codex')).toEqual(['instructions', 'mcp']);
    // GEMINI-2/3: у Gemini задокументированы ещё .gemini/.env и .gemini/settings.json.
    expect(sections('gemini')).toEqual(['instructions', 'mcp', 'env', 'permissions']);
    // OPENCODE-1/3/4: у OpenCode проектные права и ХУКИ — ключи того же
    // `<проект>/opencode.json`, что и MCP, а ПЛАГИНЫ — ещё и каталог
    // `<проект>/.opencode/plugins` рядом с ним.
    expect(sections('opencode')).toEqual([
      'instructions',
      'mcp',
      'permissions',
      'hooks',
      'plugins',
      // OPENCODE-5: скиллы проекта — каталог `<проект>/.opencode/skills`.
      'skills',
    ]);
    const opencode = resolveProviderProjectTarget(fakeStore('opencode'), root)!;
    expect(opencode.permissions).toMatchObject({
      format: 'opencode-json',
      filePath: join(resolve(root), 'opencode.json'),
      backupName: 'opencode-project-opencode.json',
    });
    expect(opencode.hooks).toMatchObject({
      format: 'opencode-json',
      scope: 'project',
      filePath: join(resolve(root), 'opencode.json'),
      backupName: 'opencode-project-opencode.json',
    });
    expect(opencode.plugins).toMatchObject({
      format: 'opencode-plugins',
      scope: 'project',
      pluginsDir: join(resolve(root), '.opencode', 'plugins'),
      configPath: join(resolve(root), 'opencode.json'),
      backupPrefix: 'opencode-project-',
    });
    // CURSOR-1: у Cursor проектные правила — КАТАЛОГ `.cursor/rules/*.mdc`.
    expect(sections('cursor')).toEqual(['instructionsRules', 'mcp']);
    const cursor = resolveProviderProjectTarget(fakeStore('cursor'), root)!;
    expect(cursor.instructionsRules).toMatchObject({
      format: 'cursor-mdc',
      scope: 'project',
      rulesDir: join(resolve(root), '.cursor', 'rules'),
      backupPrefix: 'cursor-project-',
    });
    // AIDER-4: у Aider инструкции — СПИСОК ссылок `read`, плюс `set-env`; оба
    // раздела живут в одном `<проект>/.aider.conf.yml`.
    expect(sections('aider')).toEqual(['instructionsList', 'env']);
  });

  it('MCP-цель переиспользует формат провайдера и своё имя копии', () => {
    const target = resolveProviderProjectTarget(fakeStore('codex'), root)!;
    expect(target.mcp?.format).toBe('toml');
    expect(target.mcp?.backupName).toBe('codex-project-config.toml');
    // Тот же путь, что и объявлен в каталоге, но от корня ПРОЕКТА.
    expect(target.mcp?.filePath).toBe(join(resolve(root), '.codex', 'config.toml'));
    expect(target.instructions?.fileName).toBe('AGENTS.md');
  });
});

describe('provider-projects: история изменений', () => {
  // Проектные файлы в ленту не попадают НИ У КОГО: у Claude проектные CLAUDE.md
  // и .mcp.json там никогда не показывались (лента ведёт глобальные файлы), и
  // COMMON-2 это правило не меняет — иначе поведение разъехалось бы между
  // провайдерами. Секреты исключены отдельным фильтром в любом случае.
  it('проектные файлы провайдера не попадают в отслеживаемые', () => {
    for (const provider of ['codex', 'gemini', 'opencode', 'cursor']) {
      const files = providerTrackedFiles(fakeStore(provider));
      for (const file of files) {
        expect(file.backupBase.includes('-project-'), `${provider} ${file.backupBase}`).toBe(false);
      }
    }
  });
});
