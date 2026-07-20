export {
  useChats,
  useChatMessages,
  useArtifacts,
  useArtifactSource,
  useRefreshChat,
  artifactUrl,
  chatKeys,
} from './api/ChatApi';
// Тип состояния потока определён в shared (см. @shared/lib/chat-stream); entity
// его переэкспортирует как часть публичного API. Рантайм-путь чата — стор
// agent-runs; отдельного хука-потока здесь нет.
export type { StreamState, StreamedTool } from '@shared/lib/chat-stream';
