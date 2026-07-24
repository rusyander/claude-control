import { describe, it, expect } from 'vitest';
import { basename, join } from 'node:path';
import type { ClaudePaths } from '@claude-control/contracts';
import {
  claudeTrackedFiles,
  providerTrackedFiles,
  trackedFiles,
  isSecretFile,
} from './tracked-files.ts';

/**
 * Какие файлы попадают в историю изменений.
 *
 * Три гарантии: (1) набор Claude прежний — те же четыре файла и те же имена
 * копий (регресс-ноль); (2) файлы активного провайдера видны, их копии зовутся
 * `<id>-<basename>`, откат у них запрещён; (3) секреты не попадают НИКОГДА —
 * ни `.mcp-secrets.env`, ни хранилище ключей провайдеров с машинным секретом.
 */

const ROOT = join('C:', 'home', '.claude');

const paths: ClaudePaths = {
  root: ROOT,
  settings: join(ROOT, 'settings.json'),
  settingsLocal: join(ROOT, 'settings.local.json'),
  claudeMd: join(ROOT, 'CLAUDE.md'),
  secretsEnv: join(ROOT, '.mcp-secrets.env'),
  skills: join(ROOT, 'skills'),
  hooks: join(ROOT, 'hooks'),
  mcpConfig: join('C:', 'home', '.claude.json'),
  appData: join(ROOT, 'claude-control'),
};

/** Фейковое хранилище настроек — только то, что нужно резолверам. */
function fakeStore(provider: string, claudeDirOverride = '') {
  return { getSettings: () => ({ provider, claudeDirOverride }) };
}

describe('Файлы Claude в истории — набор не менялся', () => {
  const files = claudeTrackedFiles(paths);

  it('ровно четыре файла: settings, settings.local, CLAUDE.md, ~/.claude.json', () => {
    expect(files.map((item) => item.file).sort()).toEqual(
      ['CLAUDE.md', '.claude.json', 'settings.json', 'settings.local.json'].sort(),
    );
  });

  it('имя копии — прежний basename без префикса провайдера', () => {
    for (const item of files) expect(item.backupBase).toBe(basename(item.path));
  });

  it('откат разрешён и провайдер не проставлен', () => {
    for (const item of files) {
      expect(item.canRevert).toBe(true);
      expect(item.providerId).toBeUndefined();
    }
  });

  it('файл секретов .mcp-secrets.env в набор не входит', () => {
    expect(files.some((item) => item.path === paths.secretsEnv)).toBe(false);
  });
});

