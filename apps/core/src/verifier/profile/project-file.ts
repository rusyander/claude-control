import { z } from 'zod';
import type { CheckEntry, CheckRegistry } from '@agentdeck/contracts/core/records';
import { isShellInvocation } from './ci.ts';
import { resolveRel } from './view.ts';

/**
 * `<repo>/.agentdeck/checks.json` — уровень 4, только сужение (04:9, 06:4-7, G23). Файл может
 * добавить проверку, добавить стадию `requiredAt`, расширить вход ключа (inputs, envAllow, tools,
 * обвязку, замыкание единицы) и сделать проверку зависимой от базы. Уронить проверку, снять
 * стадию, сменить команду, класс, каталог или единицу найденной проверки, сделать её независимой
 * от базы — расширение: значение отклоняется и называется (`registry.rejected`), остальное файла
 * применяется. Файл не по схеме (strict, P45) не читается частично: половина файла судила бы
 * половину проверок по чужим правилам — отклонён целиком, найденный реестр как был.
 */

export const PROJECT_FILE = '.agentdeck/checks.json';

/**
 * Путь внутри репозитория: не от корня диска (`/x`, `\x`, `C:`), не шара (`\\h\s`), не дом (`~`),
 * без `..` вовсе — то же правило, что у каталога команды CI (`resolveRel`).
 */
const repoPath = z
  .string()
  .refine(
    (p) =>
      p === '' || (resolveRel('', p) !== null && !p.replace(/\\/g, '/').split('/').includes('..')),
    {
      message: 'path must stay inside the repo',
    },
  );

const CLASS = z.enum([
  'static',
  'test-runner',
  'build',
  'live',
  'report-writing',
  'contract',
  'migration',
]);
const STAGE = z.enum(['stop', 'publish', 'deliver']);
const FILTER_KIND = z.enum([
  'vitest',
  'jest',
  'pytest',
  'go',
  'playwright',
  'gradle',
  'maven',
  'dotnet',
  'cargo',
]);

const checkSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[\w.@:/-]+$/)
    .refine((id) => !id.startsWith('/') && !id.split('/').includes('..'), {
      message: 'a check id is a name, not a path out of the repo',
    }),
  class: CLASS.optional(),
  argv: z.array(z.string().min(1)).min(1).optional(),
  cwd: repoPath.optional(),
  unit: z.enum(['package', 'project', 'file-set']).optional(),
  requiredAt: z.array(STAGE).optional(),
  baseDependent: z.boolean().optional(),
  filter: z
    .strictObject({
      kind: FILTER_KIND,
      argv: z.array(z.string()).min(1),
      filesFrom: z.literal('unit').optional(),
    })
    .optional(),
  inputs: z.array(repoPath).optional(),
  envAllow: z.array(z.string().regex(/^[A-Za-z_]\w*\*?$/)).optional(),
  tools: z.array(z.string()).optional(),
  artifacts: z.array(repoPath).optional(),
  needs: z.array(z.strictObject({ service: z.string() })).optional(),
  stand: z.strictObject({ health: z.string(), perUnit: z.boolean() }).optional(),
});

