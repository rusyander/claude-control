import type { RepoView, RepoViewFile } from '../../platform/repo-view.types.ts';

/** Чтение уже снятого вида репозитория — чистые функции, без диска (обнаружение тестируется на фикстурах). */

export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function dirName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Путь внутри корня `root` ('' — корень репозитория). */
export function joinRel(root: string, name: string): string {
  return root === '' ? name : `${root}/${name}`;
}

/**
 * Каталог `rel` от каталога `base` внутри репозитория; `null` — путь уходит из него (выше корня,
 * от корня диска или шары, в дом) или зависит от окружения (`$X`, `%X%`). Разделитель `\`
 * читается как `/`: `cd ..\..` на раннере Windows — тот же выход.
 */
export function resolveRel(base: string, rel: string): string | null {
  const p = rel.replace(/\\/g, '/');
  if (p === '' || p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p)) return null;
  if (/[$%`]/.test(p)) return null;
  const out = base === '' ? [] : base.split('/');
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

export class ViewIndex {
  readonly view: RepoView;
  private readonly byPath = new Map<string, RepoViewFile>();
  private readonly dirSet: Set<string>;

  constructor(view: RepoView) {
    this.view = view;
    for (const f of view.files) this.byPath.set(f.path, f);
    this.dirSet = new Set(view.dirs);
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  hasDir(path: string): boolean {
    return this.dirSet.has(path);
  }

  text(path: string): string | undefined {
    return this.byPath.get(path)?.text ?? undefined;
  }

  json(path: string): Record<string, unknown> | undefined {
    const text = this.text(path);
    if (text === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      // Битый манифест — не стек: сам проект скажет, что с ним не так, профиль не гадает.
      return undefined;
    }
  }

  /** Файлы с этим именем на любой глубине, по порядку пути. */
  named(name: string): RepoViewFile[] {
    return this.view.files.filter((f) => baseName(f.path) === name);
  }

  matching(test: (path: string) => boolean): RepoViewFile[] {
    return this.view.files.filter((f) => test(f.path));
  }

  /** Файлы прямо в каталоге `dir`. */
  inDir(dir: string): RepoViewFile[] {
    return this.view.files.filter((f) => dirName(f.path) === dir);
  }
}
