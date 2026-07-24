import { describe, it, expect, afterEach, vi } from 'vitest';
import { getProvider, listProviders } from './registry.ts';
import { providerCliCandidates, providerCliCommand, defaultCliCommand } from './cli.ts';

/**
 * Ф10 — кроссплатформенность БЕЗ живых macOS/Linux: платформа подменяется.
 *
 * `process.platform` читается функцией (а не константой модуля) именно ради
 * этого: иначе значение замерло бы на импорте и проверить резолвинг под три ОС
 * было бы нечем. Живой прогон на маке/линуксе всё равно нужен — но код, который
 * ветвится по ОС, проверяется здесь на всех трёх.
 */
function withPlatform(platform: NodeJS.Platform): void {
  vi.stubGlobal('process', { ...process, platform });
}

afterEach(() => vi.unstubAllGlobals());

describe('providerCliCommand по платформам', () => {
  it('win32 → .cmd-обёртка, darwin/linux → голое имя', () => {
    const codex = getProvider('codex');

    withPlatform('win32');
    expect(providerCliCommand(codex)).toBe('codex.cmd');
    expect(defaultCliCommand()).toBe('claude.cmd');

    withPlatform('darwin');
    expect(providerCliCommand(codex)).toBe('codex');
    expect(defaultCliCommand()).toBe('claude');

    withPlatform('linux');
    expect(providerCliCommand(codex)).toBe('codex');
    expect(defaultCliCommand()).toBe('claude');
  });

  it('у КАЖДОГО провайдера задан win-вариант вида <имя>.cmd', () => {
    withPlatform('win32');
    for (const provider of listProviders()) {
      expect(provider.cli.windowsCommand).toBe(`${provider.cli.command}.cmd`);
      expect(providerCliCommand(provider)).toBe(provider.cli.windowsCommand);
    }
  });
});

describe('providerCliCandidates', () => {
  it('на Windows пробуем и .cmd, и голое имя (npm-обёртка vs .exe)', () => {
    withPlatform('win32');
    // Codex ставится и как npm-обёртка codex.cmd, и как нативный codex.exe;
    // aider приходит из pip как Scripts\aider.exe — .cmd там нет вовсе.
    expect(providerCliCandidates(getProvider('codex'))).toEqual(['codex.cmd', 'codex']);
    expect(providerCliCandidates(getProvider('aider'))).toEqual(['aider.cmd', 'aider']);
    expect(providerCliCandidates(getProvider('claude'))).toEqual(['claude.cmd', 'claude']);
  });

  it('на POSIX вариант ровно один', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      withPlatform(platform);
      expect(providerCliCandidates(getProvider('codex'))).toEqual(['codex']);
      expect(providerCliCandidates(getProvider('opencode'))).toEqual(['opencode']);
    }
  });
});