export const projectFileSchema = z.strictObject({
  v: z.literal(1),
  checks: z.array(checkSchema).optional(),
  units: z
    .record(
      z.string(),
      z.strictObject({
        paths: z.array(repoPath).optional(),
        consumes: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  machinery: z.array(repoPath).optional(),
  /** Принимается схемой ради того, чтобы назвать отказ, а не уронить весь файл. */
  drop: z.array(z.string()).optional(),
});

type FileCheck = z.infer<typeof checkSchema>;
type Rejected = CheckRegistry['rejected'][number];

const WIDENING = 'widening: a repo file may only narrow (06:5-7)';

function union<T>(
  a: readonly T[],
  b: readonly T[] | undefined,
  key: (x: T) => string = String,
): T[] {
  const out = [...a];
  for (const x of b ?? []) if (!out.some((y) => key(y) === key(x))) out.push(x);
  return out;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function newEntry(c: FileCheck, rejected: Rejected[]): CheckEntry | null {
  const at = (f: string): string => `checks.${c.id}.${f}`;
  if (!c.class || !c.argv) {
    rejected.push({
      path: PROJECT_FILE,
      field: at(c.class ? 'argv' : 'class'),
      why: 'a new check needs class and argv',
    });
    return null;
  }
  if ((c.argv.length === 1 && /\s/.test(c.argv[0] as string)) || isShellInvocation(c.argv)) {
    // P25: никогда строка оболочки — argv массивом; `sh -c "…"` — та же строка в обёртке.
    rejected.push({
      path: PROJECT_FILE,
      field: at('argv'),
      why: 'a shell string: give argv as an array',
    });
    return null;
  }
  return {
    id: c.id,
    class: c.class,
    argv: c.argv,
    cwd: c.cwd ?? '',
    unit: c.unit ?? 'project',
    requiredAt: c.requiredAt ?? [],
    baseDependent: c.baseDependent ?? false,
    ...(c.filter ? { filter: c.filter } : {}),
    inputs: c.inputs ?? [],
    envAllow: c.envAllow ?? [],
    tools: c.tools ?? [],
    artifacts: c.artifacts ?? [],
    needs: c.needs ?? [],
    ...(c.stand ? { stand: c.stand } : {}),
    source: 'project-file',
  };
}

function narrowEntry(base: CheckEntry, c: FileCheck, rejected: Rejected[]): CheckEntry {
  const at = (f: string): string => `checks.${c.id}.${f}`;
  for (const f of ['class', 'argv', 'cwd', 'unit', 'filter'] as const) {
    if (c[f] !== undefined && !same(c[f], base[f]))
      rejected.push({
        path: PROJECT_FILE,
        field: at(f),
        why: `${WIDENING}; changes how a detected check runs — add a new check id instead`,
      });
  }
  const dropped = base.requiredAt.filter(
    (s) => c.requiredAt !== undefined && !c.requiredAt.includes(s),
  );
  if (dropped.length > 0)
    rejected.push({
      path: PROJECT_FILE,
      field: at('requiredAt'),
      why: `${WIDENING}; drops required stage ${dropped.join(', ')}`,
    });
  if (c.baseDependent === false && base.baseDependent)
    rejected.push({
      path: PROJECT_FILE,
      field: at('baseDependent'),
      why: `${WIDENING}; base side leaves the key`,
    });
  if (c.stand !== undefined && base.stand !== undefined && !same(c.stand, base.stand))
    rejected.push({
      path: PROJECT_FILE,
      field: at('stand'),
      why: `${WIDENING}; changes the stand of a detected check`,
    });
  const next: CheckEntry = {
    ...base,
    requiredAt: union(base.requiredAt, c.requiredAt),
    baseDependent: base.baseDependent || c.baseDependent === true,
    inputs: union(base.inputs, c.inputs),
    envAllow: union(base.envAllow, c.envAllow),
    tools: union(base.tools, c.tools),
    artifacts: union(base.artifacts, c.artifacts),
    needs: union(base.needs, c.needs, (n) => n.service),
    ...(base.stand === undefined && c.stand ? { stand: c.stand } : {}),
  };
  return same(next, base) ? base : { ...next, source: 'project-file' };
}

/** Найденный реестр + файл проекта (текст или `undefined` — файла нет) → реестр после сужения. */
export function applyProjectFile(detected: CheckRegistry, text: string | undefined): CheckRegistry {
  if (text === undefined) return detected;
  const rejected: Rejected[] = [...detected.rejected];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    rejected.push({
      path: PROJECT_FILE,
      field: '(json)',
      why: `not JSON: ${(error as Error).message}`,
    });
    return { ...detected, rejected };
  }
  const parsed = projectFileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 8))
      rejected.push({
        path: PROJECT_FILE,
        field: issue.path.join('.') || '(root)',
        why: `schema: ${issue.message}; whole file ignored`,
      });
    return { ...detected, rejected };
  }
  const file = parsed.data;
  const checks = [...detected.checks];
  for (const c of file.checks ?? []) {
    const i = checks.findIndex((e) => e.id === c.id);
    if (i >= 0) checks[i] = narrowEntry(checks[i] as CheckEntry, c, rejected);
    else {
      const added = newEntry(c, rejected);
      if (added) checks.push(added);
    }
  }
  for (const id of file.drop ?? [])
    rejected.push({
      path: PROJECT_FILE,
      field: `drop.${id}`,
      why: `${WIDENING}; dropping a check`,
    });
  const units = { ...detected.units };
  for (const [name, u] of Object.entries(file.units ?? {})) {
    const base = units[name] ?? { paths: [], consumes: [] };
    units[name] = { paths: union(base.paths, u.paths), consumes: union(base.consumes, u.consumes) };
  }
  // Ссылка на несуществующую единицу снимается: замыкание по ней не построить.
  for (const [name, u] of Object.entries(units)) {
    const missing = u.consumes.filter((c) => !units[c]);
    for (const c of missing)
      rejected.push({ path: PROJECT_FILE, field: `units.${name}.consumes`, why: `no unit ${c}` });
    if (missing.length > 0) units[name] = { ...u, consumes: u.consumes.filter((c) => units[c]) };
  }
  return {
    units,
    machinery: union(detected.machinery, file.machinery),
    checks,
    rejected,
  };
}
