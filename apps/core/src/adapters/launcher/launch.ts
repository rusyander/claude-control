import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveExecutable } from '../../platform/exec-resolve.ts';
import { longForm } from '../../platform/paths.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { launchSession, type SessionLaunchDeps } from '../../session-host/launch.ts';
import { composeEnv, coreVarsEnv } from './env.ts';
import type { LaunchInput, LaunchOutcome } from './launcher.types.ts';

/**
 * Каждый запуск CLI ядром (03 §Launcher, P25): исполняемый файл разрешается ЗДЕСЬ, до хоста
 * (`.exe` на PATH; обёртка npm/pnpm — до её цели node; нераспознанная обёртка — отказ), и в
 * журнал уходит тот argv, который исполнит ОС, а не имя команды. Хост получает уже настоящий
 * файл и сам проверяет его ещё раз тем же разрешителем — расхождения не бывает.
 * Без оболочки; длинный текст переходник кладёт файлом (`writeTextArg`), не в argv.
 */

export const SESSION_TMP = 'tmp';
export const SESSION_STATE = 'state.json';

export async function launchCli(
  input: LaunchInput,
  deps: SessionLaunchDeps = {},
): Promise<LaunchOutcome> {
  mkdirSync(input.dir, { recursive: true, mode: 0o700 });
  const dir = longForm(input.dir);
  const tmpDir = join(dir, SESSION_TMP);
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const statePath = join(dir, SESSION_STATE);
  // `agentdeck state` для авторов хуков: пока файлом, команда читает его же (спец. 03 F19).
  writeFileAtomic(
    statePath,
    JSON.stringify({
      task: input.core.taskId,
      step: input.core.stepId,
      stepKind: input.core.stepKind,
      ...(input.core.state ?? {}),
    }),
    { mode: 0o600 },
  );
  const env = composeEnv(input.env, coreVarsEnv(input.core, tmpDir, statePath));
  const cwd = longForm(input.cwd);
  // Явный относительный путь — от cwd сессии, как у хоста (`spawnResolved`), не от каталога ядра.
  const resolution = resolveExecutable(input.command, {
    env,
    cwd,
    ...(input.extraDirs ? { extraDirs: input.extraDirs } : {}),
  });
  if (!resolution.ok) {
    const reason = resolution.absent
      ? `«${input.command}» not found (searched ${resolution.searched.length} dirs)`
      : `«${resolution.found}» refused: ${resolution.refused}`;
    return { ok: false, reason, refused: true };
  }
  const argv = [...resolution.prefix, ...input.args];
  const fullEnv = { ...env, ...(resolution.envAdd ?? {}) };
  const started = await launchSession(
    {
      dir,
      sessionId: input.sessionId,
      command: resolution.file,
      args: argv,
      cwd,
      env: fullEnv,
      ...(input.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: input.readyTimeoutMs }),
    },
    deps,
  );
  if (!started.ok) return { ok: false, reason: started.reason, refused: started.refused ?? false };
  return {
    ok: true,
    dir,
    sessionId: input.sessionId,
    host: started.host,
    child: started.child,
    spawned: {
      file: resolution.file,
      argv,
      found: resolution.found,
      kind: resolution.kind,
      cwd,
      envNames: Object.keys(fullEnv).sort(),
    },
    tmpDir,
    statePath,
  };
}
