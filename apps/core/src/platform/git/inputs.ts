import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { readFact } from '../../lib/facts/read-fact.ts';

/**
 * Входы проверки вне git (D§3.2 `inputs`, D§3.3): `.env*`, скрытые lock-файлы установленных
 * зависимостей, объявленные записью файлы. Отсутствие — тоже значение (`absent`): появившийся
 * `.env.local` меняет ключ. Нечитаемый вход — исключение, ключ `unknown` и прогон (04:55): ключ
 * без входа, который не прочитался, совпал бы со старым и повторил чужой исход.
 */

/** Каталог больше — его отпечаток не считается целиком; без молчаливой половины. */
const DIR_CAP = 2_000;
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

const sha = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

const isDir = (abs: string): boolean =>
  statSync(abs, { throwIfNoEntry: false })?.isDirectory() === true;

const segmentRe = (seg: string): RegExp =>
  new RegExp(`^${seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

/**
 * Шаблон с маской в любом звене (A1-F03): `*` — часть одного имени, `**` — ноль и больше
 * каталогов. Раньше маска понималась только в последнем звене: `cfg/**\/*.json` и `svc-*\/x.env`
 * не давали ни одной строки, правка там не двигала ключ, и решение повторяло старый зелёный.
 * Под маской в ключ идут только найденные пути: появившийся файл — новая строка. Больше
 * `DIR_CAP` — исключение (ключ `unknown` → прогон), никогда молчаливая половина.
 */
function expand(top: string, pattern: string): string[] {
  if (!pattern.includes('*')) return [pattern];
  const segs = pattern.split('/').filter((s) => s !== '' && s !== '.');
  const out = new Set<string>();
  let dirs = 0;
  const child = (rel: string, name: string): string => (rel ? `${rel}/${name}` : name);
  const walk = (rel: string, i: number): void => {
    if (out.size > DIR_CAP || (dirs += 1) > DIR_CAP * 10)
      throw new Error(`input pattern over ${DIR_CAP} matches: ${pattern}`);
    const seg = segs[i] as string;
    const last = i === segs.length - 1;
    const abs = rel ? join(top, rel) : top;
    if (seg === '**') {
      if (last) throw new Error(`input pattern ends in **: ${pattern}`);
      walk(rel, i + 1);
      if (!isDir(abs)) return;
      for (const entry of readdirSync(abs, { withFileTypes: true }))
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) walk(child(rel, entry.name), i);
      return;
    }
    const names = seg.includes('*')
      ? isDir(abs)
        ? readdirSync(abs).filter((n) => segmentRe(seg).test(n))
        : []
      : [seg];
    for (const name of names) {
      const next = child(rel, name);
      if (last) {
        if (statSync(join(top, next), { throwIfNoEntry: false })) out.add(next);
      } else if (isDir(join(top, next))) walk(next, i + 1);
    }
  };
  walk('', 0);
  return [...out].sort();
}

/**
 * Отпечаток каталога-входа. Ссылка внутри (A1-F09) читается насквозь: проверка прочтёт то, на что
 * она указывает, — правка за ссылкой двигает ключ. Висячая ссылка — значение `dangling`, а не
 * пропуск; петля ссылок обходится один раз (предки по настоящему пути).
 */
function dirDigest(abs: string): string {
  const rows: string[] = [];
  const push = (row: string): void => {
    rows.push(row);
    if (rows.length > DIR_CAP) throw new Error(`input dir over ${DIR_CAP} files: ${abs}`);
  };
  const walk = (dir: string, rel: string, ancestors: ReadonlySet<string>): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      let kind: 'dir' | 'file' | 'other' = entry.isDirectory()
        ? 'dir'
        : entry.isFile()
          ? 'file'
          : 'other';
      if (entry.isSymbolicLink()) {
        const target = statSync(full, { throwIfNoEntry: false });
        if (!target) {
          push(`${path}:dangling`);
          continue;
        }
        kind = target.isDirectory() ? 'dir' : target.isFile() ? 'file' : 'other';
      }
      if (kind === 'file') push(`${path}:${sha(readFileSync(full))}`);
      else if (kind === 'dir') {
        const real = realpathSync(full);
        if (ancestors.has(real)) push(`${path}:loop`);
        else walk(full, path, new Set([...ancestors, real]));
      }
    }
  };
  walk(abs, '', new Set([realpathSync(abs)]));
  return `dir:${sha(rows.join('\n'))}`;
}

/** `путь → sha256 | dir:<sha> | absent` для каждого шаблона; пути от корня копии через `/`. */
export function inputDigests(
  top: string,
  patterns: readonly string[],
): Promise<Fact<Record<string, string>>> {
  return readFact('git.tree', () => {
    const out: Record<string, string> = {};
    for (const pattern of [...new Set(patterns)].sort()) {
      const files = expand(top, pattern);
      if (files.length === 0 && !pattern.includes('*')) out[pattern] = 'absent';
      for (const rel of files) {
        const abs = join(top, rel);
        const stats = statSync(abs, { throwIfNoEntry: false });
        if (!stats) out[rel] = 'absent';
        else out[rel] = stats.isDirectory() ? dirDigest(abs) : sha(readFileSync(abs));
      }
    }
    return out;
  });
}
