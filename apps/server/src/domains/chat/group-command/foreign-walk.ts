import { codeVerdict } from './code.ts';
import { FORGE_CLI, HTTP_CLI, WRAPPERS, wrapped } from './foreign.ts';
import { isKiller, killsProcess } from './kill.ts';
import { isStdinShell } from './readers.ts';
import { risky } from './risky.ts';
import { commandName, printed } from './segment-parts.ts';
import { ENTER, LEAVE, parse, UNPARSED, type Step, type Word } from './shell-parse.ts';
import { Tally } from './tally.ts';
import { isRemover } from './targets.ts';
import { DANGER, OTHER, ROUTINE, type SegmentVerdict, type Walk } from './walk.ts';
import { isWriter } from './writes.ts';
import { isInterpreter, unwrap } from './wrappers.ts';

/**
 * Суд над тем, что исполнится внутри незнакомой команды: обёртки, которую не
 * снять, и подстановки процесса у оболочки. Вынесено из `group-command.ts` по
 * размеру; суд звена и шагов приходит оттуда (`Judges`), чтобы модули не
 * ссылались друг на друга по кругу.
 */
export interface Judges {
  /** Звено по словам — в отдельный итог, в подоболочке обхода. */
  command(words: Word[], tally: Tally): SegmentVerdict;
  /** Шаги сценария — в данный итог. */
  steps(steps: Step[], tally: Tally): void;
}

/**
 * Слово дальше в звене — команда со своими последствиями: удаление, git,
 * обёртка, погашение, запись по пути (`sudo tee /etc/hosts`, R-C05).
 */
function consequential(words: Word[]): boolean {
  const name = commandName(words[0] as Word);
  if (name === undefined) return false;
  const named = [{ text: name, dynamic: false }, ...words.slice(1)];
  return (
    name === 'git' ||
    name === 'xargs' ||
    isRemover(name) ||
    isWriter(name) ||
    FORGE_CLI.has(name) ||
    HTTP_CLI.has(name) ||
    isKiller(named) ||
    unwrap(name, named) !== undefined
  );
}

/**
 * Хосты и контейнеры: команда за ними исполнится не в копии, а там. У
 * `docker`/`kubectl` — только подкоманды, что запускают команду (`docker rm -f
 * x` — удаление контейнера, а не файла `x`: его судят правила чата).
 */
const REMOTE_RUNNERS = new Map<string, RegExp | undefined>([
  ['ssh', undefined],
  ['docker', /^(exec|run)$/],
  ['podman', /^(exec|run)$/],
  ['nerdctl', /^(exec|run)$/],
  ['kubectl', /^(exec|run|debug)$/],
  ['oc', /^(exec|run|debug|rsh)$/],
  ['vagrant', /^ssh$/],
]);

/**
 * Обёртка исполнит команду не в каталоге звена: на другом хосте (`ssh host git
 * reset --hard`), в контейнере (`docker exec c …`), в каталоге своего ключа
 * (`sudo -D /x …`, `sudo -R /x …`, `wsl --cd /x …`, `wsl ~ …`, `start /D x …`). Раньше такая
 * команда судилась как своя, со снимком копии вместо того дерева, которое она
 * затрёт (ревью 23.10, R-04).
 */
function runsElsewhere(name: string, words: Word[]): boolean {
  const texts = words.slice(1).map((word) => word.text);
  if (REMOTE_RUNNERS.has(name)) {
    const runs = REMOTE_RUNNERS.get(name);
    // `docker container exec`, `docker compose exec` — подкоманда может быть второй.
    return runs === undefined || texts.slice(0, 3).some((text) => runs.test(text));
  }
  if (name === 'sudo') {
    return texts.some((text) => /^-[A-Za-z]*[DR]|^--(chdir|chroot)(=|$)/.test(text));
  }
  if (name === 'wsl') return texts[0] === '~' || texts.some((text) => /^--cd(=|$)/.test(text));
  if (name === 'start') return texts.some((text) => /^\/+D/i.test(text));
  return false;
}

