import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { getProvider } from '../providers/registry.ts';
import {
  readProviderMcpServers,
  upsertProviderMcpServer,
  type ProviderMcpTarget,
} from './provider-mcp.ts';
import {
  readProviderEnvVars,
  saveProviderEnvVars,
  type ProviderEnvTarget,
} from './provider-env.ts';
import {
  readProviderPermissions,
  saveProviderPermissions,
  type ProviderPermissionsTarget,
} from './provider-permissions.ts';
import {
  readInstructionsInfo,
  writeInstructions,
  type InstructionsTarget,
} from './instructions.ts';
import { stripBom } from '../lib/text-form.ts';

/**
 * Ф9/Ф10 — ФОРМА ЧУЖОГО ФАЙЛА: переводы строк и BOM.
 *
 * Пользовательские конфиги вполне бывают в CRLF (Windows-редактор, git с
 * autocrlf) и с UTF-8 BOM (Блокнот, PowerShell). Два требования:
 *   • правка НЕ должна смешивать окончания строк — вставленный блок обязан быть
 *     в стиле файла;
 *   • BOM не должен ни ломать разбор (раньше `JSON.parse`/TOML падали и раздел
 *     уходил в fail-closed на здоровом файле), ни исчезать из файла при записи.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-form-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BOM = '﻿';

/** Строки файла и то, сколько среди них «голых» LF (признак смешения). */
function eolStats(text: string): { crlf: number; bareLf: number } {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  return { crlf, bareLf: (text.match(/\n/g) ?? []).length - crlf };
}

function mcpTarget(providerId: string, file: string, format: ProviderMcpTarget['format']) {
  return {
    provider: getProvider(providerId),
    format,
    filePath: join(dir, file),
    cliDetected: true,
    jsonHttpUrlKey: 'httpUrl',
  } satisfies ProviderMcpTarget;
}

const stdioDraft = {
  name: 'ripgrep',
  transport: 'stdio' as const,
  command: 'rg',
  args: ['--json'],
  env: {},
  url: undefined,
  headers: {},
};

describe('Codex config.toml: хирургия в CRLF-файле', () => {
  it('вставленный блок mcp_servers идёт в CRLF — смешения окончаний нет', () => {
    const target = mcpTarget('codex', 'config.toml', 'toml');
    const original = ['model = "gpt-5"', '# мой комментарий', 'approval_policy = "never"', ''].join(
      '\r\n',
    );
    writeFileSync(target.filePath, original, 'utf8');

    upsertProviderMcpServer(target, null, stdioDraft, undefined);
    const text = readFileSync(target.filePath, 'utf8');

    expect(eolStats(text).bareLf).toBe(0);
    expect(text).toContain('[mcp_servers.ripgrep]\r\n');
    // Исходные строки целы, файл по-прежнему валидный TOML.
    expect(text).toContain('# мой комментарий');
    expect((parseToml(text) as { model: string }).model).toBe('gpt-5');
    expect(readProviderMcpServers(target)[0]!.command).toBe('rg');
  });

  it('BOM: файл читается (не fail-closed) и BOM остаётся на месте после записи', () => {
    const target = mcpTarget('codex', 'config.toml', 'toml');
    writeFileSync(target.filePath, `${BOM}model = "gpt-5"\n`, 'utf8');

    // Раньше TOML-парсер падал на ведущем BOM → раздел уходил в read-only.
    expect(readProviderMcpServers(target)).toEqual([]);

    upsertProviderMcpServer(target, null, stdioDraft, undefined);
    const text = readFileSync(target.filePath, 'utf8');

    expect(text.startsWith(BOM)).toBe(true);
    expect(stripBom(text)).toContain('[mcp_servers.ripgrep]');
    expect(readProviderMcpServers(target)[0]!.name).toBe('ripgrep');
  });

  it('env: блок shell_environment_policy в CRLF-файле тоже без смешения', () => {
    const target: ProviderEnvTarget = {
      provider: getProvider('codex'),
      format: 'toml',
      filePath: join(dir, 'config.toml'),
      cliDetected: true,
    };
    writeFileSync(target.filePath, 'model = "gpt-5"\r\n', 'utf8');

    saveProviderEnvVars(target, [{ key: 'NO_COLOR', value: '1' }], undefined);
    const text = readFileSync(target.filePath, 'utf8');

    expect(eolStats(text).bareLf).toBe(0);
    expect(readProviderEnvVars(target)).toEqual([{ key: 'NO_COLOR', value: '1' }]);
  });

  it('права: корневой скаляр вставляется в CRLF-файл с BOM, форма файла цела', () => {
    const target: ProviderPermissionsTarget = {
      provider: getProvider('codex'),
      format: 'toml',
      filePath: join(dir, 'config.toml'),
      cliDetected: true,
    };
    writeFileSync(target.filePath, `${BOM}model = "gpt-5"\r\n\r\n[profiles.safe]\r\n`, 'utf8');

    saveProviderPermissions(
      target,
      { approvalPolicy: 'never', sandboxMode: 'read-only' },
      undefined,
    );
    const text = readFileSync(target.filePath, 'utf8');

    expect(text.startsWith(BOM)).toBe(true);
    expect(eolStats(text).bareLf).toBe(0);
    expect(readProviderPermissions(target)).toMatchObject({
      approvalPolicy: 'never',
      sandboxMode: 'read-only',
    });
    expect(text).toContain('[profiles.safe]');
  });
});

