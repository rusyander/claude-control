import { z } from 'zod';
import { writeFileAtomic } from './safe-io/atomic-write.ts';
import { readBytesSync } from './safe-io/files.ts';
import { removeVerified } from './safe-io/remove.ts';
import { hasValue } from './os-kind.ts';
import type { KeeperSpec, KeptExit } from './kept-launch.ts';
import { spawnResolved } from './spawn.ts';

/**
 * Хранитель (`kept-launch.ts`): читает описание и сразу удаляет его, запускает цель скрытой
 * обычным потомком (на Windows — в своё задание: смерть хранителя уносит цель, дерево целое),
 * пишет её выход файлом и выходит с её кодом. TERM передаёт цели и ждёт её выхода.
 */

const keeperSpecSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()),
  extraDirs: z.array(z.string()).optional(),
  exitPath: z.string().min(1),
}) satisfies z.ZodType<KeeperSpec>;

function parseSpec(text: string): KeeperSpec | undefined {
  try {
    const parsed = keeperSpecSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// Описание несёт окружение цели (ключи) — оно удаляется ДО разбора (F-112): битый JSON или чужая
// форма раньше роняли хранителя исключением, и файл с ключами оставался на диске.
const specPath = process.argv[2] ?? '';
const bytes = readBytesSync(specPath);
if (!hasValue(bytes)) process.exit(125);
removeVerified(specPath);
const parsedSpec = parseSpec(bytes.value.toString('utf8'));
if (!parsedSpec) process.exit(125);
const spec: KeeperSpec = parsedSpec;

const finish = (exit: KeptExit, code: number): never => {
  writeFileAtomic(spec.exitPath, JSON.stringify(exit), { mode: 0o600 });
  process.exit(code);
};

const started = spawnResolved({
  command: spec.command,
  args: spec.args,
  cwd: spec.cwd,
  env: spec.env,
  stdio: 'ignore',
  ...(spec.extraDirs ? { extraDirs: spec.extraDirs } : {}),
});
if (!started.ok) finish({ refused: started.reason }, 127);
else {
  const child = started.child;
  child.on('error', (error) => finish({ refused: error.message }, 127));
  child.on('exit', (code, signal) => finish({ code, signal }, code ?? 1));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}
