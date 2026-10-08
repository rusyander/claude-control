import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import type { GroupScope } from '@agentdeck/contracts/group-sources';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { promotePathStep } from './promote.ts';

/**
 * «Сделать ресурсом» — ревью 28.09: F-13 (id файла правила из клиентского
 * `step.id` уводил запись за `.claude/rules`), F-260 (группа проекта чужой CLI
 * писала в раскладку Claude), F-261 (повторное продвижение шага — второй
 * ресурс). Всё во временном каталоге.
 */

let root: string;
let project: string;
let store: AppStore;

const deps = () => ({
  store,
  paths: {
    root: join(root, 'claude'),
    appData: join(root, 'claude', 'agentdeck'),
    settings: join(root, 'claude', 'settings.json'),
    settingsLocal: join(root, 'claude', 'settings.local.json'),
    claudeMd: join(root, 'claude', 'CLAUDE.md'),
    secretsEnv: join(root, 'claude', 'secrets.env'),
    skills: join(root, 'claude', 'skills'),
    hooks: join(root, 'claude', 'hooks'),
    mcpConfig: join(root, 'claude', '.claude.json'),
  },
  backupDir: join(root, 'claude', 'agentdeck', 'backups'),
});

function group(stepId: string, title: string, scope?: GroupScope): Group {
  const text = { ru: title, en: title };
  return store.saveGroup({
    id: 'proj-1',
    name: 'Flow',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    projectPaths: [],
    scope: scope ?? { kind: 'project', path: project, provider: 'claude' },
    isEnabled: true,
    order: 0,
    path: {
      steps: [
        {
          id: stepId,
          order: 0,
          kind: 'prompt',
          anchor: 'work',
          title: text,
          prompt: text,
          source: 'ru',
          createdAt: '2026-09-28T00:00:00.000Z',
        },
      ],
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-promote-'));
  project = join(root, 'proj');
  mkdirSync(join(root, 'claude', 'agentdeck'), { recursive: true });
  mkdirSync(join(project, '.claude'), { recursive: true });
  store = new AppStore(join(root, 'claude', 'agentdeck'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('F-13: правило проекта из шага с «пустым» заголовком', () => {
  it('id шага с `..` не уводит файл за `.claude/rules`', () => {
    const g = group('../../../pwn', '!!!');
    try {
      promotePathStep(deps(), g, { stepId: '../../../pwn', type: 'rule', draft: 'x' });
    } catch {
      // отказ — тоже честный исход; главное, что файла снаружи нет
    }
    expect(existsSync(join(root, 'pwn.md'))).toBe(false);
    expect(existsSync(join(project, 'pwn.md'))).toBe(false);
    const rules = join(project, '.claude', 'rules');
    const inside = existsSync(rules) ? readdirSync(rules) : [];
    expect(inside.every((name) => !name.includes('..'))).toBe(true);
  });
});

describe('F-260: проектная группа другой CLI', () => {
  it('отказ, а не запись в `.claude` проекта', () => {
    const g = group('s1', 'Build', { kind: 'project', path: project, provider: 'codex' });
    expect(() => promotePathStep(deps(), g, { stepId: 's1', type: 'rule', draft: 'x' })).toThrow(
      expect.objectContaining({ statusCode: 409 }),
    );
    expect(existsSync(join(project, '.claude', 'rules'))).toBe(false);
  });
});

describe('F-261: повторное продвижение того же шага', () => {
  it('второй раз — отказ, второго ресурса нет', () => {
    const first = promotePathStep(deps(), group('s1', 'Build'), {
      stepId: 's1',
      type: 'script',
      draft: 'console.log(1);',
      name: 'first',
    });
    expect(() =>
      promotePathStep(deps(), first, { stepId: 's1', type: 'script', draft: 'x', name: 'other' }),
    ).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(readdirSync(join(project, '.claude', 'hooks'))).toEqual(['first.mjs']);
  });
});
