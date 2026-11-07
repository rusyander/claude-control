import type { ChatSummary } from '@agentdeck/contracts';
import { isClaudeModelId } from '@shared/lib/chat-model';
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

/** Чем судить, годится ли имя модели разговору (W3-17a). */
export interface ChatModelFit {
  /** CLI разговора; нет — Claude. Другому CLI имя Claude не годится ни откуда. */
  cli?: string;
  /**
   * Каталог моделей этого CLI: имя `claude-*` из него — модель САМОГО CLI (OpenCode Zen), а не
   * залежавшийся выбор Claude.
   */
  catalog?: readonly { id: string }[];
  /**
   * Ход идёт через контур: модель решает его перевод (карта, каталог контура — один у любого CLI и
   * несёт `claude-*`), а не CLI. Выбор уходит как есть — тот же, что переводят запертая шапка и
   * сервер; срезанный здесь, он пропадал до перевода, и ход шёл на модели контура по умолчанию.
   */
  contour?: boolean;
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
  { cli, catalog, contour = false }: ChatModelFit = {},
): ChatModelPrefs {
  const fits = (value: string): boolean =>
    !cli ||
    cli === 'claude' ||
    contour ||
    !value ||
    !isClaudeModelId(value) ||
    Boolean(catalog?.some((model) => model.id === value));
  // Модель, назначенная разговору панелью (группа разделения, разбор), важнее
  // настройки — по тому же правилу, что и глубина ниже: без неё следующее
  // сообщение человека в группе на haiku ушло бы на модели из настроек.
  const assigned = chat?.assignedModel ?? '';
  const fromSettings = settings?.chatModel ?? '';
  const defaultModel = (fits(assigned) && assigned) || (fits(fromSettings) ? fromSettings : '');
  // Глубина, назначенная разговору панелью (разбор, группа разделения), важнее
  // настройки: разговор ИДЁТ на ней, и шапка с подписью из настроек врала бы
  // (живой прогон 24.09: разбор на xhigh, в шапке «Высокая»), а следующее
  // сообщение человека уехало бы на настройке — сервер берёт назначенную
  // глубину, только когда панель не прислала свою.
  const defaultEffort = chat?.effort || (settings?.chatEffort ?? 'xhigh');
  const [savedModel, setModelOverride] = useDraft(`chat-model:${draftKey}`);
  const [effortOverride, setEffortOverride] = useDraft(`chat-effort:${draftKey}`);
  // Выбор черновика, сделанный при активном Claude, после смены провайдера не уходит новому CLI:
  // шапка показывает «как выберет CLI», черновик хранит выбор как был.
  const modelOverride = fits(savedModel) ? savedModel : '';

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
