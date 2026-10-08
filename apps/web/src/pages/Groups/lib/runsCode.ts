import type { MemberAdvice } from '@agentdeck/contracts';

/** Замена, которая будет выполняться на машине: команда хука, запуск MCP. */
export function runsCode(item: MemberAdvice): boolean {
  return item.verdict === 'improve' && (item.kind === 'hook' || item.kind === 'mcp');
}