describe('JSON-конфиги провайдеров: CRLF и BOM', () => {
  it('gemini settings.json с BOM читается и после записи остаётся с BOM и в CRLF', () => {
    const target = mcpTarget('gemini', 'settings.json', 'json');
    const original = `${BOM}${JSON.stringify({ theme: 'dark', mcpServers: {} }, null, 2).replace(/\n/g, '\r\n')}\r\n`;
    writeFileSync(target.filePath, original, 'utf8');

    // Раньше JSON.parse падал на BOM → раздел объявлял формат нераспознанным.
    expect(readProviderMcpServers(target)).toEqual([]);

    upsertProviderMcpServer(target, null, stdioDraft, undefined);
    const text = readFileSync(target.filePath, 'utf8');

    expect(text.startsWith(BOM)).toBe(true);
    expect(eolStats(text).bareLf).toBe(0);
    // Чужой ключ цел, сервер записан.
    expect(JSON.parse(stripBom(text))).toMatchObject({ theme: 'dark' });
    expect(readProviderMcpServers(target)[0]!.name).toBe('ripgrep');
  });

  it('opencode.json в CRLF остаётся в CRLF', () => {
    const target = mcpTarget('opencode', 'opencode.json', 'opencode-json');
    writeFileSync(
      target.filePath,
      JSON.stringify({ $schema: 'https://opencode.ai/config.json' }, null, 2).replace(
        /\n/g,
        '\r\n',
      ),
      'utf8',
    );

    upsertProviderMcpServer(target, null, stdioDraft, undefined);
    const text = readFileSync(target.filePath, 'utf8');

    expect(eolStats(text).bareLf).toBe(0);
    expect(JSON.parse(text)).toMatchObject({ $schema: 'https://opencode.ai/config.json' });
  });
});

describe('Инструкции (markdown): форма файла', () => {
  function instrTarget(providerId: string, file: string): InstructionsTarget {
    return {
      provider: getProvider(providerId),
      filePath: join(dir, file),
      fileName: file,
      cliDetected: true,
    };
  }

  it('CRLF-файл: текст из <textarea> (CRLF) и текст с LF ложатся ровно в CRLF', () => {
    const target = instrTarget('codex', 'AGENTS.md');
    writeFileSync(target.filePath, '# Правила\r\n\r\nстарый текст\r\n', 'utf8');

    writeInstructions(target, 'первая строка\nвторая строка\r\nтретья\n', undefined);
    const text = readFileSync(target.filePath, 'utf8');

    expect(eolStats(text).bareLf).toBe(0);
    expect(text).toBe('первая строка\r\nвторая строка\r\nтретья\r\n');
  });

  it('LF-файл: CRLF из браузера нормализуется в LF (иначе появилось бы смешение)', () => {
    const target = instrTarget('codex', 'AGENTS.md');
    writeFileSync(target.filePath, 'старое\n', 'utf8');

    writeInstructions(target, 'раз\r\nдва\r\n', undefined);

    expect(readFileSync(target.filePath, 'utf8')).toBe('раз\nдва\n');
  });

  it('BOM: не показывается в редакторе, но сохраняется в файле', () => {
    const target = instrTarget('gemini', 'GEMINI.md');
    writeFileSync(target.filePath, `${BOM}# Заголовок\n`, 'utf8');

    // В редактор BOM не утекает (иначе «прилипал» бы вторым при сохранении).
    expect(readInstructionsInfo(target).content).toBe('# Заголовок\n');

    writeInstructions(target, '# Новый заголовок\n', undefined);
    const text = readFileSync(target.filePath, 'utf8');

    expect(text).toBe(`${BOM}# Новый заголовок\n`);
    expect(readInstructionsInfo(target).content).toBe('# Новый заголовок\n');
  });
});

