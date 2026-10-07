import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KitMode } from '@agentdeck/contracts/local-models';
import { CODEX_KIT_ENV } from './codex.ts';
import { KIT_VARIANT_ENV, KitRefusal, KitService, builtinKitDir } from './service.ts';

/**
 * Сервис набора на временных данных панели и временном каталоге Claude:
 * настоящий встроенный набор приложения, настоящая сборка, ни одного обращения
 * к `~/.claude`. Режим, копии «моё», выключенные и выбор в конфликте — всё на
 * диске, как в работе.
 */

const SKILL = 'skills/read-before-edit/SKILL.md';
const COMMAND = 'commands/review.md';
const RULE = 'rules/standard.md';

let root: string;
let appData: string;
let claudeDir: string;
let legacy: Partial<Record<string, KitMode>>;

const service = () =>
  new KitService({
    appDataDir: appData,
    claudeDir: () => claudeDir,
    providers: () => [
      { id: 'claude', name: 'Claude Code' },
      { id: 'qwen', name: 'Qwen Code' },
      { id: 'codex', name: 'Codex' },
    ],
    legacyModes: () => legacy,
  });

const statePath = () => join(appData, 'kit', 'state.json');
const effective = (mode: string) => join(appData, 'kit', 'effective', mode, 'agentdeck-kit');

function refusal(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof KitRefusal) return error.code;
    throw error;
  }
  return undefined;
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-kit-service-')));
  appData = join(root, 'app-data');
  claudeDir = join(root, 'claude');
  mkdirSync(claudeDir, { recursive: true });
  legacy = {};
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('режимы по провайдерам', () => {
  it('по умолчанию «глобальные»; что кто умеет — честно', () => {
    const view = service().describe();
    expect(view.version).toBe('1.2.0');
    expect(view.builtinDir).toBe(builtinKitDir());
    expect(view.mineDir).toBe(join(appData, 'kit', 'mine'));
    expect(view.providers).toEqual([
      { id: 'claude', title: 'Claude Code', mode: 'global', modes: ['global', 'hybrid', 'ours'] },
      {
        id: 'qwen',
        title: 'Qwen Code',
        mode: 'global',
        modes: ['global', 'ours'],
        localOnly: true,
      },
      {
        id: 'codex',
        title: 'Codex',
        mode: 'global',
        modes: ['global', 'hybrid'],
        carries: ['rule', 'skill'],
      },
    ]);
    expect(existsSync(statePath())).toBe(false);
  });

  it('смена режима записывается и читается новым экземпляром', () => {
    service().setMode('claude', 'hybrid');
    service().setMode('qwen', 'ours');
    expect(service().modeOf('claude')).toBe('hybrid');
    expect(service().modeOf('qwen')).toBe('ours');
    expect(JSON.parse(readFileSync(statePath(), 'utf8'))).toMatchObject({
      modes: { claude: 'hybrid', qwen: 'ours' },
    });
  });

  it('неподдержанный режим — отказ с кодом, состояние не тронуто', () => {
    const kit = service();
    expect(refusal(() => kit.setMode('codex', 'ours'))).toBe('kit-mode-unsupported');
    expect(refusal(() => kit.setMode('qwen', 'hybrid'))).toBe('kit-mode-unsupported');
    expect(refusal(() => kit.setMode('nobody', 'global'))).toBe('kit-mode-unsupported');
    expect(existsSync(statePath())).toBe(false);
    expect(kit.modeOf('qwen')).toBe('global');
  });

  it('режим, записанный руками мимо поддержки, читается как «глобальные»', () => {
    mkdirSync(join(appData, 'kit'), { recursive: true });
    writeFileSync(statePath(), JSON.stringify({ modes: { codex: 'ours', qwen: 'hybrid' } }));
    expect(service().modeOf('codex')).toBe('global');
    expect(service().modeOf('qwen')).toBe('global');
  });
});

