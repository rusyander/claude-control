import type { Word } from './shell-parse.ts';
import { canonical, real, within } from './paths.ts';

export interface GroupCommandScope {
  /** Копия группы — каталог прогона; `undefined` — неизвестна. */
  worktree?: string;
  /** Ветка, на которой стоит копия по git, если она не основная. */
  branch?: string;
  /** Ветка по умолчанию у `origin` (`origin/HEAD`) — защищена, как `main`. */
  base?: string;
}

export type SegmentVerdict =
  | { kind: 'routine'; writes?: boolean; lease?: boolean; deletes?: boolean }
  | { kind: 'danger' }
  | { kind: 'other' };

export const ROUTINE: SegmentVerdict = { kind: 'routine' };
export const OTHER: SegmentVerdict = { kind: 'other' };
export const DANGER: SegmentVerdict = { kind: 'danger' };

/**
 * Основные и защищённые ветки: пуш в них — человеку при любых строках. Какие
 * ветки защищены на форже, панель не знает — берём общепринятые имена и ветку
 * по умолчанию у `origin`.
 */
const PROTECTED =
  /^(main|master|develop|development|dev|trunk|stable|production|prod|staging|release|releases?[/-].+)$/i;

export function isProtectedBranch(name: string, base?: string): boolean {
  return PROTECTED.test(name) || (Boolean(base) && name === base);
}

/** Сменить ветку в этой же команде: `checkout -b x`, `switch x`, `checkout --detach`. */
function checkedOut(args: Word[]): string | undefined | 'unchanged' {
  const texts = args.map((arg) => (arg.dynamic ? '\0' : arg.text));
  if (texts.includes('--')) return 'unchanged';
  const create = texts.findIndex((text) => /^-(b|B|c|C)$|^--orphan$|^--create$/.test(text));
  if (create >= 0) {
    const name = texts[create + 1];
    return name && name !== '\0' && !name.startsWith('-') ? name : undefined;
  }
  if (texts.includes('--detach') || texts.includes('-d')) return undefined;
  const positional = texts.filter((text) => !text.startsWith('-'));
  if (positional.length !== 1) return positional.length === 0 ? 'unchanged' : undefined;
  const name = positional[0] as string;
  // Коммит, `origin/…`, `HEAD~1`, `-` — отсоединённая голова, своей ветки нет.
  if (name === '\0' || name === 'HEAD' || /[~^@:]/.test(name)) return undefined;
  if (name.startsWith('origin/') || /^[0-9a-f]{7,40}$/i.test(name)) return undefined;
  return name;
}

export class Walk {
  /** Каталог звена; `undefined` — ушли туда, куда не проследить. */
  cwd: string | undefined;
  readonly base: string | undefined;
  private readonly roots: string[];
  /** Ветка копии сейчас: сначала — по git, после `checkout` в команде — та, что выбрана. */
  private branch: string | undefined;
  /** В этой же команде уже сменили ветку: аренда дальше — не своей ветки. */
  private switched = false;
  private readonly own: string | undefined;

  constructor(scope: GroupCommandScope) {
    const worktree = scope.worktree;
    this.cwd = worktree ? canonical(worktree) : undefined;
    const roots = worktree ? [canonical(worktree), real(worktree)] : [];
    this.roots = [...new Set(roots.filter((root): root is string => Boolean(root)))];
    this.own = scope.branch;
    this.branch = scope.branch;
    this.base = scope.base;
  }

  inCopy(path: string | undefined): boolean {
    if (!path) return false;
    return this.variants(path).some((variant) => this.roots.some((root) => within(variant, root)));
  }

  isCopyRoot(path: string): boolean {
    return this.variants(path).some((variant) => this.roots.includes(variant));
  }

  /** Корень копии, под которым лежит путь (в том написании, в каком совпал). */
  rootOf(path: string): { path: string; root: string } | undefined {
    for (const variant of this.variants(path)) {
      const root = this.roots.find((entry) => within(variant, entry));
      if (root) return { path: variant, root };
    }
    return undefined;
  }

  private variants(path: string): string[] {
    return [path, real(path)].filter((entry): entry is string => Boolean(entry));
  }

  /** Текущая ветка там, где исполняется звено, — или `undefined`, если не своя копия. */
  branchAt(cwd: string | undefined): string | undefined {
    return this.inCopy(cwd) ? this.branch : undefined;
  }

  /** Своя ветка группы там, где исполняется звено, — если её не сменили в этой команде. */
  ownBranchAt(cwd: string | undefined): string | undefined {
    return this.inCopy(cwd) && !this.switched ? this.own : undefined;
  }

  checkout(args: Word[], cwd: string | undefined): void {
    if (!this.inCopy(cwd)) return;
    const next = checkedOut(args);
    if (next === 'unchanged') return;
    this.switched = true;
    this.branch = next;
  }
}
