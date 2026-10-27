import { commandSteps, gitVerb } from './check-signature.ts';
import { str } from './reduce-util.ts';
import { bare } from './shell-targets.ts';

/**
 * Предмет защищённого действия (R25, F-56): что именно оно делает, без шума записи.
 * Страж отбил действие и назвал, как надо, — повтор, который назвал цель пуша, взял
 * `-d` вместо `-D` или `--force-with-lease` вместо `--force`, поправил описание MR,
 * — исправленный повтор, а не обход. Обход — то же действие над тем же предметом,
 * только иначе записанное (`HEAD:main` вместо `main`, другой хвост `| tail`), догон
 * целевой ветки другой командой или MR другим путём (CLI после отказа MCP).
 */

/** Ключи пуша со значением: значение — не цель. */
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

/** Слова остатка команды без кавычек и перенаправлений (`2>&1`, `>out.txt`). */
function words(rest: string): string[] {
  return rest
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^["']|["']$/g, ''))
    .filter((word) => word && !/^(?:\d*[<>]|&>)/.test(word));
}

/** Ветка назначения: `+a:b` → `b`, `refs/heads/b` → `b`. */
function destination(ref: string): string {
  const target = ref.replace(/^\+/, '');
  const dest = target.includes(':') ? target.slice(target.indexOf(':') + 1) : target;
  return dest.replace(/^refs\/heads\//, '');
}

/**
 * Предмет пуша — сила и ветки назначения, без удалённого (RF-BGCD-10): `origin`,
 * его адрес (`https://…/r.git`) и `--repo=origin` — одна и та же цель, иначе
 * записанная, а не исправленная. Удалённое — первое позиционное, если не названо `--repo`.
 */
function pushSubject(rest: string): string {
  const list = words(rest);
  let force = 'none';
  let remoteNamed = list.some((word) => word === '--repo' || word.startsWith('--repo='));
  const targets: string[] = [];
  for (let at = 0; at < list.length; at += 1) {
    const word = list[at] ?? '';
    if (PUSH_VALUE_FLAGS.has(word)) {
      at += 1;
      continue;
    }
    if (/^--force-(?:with-lease|if-includes)\b/.test(word)) {
      if (force !== 'force') force = 'lease';
    } else if (word === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(word)) force = 'force';
    else if (!word.startsWith('-')) {
      if (!remoteNamed) {
        remoteNamed = true;
        continue;
      }
      if (word.startsWith('+')) force = 'force';
      targets.push(destination(word));
    }
  }
  return `${force}|${[...new Set(targets)].sort().join(' ')}`;
}

function branchDeleteSubject(rest: string): string {
  const list = words(rest);
  const force = list.some(
    (word) => word === '--force' || (/^-[a-zA-Z]+$/.test(word) && /[Df]/.test(word)),
  );
  const remote = list.some((word) => word === '-r' || word === '--remotes');
  const names = list.filter((word) => !word.startsWith('-')).sort();
  return `${force ? 'force' : 'safe'}|${remote ? 'remote|' : ''}${names.join(' ')}`;
}

function worktreeRemoveSubject(rest: string): string {
  const list = words(rest).slice(1);
  const force = list.some((word) => word === '--force' || word === '-f');
  return `${force ? 'force' : 'safe'}|${list.filter((word) => !word.startsWith('-')).join(' ')}`;
}

function resetSubject(rest: string): string {
  return words(rest).find((word) => !word.startsWith('-')) ?? 'HEAD';
}

/** Предмет шага Bash для действия `op`; шага нет — весь текст (поведение как раньше). */
function bashSubject(command: string, op: string): string {
  for (const raw of commandSteps(command)) {
    const step = bare(raw);
    const git = gitVerb(step);
    if (!git) continue;
    if (op === 'push' && git.verb === 'push') return pushSubject(git.rest);
    if (op === 'branch-delete' && git.verb === 'branch') return branchDeleteSubject(git.rest);
    if (op === 'worktree-remove' && git.verb === 'worktree') return worktreeRemoveSubject(git.rest);
    if (op === 'reset-hard' && git.verb === 'reset') return resetSubject(git.rest);
  }
  return command;
}

/**
 * Догон слиянием (`merge`, `pull` без `--rebase`) или перезаписью ветки (`rebase`,
 * `pull --rebase`, `checkout -B`, `switch -C`). Продолжение начатого — не догон.
 */
function syncSubject(command: string): string {
  for (const raw of commandSteps(command)) {
    const git = gitVerb(bare(raw));
    if (!git || /--(?:continue|abort|skip|quit)\b/.test(git.rest)) continue;
    const rest = ` ${git.rest} `;
    if (git.verb === 'merge' || (git.verb === 'pull' && !/\s(?:--rebase\S*|-r)\s/.test(rest)))
      return 'sync:merge';
    if (
      git.verb === 'rebase' ||
      git.verb === 'pull' ||
      (git.verb === 'checkout' && /\s-B\s/.test(rest)) ||
      (git.verb === 'switch' && /\s-C\s/.test(rest))
    )
      return 'sync:rebase';
  }
  return 'sync';
}

/**
 * Предмет действия: у догона целевой ветки — само действие (запрещён догон, не его
 * запись) и его способ, у MR — путь (инструмент MCP или CLI форжа), у прочих — цель и сила.
 */
export function opSubject(name: string, input: Record<string, unknown>, op: string): string {
  if (op === 'sync') return name === 'Bash' ? syncSubject(str(input.command) ?? '') : 'sync';
  // MR признан `protectedOp`: инструмент MCP — по имени, CLI форжа — шагом Bash.
  if (op === 'mr') return name === 'Bash' ? 'cli' : `mcp:${name}`;
  return name === 'Bash' ? bashSubject(str(input.command) ?? '', op) : name;
}

/**
 * Пуш назвал свой чекаут глобальным ключом git (`-C путь`, `--git-dir`, `--work-tree`).
 * Страж отправки отбивает пуш, чей каталог не проследить (`cd X; git push`), и просит
 * `git -C X push`; такой повтор — исправление, а не обход (g8 26.10: R25 «тревога» через
 * минуту после отказа на ровно запрошенный повтор).
 */
export function namesCheckout(command: string): boolean {
  for (const raw of commandSteps(command)) {
    const step = bare(raw);
    const git = gitVerb(step);
    if (git?.verb !== 'push') continue;
    const globals = step.slice(0, step.length - git.rest.length);
    return /\s(?:-C\s|--git-dir|--work-tree)/.test(globals);
  }
  return false;
}

/** Сила действия по возрастанию: понижение — исправление, повышение — нажим. */
const FORCE_RANK: Record<string, number> = { none: 0, safe: 0, lease: 1, force: 2 };

/** `сила|цель` пуша, удаления ветки и копии; иное (текст команды без шага git) — `undefined`. */
function forceAndTarget(subject: string): { rank: number; target: string } | undefined {
  const at = subject.indexOf('|');
  const rank = at > 0 ? FORCE_RANK[subject.slice(0, at)] : undefined;
  return rank === undefined ? undefined : { rank, target: subject.slice(at + 1) };
}

/**
 * Повтор после отказа — обход? MR — если пошёл другим путём (тот же путь с новым входом —
 * исправленный повтор: страж отбил описание, его и поправили). Пуш, удаление ветки и
 * копии (RF-BGCD-10): исправление — другая цель или сила НИЖЕ (`--force` → аренда →
 * без силы, `-D` → `-d`); та же цель с той же или большей силой (`+main`, `-f` после
 * отказа) — нажим, то есть обход. Прочие — тот же предмет.
 */
export function bypassesDenial(
  denied: { op: string; subject: string },
  retry: { op: string; subject: string },
): boolean {
  if (denied.op !== retry.op) return false;
  if (retry.op === 'mr') return denied.subject !== retry.subject;
  // git-guard отбивает слияние всегда, а путь конфликта — rebase, который судит брокер
  // (g0 26.10: `git merge origin/main` отбит, rebase с конфликтами — R25 «тревога»).
  if (retry.op === 'sync')
    return !(denied.subject === 'sync:merge' && retry.subject === 'sync:rebase');
  const was = forceAndTarget(denied.subject);
  const now = forceAndTarget(retry.subject);
  if (was && now) return was.target === now.target && now.rank >= was.rank;
  return denied.subject === retry.subject;
}
