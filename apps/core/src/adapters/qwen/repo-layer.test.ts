import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LayerRun, SessionSpec } from '../adapter.types.ts';
import { trustedLayer } from '../sdk-stream/layer-run.ts';
import { planQwen, refuseQwen } from './qwen.ts';
import { dotenvKeys, qwenRepoLayer, qwenRepoLayerRefusal } from './repo-layer.ts';

/**
 * Слой копии под Qwen Code 0.24.3 с выключенной проверкой доверия (F-86, H2): ключи, чьё действие
 * держит ядро, грузятся; ключи `.env` исключаются системными настройками; всё прочее — отказ
 * запуска с именем ключа. Доверенная копия файла не разбирает: её слой грузится целиком.
 */

const bases: string[] = [];
afterAll(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

/** Дом стенда (выше — слой человека) и копия под ним. */
function stand(files: Record<string, string>): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), 'qwen-repo-layer-'));
  bases.push(home);
  const cwd = join(home, 'work', 'copy');
  mkdirSync(cwd, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(home, rel, '..'), { recursive: true });
    writeFileSync(join(home, rel), text);
  }
  return { home, cwd };
}

const UNTRUSTED: LayerRun = { asked: 'on', ran: 'on', repoLayer: false, trust: 'none' };

function spec(cwd: string): SessionSpec {
  return {
    sessionId: '33333333-3333-4333-8333-333333333333',
    dir: join(cwd, '..', 'session'),
    cwd,
    brief: 'BRIEF',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: join(cwd, '..', 'core'), tokenFiles: [] },
    tools: 'all',
    mcpServers: { agentdeck: { command: 'node', args: ['core-mcp.mjs'] } },
    layer: { hooks: 'on', skills: 'on' },
    env: { pin: {} },
    coreHook: 'node hook.mjs core',
    core: {
      taskId: 't',
      stepId: 's',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'tok',
    },
  };
}

