import type {
  CheckEntry,
  CheckRegistry,
  Profile,
  ServiceRecipe,
  Stack,
} from '@agentdeck/contracts/core/records';
import type { OsKind } from '../../platform/os-kind.ts';

/** Внутренние формы обнаружения профиля (04:45-52, 04:88-103, 04:121-123). */

export type StackRow = Profile['stacks'][number];
export type WorkspaceKind = NonNullable<StackRow['workspace']>;
export type JsPm = 'pnpm' | 'yarn' | 'npm' | 'bun';

/** Обнаруженная проверка до решения о наборе публикации: `role` нужна правилу requiredAt. */
export interface DetectedCheck {
  entry: CheckEntry;
  /** test / static / build / live — без CI набор публикации по умолчанию берёт test и static. */
  role: 'test' | 'static' | 'build' | 'live';
  /** Сигнатура для сопоставления с командой CI (04:48): см. `ci.ts`. */
  match: CiSignature;
}

export type CiSignature =
  | { kind: 'script'; script: string; scope: 'root' | 'packages'; root: string }
  | { kind: 'argv'; words: string[]; root: string };

/** Часть профиля, что знает один стек. */
export interface StackFinding {
  stacks: StackRow[];
  checks: DetectedCheck[];
  units: CheckRegistry['units'];
  machinery: string[];
  pathEntries: string[];
  notes: Profile['notes'];
}

export interface DetectContext {
  os: OsKind;
}

export interface DetectedProfile {
  stacks: StackRow[];
  packageManager: Profile['packageManager'];
  runtimes: Profile['runtimes'];
  pathEntries: string[];
  envNames: string[];
  serviceVars: Profile['serviceVars'];
  serviceRecipes: ServiceRecipe[];
  registry: CheckRegistry;
  ciChecks: string[];
  gitHooks: string[];
  notes: Profile['notes'];
}

export type { Stack };
