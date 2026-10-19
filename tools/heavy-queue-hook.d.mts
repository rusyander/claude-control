/** Типы для тестов сервера, которые пишут аренды настоящим хуком. */
export interface HookInput {
  session_id?: string;
  tool_use_id?: string;
  agent_id?: string;
  tool_name?: string;
  tool_input?: { command?: string; timeout?: number; run_in_background?: boolean };
}
export function acquire(
  dir: string,
  input: HookInput,
  now?: () => number,
  learned?: Map<string, number>,
  held?: object[],
): Promise<number | null>;
/** Число мест: `config.json` каталога очереди, иначе окружение, иначе одно. */
export function slotsOf(dir: string): number;
export function queueStatus(dir: string, now?: number): string;
