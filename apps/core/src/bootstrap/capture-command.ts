import { resolve } from 'node:path';
import {
  composeCaptureNodeOptions,
  splitNodeOptions,
  withoutCaptureRequire,
} from '../mcp/capture-wrap.ts';
import {
  CAPTURE_SHIM,
  CAPTURE_VARS,
  captureTokenPath,
  ensureCaptureToken,
  readCaptureToken,
} from '../platform/capture-shim.ts';
import { defaultCoreHome } from '../platform/core-home.ts';
import { writeFileAtomic } from '../platform/safe-io/atomic-write.ts';
import { readBytesSync } from '../platform/safe-io/files.ts';
import { removeVerified } from '../platform/safe-io/remove.ts';
import type { DevCommandIo } from './dev-commands.ts';

/**
 * `index.ts capture install|remove|status --settings <файл> [--home <дом ядра>]` (04:41, G5):
 * захват проверок в сессиях CLI, запущенных человеком, а не ядром. Установка пишет в блок `env`
 * файла настроек CLI (у Claude — `settings.json`) `NODE_OPTIONS` с прокладкой ПЕРВОЙ (прочие
 * записи остаются) и `AGENTDECK_CAPTURE_HOME`, и создаёт доступ захвата в доме ядра. Команда не
 * знает ни одного CLI: файл настроек называет вызывающий — по умолчанию не пишется ничего.
 *
 * Обёртки PATH (go, pytest, cargo …) сессии человека не получают: PATH его CLI ядру не
 * принадлежит — `status` называет эту дорогу «не захвачена». Снятие удаляет обе переменные и
 * доступ захвата (ручка сразу перестаёт отвечать держателю).
 */

const USAGE =
  'capture: usage: capture install|remove|status --settings <settings.json> [--home <core home>]';

type Settings = Record<string, unknown> & { env?: Record<string, unknown> };

interface Args {
  verb: string;
  settings: string;
  home: string;
}

function parseArgs(argv: readonly string[]): Args | string {
  const [verb = '', ...rest] = argv;
  if (!['install', 'remove', 'status'].includes(verb)) return USAGE;
  let settings: string | undefined;
  let home: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i];
    const next = rest[i + 1];
    if (word === '--settings' && next) {
      settings = next;
      i += 1;
    } else if (word === '--home' && next) {
      home = next;
      i += 1;
    } else return `capture: unknown argument ${String(word)}\n${USAGE}`;
  }
  if (!settings)
    return `capture: --settings is required (the command never guesses a CLI config)\n${USAGE}`;
  return { verb, settings: resolve(settings), home: resolve(home ?? defaultCoreHome()) };
}

function readSettings(file: string): Settings | string {
  const bytes = readBytesSync(file);
  if ('absent' in bytes) return {};
  if ('unknown' in bytes) return `capture: ${file} unread: ${bytes.unknown}`;
  try {
    const doc = JSON.parse(bytes.value.toString('utf8')) as unknown;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return `capture: ${file} is not a JSON object; left untouched`;
    }
    const env = (doc as Settings).env;
    if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env))) {
      return `capture: ${file} has a non-object env block; left untouched`;
    }
    return doc as Settings;
  } catch (error) {
    return `capture: ${file} is not JSON (${(error as Error).message}); left untouched`;
  }
}

const shimIn = (nodeOptions: unknown): boolean =>
  typeof nodeOptions === 'string' &&
  splitNodeOptions(withoutCaptureRequire(nodeOptions)).length <
    splitNodeOptions(nodeOptions).length;

function accessText(access: ReturnType<typeof readCaptureToken> | undefined): string {
  if (access === undefined) return 'n/a';
  if ('value' in access) return 'present';
  if ('unknown' in access) return `unread (${access.unknown})`;
  return 'absent';
}

export async function runCaptureCommand(
  argv: readonly string[],
  io: DevCommandIo,
): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    io.err(args);
    return 2;
  }
  const settings = readSettings(args.settings);
  if (typeof settings === 'string') {
    io.err(settings);
    return 2;
  }
  const env: Record<string, unknown> = { ...(settings.env ?? {}) };

  if (args.verb === 'status') {
    const preload = shimIn(env['NODE_OPTIONS']);
    const home =
      typeof env[CAPTURE_VARS.home] === 'string' ? (env[CAPTURE_VARS.home] as string) : null;
    const access = home ? readCaptureToken(home) : undefined;
    const installed = preload && home !== null && access !== undefined && 'value' in access;
    io.out(`capture: ${installed ? 'installed' : 'not installed'} in ${args.settings}`);
    io.out(`  node-preload: ${preload ? 'captured' : 'not captured'}`);
    io.out(`  core home: ${home ?? 'not set'}`);
    io.out(`  capture access: ${accessText(access)}`);
    io.out(
      '  path-wrapper (go, pytest, cargo, dotnet, gradle, mvn): not captured outside core sessions',
    );
    return installed ? 0 : 1;
  }

  if (args.verb === 'install') {
    ensureCaptureToken(args.home);
    env['NODE_OPTIONS'] = composeCaptureNodeOptions(
      typeof env['NODE_OPTIONS'] === 'string' ? env['NODE_OPTIONS'] : undefined,
      CAPTURE_SHIM,
    );
    env[CAPTURE_VARS.home] = args.home;
    writeFileAtomic(args.settings, `${JSON.stringify({ ...settings, env }, null, 2)}\n`);
    io.out(`capture: installed in ${args.settings} (core home ${args.home})`);
    return 0;
  }

  // remove
  const rest = withoutCaptureRequire(
    typeof env['NODE_OPTIONS'] === 'string' ? env['NODE_OPTIONS'] : undefined,
  );
  if (rest === '') delete env['NODE_OPTIONS'];
  else env['NODE_OPTIONS'] = rest;
  delete env[CAPTURE_VARS.home];
  const next: Settings = { ...settings, env };
  if (Object.keys(env).length === 0) delete next.env;
  writeFileAtomic(args.settings, `${JSON.stringify(next, null, 2)}\n`);
  const removed = removeVerified(captureTokenPath(args.home));
  if (!removed.removed) {
    io.err(`capture: removed from ${args.settings}; capture access NOT removed: ${removed.reason}`);
    return 1;
  }
  io.out(`capture: removed from ${args.settings}; capture access revoked`);
  return 0;
}
