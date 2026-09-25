import type { ChatSummary } from '@agentdeck/contracts';
import { useDraft } from '@shared/lib/draft';

export interface ChatModelPrefs {
  /** Из настроек панели — общий для всех разговоров; обе перекрывает назначенное чату. */
  defaultModel: string;
  defaultEffort: string;
  /** Выбор ДЛЯ ЭТОГО разговора; пусто — берётся общий. */
  modelOverride: string;
  setModelOverride: (value: string) => void;
  effortOverride: string;
  setEffortOverride: (value: string) => void;
  /**
   * С чем реально уйдёт следующий запрос. Одним объектом, потому что во всех
   * местах страницы эти два значения передаются только вместе — и всегда под
   * именами `model`/`effort`.
   */
  effective: { model: string; effort: string };
}

/**
 * Модель и глубина продумывания разговора.
 *
 * Общий дефолт живёт в настройках, а в конкретном чате его можно переопределить
 * — оверрайд хранится рядом с черновиком поля ввода, по тому же ключу
 * контекста, и настроек не меняет: выбор «в этом чате думай глубже» не должен
 * менять поведение всех остальных.
 */
export function useChatModelPrefs(
  draftKey: string,
  settings?: { chatModel?: string; chatEffort?: string },
  chat?: Pick<ChatSummary, 'effort' | 'assignedModel'>,
): ChatModelPrefs {
  // Модель, назначенная разговору панелью (группа разделения, разбор), важнее
  // настройки — по тому же правилу, что и глубина ниже: без неё следующее
  // сообщение человека в группе на haiku ушло бы на модели из настроек.
  const defaultModel = chat?.assignedModel || (settings?.chatModel ?? '');
  // Глубина, назначенная разговору панелью (разбор, группа разделения), важнее
  // настройки: разговор ИДЁТ на ней, и шапка с подписью из настроек врала бы
  // (живой прогон 24.09: разбор на xhigh, в шапке «Высокая»), а следующее
  // сообщение человека уехало бы на настройке — сервер берёт назначенную
  // глубину, только когда панель не прислала свою.
  const defaultEffort = chat?.effort || (settings?.chatEffort ?? 'xhigh');
  const [modelOverride, setModelOverride] = useDraft(`chat-model:${draftKey}`);
  const [effortOverride, setEffortOverride] = useDraft(`chat-effort:${draftKey}`);

  return {
    defaultModel,
    defaultEffort,
    modelOverride,
    setModelOverride,
    effortOverride,
    setEffortOverride,
    effective: { model: modelOverride || defaultModel, effort: effortOverride || defaultEffort },
  };
}