describe('перенос режима со страницы «Локальная модель»', () => {
  it('state.json ещё нет — режим берётся оттуда и закрепляется первой записью', () => {
    legacy = { claude: 'ours', qwen: 'ours' };
    const kit = service();
    expect(kit.modeOf('claude')).toBe('ours');
    expect(kit.modeOf('qwen')).toBe('ours');
    kit.setEnabled(SKILL, false);
    legacy = {};
    expect(service().modeOf('claude')).toBe('ours');
  });

  it('state.json уже есть — прежний режим не читается вовсе', () => {
    mkdirSync(join(appData, 'kit'), { recursive: true });
    writeFileSync(statePath(), JSON.stringify({ modes: {} }));
    legacy = { claude: 'hybrid' };
    expect(service().modeOf('claude')).toBe('global');
  });

  it('прежний «глобальный» и неподдержанный режим не переносятся', () => {
    legacy = { claude: 'global', qwen: 'hybrid' };
    expect(service().modeOf('claude')).toBe('global');
    expect(service().modeOf('qwen')).toBe('global');
  });
});

describe('копия «моё»: правка, чтение, возврат встроенного в архив', () => {
  it('правка ложится копией, встроенный файл не меняется', () => {
    const kit = service();
    const builtin = readFileSync(join(builtinKitDir(), SKILL), 'utf8');
    kit.write(SKILL, '---\ndescription: моя версия\n---\nМОЁ\n');
    expect(kit.read(SKILL)).toEqual({
      id: SKILL,
      builtin,
      mine: '---\ndescription: моя версия\n---\nМОЁ\n',
      global: null,
      diff: null,
    });
    expect(readFileSync(join(appData, 'kit', 'mine', SKILL), 'utf8')).toContain('МОЁ');
    expect(readFileSync(join(builtinKitDir(), SKILL), 'utf8')).toBe(builtin);
    const item = kit.describe().items.find((entry) => entry.id === SKILL);
    expect(item).toMatchObject({ origin: 'modified', description: 'моя версия', enabled: true });
  });

  it('без копии — mine: null и origin builtin', () => {
    const kit = service();
    expect(kit.read(COMMAND).mine).toBeNull();
    expect(kit.describe().items.find((entry) => entry.id === COMMAND)?.origin).toBe('builtin');
  });

  it('«Вернуть встроенный» уносит копию в архив, а не удаляет', () => {
    const kit = service();
    kit.write(RULE, 'МОИ ПРАВИЛА\n');
    kit.reset(RULE);
    expect(kit.read(RULE).mine).toBeNull();
    expect(existsSync(join(appData, 'kit', 'mine', RULE))).toBe(false);
    const archive = join(appData, 'kit', 'archive');
    const stamps = readdirSync(archive);
    expect(stamps).toHaveLength(1);
    expect(readFileSync(join(archive, stamps[0] ?? '', RULE), 'utf8')).toBe('МОИ ПРАВИЛА\n');
  });

  it('возврат без копии — ничего, и архив не заводится', () => {
    service().reset(RULE);
    expect(existsSync(join(appData, 'kit', 'archive'))).toBe(false);
  });
});

describe('неизвестный id — отказ на каждом входе, и ни байта мимо набора', () => {
  const bad = [
    '',
    'nope',
    '../x',
    'skills/../../etc',
    'skills/../../../escape/SKILL.md',
    '../../outside.md',
    '.claude-plugin/plugin.json',
    'skills/read-before-edit/reference.md',
    'rules/../rules/standard.md',
  ];

  it.each(bad)('%j', (id) => {
    const kit = service();
    expect(refusal(() => kit.read(id))).toBe('kit-item-unknown');
    expect(refusal(() => kit.write(id, 'ВЗЛОМ'))).toBe('kit-item-unknown');
    expect(refusal(() => kit.reset(id))).toBe('kit-item-unknown');
    expect(refusal(() => kit.setEnabled(id, false))).toBe('kit-item-unknown');
    expect(refusal(() => kit.setWinner(id, 'kit'))).toBe('kit-item-unknown');
    expect(existsSync(join(appData, 'kit'))).toBe(false);
    expect(existsSync(join(root, 'x'))).toBe(false);
    expect(existsSync(join(root, 'outside.md'))).toBe(false);
  });
});

