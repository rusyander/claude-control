import type { InboxDeferred } from '@agentdeck/contracts/chat-inbox';

/**
 * Отложенные вопросы D-n глазами телефона: прогон уже пошёл дальше, решение
 * ждёт человека в одном списке. Модуль без React — его гоняют тесты.
 */

/** Что можно решить: ждущие первыми, потом истёкшие; выданное разрешение — не вопрос. */
export function openDeferred(items: readonly InboxDeferred[]): InboxDeferred[] {
  return [
    ...items.filter((item) => item.state === 'waiting'),
    ...items.filter((item) => item.state === 'expired'),
  ];
}

/** Сколько записей ждёт — в число на вкладке «Вопросы». Истёкшая агента не ждёт. */
export function waitingDeferred(items: readonly InboxDeferred[]): number {
  return items.filter((item) => item.state === 'waiting').length;
}

/** Тексты причин на языке телефона (`home.deferredReasons`). */
export interface DeferredReasonTexts {
  'group-rows': string;
  'not-auto-approved': string;
  'main-copy': string;
  'backend-guard': (rule: string, match: string) => string;
}

/**
 * Почему решает человек — по коду записи: `reason` написан для агента
 * по-английски. Кода нет (сервер постарше) — `reason` как есть.
 */
export function deferredReasonOf(item: InboxDeferred, texts: DeferredReasonTexts): string {
  switch (item.reasonCode) {
    case 'group-rows':
    case 'not-auto-approved':
    case 'main-copy':
      return texts[item.reasonCode];
    case 'backend-guard':
      return texts['backend-guard'](item.reasonParams?.rule ?? '', item.reasonParams?.match ?? '');
    default:
      return item.reason;
  }
}

/** Путь решения: свой маршрут записи, не `permission-decision` — карточки у CLI уже нет. */
export function deferredDecisionPath(id: string): string {
  return `/chat/deferred/${encodeURIComponent(id)}/decision`;
}

/**
 * Тело решения. `via: 'mobile'` — только подпись в списке «кто ответил»: кто
 * вправе решать, сервер проверяет по сокету, а не по телу.
 */
export function deferredDecisionBody(behavior: 'allow' | 'deny'): {
  behavior: 'allow' | 'deny';
  via: 'mobile';
} {
  return { behavior, via: 'mobile' };
}
