import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { updateGroupSources } from '../../../lib/app-store/group-sources.ts';
import { setGroupEnabled } from '../../group-toggle.ts';
import { applyAdvice } from './advice.ts';

/**
 * Ревью 28.09 (F-114): «улучшить» скилл, который лежит в `skills-disabled/`
 * (группа выключена или скилл выключен руками), писал новый текст в `skills/` —
 * вторая, включённая копия: Claude её видел, а включение группы падало на
 * переносе папки поверх существующей. Всё во временном каталоге.
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
    skills: join(root, 'skills'),
    hooks: join(root, 'hooks'),
    mcpConfig: join(root, '.claude.json'),
  },
  backupDir: join(root, 'agentdeck', 'backups'),
});

const IMPROVED = '---\nname: ladder\ndescription: ladder skill\n---\n\nRun 3 review rounds.\n';

function seedGroup(): Group {
  mkdirSync(join(root, 'skills', 'ladder'), { recursive: true });
  writeFileSync(
    join(root, 'skills', 'ladder', 'SKILL.md'),
    '---\nname: ladder\ndescription: ladder skill\n---\n\nRun 2 review rounds.\n',
    'utf8',
  );
  const group = store.saveGroup({
    id: 'glob-1',
    name: 'Flow',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [{ kind: 'skill', id: 'ladder' }],
    env: {},
    projectPaths: [],
    scope: { kind: 'global' },
    isEnabled: true,
    order: 0,
  });
  updateGroupSources(join(root, 'agentdeck'), (state) => {
    state.advice[group.id] = {
      mode: 'copy',
      items: [
        { kind: 'skill', id: 'ladder', verdict: 'improve', reason: 'r', replacement: IMPROVED },
      ],
      at: '2026-09-28T00:00:00.000Z',
    };
  });
  return group;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-advice-disabled-'));
  mkdirSync(join(root, 'agentdeck'), { recursive: true });
  writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
  store = new AppStore(join(root, 'agentdeck'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('F-114: «улучшить» скилл выключенной группы', () => {
  it('пишет туда, где скилл лежит, и группа потом включается', () => {
    const group = seedGroup();
    setGroupEnabled(deps(), group, false);
    const off = store.getGroups().find((item) => item.id === group.id)!;
    expect(existsSync(join(root, 'skills-disabled', 'ladder', 'SKILL.md'))).toBe(true);

    const saved = applyAdvice(deps(), off, [{ kind: 'skill', id: 'ladder' }]);

    expect(existsSync(join(root, 'skills', 'ladder'))).toBe(false);
    expect(readFileSync(join(root, 'skills-disabled', 'ladder', 'SKILL.md'), 'utf8')).toBe(
      IMPROVED,
    );
    expect(() => setGroupEnabled(deps(), saved, true)).not.toThrow();
    expect(readFileSync(join(root, 'skills', 'ladder', 'SKILL.md'), 'utf8')).toBe(IMPROVED);
    expect(existsSync(join(root, 'skills-disabled', 'ladder'))).toBe(false);
  });

  // Ревью 28.09 (F-221): отмечено то, чего нет среди ожидающих, — было 200 и
  // пересохранение группы без единой правки.
  it('выбор мимо ожидающих советов — отказ 409, группа не пересохраняется', () => {
    const group = seedGroup();
    const before = JSON.stringify(store.getGroups());
    expect(() => applyAdvice(deps(), group, [{ kind: 'skill', id: 'no-such' }])).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'advice_empty' }),
    );
    expect(JSON.stringify(store.getGroups())).toBe(before);
  });

  it('включённый скилл улучшается на месте', () => {
    const group = seedGroup();
    applyAdvice(deps(), group, [{ kind: 'skill', id: 'ladder' }]);
    expect(readFileSync(join(root, 'skills', 'ladder', 'SKILL.md'), 'utf8')).toBe(IMPROVED);
    expect(existsSync(join(root, 'skills-disabled', 'ladder'))).toBe(false);
  });
});
