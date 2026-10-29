import { z } from 'zod';
import type { Profile } from '@agentdeck/contracts/core/records';

/**
 * Схема файла профиля `<core home>/profiles/<hash>.json` (strict, P45). Файл, не прошедший её, —
 * мусор: `unknown`, не «профиля нет» (P44) — и не перезаписывается молча (в нём правки человека).
 */

const SCHEME = z.enum(['postgres', 'mysql', 'mongodb', 'redis', 'amqp', 'kafka', 'other']);

const entry = z.strictObject({
  id: z.string(),
  class: z.enum([
    'static',
    'test-runner',
    'build',
    'live',
    'report-writing',
    'contract',
    'migration',
  ]),
  argv: z.array(z.string()),
  cwd: z.string(),
  unit: z.enum(['package', 'project', 'file-set']),
  requiredAt: z.array(z.enum(['stop', 'publish', 'deliver'])),
  baseDependent: z.boolean(),
  filter: z
    .strictObject({
      kind: z.enum([
        'vitest',
        'jest',
        'pytest',
        'go',
        'playwright',
        'gradle',
        'maven',
        'dotnet',
        'cargo',
      ]),
      argv: z.array(z.string()),
    })
    .optional(),
  inputs: z.array(z.string()),
  envAllow: z.array(z.string()),
  tools: z.array(z.string()),
  artifacts: z.array(z.string()),
  needs: z.array(z.strictObject({ service: z.string() })),
  stand: z.strictObject({ health: z.string(), perUnit: z.boolean() }).optional(),
  source: z.enum(['platform', 'live-user', 'scenario', 'project-file', 'user-layer', 'detected']),
});

export const profileSchema = z.strictObject({
  v: z.literal(1),
  repoKey: z.string(),
  inputsFp: z.string().regex(/^[0-9a-f]{64}$/),
  stacks: z.array(
    z.strictObject({
      stack: z.enum(['js-ts', 'go', 'python', 'jvm', 'dotnet', 'rust', 'generic']),
      root: z.string(),
      workspace: z.enum(['pnpm', 'yarn', 'npm', 'bun', 'turbo', 'nx']).optional(),
      named: z.string().optional(),
    }),
  ),
  packageManager: z.strictObject({ name: z.string(), version: z.string() }).nullable(),
  runtimes: z.record(z.string(), z.strictObject({ version: z.string(), from: z.string() })),
  pathEntries: z.array(z.string()),
  envNames: z.array(z.string()),
  serviceVars: z.array(
    z.strictObject({
      name: z.string(),
      scheme: SCHEME,
      hostKind: z.enum(['ephemeral', 'local-non-ephemeral', 'remote']),
      source: z.enum(['name', 'scheme']),
    }),
  ),
  serviceRecipes: z.array(
    z.strictObject({
      name: z.string(),
      source: z.enum(['compose', 'testcontainers', 'recipe']),
      image: z.string(),
      ports: z.array(z.number().int()),
      env: z.record(z.string(), z.string()),
      scheme: SCHEME.optional(),
    }),
  ),
  registry: z.strictObject({
    units: z.record(
      z.string(),
      z.strictObject({ paths: z.array(z.string()), consumes: z.array(z.string()) }),
    ),
    machinery: z.array(z.string()),
    checks: z.array(entry),
    rejected: z.array(z.strictObject({ path: z.string(), field: z.string(), why: z.string() })),
  }),
  ciChecks: z.array(z.string()),
  gitHooks: z.array(z.string()),
  userEdits: z.record(z.string(), z.unknown()),
  detectedAt: z.number(),
  notes: z.array(z.strictObject({ subject: z.string(), why: z.string() })),
});

/** Проверка, что схема и контракт не разошлись: лишнее или недостающее поле — ошибка типов. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const PROFILE_SCHEMA_MATCHES_CONTRACT: Same<z.infer<typeof profileSchema>, Profile> = true;