describe('Кириллица в пути и атомарность (safe-io)', () => {
  it('конфиг провайдера в каталоге с кириллицей пишется, бэкапится и перечитывается', () => {
    const nested = join(dir, 'Мои документы', 'настройки провайдера');
    const target = mcpTarget('gemini', 'settings.json', 'json');
    (target as { filePath: string }).filePath = join(nested, 'settings.json');
    const backupDir = join(dir, 'копии');

    // Каталога ещё нет — safe-io создаёт его рекурсивно при явном сохранении.
    upsertProviderMcpServer(target, null, stdioDraft, backupDir);
    upsertProviderMcpServer(target, null, { ...stdioDraft, name: 'второй сервер' }, backupDir);

    expect(
      readProviderMcpServers(target)
        .map((s) => s.name)
        .sort(),
    ).toEqual(['ripgrep', 'второй сервер']);
    // Копия снята и лежит под именем с префиксом провайдера.
    expect(readdirSync(backupDir).some((n) => n.startsWith('gemini-settings.json.'))).toBe(true);
    // Временных файлов атомарной записи не осталось.
    expect(readdirSync(nested).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
});

describe('Резервные копии провайдеров не смешиваются с claude', () => {
  it('копия gemini settings.json именуется с префиксом провайдера', () => {
    const backupDir = join(dir, 'backups');
    const target = mcpTarget('gemini', 'settings.json', 'json');
    writeFileSync(target.filePath, '{"theme":"dark"}', 'utf8');

    upsertProviderMcpServer(target, null, stdioDraft, backupDir);
    const names = readdirSync(backupDir);

    // Ключевое: НЕ `settings.json.<метка>.bak` — иначе откат по basename вернул
    // бы конфиг Gemini поверх ~/.claude/settings.json.
    expect(names.some((name) => name.startsWith('gemini-settings.json.'))).toBe(true);
    expect(names.some((name) => name.startsWith('settings.json.'))).toBe(false);
  });

  it('AGENTS.md codex и opencode не делят одну ротацию копий', () => {
    const backupDir = join(dir, 'backups');
    for (const id of ['codex', 'opencode']) {
      const target: InstructionsTarget = {
        provider: getProvider(id),
        filePath: join(dir, `${id}-AGENTS.md`),
        fileName: 'AGENTS.md',
        cliDetected: true,
      };
      writeFileSync(target.filePath, 'старое\n', 'utf8');
      writeInstructions(target, 'новое\n', backupDir);
    }

    const names = readdirSync(backupDir);
    expect(names.some((name) => name.startsWith('codex-'))).toBe(true);
    expect(names.some((name) => name.startsWith('opencode-'))).toBe(true);
  });

  it('claude сохраняет ПРЕЖНЕЕ имя копии CLAUDE.md (история и откат не ломаются)', () => {
    const backupDir = join(dir, 'backups');
    const target: InstructionsTarget = {
      provider: getProvider('claude'),
      filePath: join(dir, 'CLAUDE.md'),
      fileName: 'CLAUDE.md',
      cliDetected: true,
    };
    writeFileSync(target.filePath, 'старое\n', 'utf8');

    writeInstructions(target, 'новое\n', backupDir);

    expect(readdirSync(backupDir).some((name) => name.startsWith('CLAUDE.md.'))).toBe(true);
  });
});