describe('выключение и конфликт имён', () => {
  it('выключенный элемент виден выключенным, список без повторов и по порядку', () => {
    const kit = service();
    kit.setEnabled(SKILL, false);
    kit.setEnabled(COMMAND, false);
    kit.setEnabled(SKILL, false);
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).disabled).toEqual([COMMAND, SKILL]);
    expect(kit.describe().items.find((entry) => entry.id === SKILL)?.enabled).toBe(false);
    kit.setEnabled(SKILL, true);
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).disabled).toEqual([COMMAND]);
  });

  it('одноимённый навык и команда человека — конфликт, по умолчанию побеждает человек', () => {
    mkdirSync(join(claudeDir, 'skills', 'read-before-edit'), { recursive: true });
    writeFileSync(join(claudeDir, 'skills', 'read-before-edit', 'SKILL.md'), 'мой навык');
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'review.md'), 'моя команда');
    const kit = service();
    const items = kit.describe().items;
    expect(items.find((entry) => entry.id === SKILL)?.conflict).toEqual({
      userPath: join(claudeDir, 'skills', 'read-before-edit', 'SKILL.md'),
      winner: 'user',
      same: false,
    });
    expect(items.find((entry) => entry.id === COMMAND)?.conflict?.winner).toBe('user');
    expect(items.filter((entry) => entry.conflict)).toHaveLength(2);
    kit.setWinner(SKILL, 'kit');
    expect(kit.describe().items.find((entry) => entry.id === SKILL)?.conflict?.winner).toBe('kit');
  });
});

