import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  CheckEntry,
  CheckKey,
  CheckRegistry,
  KeyParts,
  TreeRow,
} from '@agentdeck/contracts/core/records';
import { canonical, sha256 } from './canonical.ts';
import type { KeyContext, KeyOf } from './key.types.ts';

/** Путь внутри репозитория через `/` (форма `TreeRow.path`). */
type RepoPath = string;

/**
 * Ключ проверки (04:10, D§3.3) — по СОДЕРЖИМОМУ того, что единица читает:
 * `H(версия, id проверки, отпечаток записи реестра, единица, выборка, замыкание, обвязка,
 * [замыкание на базе], входы вне git, инструменты, окружение)`. Отпечаток — строки
 * `(режим, blob, путь)`: смена exec-бита — новый ключ (R:S2-32d). Ни sha коммита, ни счёта правок,
 * ни пути копии: копии одного репозитория делят записи.
 */

/** Новая версия формулы — только промахи, никогда чужое попадание (D§6). */
export const KEY_VERSION = 1;

/**
 * Скрытые lock-файлы установленных зависимостей и `.env*` — у корня и у каталога единицы (L2):
 * поставленные пакеты меняют исход, не меняя ни одного файла под git.
 */
const DEFAULT_INPUTS: readonly string[] = [
  '.env*',
  'node_modules/.modules.yaml',
  'node_modules/.package-lock.json',
  'node_modules/.yarn-state.yml',
];

/** Путь реестра покрывает путь дерева: `dir/` — каталог, иначе файл или каталог, `''` — всё. */
export function covers(prefix: RepoPath, path: RepoPath): boolean {
  if (prefix === '') return true;
  if (prefix.endsWith('/')) return path.startsWith(prefix);
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Отпечаток части дерева: строки, которые покрывает хоть один путь; режим — в строке. */
export function fingerprint(rows: readonly TreeRow[], prefixes: readonly RepoPath[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    if (prefixes.some((p) => covers(p, row.path)))
      lines.push(`${row.mode} ${row.blob}\t${row.path}`);
  }
  lines.sort();
  return sha256(lines.join('\n'));
}

/**
 * Замыкание единицы: свои пути и пути всех единиц, что она потребляет (shared-ui входит в
 * замыкание каждого потребителя — мутант M3, D§4). Единица `.` — весь репозиторий.
 */
export function closureOf(registry: CheckRegistry, unit: string): RepoPath[] {
  if (unit === '.') return [''];
  const out = new Set<RepoPath>();
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const def = registry.units[name];
    if (!def) throw new Error(`unit ${name} not in the registry`);
    for (const path of def.paths) out.add(path);
    for (const consumed of def.consumes) visit(consumed);
  };
  visit(unit);
  return [...out].sort();
}

export function defHash(entry: CheckEntry): string {
  return sha256(canonical(entry));
}

export function registryFp(registry: CheckRegistry): string {
  return sha256(canonical(registry));
}

export function keyFromParts(parts: KeyParts): CheckKey {
  return sha256(canonical(parts));
}

/** Каталоги, где ищутся входы по умолчанию: корень и каталоги своих путей единицы. */
export function inputPatterns(entry: CheckEntry, registry: CheckRegistry, unit: string): string[] {
  const dirs = new Set<string>(['']);
  const own = unit === '.' ? [] : (registry.units[unit]?.paths ?? []);
  for (const path of own) {
    const last = path.replace(/\/$/, '').split('/').pop() ?? '';
    if (path !== '' && (path.endsWith('/') || !last.includes('.')))
      dirs.add(path.replace(/\/$/, ''));
  }
  const patterns = new Set<string>(entry.inputs);
  for (const dir of dirs) for (const p of DEFAULT_INPUTS) patterns.add(dir ? `${dir}/${p}` : p);
  return [...patterns].sort();
}

/**
 * Имена `envAllow` (маска `*` — хвост имени) без учёта регистра на любой ОС: лишнее совпадение
 * даёт только промах, а потерянное (Windows `Path`/`PATH`) — чужое попадание.
 */
