import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../adapter.types.ts';
import { trustedLayer } from '../sdk-stream/layer-run.ts';
import { QWEN_BUILTIN_TOOLS, QWEN_NONE_EXCLUDED } from './permission.ts';
import { planQwen } from './qwen.ts';

/**
 * Набор `none` Qwen Code сверяется с НАСТОЯЩЕЙ сборкой CLI (F3, кейс panel-agent-foreign-001):
 * значения `ToolNames` из установленного пакета `@qwen-code/qwen-code` — каждое обязано быть в
 * `--exclude-tools` сеанса без инструментов. Сборки нет на машине — проверка пропущена, а не
 * зелёная; статическая половина (список → argv) идёт всегда.
 */

const PACKAGE = join('@qwen-code', 'qwen-code');

function qwenPackageDir(): string | null {
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const root of [join(dir, 'node_modules'), join(dirname(dir), 'lib', 'node_modules')]) {
      const at = join(root, PACKAGE);
      if (existsSync(join(at, 'package.json'))) return at;
    }
  }
  return null;
}

/** Значения объекта `var ToolNames = { … }` из чанков сборки. */
export function builtToolNames(packageDir: string): string[] {
  const chunks = join(packageDir, 'chunks');
  const files = existsSync(chunks) ? readdirSync(chunks).map((f) => join(chunks, f)) : [];
  for (const file of [join(packageDir, 'cli.js'), ...files]) {
    if (!file.endsWith('.js') || !existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const at = text.indexOf('var ToolNames = {');
    if (at < 0) continue;
    const body = text.slice(at, text.indexOf('};', at));
    return [...body.matchAll(/^\s+[A-Z0-9_]+:\s*"([a-z0-9_]+)"/gm)].map((m) => m[1]!);
  }
  return [];
}

const packageDir = qwenPackageDir();

describe('qwen tools none: every built-in of the real build is excluded (F3)', () => {
  it.skipIf(!packageDir)('ToolNames of the installed qwen build ⊆ QWEN_NONE_EXCLUDED', () => {
    const built = builtToolNames(packageDir as string);
    const version = (
      JSON.parse(readFileSync(join(packageDir as string, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    // Разбор сборки сам не должен «зеленеть» пустым: 0.24.3 несёт 71 имя.
    expect(built.length, `qwen ${version}: ToolNames not found`).toBeGreaterThan(40);
    const missing = built.filter((name) => !QWEN_NONE_EXCLUDED.includes(name));
    expect(missing, `qwen ${version}: built-ins offered under tools none`).toEqual([]);
  });

  it('a tools-none launch passes every listed built-in to --exclude-tools', () => {
    const cwd = join(tmpdir(), 'qwen-builtins-work');
    const spec: SessionSpec = {
      sessionId: '33333333-3333-4333-8333-333333333333',
      dir: join(tmpdir(), 'qwen-builtins-session'),
      cwd,
      brief: 'BRIEF',
      deny: { paths: [], commands: [], mcpTools: [], tools: [] },
      platform: { coreHome: join(cwd, '..', 'qwen-builtins-core'), tokenFiles: [] },
      tools: 'none',
      mcpServers: {},
      layer: { hooks: 'off', skills: 'off' },
      env: { pin: {} },
      coreHook: 'node hook.mjs core',
      core: {
        taskId: 't',
        stepId: 's',
        stepKind: 'chat',
        coreUrl: 'http://127.0.0.1:1',
        sessionToken: 'tok',
      },
    };
    const plan = planQwen(spec, null, trustedLayer(spec));
    const at = plan.args.indexOf('--exclude-tools');
    expect(at).toBeGreaterThan(-1);
    const excluded = new Set(plan.args.slice(at + 1).filter((a) => !a.startsWith('--')));
    expect(QWEN_BUILTIN_TOOLS.filter((name) => !excluded.has(name))).toEqual([]);
  });
});
