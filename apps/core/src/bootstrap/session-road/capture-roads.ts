import { CAPTURE_TOOLS } from '../../mcp/capture-wrap.ts';
import type { CaptureWrapperOutcome } from './hook-file.ts';

/**
 * Какие дороги захвата у сессии есть, а каких нет (03:112-126, P99): незахваченная дорога
 * названа в журнале сигналом `capture-roads`, а не изображена захваченной. Проверка по
 * незахваченной дороге идёт мимо очереди и повтора — это видно в журнале шага.
 */

/** Дороги, которые захват не видит по устройству, — на всех ОС. */
export const UNCAPTURED_ROADS: readonly string[] = [
  'bun/deno: own runtime, NODE_OPTIONS not read',
  'uv run / poetry run / venv python -m pytest: python itself is not wrapped, only pytest on PATH',
  'a command that resets or replaces NODE_OPTIONS',
  'Windows CreateProcess without a shell: PATHEXT not applied, the command wrapper is not found',
  'a check runner started by another path than its package script (node -e, tsx, a bundled copy)',
];

export function captureRoadsDetail(capture: CaptureWrapperOutcome): string {
  const absent = CAPTURE_TOOLS.map((t) => t.tool).filter(
    (tool) => !capture.tools.includes(tool) && !capture.failed.some((f) => f.tool === tool),
  );
  const parts = [
    'captured: node-preload (vitest, jest, tsc, eslint, prettier, playwright)',
    `path-wrapper: ${capture.tools.length > 0 ? capture.tools.join(', ') : 'none on PATH'}`,
    ...capture.failed.map((f) => `NOT captured: ${f.tool} wrapper not installed (${f.reason})`),
    ...(absent.length > 0 ? [`not on PATH (no wrapper): ${absent.join(', ')}`] : []),
    ...UNCAPTURED_ROADS.map((road) => `not captured: ${road}`),
  ];
  return parts.join('; ');
}

/** Сигнал `capture-roads`: обёртка, что не встала у найденного инструмента, — `warn`, не `info`. */
export function captureRoadsSignal(capture: CaptureWrapperOutcome): {
  severity: 'info' | 'warn';
  detail: string;
} {
  return {
    severity: capture.failed.length > 0 ? 'warn' : 'info',
    detail: captureRoadsDetail(capture),
  };
}

/** Движки для поиска контейнеров: `docker-compose` (v1) ставит метку проекта, ищется через `docker`. */
export function scanEngines(engines: readonly string[]): string[] {
  const out = engines.filter((e) => e !== 'docker-compose');
  if (engines.includes('docker-compose') && !out.includes('docker')) out.push('docker');
  return out;
}
