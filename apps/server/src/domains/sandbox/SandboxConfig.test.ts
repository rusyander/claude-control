import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClaudeLocation } from '@claude-control/contracts';
import { AppStore } from '../../lib/app-store.ts';
import { createSandbox, removeSandbox, sandboxPaths } from './SandboxConfig.ts';

/**
 * Тесты изоляции песочницы. Суть песочницы — временный каталог настроек, куда
 * попадает только проверяемое. Здесь закрепляем главное: границы соблюдаются,
 * учётные данные переносятся (без них Claude Code не работает), а файл с
 * токенами не копируется никогда.
 *
 * Песочница пишет в ~/.claude-control/sandboxes — тест использует уникальный
 * id и убирает его за собой.
 */
describe('SandboxConfig', () => {
  let root: string;
  let location: ClaudeLocation;
  let store: AppStore;
  const sandboxId = `qa-test-${process.pid}`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-sandbox-'));
    mkdirSync(join(root, 'skills'), { recursive: true });
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), '');
    writeFileSync(join(root, '.credentials.json'), '{"token":"secret"}');
    writeFileSync(join(root, '.mcp-secrets.env'), 'GITLAB_TOKEN=real-secret');

    location = {
      source: 'manual',
      paths: {
        root,
        settings: join(root, 'settings.json'),
        settingsLocal: join(root, 'settings.local.json'),
        claudeMd: join(root, 'CLAUDE.md'),
        secretsEnv: join(root, '.mcp-secrets.env'),
        skills: join(root, 'skills'),
        hooks: join(root, 'hooks'),
        mcpConfig: join(root, '.claude.json'),
        appData: join(root, 'claude-control'),
      },
      isValid: true,
      missing: [],
    } as ClaudeLocation;

    store = new AppStore(join(root, 'claude-control'));
  });

  afterEach(() => {
    removeSandbox(sandboxId);
    rmSync(root, { recursive: true, force: true });
  });

  it('создаёт каталог конфигурации и рабочую папку', () => {
    const sandbox = createSandbox(sandboxId, {}, location, store);
    expect(existsSync(sandbox.configDir)).toBe(true);
    expect(existsSync(sandbox.workDir)).toBe(true);
  });

  it('переносит учётные данные — без них Claude Code не запустится', () => {
    const sandbox = createSandbox(sandboxId, {}, location, store);
    expect(existsSync(join(sandbox.configDir, '.credentials.json'))).toBe(true);
  });

  it('НЕ копирует файл с токенами MCP', () => {
    const sandbox = createSandbox(sandboxId, {}, location, store);
    expect(existsSync(join(sandbox.configDir, '.mcp-secrets.env'))).toBe(false);
  });

  it('настройки песочницы закрывают настоящий каталог на запись', () => {
    const sandbox = createSandbox(sandboxId, {}, location, store);
    const settings = JSON.parse(readFileSync(join(sandbox.configDir, 'settings.json'), 'utf8'));
    const deny: string[] = settings.permissions?.deny ?? [];

    const realPath = root.replace(/\\/g, '/');
    expect(deny.some((rule) => rule.includes(`Write(${realPath}`))).toBe(true);
    expect(deny.some((rule) => rule.includes('.credentials.json'))).toBe(true);
    expect(deny.some((rule) => rule.includes('.mcp-secrets.env'))).toBe(true);
  });

  it('пустой набор — пустое описание состава', () => {
    const sandbox = createSandbox(sandboxId, {}, location, store);
    expect(sandbox.description.rules).toEqual([]);
    expect(sandbox.description.skills).toEqual([]);
  });

  it('sandboxPaths кладёт песочницы вне настоящего каталога .claude', () => {
    const { root: sandboxRoot } = sandboxPaths(sandboxId);
    expect(sandboxRoot).toContain('.claude-control');
  });
});