describe('runExtras: что получает прогон', () => {
  const extras = (provider: string, local = false, hasSources = false) =>
    service().runExtras({ provider, local, hasSources });

  it('Claude «глобальные» — ничего', () => {
    expect(extras('claude')).toEqual({ args: [], env: {} });
    expect(existsSync(join(appData, 'kit', 'effective'))).toBe(false);
  });

  it('Claude «оба» — плагин собранного набора и стандартный вариант правил', () => {
    service().setMode('claude', 'hybrid');
    const result = extras('claude');
    expect(result).toEqual({
      args: ['--plugin-dir', effective('hybrid')],
      env: { [KIT_VARIANT_ENV]: 'standard' },
    });
    expect(existsSync(join(effective('hybrid'), '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(effective('hybrid'), 'hooks', 'hooks.json'))).toBe(true);
  });

  it('Claude на контуре локальной модели — локальный вариант правил', () => {
    service().setMode('claude', 'hybrid');
    expect(extras('claude', true).env).toEqual({ [KIT_VARIANT_ENV]: 'local' });
  });

  it('Claude «только наш» — плагин и без источника user', () => {
    service().setMode('claude', 'ours');
    expect(extras('claude').args).toEqual([
      '--plugin-dir',
      effective('ours'),
      '--setting-sources',
      'project,local',
    ]);
  });

  it('Claude «только наш», флаг источников уже от слоёв контура — второй не добавляется', () => {
    service().setMode('claude', 'ours');
    expect(extras('claude', true, true)).toEqual({
      args: ['--plugin-dir', effective('ours')],
      env: { [KIT_VARIANT_ENV]: 'local' },
    });
  });

  it('гибрид: одноимённый навык человека побеждает — навыка набора в сборке нет; выбор «набор» возвращает его', () => {
    mkdirSync(join(claudeDir, 'skills', 'read-before-edit'), { recursive: true });
    writeFileSync(join(claudeDir, 'skills', 'read-before-edit', 'SKILL.md'), 'мой');
    service().setMode('claude', 'hybrid');
    extras('claude');
    expect(existsSync(join(effective('hybrid'), 'skills', 'read-before-edit'))).toBe(false);
    expect(existsSync(join(effective('hybrid'), 'skills', 'verify-by-running', 'SKILL.md'))).toBe(
      true,
    );
    service().setWinner(SKILL, 'kit');
    extras('claude');
    expect(existsSync(join(effective('hybrid'), 'skills', 'read-before-edit', 'SKILL.md'))).toBe(
      true,
    );
  });

  it('«только наш» не уступает человеку: его навыки сняты флагом источников', () => {
    mkdirSync(join(claudeDir, 'skills', 'read-before-edit'), { recursive: true });
    writeFileSync(join(claudeDir, 'skills', 'read-before-edit', 'SKILL.md'), 'мой');
    service().setMode('claude', 'ours');
    extras('claude');
    expect(existsSync(join(effective('ours'), 'skills', 'read-before-edit', 'SKILL.md'))).toBe(
      true,
    );
  });

  it('выключенный хук и правка «моё» доезжают до сборки прогона', () => {
    const kit = service();
    kit.setMode('claude', 'hybrid');
    const wired = (): string =>
      JSON.stringify(
        (
          JSON.parse(readFileSync(join(effective('hybrid'), 'hooks', 'hooks.json'), 'utf8')) as {
            hooks: Record<string, unknown>;
          }
        ).hooks,
      );
    extras('claude');
    expect(wired()).toContain('guard-destructive.mjs');
    kit.setEnabled('hooks/guard-destructive.mjs', false);
    kit.write(RULE, '# МОИ ПРАВИЛА\n');
    extras('claude');
    const hooks = JSON.parse(
      readFileSync(join(effective('hybrid'), 'hooks', 'hooks.json'), 'utf8'),
    ) as { hooks: Record<string, unknown> };
    expect(wired()).not.toContain('guard-destructive.mjs');
    // Выключение одного хука не снимает соседей: прочие события набора на месте.
    expect(Object.keys(hooks.hooks)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'PreCompact',
      'PostCompact',
    ]);
    expect(existsSync(join(effective('hybrid'), 'hooks', 'guard-destructive.mjs'))).toBe(false);
    expect(readFileSync(join(effective('hybrid'), RULE), 'utf8')).toBe('# МОИ ПРАВИЛА\n');
  });

  it('смена режима действует со следующего старта, без нового экземпляра', () => {
    const kit = service();
    expect(kit.runExtras({ provider: 'claude', local: false, hasSources: false }).args).toEqual([]);
    kit.setMode('claude', 'hybrid');
    expect(kit.runExtras({ provider: 'claude', local: false, hasSources: false }).args[0]).toBe(
      '--plugin-dir',
    );
    kit.setMode('claude', 'global');
    expect(kit.runExtras({ provider: 'claude', local: false, hasSources: false }).args).toEqual([]);
  });

  it('Qwen «только наш» на контуре локальной модели — свой QWEN_HOME с локальными правилами', () => {
    service().setMode('qwen', 'ours');
    const result = extras('qwen', true);
    const home = join(appData, 'kit', 'qwen-home');
    expect(result).toEqual({ args: [], env: { QWEN_HOME: home, AGENTDECK_KIT_VARIANT: 'local' } });
    const rules = readFileSync(join(home, 'QWEN.md'), 'utf8');
    expect(rules).toContain('agentdeck kit rules');
    expect(rules).toContain('One tool call per step');
    const ext = join(home, 'extensions', 'agentdeck-kit');
    expect(existsSync(join(ext, 'skills', 'read-before-edit', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(ext, 'qwen-extension.json'))).toBe(true);
    expect(readFileSync(join(ext, 'hooks', 'hooks.json'), 'utf8')).toContain('session-rules.mjs');
    expect(readFileSync(join(ext, 'commands', 'review.md'), 'utf8')).toContain('{{args}}');
    expect(existsSync(join(ext, 'rules'))).toBe(false);
  });

  it('Qwen «только наш» мимо контура локальной модели — ничего', () => {
    service().setMode('qwen', 'ours');
    expect(extras('qwen', false)).toEqual({ args: [], env: {} });
    expect(existsSync(join(appData, 'kit', 'qwen-home'))).toBe(false);
  });

  it('Qwen «глобальные» на контуре — ничего', () => {
    expect(extras('qwen', true)).toEqual({ args: [], env: {} });
  });

  it('Codex «оба» — путь к наложению в окружении, файл с правилами и навыками набора', () => {
    service().setMode('codex', 'hybrid');
    const result = extras('codex');
    expect(result.args).toEqual([]);
    const file = result.env[CODEX_KIT_ENV] ?? '';
    expect(file).toBe(join(appData, 'kit', 'codex', 'overlay-standard.json'));
    const overlay = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    expect(overlay.appServer).toContain('# agentdeck kit rules');
    expect(overlay.exec).toContain('verify-by-running');
    // Весь набор, а не сборка «оба» Claude: ~/.claude Codex не читает.
    expect(overlay.skillsDir).toBe(join(effective('ours'), 'skills'));
    expect(extras('codex', true).env[CODEX_KIT_ENV]).toBe(
      join(appData, 'kit', 'codex', 'overlay-local.json'),
    );
  });

  it('Codex — ничего, даже с режимом, записанным в state.json руками', () => {
    mkdirSync(join(appData, 'kit'), { recursive: true });
    writeFileSync(statePath(), JSON.stringify({ modes: { codex: 'ours' } }));
    expect(extras('codex', true)).toEqual({ args: [], env: {} });
  });
});

describe('набор ↔ глобальный слой', () => {
  const putGlobal = (rel: string, text: string) => {
    mkdirSync(join(claudeDir, rel, '..'), { recursive: true });
    writeFileSync(join(claudeDir, rel), text);
  };
  const serviceWithBackups = () =>
    new KitService({
      appDataDir: appData,
      claudeDir: () => claudeDir,
      providers: () => [{ id: 'claude', name: 'Claude Code' }],
      backupDir: join(root, 'backups'),
    });

  it('совпадающий текст — «как в глобальном», разница пуста', () => {
    putGlobal(SKILL, readFileSync(join(builtinKitDir(), SKILL), 'utf8').replace(/\n/g, '\r\n'));
    const kit = service();
    expect(kit.describe().items.find((entry) => entry.id === SKILL)?.conflict?.same).toBe(true);
    const content = kit.read(SKILL);
    expect(content.global).not.toBeNull();
    expect(content.diff?.every((line) => line.kind === 'ctx')).toBe(true);
  });

  it('разный текст — построчная разница «глобальный → набор»', () => {
    putGlobal(COMMAND, 'ГЛОБАЛЬНАЯ СТРОКА\n');
    const diff = service().read(COMMAND).diff ?? [];
    expect(diff).toContainEqual(
      expect.objectContaining({ kind: 'del', text: 'ГЛОБАЛЬНАЯ СТРОКА' }),
    );
    expect(diff.some((line) => line.kind === 'add')).toBe(true);
  });

  it('только в глобальном — в списке, после «Из глобального» — элемент набора «added» и в сборке', () => {
    putGlobal('agents/helper.md', '---\nname: helper\ndescription: Helper agent\n---\nBody\n');
    const kit = service();
    expect(kit.describe().globalOnly).toContainEqual(
      expect.objectContaining({ kind: 'agent', name: 'helper', description: 'Helper agent' }),
    );
    kit.importFromGlobal('agent', 'helper');
    const after = kit.describe();
    expect(after.globalOnly.some((item) => item.name === 'helper')).toBe(false);
    expect(after.items.find((entry) => entry.id === 'agents/helper.md')).toMatchObject({
      kind: 'agent',
      origin: 'added',
      conflict: { same: true },
    });
    // «Только набор панели» — двойник не уступает, файл должен доехать до сборки.
    expect(readFileSync(join(kit.composed('ours'), 'agents', 'helper.md'), 'utf8')).toContain(
      'Body',
    );
    kit.reset('agents/helper.md');
    expect(kit.describe().items.some((entry) => entry.id === 'agents/helper.md')).toBe(false);
    expect(readdirSync(join(appData, 'kit', 'archive'))).toHaveLength(1);
  });

  it('«В глобальный»: файл ложится, прежняя версия — в резервной копии', () => {
    putGlobal(COMMAND, 'старая версия\n');
    const kit = serviceWithBackups();
    const backup = kit.exportToGlobal(COMMAND);
    expect(readFileSync(join(claudeDir, COMMAND), 'utf8')).toBe(
      readFileSync(join(builtinKitDir(), COMMAND), 'utf8'),
    );
    expect(backup && readFileSync(backup, 'utf8')).toBe('старая версия\n');
    expect(kit.describe().items.find((entry) => entry.id === COMMAND)?.conflict?.same).toBe(true);
  });

  it('кривой hooks.json не сохраняется — сборка не сломается на каждом прогоне', () => {
    const kit = service();
    for (const text of ['{', '[]', '{"hooks": []}', '{"other": {}}', 'null']) {
      expect(refusal(() => kit.write('hooks/hooks.json', text))).toBe('kit-hooks-invalid');
    }
    expect(existsSync(join(kit.mineDir, 'hooks', 'hooks.json'))).toBe(false);
    kit.write('hooks/hooks.json', '{"hooks": {}}');
    expect(readFileSync(join(kit.mineDir, 'hooks', 'hooks.json'), 'utf8')).toBe('{"hooks": {}}');
  });

  it('изменённый встроенный элемент — одна строка, не две', () => {
    const kit = service();
    kit.write(COMMAND, 'МОЯ КОМАНДА\n');
    const ids = kit.describe().items.map((entry) => entry.id);
    expect(ids.filter((id) => id === COMMAND)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('взятый из глобального навык сбрасывается папкой — соседние файлы не остаются в сборке', () => {
    putGlobal('skills/own/SKILL.md', '---\ndescription: Own\n---\nBody\n');
    putGlobal('skills/own/notes.md', 'NOTES\n');
    const kit = service();
    kit.importFromGlobal('skill', 'own');
    expect(existsSync(join(kit.mineDir, 'skills', 'own', 'notes.md'))).toBe(true);
    kit.reset('skills/own/SKILL.md');
    expect(existsSync(join(kit.mineDir, 'skills', 'own'))).toBe(false);
    expect(existsSync(join(kit.composed('ours'), 'skills', 'own'))).toBe(false);
  });

  it('имя с разделителем не уводит импорт в подпапку, даже если там лежит файл', () => {
    putGlobal('commands/sub/x.md', 'NESTED\n');
    putGlobal('skills/.hidden/SKILL.md', 'HIDDEN\n');
    const kit = service();
    expect(refusal(() => kit.importFromGlobal('command', 'sub/x'))).toBe('kit-global-missing');
    expect(refusal(() => kit.importFromGlobal('command', 'sub\\x'))).toBe('kit-global-missing');
    expect(refusal(() => kit.importFromGlobal('skill', '.hidden'))).toBe('kit-global-missing');
    expect(existsSync(kit.mineDir)).toBe(false);
  });

  it('отказы: правило не переносится, нет такого в глобальном, имя-путь', () => {
    const kit = service();
    expect(refusal(() => kit.exportToGlobal(RULE))).toBe('kit-global-unsupported');
    expect(refusal(() => kit.importFromGlobal('skill', 'absent'))).toBe('kit-global-missing');
    for (const name of ['..', '.hidden', 'a/b', 'a\b']) {
      expect(refusal(() => kit.importFromGlobal('command', name))).toBe('kit-global-missing');
    }
    expect(existsSync(kit.mineDir)).toBe(false);
  });
});
