import { CAPTURE_SHIM, CAPTURE_WRAP_FLAG } from '../platform/capture-shim.ts';
import type { CaptureTool, CaptureWrapSpec } from './capture-wrap.types.ts';

export type { CaptureTool, CaptureWrapSpec } from './capture-wrap.types.ts';
// Разбор `NODE_OPTIONS` живёт в platform/: его же зовёт лаунчер переходников, которому mcp/ закрыт.
export {
  composeCaptureNodeOptions,
  splitNodeOptions,
  withoutCaptureRequire,
  type NodeOptionWord,
} from '../platform/node-options.ts';

/**
 * Дорога `path-wrapper` захвата проверок (03:119): обёртки PATH сессии над инструментами
 * проверок не на node. Обёртка исполняет прокладку захвата напрямую (`node capture-preload.cjs
 * --agentdeck-capture-wrap <spec>`), а не `run.ts`: каждый `go test` платил бы загрузкой TS ядра.
 * Ядро спрашивается только о подкомандах проверок (`go test`, не `go build` … кроме cargo, где
 * `build` — проверка компиляции); остальное идёт насквозь без вопроса.
 */

export const CAPTURE_TOOLS: readonly CaptureTool[] = [
  { tool: 'go', ask: ['test', 'vet'] },
  { tool: 'cargo', ask: ['test', 'check', 'clippy', 'build'] },
  { tool: 'dotnet', ask: ['test', 'build'] },
  { tool: 'gradle', ask: ['test', 'check', 'build'] },
  { tool: 'mvn', ask: ['test', 'verify', 'package'] },
  { tool: 'pytest', ask: '*' },
];

/** argv обёртки PATH: node, прокладка, режим и спецификация одним словом base64url (без кавычек для sh и cmd). */
export function captureWrapperArgv(node: string, spec: CaptureWrapSpec): string[] {
  const encoded = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64url');
  return [node, CAPTURE_SHIM, CAPTURE_WRAP_FLAG, encoded];
}
