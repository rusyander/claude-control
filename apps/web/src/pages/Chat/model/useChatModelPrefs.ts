import { useDraft } from '@shared/lib/draft';

export interface ChatModelPrefs {
  /** Из настроек панели — общий для всех разговоров. */
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
): ChatModelPrefs {
  const defaultModel = settings?.chatModel ?? '';
  const defaultEffort = settings?.chatEffort ?? 'xhigh';
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