/**
 * Суд в отдельном итоге и подоболочке: состояние обхода наружу не выходит.
 * `elsewhere` — каталог исполнения неизвестен (`runsElsewhere`).
 */
function probe(
  run: (tally: Tally) => SegmentVerdict,
  walk: Walk,
  blind: boolean,
  elsewhere: boolean,
): boolean {
  const sub = new Tally();
  walk.enter();
  if (blind) walk.blind();
  if (elsewhere) walk.changeDir(undefined);
  const verdict = run(sub);
  walk.leave();
  return sub.danger || verdict.kind === 'danger';
}

/**
 * Незнакомая команда: обёртка, которую не снять (`sudo -u x rm -rf ~`, `ssh
 * host 'rm -rf ~'`, `pnpm exec rimraf ~`). Ищется слово-команда дальше в
 * звене и строки-сценарии в словах: опасное в них — человеку. Остальное —
 * как раньше, по словам целиком.
 *
 * Строка-аргумент читается как проза (`walk.prose`): удаление, git и
 * погашение в ней видны, а неизвестное имя «команды» (`$1`, `**Create`,
 * JSON) — нет: иначе текст сообщения или сценарий `sed` давал карточку.
 */
export function foreignVerdict(
  words: Word[],
  name: string,
  walk: Walk,
  judges: Judges,
): SegmentVerdict {
  const elsewhere = runsElsewhere(name, words);
  for (let k = 1; k < words.length - 1; k += 1) {
    const rest = words.slice(k);
    if (!consequential(rest)) continue;
    if (probe((sub) => judges.command(rest, sub), walk, false, elsewhere)) return DANGER;
  }
  for (const word of words.slice(1)) {
    if (word.dynamic || !/\s/.test(word.text)) continue;
    const steps = parse(word.text);
    if (steps === UNPARSED) {
      if (risky(word.text)) return DANGER;
      continue;
    }
    const run = (sub: Tally): SegmentVerdict => {
      judges.steps(steps, sub);
      return ROUTINE;
    };
    walk.prose += 1;
    const danger = probe(run, walk, true, elsewhere);
    walk.prose -= 1;
    if (danger) return DANGER;
  }
  return wrapped(words, WRAPPERS.has(name));
}

/** Шаги подстановки — одно звено `echo …`/`printf …`: его печать и станет файлом. */
function printedText(steps: Step[]): string | undefined {
  const segments = steps.filter((step) => step !== ENTER && step !== LEAVE);
  const [only] = segments;
  if (segments.length !== 1 || typeof only !== 'object') return undefined;
  if (only.redirects.length > 0 || only.words.some((word) => word.dynamic)) return undefined;
  return printed(only.words)[0];
}

/**
 * `bash <(echo 'rm -rf ~')`, `source <(…)`, `node <(…)`: вывод подстановки
 * исполнится. Сама команда внутри уже судима как звено; здесь — то, что она
 * напечатает. Известная печать судится как сценарий, прочее — человеку.
 * `undefined` — звено подстановку только читает (`diff <(…) <(…)`).
 */
export function fedVerdict(
  words: Word[],
  walk: Walk,
  tally: Tally,
  judges: Judges,
): SegmentVerdict | undefined {
  const name = words[0]?.text ?? '';
  const fed = words.slice(1).find((word) => word.fed !== undefined)?.fed;
  const shell = name === 'source' || name === '.' || isStdinShell([words[0] as Word]);
  if (fed === undefined || (!shell && !isInterpreter(name))) return undefined;
  const steps = parse(fed);
  const text = steps === UNPARSED ? undefined : printedText(steps);
  if (text === undefined) return DANGER;
  if (!shell) return codeVerdict({ codes: [text], file: false }, words, walk);
  const script = parse(text);
  if (script === UNPARSED) return risky(text) || killsProcess(text) ? DANGER : OTHER;
  walk.enterChild(new Map());
  judges.steps(script, tally);
  walk.leave();
  // `source` исполняет в этой же оболочке: что он сменил, дальше не проследить.
  if (name === 'source' || name === '.') walk.blind();
  return ROUTINE;
}