describe('Файлы активного провайдера', () => {
  it('claude активен → провайдер-файлов нет (дубля с claudeTrackedFiles не будет)', () => {
    expect(providerTrackedFiles(fakeStore('claude'))).toEqual([]);
  });

  it('codex: AGENTS.md + config.toml, причём config.toml ОДИН раз (mcp/env/права в нём же)', () => {
    const files = providerTrackedFiles(fakeStore('codex'));
    expect(files.map((item) => item.file).sort()).toEqual(['AGENTS.md', 'config.toml']);
    expect(files.filter((item) => item.file === 'config.toml')).toHaveLength(1);
  });

  it('codex: копии называются codex-<basename>, откат запрещён', () => {
    for (const item of providerTrackedFiles(fakeStore('codex'))) {
      expect(item.backupBase).toBe(`codex-${item.file}`);
      expect(item.canRevert).toBe(false);
      expect(item.providerId).toBe('codex');
      expect(item.providerName).toBe('Codex (OpenAI)');
    }
  });

  // GEMINI-2/3: settings.json обслуживает и MCP, и права — в ленте он один раз
  // (пути дедуплицируются), плюс появился файл переменных окружения .env.
  it('gemini: GEMINI.md + settings.json + .env, копия — gemini-settings.json (не смешается с claude)', () => {
    const files = providerTrackedFiles(fakeStore('gemini'));
    expect(files.map((item) => item.file).sort()).toEqual(['.env', 'GEMINI.md', 'settings.json']);
    const settings = files.find((item) => item.file === 'settings.json')!;
    expect(settings.backupBase).toBe('gemini-settings.json');
    expect(settings.backupBase).not.toBe('settings.json');
  });

  // CURSOR-1: правила Cursor — это КАТАЛОГ из многих файлов `.mdc`, а лента
  // ведёт отдельные ФАЙЛЫ конфигурации. Каталог в неё осознанно не попадает
  // (иначе пришлось бы индексировать произвольное число пользовательских
  // файлов); резервные копии у правок правил при этом делаются как обычно.
  it('cursor: в ленте только mcp.json — каталог правил .mdc туда не попадает', () => {
    expect(providerTrackedFiles(fakeStore('cursor')).map((item) => item.file)).toEqual([
      'mcp.json',
    ]);
  });

  it('opencode: AGENTS.md + opencode.json', () => {
    expect(
      providerTrackedFiles(fakeStore('opencode'))
        .map((item) => item.file)
        .sort(),
    ).toEqual(['AGENTS.md', 'opencode.json']);
  });

  it('aider: только ~/.aider.conf.yml (env=ready), инструкций/MCP у него нет', () => {
    const files = providerTrackedFiles(fakeStore('aider'));
    expect(files.map((item) => item.file)).toEqual(['.aider.conf.yml']);
    expect(files[0]!.backupBase).toBe('aider-.aider.conf.yml');
    expect(files[0]!.canRevert).toBe(false);
  });

  it('незнакомый провайдер откатывается на claude → провайдер-файлов нет', () => {
    expect(providerTrackedFiles(fakeStore('нет-такого'))).toEqual([]);
  });
});

describe('Полный набор: Claude + активный провайдер', () => {
  it('claude активен → ровно прежние четыре файла', () => {
    expect(trackedFiles(paths, fakeStore('claude'))).toEqual(claudeTrackedFiles(paths));
  });

  it('codex активен → файлы Claude остаются, к ним добавляются файлы codex', () => {
    const files = trackedFiles(paths, fakeStore('codex'));
    // Файлы Claude никуда не делись и по-прежнему откатываемы.
    expect(files.filter((item) => item.providerId === undefined)).toHaveLength(4);
    expect(files.filter((item) => item.providerId === 'codex').length).toBeGreaterThan(0);
  });

  it('имена копий уникальны — чужая копия не может «стать» файлом Claude', () => {
    for (const id of ['codex', 'gemini', 'cursor', 'opencode', 'aider']) {
      const names = trackedFiles(paths, fakeStore(id)).map((item) => item.backupBase);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe('Секреты не отслеживаются никогда', () => {
  it('isSecretFile ловит все три файла по basename, в любом каталоге', () => {
    expect(isSecretFile(join('C:', 'x', '.mcp-secrets.env'))).toBe(true);
    expect(isSecretFile(join('C:', 'y', 'provider-keys.enc'))).toBe(true);
    expect(isSecretFile(join('C:', 'z', 'provider-keys.key'))).toBe(true);
    expect(isSecretFile(join('C:', 'z', 'settings.json'))).toBe(false);
  });

  it('ни у одного провайдера секретных файлов в наборе нет', () => {
    for (const id of ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'aider']) {
      const files = trackedFiles(paths, fakeStore(id));
      expect(files.some((item) => isSecretFile(item.path))).toBe(false);
      expect(files.some((item) => isSecretFile(item.backupBase))).toBe(false);
    }
  });

  it('секретный путь, подсунутый в ClaudePaths, отфильтровывается', () => {
    const poisoned: ClaudePaths = { ...paths, claudeMd: join(ROOT, '.mcp-secrets.env') };
    expect(claudeTrackedFiles(poisoned).some((item) => isSecretFile(item.path))).toBe(false);
  });
});
