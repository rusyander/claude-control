import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppStore } from '../../lib/app-store/app-store.ts';
import {
  cachedMainOf,
  GUARD_COMMAND,
  GUARD_HOOK_ID,
  GUARD_MATCHER,
  GUARD_RULE_TEXT,
  guardConfigFor,
  guardHitFor,
  guardStatus,
  installGuard,
  removeGuard,
  saveGuardSettings,
} from './backend-guard.ts';

/**
 * Защита в `.claude/` проекта: что ставится, что остаётся от файлов человека и
 * что убирается. Хук пишется в ЧУЖОЙ файл проекта — поэтому главное здесь:
 * соседние записи settings.json не трогаются, а снятие возвращает файл байт в
 * байт.
 */

let root: string;
let project: string;
let store: AppStore;
let backupDir: string;

const SETTINGS_BEFORE = `${JSON.stringify(
  {
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node lint.mjs' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo done', timeout: 5 }] }],
    },
    model: 'sonnet',
  },
  null,
  2,
)}\n`;

const read = (rel: string): string => readFileSync(join(project, rel), 'utf8');
const deps = () => ({ store, backupDir });
const SETTINGS = { prodMarkers: ['db.prod.internal'], disabled: [] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-guard-'));
  project = join(root, 'shop');
  backupDir = join(root, 'backups');
  mkdirSync(join(project, '.claude'), { recursive: true });
  store = new AppStore(join(root, 'data'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('установка', () => {
  it('скрипт, хук первым, правило, настройки и проектная группа; соседи settings.json целы', () => {
    writeFileSync(join(project, '.claude', 'settings.json'), SETTINGS_BEFORE);
    const status = installGuard(deps(), project, SETTINGS, 'ru');

    expect(status.state).toBe('installed');
    expect(status.parts).toEqual({ script: 'ok', hook: 'ok', rule: 'ok' });
    expect(read('.claude/hooks/backend-guard.mjs')).toBe(
      readFileSync(fileURLToPath(new URL('./guard-script.mjs', import.meta.url)), 'utf8'),
    );
    expect(read('.claude/rules/backend-safety.md')).toBe(GUARD_RULE_TEXT);

    const settings = JSON.parse(read('.claude/settings.json'));
    expect(settings.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(settings.model).toBe('sonnet');
    expect(settings.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'echo done', timeout: 5 }] },
    ]);
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: GUARD_COMMAND }] },
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'node lint.mjs' }] },
    ]);

    const config = JSON.parse(read('.claude/backend-guard.json'));
    expect(config).toMatchObject({ version: 1, lang: 'ru', prodMarkers: ['db.prod.internal'] });
    expect(config.createdSettings).toBeUndefined();

    const [group] = store.getGroups();
    expect(group).toMatchObject({ name: 'Защита бэкенда · shop', isEnabled: true });
    expect(group?.scope).toMatchObject({ kind: 'project', provider: 'claude' });
    expect(group?.members.map((member) => `${member.kind}:${member.id}`)).toEqual([
      `hook:${GUARD_HOOK_ID}`,
      'rule:backend-safety',
    ]);
    expect(status.groupId).toBe(group?.id);
  });

  it('повторная установка не дублирует ни хук, ни группу', () => {
    installGuard(deps(), project, SETTINGS);
    installGuard(deps(), project, SETTINGS);
    const settings = JSON.parse(read('.claude/settings.json'));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(store.getGroups()).toHaveLength(1);
  });

  it('второй проект с тем же именем каталога — группа с номером', () => {
    installGuard(deps(), project, SETTINGS);
    const other = join(root, 'other', 'shop');
    mkdirSync(other, { recursive: true });
    installGuard(deps(), other, SETTINGS);
    expect(store.getGroups().map((group) => group.name)).toEqual([
      'Защита бэкенда · shop',
      'Защита бэкенда · shop (2)',
    ]);
  });
});

