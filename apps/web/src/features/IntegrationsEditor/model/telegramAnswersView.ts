import type { TelegramAnswersView } from '@agentdeck/contracts/telegram-answers';

/**
 * Поле отдельного токена: по умолчанию ответы слушает бот карточки Telegram, и
 * второй бот нужен только тогда, когда этого бота уже слушает агент
 * (`same-bot`). Сохранённый токен показывается всегда — иначе его не стереть.
 */
export function showsAnswersToken(view: Pick<TelegramAnswersView, 'hasToken' | 'status'>): boolean {
  return view.hasToken || view.status.state === 'same-bot';
}

/**
 * Подробность состояния опроса — у любого состояния, кроме чистого «слушаю»:
 * «слушаю» с подробностью значит, что владельцу написать не удалось, и это
 * человек должен видеть, а не только журнал сервера.
 */
export function answersDetail(status: TelegramAnswersView['status']): string | undefined {
  return status.detail || undefined;
}
