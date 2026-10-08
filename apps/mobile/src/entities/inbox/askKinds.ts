import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';

export interface AskKinds {
  questions: number;
  /** Разрешения на вызов и первая правка в основной копии — обе просят «можно?». */
  permissions: number;
}

/** Что именно ждёт в чате — значок называет это словами, а не одним «вопросом». */
export function askKinds(asks: readonly Pick<InboxAsk, 'kind'>[]): AskKinds {
  let questions = 0;
  for (const ask of asks) if (ask.kind === 'question') questions += 1;
  return { questions, permissions: asks.length - questions };
}
