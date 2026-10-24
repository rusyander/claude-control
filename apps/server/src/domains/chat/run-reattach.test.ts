import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerLaunchOf, ledgerRunOptions, providerOfCommand } from './run-reattach.ts';
import { readRunLedger, type RunLedgerEntry } from './run-ledger/run-ledger.ts';

const BASE: RunLedgerEntry = { key: 'new-a', cwd: '/w', startedAt: 1, pid: 10 };

describe('журнал прогонов: команда запуска (EF-190)', () => {
  it('запись знает команду, её провайдера, каталог конфигурации и источники настроек', () => {
    expect(
      ledgerLaunchOf({ command: 'claude.cmd', configDir: '/cfg', settingSources: 'user' }),
    ).toEqual({
      command: 'claude.cmd',
      provider: 'claude',
      configDir: '/cfg',
      settingSources: 'user',
    });
    expect(ledgerLaunchOf({ command: 'C:\\bin\\codex.cmd' })).toEqual({
      command: 'C:\\bin\\codex.cmd',
      provider: 'codex',
    });
    // Чужая команда (скрипт, путь к node) пишется как есть, провайдера у неё нет.
    expect(ledgerLaunchOf({ command: '"node" "fake.mjs"' })).toEqual({
      command: '"node" "fake.mjs"',
    });
    expect(ledgerLaunchOf({})).toEqual({});
  });

  it('провайдер по команде: имя без каталога, кавычек и регистра', () => {
    expect(providerOfCommand('claude')).toBe('claude');
    expect(providerOfCommand('"C:\\Tools\\CLAUDE.CMD"')).toBe('claude');
    expect(providerOfCommand('/usr/local/bin/qwen')).toBe('qwen');
    expect(providerOfCommand('fakeprov')).toBeUndefined();
  });

  it('продолжение берёт записанную команду и каталог конфигурации', () => {
    const told: string[] = [];
    const options = ledgerRunOptions(
      { ...BASE, command: 'fakeprov', configDir: '/cfg', settingSources: 'user' },
      (line) => told.push(line),
    );
    expect(options).toMatchObject({
      command: 'fakeprov',
      configDir: '/cfg',
      settingSources: 'user',
    });
    expect(told).toEqual([]);
  });

  it('команды нет, провайдер есть — команда провайдера для этой ОС', () => {
    const told: string[] = [];
    const options = ledgerRunOptions({ ...BASE, key: 'new-p', provider: 'codex' }, (line) =>
      told.push(line),
    );
    expect(options.command).toBe(process.platform === 'win32' ? 'codex.cmd' : 'codex');
    expect(told).toEqual([]);
  });

  it('запись прежней версии без команды — CLI по умолчанию и одна строка в журнале сервера', () => {
    const told: string[] = [];
    const old = { ...BASE, key: 'new-old' };
    expect(ledgerRunOptions(old, (line) => told.push(line)).command).toBeUndefined();
    expect(ledgerRunOptions(old, (line) => told.push(line)).command).toBeUndefined();
    expect(told).toEqual([
      'run ledger: entry new-old has no command (older panel); continuing with the default CLI',
    ]);
  });

  it('битое поле запуска снимается, а запись остаётся усыновляемой', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-launch-'));
    try {
      writeFileSync(
        join(dir, 'runs.json'),
        JSON.stringify([{ ...BASE, command: 42, provider: '', configDir: '/cfg' }]),
      );
      expect(readRunLedger(dir)).toEqual([{ ...BASE, configDir: '/cfg' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
