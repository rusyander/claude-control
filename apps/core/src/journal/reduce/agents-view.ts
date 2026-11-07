/**
 * История агентов задачи (этап 11, P146-P149) — свёртка ТОЛЬКО журнала: сеанс единицы
 * (`session.*`), субагент (`agent.spawned`/`agent.ended`), фоновая работа (`bg.*`), вызовы
 * (`tool.started` + `tool.event`), расход (`turn.usage.parentToolUseId`). Транскриптов CLI вид не
 * читает — расхода, которого журнал не назвал, нет: `null` «неизвестно», никогда не `0`. Строка
 * расхода с неизвестным родителем к родителю не прибавляется (P149): она ждёт `agent.spawned`
 * своего вызова, а не дождавшись — названа отдельно (`spend-misattributed`).
 */

export type { AgentsFold, CallAcc, NodeAcc } from './agents-view.types.ts';
export { AGENT_SLICE_KINDS, initAgentsFold, usageTokens } from './agents-view/base.ts';
export { agentNodeOf, agentTreeOf, agentDetailOf, AGENT_CALLS_PAGE } from './agents-view/read.ts';
export { foldAgents, openBgItems, stepAgents } from './agents-view/step.ts';
