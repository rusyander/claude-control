import { useSettings } from '@entities/AppConfig';
import { AssistantKeyGate } from '@features/AssistantKeyGate';
import { ProviderChatPage } from '@pages/ProviderChat';
import { ChatPage } from './ChatPage';

/**
 * Раздел чата по активному провайдеру. Claude — прежний богатый стриминговый чат
 * (`ChatPage`) БЕЗ изменений: роутинг по провайдеру, а не переписывание (регресс-
 * ноль). Прочие провайдеры — свой чат с разговорами, памятью между вопросами и
 * ответом по мере печати (`ProviderChatPage`).
 *
 * До загрузки настроек считаем провайдера дефолтным (claude) — как в остальных
 * гейтах.
 */
export function ChatSection() {
  const { data: settings } = useSettings();
  const providerId = settings?.provider ?? 'claude';

  if (providerId === 'claude') return <ChatPage />;

  // Модалка-инструкция (подписка → ключ) монтируется на уровне страницы:
  // фичи не импортируют друг друга (граница FSD).
  return (
    <>
      <AssistantKeyGate />
      <ProviderChatPage />
    </>
  );
}
