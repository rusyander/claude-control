import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { hashDir, memberContent } from './members.ts';

/**
 * Ревью 28.09: чтение участника группы — обход пути в id (F-11) и петля
 * ссылок в каталоге скилла (F-252). Всё во временном каталоге.
 */

let root: string;
let store: AppStore;

const deps = () => ({
  store,
  paths: {
    root,
    appData: join(root, 'agentdeck'),
    settings: join(root, 'settings.json'),
    settingsLocal: join(root, 'settings.local.json'),
    claudeMd: join(root, 'CLAUDE.md'),
    secretsEnv: join(root, 'secrets.env'),
    skills: join(root, 'claude', 'skills'),
    hooks: join(root, 'hooks'),
    mcpConfig: join(root, '.claude.json'),
  },
  backupDir: join(root, 'agentdeck', 'backups'),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-members-guards-'));
  mkdirSync(join(root, 'agentdeck'), { recursive: true });
  mkdirSync(join(root, 'claude', 'skills'), { recursive: true });
  store = new AppStore(join(root, 'agentdeck'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('F-11: id участника — одно имя, не путь', () => {
  it('скилл `..` (каталог со SKILL.md выше) не читается', () => {
    writeFileSync(join(root, 'claude', 'SKILL.md'), 'outside', 'utf8');
    expect(memberContent(deps(), { kind: 'global' }, { kind: 'skill', id: '..' })).toBeUndefined();
  });

  it('обычное правило проекта читается', () => {
    const project = join(root, 'proj');
    mkdirSync(join(project, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(project, '.claude', 'rules', 'build.md'), '# Build\n\nx\n', 'utf8');
    const scope = { kind: 'project' as const, path: project, provider: 'claude' as const };
    expect(memberContent(deps(), scope, { kind: 'rule', id: 'build' })?.text).toContain('Build');
  });
});

describe('F-252: петля ссылок в каталоге скилла', () => {
  it('junction на родителя не уводит хэш в бесконечную рекурсию', () => {
    const dir = join(root, 'claude', 'skills', 'ladder');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'x', 'utf8');
    symlinkSync(dir, join(dir, 'loop'), 'junction');
    expect(() => hashDir(dir)).not.toThrow();
    const content = memberContent(deps(), { kind: 'global' }, { kind: 'skill', id: 'ladder' });
    expect(content?.text).toBe('x');
  });
});
