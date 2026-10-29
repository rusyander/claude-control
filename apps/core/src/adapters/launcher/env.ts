import { gitBaseArgs } from '../../platform/encoding.ts';
import { withoutCaptureRequire } from '../../platform/node-options.ts';
import { envValue } from '../../platform/os-kind.ts';
import { pinEnv, quoteNodeOption } from '../../platform/spawn.ts';
import type { CoreSessionVars, EnvLayers } from './launcher.types.ts';

/**
 * Окружение сессии (03 §Launcher, P25): пин задачи < сессия < ядро, без наследования от
 * процесса ядра — иначе ключи и переменные панели утекали бы в CLI (живая проба 27.10:
 * `cc_entrypoint` и окружение редактора доходили до запроса модели).
 */

export const CORE_VARS = {
  task: 'AGENTDECK_TASK',
  step: 'AGENTDECK_STEP',
  stepKind: 'AGENTDECK_STEP_KIND',
  coreUrl: 'AGENTDECK_CORE_URL',
  access: 'AGENTDECK_SESSION_TOKEN',
  state: 'AGENTDECK_STATE',
} as const;

const NODE_OPTIONS = 'NODE_OPTIONS';
const TEMP_VARS = ['TMPDIR', 'TEMP', 'TMP'] as const;

/**
 * `NODE_OPTIONS` слоёв складываются, а не затирают друг друга: перехват проверок ядра не
 * должен выбить `--max-old-space-size` пина. `--require` ядра идут ПЕРВЫМИ (G22): прокладка
 * захвата должна встать раньше чужого preload, который может сам запустить проверку; прокладка
 * из пина (прежняя установка другой копии) выброшена — она спрашивала бы чужое ядро.
 * Путь `--require` — в кавычках (пробелы в пути).
 */
export function joinNodeOptions(
  parts: readonly (string | undefined)[],
  requires: readonly string[],
): string {
  const own = requires.map((file) => `--require ${quoteNodeOption(file)}`);
  const rest = parts.map((part) => withoutCaptureRequire(part).trim());
  return [...own, ...rest].filter(Boolean).join(' ');
}

/**
 * Аргументы git ядра (`gitBaseArgs`: длинные пути на Windows, `quotepath`) — переменными
 * `GIT_CONFIG_COUNT/KEY_n/VALUE_n`, чтобы их получил и git, которого зовёт сам CLI.
 * Уже заданные пином пары остаются, наши дописываются после них.
 */
export function gitConfigEnv(
  env: Record<string, string>,
  baseArgs: readonly string[] = gitBaseArgs(),
): Record<string, string> {
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < baseArgs.length; i += 2) {
    if (baseArgs[i] !== '-c') continue;
    const item = baseArgs[i + 1] ?? '';
    const at = item.indexOf('=');
    if (at > 0) pairs.push([item.slice(0, at), item.slice(at + 1)]);
  }
  // Только десятичные цифры: `Number` принял бы `1e1`/`0x2`, а git такой счётчик отвергает (F-95).
  const raw = (envValue(env, 'GIT_CONFIG_COUNT') ?? '').trim();
  const start = /^\d+$/.test(raw) ? Number(raw) : 0;
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(start + pairs.length) };
  pairs.forEach(([key, value], index) => {
    out[`GIT_CONFIG_KEY_${start + index}`] = key;
    out[`GIT_CONFIG_VALUE_${start + index}`] = value;
  });
  return out;
}

/** Переменные ядра одной сессии (F19). Токен сессии — только чтение и инструменты модели. */
export function coreVarsEnv(
  core: CoreSessionVars,
  tmpDir: string,
  statePath: string,
): Record<string, string> {
  const temp = Object.fromEntries(TEMP_VARS.map((name) => [name, tmpDir]));
  return {
    ...temp,
    [CORE_VARS.task]: core.taskId,
    [CORE_VARS.step]: core.stepId,
    [CORE_VARS.stepKind]: core.stepKind,
    [CORE_VARS.coreUrl]: core.coreUrl,
    [CORE_VARS.access]: core.sessionToken,
    [CORE_VARS.state]: statePath,
  };
}

/**
 * Итоговое окружение CLI. Имена без учёта регистра там, где ОС так считает (`pinEnv`):
 * `Path` пина и `PATH` сессии — одна переменная, побеждает верхний слой.
 */
export function composeEnv(
  layers: EnvLayers,
  coreEnv: Record<string, string>,
): Record<string, string> {
  const pin = pinEnv(layers.pin);
  const session = pinEnv(layers.session ?? {});
  const merged = pinEnv({ ...pin, ...session, ...coreEnv });
  const nodeOptions = joinNodeOptions(
    [envValue(pin, NODE_OPTIONS), envValue(session, NODE_OPTIONS)],
    layers.nodeRequires ?? [],
  );
  const withoutNode = Object.fromEntries(
    Object.entries(merged).filter(([key]) => key.toUpperCase() !== NODE_OPTIONS),
  );
  const withNode = nodeOptions ? { ...withoutNode, [NODE_OPTIONS]: nodeOptions } : withoutNode;
  const git = gitConfigEnv({ ...pin, ...session }, [...gitBaseArgs(), ...SESSION_GIT_ARGS]);
  return pinEnv({ ...withNode, ...git, ...pushClosureEnv(merged) });
}

/** Сброс списка помощников учётных данных: у сессии нет пароля к удалённому (спека 05). */
const SESSION_GIT_ARGS = ['-c', 'credential.helper='] as const;

/** Слово в одинарных кавычках sh. */
function shQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Закрытие push сессии через окружение (05 §Push closure, F-45): git не спрашивает пароль
 * (`GIT_TERMINAL_PROMPT=0`, пустой `GIT_ASKPASS`), а `GIT_SSH_COMMAND` — обёртка, которая
 * отказывает `git-receive-pack` (push по ssh) и иначе зовёт прежний ssh пина. Публикатор
 * пушит своим окружением, без этой обёртки.
 */
export function pushClosureEnv(env: Record<string, string>): Record<string, string> {
  // `GIT_SSH_COMMAND` — строка оболочки, `GIT_SSH` — путь к программе (в кавычки).
  const program = envValue(env, 'GIT_SSH');
  const base = envValue(env, 'GIT_SSH_COMMAND') ?? (program ? shQuote(program) : 'ssh');
  const script = [
    'for a in "$@"; do case "$a" in *git-receive-pack*)',
    'echo "agentdeck: push is a platform step, the core publishes" >&2; exit 1;; esac; done;',
    `exec ${base} "$@"`,
  ].join(' ');
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_SSH_COMMAND: `sh -c ${shQuote(script)} agentdeck-ssh`,
  };
}
