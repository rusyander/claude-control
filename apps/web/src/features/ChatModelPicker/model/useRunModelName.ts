import { useTranslation } from 'react-i18next';
import { chooseRunModel } from '@agentdeck/contracts/platform-models';
import { usePlatformRunPlan } from '@entities/Platform';
import { modelLabel } from '@shared/lib/chat-model';

export interface RunModelNameInput {
  /** Потребитель маршрута — тот же, которым спрашивает шапка чата. */
  consumer?: string;
  /** Выбор этого чата; пусто — «как в настройках». */
  model: string;
  /** Модель из настроек. */
  defaultModel?: string;
}

/**
 * Имя модели, которая ответит на следующее сообщение, — для подписей вроде
 * «… думает над ответом». Через контур это модель контура: «Claude думает»
 * над ответом, который пишет Qwen, — ровно та путаница, из-за которой владелец
 * решил, что контур не подключился (14.09.2026). Считается той же функцией,
 * что сервер и шапка, — третий расчёт разошёлся бы с ними молча.
 */
export function useRunModelName({
  consumer = 'chat',
  model,
  defaultModel,
}: RunModelNameInput): string {
  const { t } = useTranslation();
  const plan = usePlatformRunPlan(consumer);
  if (plan.data?.routed === true) {
    return chooseRunModel(plan.data.rules, model).model || plan.data.title;
  }
  return modelLabel(model || defaultModel || '') || t('chat.modelClaudeDefault');
}