function envPart(
  allow: readonly string[],
  env: KeyContext['env'],
  digest: KeyContext['envDigest'],
): Record<string, string> {
  const res = allow.map(
    (name) =>
      new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i'),
  );
  // Имя — в верхнем регистре: `Path` одного процесса и `PATH` другого — одна переменная Windows;
  // две разные переменные POSIX, совпавшие без регистра, обе остаются в значении.
  const found = new Map<string, string[]>();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !res.some((re) => re.test(name))) continue;
    const upper = name.toUpperCase();
    found.set(upper, [...(found.get(upper) ?? []), digest(value)]);
  }
  const out: Record<string, string> = {};
  for (const [name, digests] of found) out[name] = digests.sort().join(',');
  return out;
}

/**
 * Ключ единицы. Чего-то не прочитали (дерево, база, входы) или единицы нет в реестре — `unknown`:
 * ключа без входа нет, решение тогда — прогон (04:55), никогда повтор старого исхода.
 */
export function keyOf(entry: CheckEntry, unit: string, ctx: KeyContext): Fact<KeyOf> {
  const need = <T>(name: string, fact: Fact<T>): T => {
    if ('value' in fact) return fact.value;
    throw new Error(`${name} ${'absent' in fact ? 'absent' : fact.unknown}`);
  };
  try {
    const rows = need('tree', ctx.rows);
    const closure = closureOf(ctx.registry, unit);
    // Путь реестра, не покрывший ни одной строки дерева (регистр `Apps/` против `apps/`, каталог
    // переименован), даёт отпечаток пустоты: правка единицы ключ не сдвинет — повтор чужого исхода.
    const dead = closure.find((p) => !rows.some((row) => covers(p, row.path)));
    if (dead !== undefined) throw new Error(`unit path ${dead || '.'} covers no tracked file`);
    const machinery = [...ctx.registry.machinery].sort();
    let base: string | null = null;
    if (entry.baseDependent) {
      if (ctx.baseRows === null) throw new Error('base tree not given for a base-dependent check');
      base = fingerprint(need('base tree', ctx.baseRows), [...closure, ...machinery]);
    }
    const parts: KeyParts = {
      v: KEY_VERSION,
      checkId: entry.id,
      entryHash: defHash(entry),
      unit,
      selection: [...ctx.selection].sort(),
      closure: fingerprint(rows, closure),
      machinery: fingerprint(rows, machinery),
      base,
      inputs: sha256(canonical(need('inputs', ctx.inputs))),
      tools: { ...ctx.tools },
      env: envPart(entry.envAllow, ctx.env, ctx.envDigest),
    };
    return { value: { key: keyFromParts(parts), parts } };
  } catch (error) {
    return { unknown: `key: ${(error as Error).message}` };
  }
}

/**
 * Ключ «запрошено, но в реестре нет» (G3): id проверки + отпечаток реестра — появившаяся позже
 * запись реестра меняет ключ, и старый `fail{absent}` больше не отвечает.
 */
export function absentKeyOf(checkId: string, registry: CheckRegistry): KeyOf {
  const empty = sha256('');
  const parts: KeyParts = {
    v: KEY_VERSION,
    checkId,
    entryHash: registryFp(registry),
    unit: '',
    selection: [],
    closure: empty,
    machinery: empty,
    base: null,
    inputs: empty,
    tools: {},
    env: {},
  };
  return { key: keyFromParts(parts), parts };
}

/** Имена частей, которыми два ключа расходятся («почему промах»), без значений. */
export function diffParts(a: KeyParts | null, b: KeyParts | null): string[] {
  if (!a || !b) return ['all'];
  const out: string[] = [];
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort() as (keyof KeyParts)[];
  for (const name of names) {
    if (canonical(a[name]) === canonical(b[name])) continue;
    if (name === 'env' || name === 'tools') {
      const left = a[name] as Record<string, string>;
      const right = b[name] as Record<string, string>;
      for (const sub of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort())
        if (left[sub] !== right[sub]) out.push(`${name}.${sub}`);
    } else out.push(name);
  }
  return out;
}
