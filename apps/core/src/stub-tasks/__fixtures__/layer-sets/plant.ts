import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Наборы слоя человека для P36 (G10: три синтетических, набор владельца — этап 11): каталог набора
 * сажается в каталог конфига CLI одноразового стенда — никогда не в настоящий `~/.claude*`.
 * Набор — обычный каталог в раскладке каталога конфига Claude, поэтому годится любой каталог,
 * в том числе настоящий набор человека; отличия от раскладки:
 * - `instructions.md` → `CLAUDE.md` (файл инструкций не лежит в дереве репозитория под своим именем);
 * - `settings.json`: `{{NODE}}`, `{{HOOKS}}` (каталог `_hooks`), `{{MARKERS}}` (каталог отметок
 *   стенда) подставляются; уже лежащие настройки стенда сохраняются, хуки набора дописываются;
 * - `bulk.json` `{rules, lines}` — объём: столько файлов правил по столько строк (набор «большой»,
 *   а в репозитории не раздувается); `.keep` пропускается.
 */

export const LAYER_SETS = ['none', 'synthetic-large', 'hostile'] as const;
export type LayerSetName = (typeof LAYER_SETS)[number];

const HERE = dirname(fileURLToPath(import.meta.url));
export const HOOKS_DIR = join(HERE, '_hooks');

export const layerSetDir = (name: LayerSetName): string => join(HERE, name);

const slashes = (p: string): string => p.replace(/\\/g, '/');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const BULK_LINE = (rule: number, line: number): string =>
  `- Rule ${rule}.${line}: keep the change small, named and covered by a test that can go red.`;

function mergeSettings(target: string, planted: Record<string, unknown>): void {
  const before = existsSync(target)
    ? (JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>)
    : {};
  const hooks = { ...((before.hooks as Record<string, unknown[]>) ?? {}) };
  for (const [event, groups] of Object.entries((planted.hooks as Record<string, unknown[]>) ?? {}))
    hooks[event] = [...(hooks[event] ?? []), ...groups];
  writeFileSync(target, `${JSON.stringify({ ...before, ...planted, hooks }, null, 2)}\n`);
}

/** Сажает набор в `configDir`; отдаёт посаженные пути (относительно `configDir`). */
export function plantLayerSet(setDir: string, configDir: string, markersDir: string): string[] {
  mkdirSync(configDir, { recursive: true });
  mkdirSync(markersDir, { recursive: true });
  const planted: string[] = [];
  for (const file of walk(setDir)) {
    const rel = relative(setDir, file);
    const name = slashes(rel);
    if (name === '.keep' || name.endsWith('/.keep')) continue;
    if (name === 'bulk.json') {
      const bulk = JSON.parse(readFileSync(file, 'utf8')) as { rules: number; lines: number };
      for (let r = 1; r <= bulk.rules; r += 1) {
        const out = join(configDir, 'rules', `bulk-${String(r).padStart(2, '0')}.md`);
        mkdirSync(dirname(out), { recursive: true });
        const body = Array.from({ length: bulk.lines }, (_, l) => BULK_LINE(r, l + 1));
        writeFileSync(out, `# Bulk rule ${r}\n\n${body.join('\n')}\n`);
        planted.push(slashes(relative(configDir, out)));
      }
      continue;
    }
    const target = join(configDir, name === 'instructions.md' ? 'CLAUDE.md' : rel);
    mkdirSync(dirname(target), { recursive: true });
    if (name === 'settings.json') {
      const text = readFileSync(file, 'utf8')
        .replaceAll('{{NODE}}', slashes(process.execPath))
        .replaceAll('{{HOOKS}}', slashes(HOOKS_DIR))
        .replaceAll('{{MARKERS}}', slashes(markersDir));
      mergeSettings(target, JSON.parse(text) as Record<string, unknown>);
    } else copyFileSync(file, target);
    planted.push(slashes(relative(configDir, target)));
  }
  return planted.sort();
}

/** Отметки хуков набора: имя хука → сколько раз сработал (по файлам отметок). */
export function markersOf(markersDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!existsSync(markersDir)) return out;
  for (const name of readdirSync(markersDir)) {
    const hook = name.replace(/-\d+-\d+\.json$/, '');
    out[hook] = (out[hook] ?? 0) + 1;
  }
  return out;
}
