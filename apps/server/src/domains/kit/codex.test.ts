import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_KIT_ARG_LIMIT,
  CODEX_KIT_ENV,
  CodexKitTooLarge,
  buildCodexOverlay,
  withCodexKit,
  writeCodexOverlay,
} from './codex.ts';

/**
 * Набор панели в Codex — наложение на запуск. Набор и дом Codex — временные
 * каталоги; `config.toml` человека только читается. Что из этого реально
 * принимает настоящий codex, проверяет `tools/qa/check-codex-kit.mjs`.
 */

let root: string;
let kitDir: string;
let codexHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-codex-kit-'));
  kitDir = join(root, 'kit');
  codexHome = join(root, 'codex-home');
  mkdirSync(join(kitDir, 'rules'), { recursive: true });
  mkdirSync(join(kitDir, 'skills', 'verify-by-running'), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(kitDir, 'rules', 'standard.md'), '# agentdeck kit rules\n\n- RULE-STANDARD\n');
  writeFileSync(join(kitDir, 'rules', 'local.md'), '- RULE-LOCAL\n');
  writeFileSync(
    join(kitDir, 'skills', 'verify-by-running', 'SKILL.md'),
    '---\nname: verify-by-running\ndescription: "Run the check before calling work done"\n---\nbody\n',
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('buildCodexOverlay', () => {
  it('собственные инструкции человека — первыми, правила набора — после', () => {
    writeFileSync(
      join(codexHome, 'config.toml'),
      'developer_instructions = "USER-OWN"\nmodel = "x"\n',
    );
    const overlay = buildCodexOverlay({ kitDir, local: false, codexHome });
    expect(overlay.appServer.indexOf('USER-OWN')).toBe(0);
    expect(overlay.appServer).toContain('RULE-STANDARD');
    expect(overlay.appServer.indexOf('RULE-STANDARD')).toBeGreaterThan(
      overlay.appServer.indexOf('USER-OWN'),
    );
  });

  it('local.md — только варианту локальной модели', () => {
    expect(buildCodexOverlay({ kitDir, local: false, codexHome }).exec).not.toContain('RULE-LOCAL');
    expect(buildCodexOverlay({ kitDir, local: true, codexHome }).exec).toContain('RULE-LOCAL');
  });

  it('навыки: у exec — список с описанием и путём, у app-server — только каталог', () => {
    const overlay = buildCodexOverlay({ kitDir, local: false, codexHome });
    const skillPath = join(kitDir, 'skills', 'verify-by-running', 'SKILL.md');
    expect(overlay.exec).toContain(
      `- verify-by-running — Run the check before calling work done (${skillPath})`,
    );
    expect(overlay.appServer).not.toContain('verify-by-running');
    expect(overlay.skillsDir).toBe(join(kitDir, 'skills'));
  });

  it('нечитаемый config.toml человека не роняет сборку: дописывать не к чему', () => {
    writeFileSync(join(codexHome, 'config.toml'), 'developer_instructions = [broken');
    expect(buildCodexOverlay({ kitDir, local: false, codexHome }).appServer).toMatch(
      /^# agentdeck kit rules/,
    );
  });

  it('не помещается в командную строку — отказ, а не урезанные правила', () => {
    writeFileSync(join(kitDir, 'rules', 'huge.md'), 'x'.repeat(CODEX_KIT_ARG_LIMIT));
    expect(() => buildCodexOverlay({ kitDir, local: false, codexHome })).toThrow(CodexKitTooLarge);
  });
});

describe('withCodexKit', () => {
  const overlayFile = () =>
    writeCodexOverlay(
      join(root, 'overlay.json'),
      buildCodexOverlay({ kitDir, local: false, codexHome }),
    );

  it('без переменной наложения запуск не меняется', () => {
    const env = { OPENAI_BASE_URL: 'http://x' };
    expect(withCodexKit(['exec', 'привет'], env, 'exec')).toEqual({
      args: ['exec', 'привет'],
      env,
      skillRoots: [],
    });
  });

  it('exec: ключ сразу после подкоманды, до промпта; переменная убрана из окружения', () => {
    const result = withCodexKit(
      ['exec', '-m', 'gpt-5', 'привет'],
      { [CODEX_KIT_ENV]: overlayFile(), OPENAI_BASE_URL: 'http://x' },
      'exec',
    );
    expect(result.args.slice(0, 2)).toEqual(['exec', '-c']);
    expect(result.args.slice(3)).toEqual(['-m', 'gpt-5', 'привет']);
    const value = result.args[2] ?? '';
    expect(value.startsWith('developer_instructions="')).toBe(true);
    // Строка TOML без настоящих переводов строки: cmd-обёртка её не обрежет.
    expect(value).not.toMatch(/\n/);
    expect(JSON.parse(value.slice('developer_instructions='.length))).toContain('RULE-STANDARD');
    expect(result.env).toEqual({ OPENAI_BASE_URL: 'http://x' });
    expect(result.skillRoots).toEqual([]);
  });

  it('app-server: инструкции без списка навыков и корень навыков', () => {
    const result = withCodexKit(['app-server'], { [CODEX_KIT_ENV]: overlayFile() }, 'appServer');
    expect(result.args[0]).toBe('app-server');
    expect(result.args[2]).not.toContain('verify-by-running');
    expect(result.skillRoots).toEqual([join(kitDir, 'skills')]);
    expect(result.env).toEqual({});
  });

  it('файл наложения пропал — missing, а не тихий запуск без набора', () => {
    const result = withCodexKit(
      ['exec', 'привет'],
      { [CODEX_KIT_ENV]: join(root, 'gone.json') },
      'exec',
    );
    expect(result.missing).toBe(true);
  });
});
