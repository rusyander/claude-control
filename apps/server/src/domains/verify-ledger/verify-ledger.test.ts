import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installLedger, ledgerEnv, ledgerSummary, withPreload } from './verify-ledger.ts';

/**
 * Установка журнала проверок панелью (T17, T29 из `.agent/tmp/verify-ledger-tests.agent.md`):
 * копия preload в данных панели, живая самопроверка `node -e`, NODE_OPTIONS без потерь.
 */
const SOURCE = resolve(__dirname, '../../../../../tools/verify-ledger');

let appData: string;
beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'cc-ledger-install-'));
});
afterEach(() => rmSync(appData, { recursive: true, force: true }));

describe('installLedger', () => {
  it('ставит копию по версии содержимого и проходит самопроверку живым node', () => {
    const install = installLedger({ appData, sourceDir: SOURCE });
    expect(install.reason).toBeUndefined();
    // Подмешивается постоянный вход, а он ведёт на проверенную версию.
    expect(install.preload).toMatch(/verify-ledger\/bin\/preload\.cjs$/);
    expect(install.preload).not.toContain('\\');
    expect(existsSync(install.preload!)).toBe(true);
    const bin = join(appData, 'verify-ledger', 'bin');
    expect(readFileSync(join(bin, 'current'), 'utf8')).toBe(install.version);
    expect(existsSync(join(bin, install.version!, 'delta.cjs'))).toBe(true);
    // Повтор той же версии — тот же каталог, без второй копии.
    installLedger({ appData, sourceDir: SOURCE });
    expect(readdirSync(bin).filter((n) => /^[0-9a-f]{12}$/.test(n))).toHaveLength(1);
  });

  it('постоянный вход грузит версию из current и ставит общий дом ленты', () => {
    const install = installLedger({ appData, sourceDir: SOURCE });
    const probe = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(String(globalThis[Symbol.for("agentdeck.verify-ledger")]))'],
      {
        env: { ...process.env, NODE_OPTIONS: `--require "${install.preload}"` },
        encoding: 'utf8',
      },
    );
    expect(probe.stdout).toBe('true');
    // Без current вход молчит, а node живёт: битая установка не роняет хуки.
    rmSync(join(appData, 'verify-ledger', 'bin', 'current'));
    const bare = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], {
      env: { ...process.env, NODE_OPTIONS: `--require "${install.preload}"` },
      encoding: 'utf8',
    });
    expect(bare.stdout).toBe('ok');
  });

  it('T17: preload, роняющий node, не ставится — панель ничего не подмешивает', () => {
    const broken = join(appData, 'src');
    mkdirSync(broken);
    for (const name of ['checks.cjs', 'delta.cjs', 'ledger.cjs', 'vcs-delta.mjs']) {
      copyFileSync(join(SOURCE, name), join(broken, name));
    }
    // Ошибка вне try/catch preload — то, что уронило бы КАЖДЫЙ процесс node.
    writeFileSync(join(broken, 'preload.cjs'), 'process.exit(3)');
    const install = installLedger({ appData, sourceDir: broken });
    expect(install.preload).toBeNull();
    expect(install.reason).toMatch(/self-test failed/);
    expect(ledgerEnv(install, appData, {})).toEqual({});
  });

  // 24.10: голый `node -e` грузил только preload, а delta.cjs и прочие тот грузит лениво.
  describe('проба грузит каждый модуль', () => {
    it.each([
      ['delta.cjs', 'module.exports = {'],
      ['vcs-delta.mjs', 'export const = 1;'],
    ])('синтаксическая ошибка в %s — версия не ставится', (name, body) => {
      const broken = join(appData, 'src');
      mkdirSync(broken);
      for (const file of readdirSync(SOURCE)) copyFileSync(join(SOURCE, file), join(broken, file));
      writeFileSync(join(broken, name), body);
      const install = installLedger({ appData, sourceDir: broken });
      expect(install.preload).toBeNull();
      expect(install.reason).toMatch(/self-test failed/);
      expect(existsSync(join(appData, 'verify-ledger', 'bin', 'current'))).toBe(false);
    });
  });

  describe('загрузка панели ставит только записанное в git (24.10: недописанный журнал ушёл группам)', () => {
    let src = '';
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd: src,
        encoding: 'utf8',
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    const installed = (install: { version?: string }, name: string) =>
      join(appData, 'verify-ledger', 'bin', install.version!, name);

    beforeEach(() => {
      src = join(appData, 'repo');
      mkdirSync(src);
      for (const file of ['checks.cjs', 'delta.cjs', 'ledger.cjs', 'preload.cjs']) {
        copyFileSync(join(SOURCE, file), join(src, file));
      }
      git('init', '-q');
      git('add', '.');
      git('commit', '-q', '-m', 'ledger');
      // Правка посреди работы: новый модуль ещё не записан, preload переписан наполовину.
      copyFileSync(join(SOURCE, 'vcs-delta.mjs'), join(src, 'vcs-delta.mjs'));
      writeFileSync(
        join(src, 'preload.cjs'),
        `${readFileSync(join(src, 'preload.cjs'), 'utf8')}\n// wip\n`,
      );
    });

    it('грязный каталог — версия HEAD: без недописанного preload и без незаписанного модуля', () => {
      const install = installLedger({ appData, sourceDir: src, committedOnly: true });
      expect(install.reason).toBeUndefined();
      expect(install.source).toBe('head');
      expect(readFileSync(installed(install, 'preload.cjs'), 'utf8')).not.toContain('// wip');
      expect(existsSync(installed(install, 'vcs-delta.mjs'))).toBe(false);
      expect(readFileSync(join(appData, 'verify-ledger', 'bin', 'current'), 'utf8')).toBe(
        install.version,
      );
    });

    it('флаг AGENTDECK_VERIFY_LEDGER_SOURCE=tree — рабочее дерево как есть', () => {
      const install = installLedger({
        appData,
        sourceDir: src,
        committedOnly: true,
        env: { ...process.env, AGENTDECK_VERIFY_LEDGER_SOURCE: 'tree' },
      });
      expect(install.source).toBe('tree');
      expect(readFileSync(installed(install, 'preload.cjs'), 'utf8')).toContain('// wip');
    });

    it('чистый каталог — рабочее дерево; без флага (тесты) — тоже дерево', () => {
      expect(installLedger({ appData, sourceDir: src }).source).toBe('tree');
      git('add', '.');
      git('commit', '-q', '-m', 'done');
      const install = installLedger({ appData, sourceDir: src, committedOnly: true });
      expect(install.source).toBe('tree');
      expect(existsSync(installed(install, 'vcs-delta.mjs'))).toBe(true);
    });
  });

  it('выключатель disabled — без установки', () => {
    const install = installLedger({
      appData,
      sourceDir: SOURCE,
      env: { AGENTDECK_VERIFY_LEDGER: 'disabled' },
    });
    expect(install).toEqual({ preload: null, reason: 'disabled' });
  });

  it('T17: окружение запусков сохраняет чужие ключи и реально грузится в node', () => {
    const install = installLedger({ appData, sourceDir: SOURCE });
    const env = ledgerEnv(install, appData, { NODE_OPTIONS: '--max-old-space-size=2048' });
    expect(env.NODE_OPTIONS).toContain('--max-old-space-size=2048');
    const r = spawnSync(
      process.execPath,
      ['-e', 'console.log(require("v8").getHeapStatistics().heap_size_limit > 1.5e9)'],
      { env: { ...process.env, ...env }, encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('true');
  });
});

