import { useSettings } from '@entities/AppConfig';
import { BasicAssistantChat } from '@features/BasicAssistantChat';
import { AssistantKeyGate } from '@features/AssistantKeyGate';
import { ChatPage } from './ChatPage';

/**
 * Раздел чата по активному провайдеру. Claude — прежний богатый стриминговый чат
 * (`ChatPage`) БЕЗ изменений: роутинг по провайдеру, а не переписывание (регресс-
 * ноль). Прочие провайдеры с `chat=ready` (Codex, Gemini) — basic-чат
 * мультимодельного ассистента (`/api/assistant/run`, one-shot CLI / прямой API).
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
      <BasicAssistantChat />
    </>
  );
}