describe('состояние', () => {
  it('правленый руками скрипт и пропавший хук — «частично»; переустановка чинит', () => {
    installGuard(deps(), project, SETTINGS);
    writeFileSync(join(project, '.claude', 'hooks', 'backend-guard.mjs'), '// edited\n');
    writeFileSync(join(project, '.claude', 'settings.json'), '{}\n');
    const broken = guardStatus(deps(), project);
    expect(broken.state).toBe('partial');
    expect(broken.parts).toEqual({ script: 'changed', hook: 'missing', rule: 'ok' });

    expect(installGuard(deps(), project, SETTINGS).state).toBe('installed');
  });

  it('CRLF после git на Windows — не правка', () => {
    installGuard(deps(), project, SETTINGS);
    const path = join(project, '.claude', 'rules', 'backend-safety.md');
    writeFileSync(path, GUARD_RULE_TEXT.replace(/\n/g, '\r\n'));
    expect(guardStatus(deps(), project).parts.rule).toBe('ok');
  });

  it('ничего не ставили — «нет»', () => {
    expect(guardStatus(deps(), project).state).toBe('none');
  });
});

describe('снятие', () => {
  it('settings.json возвращается байт в байт, файлы — в копиях, группа уходит', () => {
    writeFileSync(join(project, '.claude', 'settings.json'), SETTINGS_BEFORE);
    installGuard(deps(), project, SETTINGS);
    const status = removeGuard(deps(), project);

    expect(status.state).toBe('none');
    expect(read('.claude/settings.json')).toBe(SETTINGS_BEFORE);
    for (const rel of [
      'hooks/backend-guard.mjs',
      'rules/backend-safety.md',
      'backend-guard.json',
    ]) {
      expect(existsSync(join(project, '.claude', rel))).toBe(false);
    }
    const backups = readdirSync(backupDir);
    expect(backups.some((name) => name.startsWith('backend-guard.mjs.'))).toBe(true);
    expect(backups.some((name) => name.startsWith('backend-safety.md.'))).toBe(true);
    expect(store.getGroups()).toEqual([]);
  });

  it('settings.json, заведённый панелью, уходит целиком', () => {
    installGuard(deps(), project, SETTINGS);
    expect(JSON.parse(read('.claude/backend-guard.json')).createdSettings).toBe(true);
    removeGuard(deps(), project);
    expect(existsSync(join(project, '.claude', 'settings.json'))).toBe(false);
  });

  it('…но остаётся, если человек дописал в него своё', () => {
    installGuard(deps(), project, SETTINGS);
    const path = join(project, '.claude', 'settings.json');
    writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(read('.claude/settings.json')), model: 'opus' }),
    );
    removeGuard(deps(), project);
    expect(JSON.parse(read('.claude/settings.json'))).toEqual({ model: 'opus' });
  });
});

describe('настройки и брокер', () => {
  it('настройки меняют только файл настроек', () => {
    installGuard(deps(), project, SETTINGS);
    const script = read('.claude/hooks/backend-guard.mjs');
    saveGuardSettings(deps(), project, { prodMarkers: ['10.0.0.5'], disabled: ['infra-change'] });
    expect(JSON.parse(read('.claude/backend-guard.json'))).toMatchObject({
      prodMarkers: ['10.0.0.5'],
      disabled: ['infra-change'],
      lang: 'ru',
      createdSettings: true,
    });
    expect(read('.claude/hooks/backend-guard.mjs')).toBe(script);
  });

  it('прогон в подкаталоге находит настройки проекта; без защиты — ничего', () => {
    const sub = join(project, 'services', 'api');
    mkdirSync(sub, { recursive: true });
    expect(guardHitFor(sub, 'Bash', { command: 'terraform destroy' })).toBeUndefined();
    installGuard(deps(), project, SETTINGS);
    expect(guardHitFor(sub, 'Bash', { command: 'terraform destroy' })?.rule).toBe('infra-change');
    expect(guardHitFor(sub, 'Edit', { file_path: 'drop table.sql' })).toBeUndefined();
  });

  it('копия ветки без .claude — настройки основной копии', () => {
    installGuard(deps(), project, SETTINGS);
    const copy = join(root, 'shop-worktrees', 'feature');
    mkdirSync(copy, { recursive: true });
    expect(guardConfigFor(copy)).toBeUndefined();
    expect(guardConfigFor(copy, () => project)?.prodMarkers).toEqual(['db.prod.internal']);
  });

  it('основная копия запоминается на пять минут, потом спрашивается заново', () => {
    let calls = 0;
    let now = 1_000;
    const mainOf = cachedMainOf(
      () => {
        calls += 1;
        return project;
      },
      () => now,
    );
    const dir = join(root, 'cache-probe');
    mainOf(dir);
    mainOf(dir);
    expect(calls).toBe(1);
    now += 5 * 60_000 + 1;
    mainOf(dir);
    expect(calls).toBe(2);
  });
});
