import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGroupSources } from '../../lib/app-store/group-sources.ts';
import { disableOverride, enableOverride } from './override.ts';

/**
 * Выключение перекрытия возвращает проект к виду до включения, даже когда файлы
 * правили после нас. Проект — настоящий git-репозиторий во временной папке:
 * исключения пишутся в его `.git/info/exclude`.
 */

let tmp: string;
let appData: string;
let project: string;
let settings: string;
let exclude: string;

const BOM = String.fromCharCode(0xfeff);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cc-override-'));
  appData = join(tmp, 'app');
  mkdirSync(appData);
  project = join(tmp, 'proj');
  mkdirSync(join(project, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: project });
  settings = join(project, '.claude', 'settings.local.json');
  exclude = join(project, '.git', 'info', 'exclude');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const denyOf = (): string[] | undefined =>
  (
    JSON.parse(readFileSync(settings, 'utf8').replace(/^\uFEFF/, '')) as {
      permissions?: { deny?: string[] };
    }
  ).permissions?.deny;

// Ревью 28.09 (F-32): Блокнот пересохранил файл с BOM — JSON.parse падал, запись
// удалялась, и `Skill(ladder)` оставалась в проекте навсегда.
describe('выключение перекрытия', () => {
  it('файл прав пересохранён с BOM — свои запреты сняты, чужая правка цела', () => {
    writeFileSync(settings, `${JSON.stringify({ permissions: { allow: ['Bash(ls)'] } })}\n`);
    enableOverride(appData, {
      groupId: 'g',
      projectPath: project,
      text: '# t',
      denySkills: ['ladder'],
    });
    expect(denyOf()).toEqual(['Skill(ladder)']);
    const current = JSON.parse(readFileSync(settings, 'utf8')) as {
      permissions: { allow: string[] };
    };
    current.permissions.allow.push('Bash(pwd)');
    writeFileSync(settings, `${BOM}${JSON.stringify(current, null, 2)}\n`);

    const view = disableOverride(appData, project);
    expect(view.enabled).toBe(false);
    expect(denyOf()).toEqual([]);
    expect(readFileSync(settings, 'utf8')).toContain('Bash(pwd)');
  });

  it('файл прав больше не JSON — запись о запретах остаётся, а не теряется', () => {
    writeFileSync(settings, `${JSON.stringify({ permissions: {} })}\n`);
    enableOverride(appData, {
      groupId: 'g',
      projectPath: project,
      text: '# t',
      denySkills: ['ladder'],
    });
    writeFileSync(settings, '{ broken');
    const view = disableOverride(appData, project);
    expect(view.enabled).toBe(true);
    expect(view.deny).toEqual(['Skill(ladder)']);
    expect(Object.values(readGroupSources(appData).overrides)).toHaveLength(1);
  });

  // Ревью 28.09 (F-33): своя строка `/.claude/settings.local.json` человека
  // уходила вместе с нашим блоком — личный файл становился коммитируемым.
  it('строка исключений человека остаётся, наш блок снят', () => {
    appendFileSync(exclude, '/.claude/settings.local.json\n');
    writeFileSync(settings, `${JSON.stringify({ permissions: {} })}\n`);
    enableOverride(appData, {
      groupId: 'g',
      projectPath: project,
      text: '# t',
      denySkills: ['ladder'],
    });
    appendFileSync(exclude, '/other\n');

    disableOverride(appData, project);
    const text = readFileSync(exclude, 'utf8');
    expect(text).toContain('/.claude/settings.local.json');
    expect(text).toContain('/other');
    expect(text).not.toContain('group-override');
  });
});

// Ревью 28.09 (F-256): выключение удаляло файл правила целиком, если он
// начинался с метки, — вместе со строками, которые человек дописал ниже блока
// панели. Снимается только блок панели; своё человека остаётся.
describe('файл правила: блок панели и правка человека', () => {
  const rule = (): string => join(project, '.claude', 'rules', 'agentdeck-group.local.md');
  const enable = (text: string): void => {
    enableOverride(appData, { groupId: 'g', projectPath: project, text });
  };

  it('без правок человека — файл удаляется, как и был', () => {
    enable('# Follow the global group');
    disableOverride(appData, project);
    expect(() => readFileSync(rule(), 'utf8')).toThrow();
  });

  it('дописанное человеком ниже блока остаётся, блок панели снят, в шапке сказано, чей файл', () => {
    enable('# Follow the global group');
    appendFileSync(rule(), '\nAlways run pnpm lint before commit.\n');
    disableOverride(appData, project);
    const text = readFileSync(rule(), 'utf8');
    expect(text).toContain('Always run pnpm lint before commit.');
    expect(text).not.toContain('Follow the global group');
    expect(text.split('\n')[0]).toMatch(/^<!-- .* -->$/);
    expect(text).toMatch(/no longer managed by agentdeck/i);
    // Файл теперь человека: включение его не перезапишет (отказ «чужой файл»).
    expect(() => enable('# again')).toThrow(/override_foreign_file|group-override-foreign-file/);
  });

  it('новый текст включённого переопределения не стирает дописанное человеком', () => {
    enable('# First text');
    appendFileSync(rule(), '\nHuman note.\n');
    enable('# Second text');
    const text = readFileSync(rule(), 'utf8');
    expect(text).toContain('# Second text');
    expect(text).not.toContain('# First text');
    expect(text).toContain('Human note.');
  });
});
