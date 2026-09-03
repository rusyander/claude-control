import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DlpRule } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import {
  applyPromptGate,
  describePromptGate,
  gateScriptPath,
  isPanelScript,
} from './prompt-gate.ts';
import { saveRules } from './dlp/rules-store.ts';

/**
 * Что нашёл аудит: смена действия в панели не доходила до диска, потому что
 * свой же скрипт, собранный при старых настройках, читался как чужая правка;
 * флаг журнала был зашит в скрипт и тумблер делал его «изменённым»; повторное
 * применение переписывало settings.json без изменений.
 */

const RULE: DlpRule = {
  id: 'r1',
  name: 'Сотрудники',
  enabled: true,
  kind: 'terms',
  terms: ['Рустам Урманов'],
  pattern: '',
  action: 'mask',
  label: 'ИМЯ',
};

describe('гейт на промпте: свой скрипт и чужой', () => {
  let dir: string;
  let store: AppStore;
  let location: { hooksDir: string; settingsPath: string; appDataDir: string };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gate-audit-'));
    location = {
      hooksDir: join(dir, 'hooks'),
      settingsPath: join(dir, 'settings.json'),
      appDataDir: join(dir, 'claude-control'),
    };
    mkdirSync(location.hooksDir, { recursive: true });
    mkdirSync(location.appDataDir, { recursive: true });
    writeFileSync(location.settingsPath, '{}', 'utf8');
    store = new AppStore(join(dir, 'state.json'));
    saveRules(location.appDataDir, [RULE]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const script = () => readFileSync(gateScriptPath(location.hooksDir), 'utf8');

  it('смена действия переписывает скрипт панели — он не читается как правленный руками', () => {
    applyPromptGate(store, location, { enabled: true, action: 'block' });
    expect(script()).toContain('"action": "block"');
    expect(isPanelScript(script())).toBe(true);

    const info = applyPromptGate(store, location, { enabled: true, action: 'warn' });
    expect(script()).toContain('"action": "warn"');
    expect(info.customized).toBe(false);
    expect(info.installed).toBe(true);
  });

  it('флаг журнала в скрипт не зашит: скрипт читает его из state.json', () => {
    applyPromptGate(store, location, { enabled: true, action: 'block' });
    expect(script()).toContain('statePath');
    expect(script()).not.toMatch(/"journal":\s*(true|false)/);
  });

  it('правленный руками скрипт не перезаписывается, force возвращает свой', () => {
    applyPromptGate(store, location, { enabled: true, action: 'block' });
    const path = gateScriptPath(location.hooksDir);
    writeFileSync(path, `${script()}\n// моя правка\n`, 'utf8');

    let info = applyPromptGate(store, location, { enabled: true, action: 'warn' });
    expect(info.customized).toBe(true);
    expect(script()).toContain('// моя правка');

    info = applyPromptGate(store, location, { enabled: true, action: 'warn' }, { force: true });
    expect(info.customized).toBe(false);
    expect(script()).toContain('"action": "warn"');
    expect(script()).not.toContain('// моя правка');
  });

  it('повторное применение без изменений не трогает settings.json', () => {
    applyPromptGate(store, location, { enabled: true, action: 'block' });
    const before = readFileSync(location.settingsPath, 'utf8');
    const mtime = statSync(location.settingsPath).mtimeMs;

    applyPromptGate(store, location, { enabled: true, action: 'block' });
    applyPromptGate(store, location, { enabled: true, action: 'warn' });

    expect(readFileSync(location.settingsPath, 'utf8')).toBe(before);
    expect(statSync(location.settingsPath).mtimeMs).toBe(mtime);
  });

  it('выключенный гейт при выключенном хуке не пишет settings.json вовсе', () => {
    const before = readFileSync(location.settingsPath, 'utf8');
    applyPromptGate(store, location, { enabled: false, action: 'block' });
    expect(readFileSync(location.settingsPath, 'utf8')).toBe(before);
    expect(describePromptGate(store, location).installed).toBe(false);
  });
});
