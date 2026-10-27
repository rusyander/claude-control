import type { ChatSummary } from '@agentdeck/contracts';

export interface ChatOriginTexts {
  sandbox: string;
  forkOf: (title: string) => string;
  forkOfUnknown: string;
}

/**
 * Подпись под названием разговора в списке. Ветка правки реплики — первой: у неё
 * та же история и то же название, что у исходного, и без подписи в списке
 * стояли два одинаковых чата (Telegram 26.10, R2).
 */
export function chatOrigin(chat: ChatSummary, texts: ChatOriginTexts): string {
  if (chat.forkOf) return chat.forkOf.title ? texts.forkOf(chat.forkOf.title) : texts.forkOfUnknown;
  return chat.isSandbox ? texts.sandbox : chat.project;
}