describe('qwen repo layer — what the CLI would load from an untrusted copy', () => {
  it('held keys only (permissions allow/ask/deny, tools.exclude, mcpServers, $schema) → launches; nothing refused', () => {
    const s = stand({
      'work/copy/.qwen/settings.json': JSON.stringify({
        $schema: 'x',
        permissions: { allow: ['read_file'], deny: ['run_shell_command(rm:*)'] },
        tools: { exclude: ['web_fetch'] },
        mcpServers: { repo: { command: 'node', args: ['repo-mcp.mjs'] } },
      }),
    });
    const layer = qwenRepoLayer(s.cwd, s.home);
    expect(layer.unheld).toEqual([]);
    expect(layer.held).toEqual([
      '$schema',
      'permissions.allow',
      'permissions.deny',
      'tools.exclude',
      'mcpServers',
    ]);
    expect(qwenRepoLayerRefusal(layer)).toBeNull();
    expect(refuseQwen(spec(s.cwd), {}, UNTRUSTED)).toBeNull();
  });

  it.each([
    [{ hooks: { PreToolUse: [] } }, 'hooks'],
    [{ env: { R: '1' } }, 'env'],
    [{ disableAllHooks: true }, 'disableAllHooks'],
    [{ tools: { exclude: [], discoveryCommand: 'evil' } }, 'tools.discoveryCommand'],
    [{ mcp: { serverCommand: 'evil' } }, 'mcp'],
    [{ permissions: { autoMode: {} } }, 'permissions.autoMode'],
    [{ security: { folderTrust: { enabled: true } } }, 'security'],
    [{ tools: { core: ['x'] } }, 'tools.core'],
  ])('a key the core cannot strip refuses the untrusted launch, named: %j', (settings, named) => {
    const s = stand({ 'work/copy/.qwen/settings.json': JSON.stringify(settings) });
    const refusal = refuseQwen(spec(s.cwd), {}, UNTRUSTED);
    expect(refusal).toMatch(
      /^untrusted copy: repo settings .* set .* which the CLI would load and the core cannot strip/,
    );
    expect(qwenRepoLayer(s.cwd, s.home).unheld).toContain(named);
    // Доверенная копия файл не разбирает — её слой грузится целиком.
    expect(refuseQwen(spec(s.cwd), {}, trustedLayer(spec(s.cwd)))).toBeNull();
  });

  it('JSONC with comments parses as the CLI; a broken copy file refuses (the core cannot tell what loads)', () => {
    const ok = stand({
      'work/copy/.qwen/settings.json': '{ // c\n "permissions": {"deny": []} /* x */ }',
    });
    expect(qwenRepoLayer(ok.cwd, ok.home)).toMatchObject({ unheld: [], unreadable: [] });
    const bad = stand({ 'work/copy/.qwen/settings.json': '{"hooks": {},}' });
    expect(qwenRepoLayerRefusal(qwenRepoLayer(bad.cwd, bad.home))).toMatch(
      /^repo layer unreadable, the core cannot tell what the CLI would load: .*settings\.json: not JSON/,
    );
    // Через запуск первым отказывает чтение запретов (тот же файл копии) — запуска нет в любом случае.
    expect(refuseQwen(spec(bad.cwd), {}, UNTRUSTED)).toMatch(/unreadable/);
    // Ключ, который не объект там, где ядро ждёт подключи, — не держится.
    const flat = stand({ 'work/copy/.qwen/settings.json': '{"permissions": "x"}' });
    expect(qwenRepoLayer(flat.cwd, flat.home).unheld).toEqual(['permissions']);
  });

  it('a copy .env → its keys (plus the CLI defaults) go to advanced.excludedEnvVars; the journal names them', () => {
    const s = stand({ 'work/copy/.env': 'A=1\nexport B = 2\n# C=3\n  D: 4\nE.F-G=x\n' });
    const plan = planQwen(spec(s.cwd), null, UNTRUSTED);
    const settings = JSON.parse(plan.files['qwen/system-settings.json']!);
    expect(settings.advanced.excludedEnvVars).toEqual([
      'DEBUG',
      'DEBUG_MODE',
      'A',
      'B',
      'D',
      'E.F-G',
    ]);
    expect(plan.layerDetail).toMatch(/repo \.env keys excluded: A, B, D, E\.F-G \(.*\.env\)$/);
    // Доверенная копия — `.env` её, ничего не исключается.
    const trusted = planQwen(spec(s.cwd), null, trustedLayer(spec(s.cwd)));
    expect(JSON.parse(trusted.files['qwen/system-settings.json']!).advanced).toBeUndefined();
  });

  it('the CLI walk: first .qwen/.env or .env from cwd up, stopping at home', () => {
    // `.env` выше копии (до дома) CLI тоже берёт — ядро исключает и его ключи.
    const up = stand({ 'work/.env': 'UP=1\n' });
    expect(qwenRepoLayer(up.cwd, up.home).dotenv).toMatchObject({ keys: ['UP'] });
    // Дом — слой человека: CLI берёт его `.env` всегда, ядро его не трогает.
    const home = stand({ '.env': 'HOME_KEY=1\n' });
    expect(qwenRepoLayer(home.cwd, home.home).dotenv).toBeNull();
    // Первый найденный побеждает: `.env` копии закрывает `.env` выше.
    const first = stand({ 'work/copy/.env': 'NEAR=1\n', 'work/.env': 'FAR=1\n' });
    expect(qwenRepoLayer(first.cwd, first.home).dotenv).toMatchObject({ keys: ['NEAR'] });
  });

  it('.qwen/.env would load and its keys cannot be excluded → refused, named', () => {
    const s = stand({ 'work/copy/.qwen/.env': 'Q=1\n' });
    const layer = qwenRepoLayer(s.cwd, s.home);
    expect(layer.qwenDotenv).toBe(join(s.cwd, '.qwen', '.env'));
    expect(qwenRepoLayerRefusal(layer)).toMatch(
      /^untrusted copy: .*\.qwen[\\/]\.env would load and its keys cannot be excluded/,
    );
  });

  it('dotenv keys are a superset of the dotenv grammar: BOM, CRLF, export, colon form', () => {
    expect(dotenvKeys('﻿A=1\r\nexport B=2\rC: 3\n  D =4\n=5\n# E=6\nnot a key\n')).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
  });
});