describe('withPreload', () => {
  it('старая версия журнала заменяется, а не копится', () => {
    const once = withPreload('--inspect=0', 'C:/a/verify-ledger/bin/old/preload.cjs');
    const twice = withPreload(once, 'C:/a/verify-ledger/bin/new/preload.cjs');
    expect(twice).toBe('--inspect=0 --require "C:/a/verify-ledger/bin/new/preload.cjs"');
  });

  it('пустые NODE_OPTIONS — только наш ключ', () => {
    expect(withPreload(undefined, '/p/verify-ledger/preload.cjs')).toBe(
      '--require "/p/verify-ledger/preload.cjs"',
    );
  });
});

describe('ledgerSummary', () => {
  it('считает тень, экономию и расхождения за окно; битые строки пропускает', () => {
    const home = join(appData, 'verify-ledger');
    mkdirSync(join(home, 'seen'), { recursive: true });
    const now = 1_000_000_000_000;
    const line = (o: object) => JSON.stringify({ at: now - 1000, repo: 'r1', ...o });
    writeFileSync(
      join(home, 'events.jsonl'),
      [
        line({ kind: 'record' }),
        line({ kind: 'would-skip', savedMs: 60_000 }),
        line({ kind: 'mismatch' }),
        line({ kind: 'off', reason: 'tree-changed' }),
        line({ kind: 'hit', savedMs: 30_000, repo: 'r2' }),
        JSON.stringify({ at: now - 30 * 24 * 3600e3, kind: 'would-skip', savedMs: 999 }),
        '{"half',
      ].join('\n'),
    );
    writeFileSync(join(home, 'seen', 'claude.json'), JSON.stringify({ cli: 'claude', at: now }));
    const s = ledgerSummary(appData, { preload: '/x', version: 'abc' }, now);
    expect(s).toMatchObject({
      active: true,
      version: 'abc',
      records: 1,
      wouldSkip: 1,
      hits: 1,
      mismatches: 1,
      savedMs: 90_000,
      repos: 2,
      offReasons: { 'tree-changed': 1 },
      seen: [{ cli: 'claude', at: now }],
    });
  });
});
