import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmCmdShim } from '../../../platform/__fixtures__/shims.ts';

/**
 * Подставной CLI JSON-RPC по stdio для набора соответствия: запись живого CLI (`rpc-tee.mjs`)
 * и её проигрывание (`replay-rpc.mjs`) ставятся в каталог PATH сеанса под именем CLI — тем же
 * путём, каким ядро находит настоящий (npm-обёртка `.cmd` на Windows, исполняемый файл иначе).
 */

export const RPC_TEE = fileURLToPath(new URL('./rpc-tee.mjs', import.meta.url));
export const RPC_REPLAY = fileURLToPath(new URL('./replay-rpc.mjs', import.meta.url));

export function installRpcScript(binDir: string, command: string, script: string): void {
  if (process.platform === 'win32') {
    const pkg = join(binDir, 'node_modules', `${command}-rpc`);
    mkdirSync(pkg, { recursive: true });
    copyFileSync(script, join(pkg, 'cli.mjs'));
    writeFileSync(
      join(binDir, `${command}.cmd`),
      npmCmdShim(`node_modules\\${command}-rpc\\cli.mjs`),
    );
    return;
  }
  mkdirSync(binDir, { recursive: true });
  const target = join(binDir, command);
  writeFileSync(target, readFileSync(script, 'utf8'));
  chmodSync(target, 0o755);
}

/**
 * Каталог первым в PATH закреплённого окружения. На Windows в пине бывают оба ключа (`PATH` и
 * `Path`, окружение там без регистра): правка одного оставила бы второй, и процесс взял бы
 * любой из них — подставной файл не находился бы (проба 02.11: исполнился настоящий `git`).
 */
export function withBinFirst(pin: Record<string, string>, bin: string): Record<string, string> {
  const keys = Object.keys(pin).filter((k) => k.toUpperCase() === 'PATH');
  const out = { ...pin };
  for (const key of keys.length > 0 ? keys : ['PATH']) {
    out[key] = `${bin}${delimiter}${pin[key] ?? ''}`;
  }
  return out;
}

export function rpcFixturePath(cli: string, name: string): string {
  return fileURLToPath(new URL(`../../${cli}/__fixtures__/${name}.jsonl`, import.meta.url));
}

/** Первая строка записи: что было на месте путей и команды хука во время записи. */
export interface RpcFixtureMeta {
  version: string;
  hookCommand: string;
  dir: string;
  cwd: string;
}

export function readRpcMeta(file: string): RpcFixtureMeta {
  const first = readFileSync(file, 'utf8').split('\n')[0] ?? '';
  return (JSON.parse(first) as { meta: RpcFixtureMeta }).meta;
}

export interface RpcDump {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: Record<string, unknown>[];
}

export function readRpcDump(file: string): RpcDump {
  return JSON.parse(readFileSync(file, 'utf8')) as RpcDump;
}

/**
 * Строка клиента с методом `method`, когда она дошла до подставного CLI (ждёт до `ms`). Запись,
 * в которой этого метода нет (продолжение над записью нового сеанса), проигрыш на нём встанет —
 * но всё, что клиент прислал, уже в дампе.
 */
export async function sentRpcMethod(
  file: string,
  method: string,
  ms = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  for (;;) {
    let stdin: Record<string, unknown>[] = [];
    try {
      stdin = readRpcDump(file).stdin;
    } catch {
      // Дамп пишется по строке: недописанный файл — читаем заново.
    }
    const found = stdin.find((m) => m.method === method);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`client never sent ${method}; sent ${stdin.map((m) => m.method).join(',')}`);
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}
