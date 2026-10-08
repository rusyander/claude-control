import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClaudePaths } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { setPermissionsEnabled } from './permissions.ts';
import { applyEntityState } from '../entity-toggle.ts';

/**
 * Ревью 28.09 (F-270, F-271): выключение-включение права возвращает settings.json
 * байт в байт. Раньше код без памяти не отличал контейнер (`permissions`, список
 * решения), заведённый панелью, от положенного человеком: пустой `permissions: {}`
 * человека пропадал после включения и выключения, а список из одного шаблона,
 * снятый выключением, при включении вставал в конец `permissions`. Теперь панель
 * помнит, что завела сама и где стояло снятое, и откатывает ровно это.
 */

let dir: string;
let path: string;
let store: AppStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-perm-places-'));
  path = join(dir, 'settings.json');
  const appData = join(dir, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  writeFileSync(
    join(appData, 'state.json'),
    JSON.stringify({
      groups: [],
      automations: [],
      disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
    }),
  );
  store = new AppStore(appData);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const file = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const toggle = (id: string, isEnabled: boolean): void => {
  setPermissionsEnabled(path, [{ id, isEnabled }], undefined, store);
};

describe('включение → выключение: снимается только заведённое панелью', () => {
  it('пустой permissions человека остаётся после включения и выключения права (F-270)', () => {
    const original = file({ model: 'sonnet', permissions: {} });
    writeFileSync(path, original);
    toggle('allow:Bash(ls)', true);
    expect(JSON.parse(readFileSync(path, 'utf8')).permissions).toEqual({ allow: ['Bash(ls)'] });
    toggle('allow:Bash(ls)', false);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('пустой список человека остаётся (F-270)', () => {
    const original = file({ permissions: { deny: [], allow: ['Read'] } });
    writeFileSync(path, original);
    toggle('deny:Bash(rm:*)', true);
    toggle('deny:Bash(rm:*)', false);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('заведённое панелью по-прежнему уходит целиком — без "ask": [] и "permissions": {}', () => {
    const original = file({ model: 'sonnet' });
    writeFileSync(path, original);
    toggle('ask:Bash(git push:*)', true);
    toggle('ask:Bash(git push:*)', false);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});

describe('выключение → включение: снятое возвращается на своё место', () => {
  it('список из одного шаблона возвращается на своё место среди списков (F-271)', () => {
    const original = file({ permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm:*)'] } });
    writeFileSync(path, original);
    toggle('allow:Bash(ls)', false);
    expect(JSON.parse(readFileSync(path, 'utf8')).permissions).toEqual({ deny: ['Bash(rm:*)'] });
    toggle('allow:Bash(ls)', true);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('permissions, снятый выключением, возвращается на своё место в файле', () => {
    const original = file({ model: 'sonnet', permissions: { ask: ['Bash(x)'] }, env: {} });
    writeFileSync(path, original);
    toggle('ask:Bash(x)', false);
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')))).toEqual(['model', 'env']);
    toggle('ask:Bash(x)', true);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('шаблон в списке, выстроенном руками не по алфавиту, возвращается между теми же соседями', () => {
    const original = file({ permissions: { allow: ['Write', 'Bash(ls)', 'Agent'] } });
    writeFileSync(path, original);
    toggle('allow:Bash(ls)', false);
    toggle('allow:Bash(ls)', true);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('пачкой выключили два соседа — поштучное включение в любом порядке восстанавливает порядок', () => {
    const original = file({ permissions: { allow: ['Zed', 'Alpha', 'Mid'] } });
    writeFileSync(path, original);
    setPermissionsEnabled(
      path,
      [
        { id: 'allow:Zed', isEnabled: false },
        { id: 'allow:Alpha', isEnabled: false },
      ],
      undefined,
      store,
    );
    toggle('allow:Alpha', true);
    toggle('allow:Zed', true);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('поштучный тумблер (applyEntityState) тоже помнит место', () => {
    const original = file({ permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm:*)'] } });
    writeFileSync(path, original);
    const paths = { settings: path, settingsLocal: join(dir, 'settings.local.json') };
    const deps = { paths: paths as unknown as ClaudePaths, store };
    applyEntityState(deps, 'permission', 'allow:Bash(ls)', false);
    applyEntityState(deps, 'permission', 'allow:Bash(ls)', true);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});
