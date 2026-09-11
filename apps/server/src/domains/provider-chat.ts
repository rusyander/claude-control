/**
 * Чат чужого провайдера — ветка, отдельная от чата Claude.
 *
 * Claude ведёт переписку сам, и панель её читает (`domains/chat/`). У остальных
 * CLI своей читаемой истории нет, поэтому здесь другое устройство: переписку
 * ведёт панель, а ответ показывается по мере того, как CLI его печатает.
 * Пересечений с веткой Claude нет ни одного — это и есть гарантия, что его чат
 * не пострадает.
 *
 * Модули: `store.ts` — переписка на диске, `prompt.ts` — сборка промпта из неё,
 * `ProviderChatRun.ts` — один ответ (поток CLI, сессия, API),
 * `ProviderChatService.ts` — живые прогоны, подписка и запись результата,
 * `cascade.ts` — конвейер «работа → ревью → правки» над понижёнными прогонами,
 * `handoff.ts` — продолжение работы в новом разговоре (у чужого CLI сессии нет).
 */

export {
  appendMessage,
  createChat,
  deleteChat,
  listChats,
  patchChat,
  readChat,
  readChatCascade,
  setChatCascade,
  titleFromText,
  type ProviderChatCascade,
} from './provider-chat/store.ts';
export {
  createForeignStagePlanner,
  foreignStagePrefix,
  foreignChatPrefix,
  planForeignStage,
  type ForeignRunFinished,
  type ForeignStagePlan,
} from './provider-chat/cascade.ts';
export {
  continuationTitle,
  planForeignHandoff,
  startForeignHandoff,
  type ForeignHandoffDeps,
  type ForeignHandoffInput,
  type ForeignHandoffOutcome,
} from './provider-chat/handoff.ts';
export { MAX_PROMPT_CHARS, buildPrompt, composeUserMessage } from './provider-chat/prompt.ts';
export {
  ProviderChatRun,
  type ProviderChatRunEvent,
  type ProviderChatRunLike,
  type ProviderChatRunOptions,
} from './provider-chat/ProviderChatRun.ts';
export {
  ProviderChatService,
  type ProviderChatFinished,
  type ProviderChatSubscriber,
  type SendOutcome,
} from './provider-chat/ProviderChatService.ts';
