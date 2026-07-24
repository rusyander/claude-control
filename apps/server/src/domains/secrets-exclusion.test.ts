import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClaudePaths } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import { setStoredKey } from '../lib/provider-keys.ts';
import { buildConfigBundle } from './config-bundle.ts';
import { buildDiff, buildHistory } from './history.ts';
import { collectSearchInputs, searchConfig } from './search.ts';
import { trackedFiles, isSecretFile } from './tracked-files.ts';

/**
 * КРИТИЧЕСКИЙ ИНВАРИАНТ: секреты не попадают ни в историю, ни в поиск, ни в
 * бандл — при ЛЮБОМ активном провайдере.
 *
 * Секретов три:
 *  - `.mcp-secrets.env` — токены MCP-серверов;
 *  - `provider-keys.enc` — зашифрованное хранилище API-ключей провайдеров;
 *  - `provider-keys.key` — машинный секрет, которым `.enc` расшифровывается.
 *
 * Ф11a расширила историю и поиск на файлы провайдеров, поэтому проверяем не
 * «раздела нет», а честно: кладём копии секретов в каталог резервных копий,
 * кладём сами секреты на диск — и убеждаемся, что ни лента, ни дифф, ни поиск,
 * ни бандл их не показывают, перебирая ВСЕХ провайдеров.
 */

const PROVIDERS = ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'aider'] as const;

const MCP_SECRET_VALUE = 'glpat-очень-секретный-токен';
const API_KEY_VALUE = 'sk-секретный-ключ-провайдера-1234';

let root: string;
let backupDir: string;
let paths: ClaudePaths;
let store: AppStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-secrets-'));
  const appData = join(root, 'claude-control');
  backupDir = join(appData, 'backups');
  mkdirSync(appData, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(join(root, 'skills'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });

  paths = {
    root,
    settings: join(root, 'settings.json'),
    settingsLocal: join(root, 'settings.local.json'),
    claudeMd: join(root, 'CLAUDE.md'),
    secretsEnv: join(root, '.mcp-secrets.env'),
    skills: join(root, 'skills'),
    hooks: join(root, 'hooks'),
    mcpConfig: join(root, '.claude.json'),
    appData,
  };

  writeFileSync(paths.settings, '{}\n');
  writeFileSync(paths.claudeMd, '# правила\n');
  // Живой файл секретов и его копии в каталоге резервных копий.
  writeFileSync(paths.secretsEnv, `GITLAB_TOKEN=${MCP_SECRET_VALUE}\n`);
  writeFileSync(
    join(backupDir, '.mcp-secrets.env.2026-07-20T10-00-00-000Z.bak'),
    `GITLAB_TOKEN=${MCP_SECRET_VALUE}\n`,
  );
  // Хранилище ключей провайдеров + его машинный секрет (создаются setStoredKey).
  setStoredKey(appData, 'codex', API_KEY_VALUE);
  // И их «копии», как если бы кто-то однажды их забэкапил.
  writeFileSync(join(backupDir, 'provider-keys.enc.2026-07-20T10-00-00-000Z.bak'), 'шифротекст');
  writeFileSync(join(backupDir, 'provider-keys.key.2026-07-20T10-00-00-000Z.bak'), 'машинный');

  store = new AppStore(appData);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Секреты не попадают в историю изменений', () => {
  it('ни при одном провайдере секретный файл не отслеживается', () => {
    for (const provider of PROVIDERS) {
      store.updateSettings({ provider });
      const targets = trackedFiles(paths, store);
      expect(targets.some((item) => isSecretFile(item.path))).toBe(false);
    }
  });

  it('копии секретов лежат в каталоге, но в ленту не попадают', () => {
    for (const provider of PROVIDERS) {
      store.updateSettings({ provider });
      const items = buildHistory(backupDir, trackedFiles(paths, store));
      expect(items.some((item) => item.file.includes('mcp-secrets'))).toBe(false);
      expect(items.some((item) => item.file.includes('provider-keys'))).toBe(false);
    }
  });

  it('дифф копии секретов недоступен — значение токена не показать', () => {
    store.updateSettings({ provider: 'codex' });
    const targets = trackedFiles(paths, store);
    for (const name of [
      '.mcp-secrets.env.2026-07-20T10-00-00-000Z.bak',
      'provider-keys.enc.2026-07-20T10-00-00-000Z.bak',
      'provider-keys.key.2026-07-20T10-00-00-000Z.bak',
    ]) {
      expect(buildDiff(backupDir, name, targets)).toBeUndefined();
    }
  });
});

describe('Секреты не попадают в глобальный поиск', () => {
  it('значение токена MCP не находится ни при одном провайдере', async () => {
    for (const provider of PROVIDERS) {
      store.updateSettings({ provider });
      const response = await searchConfig({ paths, store }, 'glpat-очень');
      expect(response.results).toEqual([]);
    }
  });

  it('API-ключ провайдера не находится и не индексируется', async () => {
    for (const provider of PROVIDERS) {
      store.updateSettings({ provider });
      const response = await searchConfig({ paths, store }, 'секретный-ключ');
      expect(response.results).toEqual([]);

      const inputs = await collectSearchInputs({ paths, store });
      expect(JSON.stringify(inputs)).not.toContain(API_KEY_VALUE);
      expect(JSON.stringify(inputs)).not.toContain(MCP_SECRET_VALUE);
    }
  });

  it('у провайдера в индекс попадают ИМЕНА переменных, но не значения', async () => {
    store.updateSettings({ provider: 'codex' });
    const inputs = await collectSearchInputs({ paths, store });
    // Ветка провайдера собирает только имена ключей — поля значений там нет.
    expect(inputs.provider?.envKeys.every((key) => typeof key === 'string')).toBe(true);
    expect(JSON.stringify(inputs.provider ?? {})).not.toContain(MCP_SECRET_VALUE);
  });
});

describe('Секреты не попадают в бандл конфигурации', () => {
  it('бандл собирает только правила/скиллы/хуки', () => {
    const bundle = JSON.stringify(buildConfigBundle(paths, '2026-07-24T00:00:00.000Z'));
    expect(bundle).not.toContain(MCP_SECRET_VALUE);
    expect(bundle).not.toContain(API_KEY_VALUE);
    expect(bundle).not.toContain('provider-keys');
    expect(bundle).not.toContain('mcp-secrets');
  });
});
