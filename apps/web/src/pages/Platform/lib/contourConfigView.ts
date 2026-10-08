import {
  FOREIGN_CONSUMER_PREFIX,
  PLATFORM_ASSISTANT_CONSUMER,
  PLATFORM_TERMINAL_CONSUMER,
  platformRunConsumers,
} from '@agentdeck/contracts';
import type {
  Platform,
  PlatformConsumerOption,
  PlatformConsumerReason,
} from '@agentdeck/contracts';

/**
 * Разделы через контур и выбор «чьи правила действуют» (баг 11) — то, что
 * карточка и вкладка правил показывают и что отправляют обратно.
 *
 * Чистый модуль без React. Решений о том, КТО берёт верх, здесь нет: победителя
 * называет сервер (`rules-matrix.ts`) тем же кодом, которым собирает запрос, а
 * экран только подбирает ему слова.
 */

/** Вид раздела: от него зависит, чем он открывается. */
export type SectionKind = 'run' | 'assistant' | 'terminal' | 'foreign';

export interface SectionRow {
  id: string;
  kind: SectionKind;
  /** Имя CLI у чужого чата; у встроенных пусто — их называет словарь. */
  name: string;
  open: boolean;
  /** Недоступен у этого контура — и почему. */
  reason?: PlatformConsumerReason;
  /**
   * Открыть можно прямо на карточке. Ассистент и терминал открываются ЗАПИСЬЮ
   * (профиль ассистента, файлы CLI) — на вкладке доступа, где видно, что именно
   * ляжет в настройки; на карточке их можно только закрыть.
   */
  opensHere: boolean;
}

function kindOf(id: string): SectionKind {
  if (id === PLATFORM_ASSISTANT_CONSUMER) return 'assistant';
  if (id === PLATFORM_TERMINAL_CONSUMER) return 'terminal';
  return id.startsWith(FOREIGN_CONSUMER_PREFIX) ? 'foreign' : 'run';
}

/**
 * Строки разделов. Список — из плана (`consumers` ответа применения): он
 * собирается сервером из того, что действительно запускает модель, и галочки,
 * за которой нет места запуска, здесь быть не должно. Плана ещё нет — встроенные
 * разделы по сохранённому выбору, без чужих CLI: угадывать их список нечем.
 */
export function sectionRows(
  platform: Platform,
  options: readonly PlatformConsumerOption[] | undefined,
): SectionRow[] {
  const chosen = platform.consumers ?? [];
  const source: readonly Pick<PlatformConsumerOption, 'id' | 'title' | 'reason'>[] = options ?? [
    ...platformRunConsumers.map((id) => ({ id, title: '' })),
    { id: PLATFORM_ASSISTANT_CONSUMER, title: '' },
    { id: PLATFORM_TERMINAL_CONSUMER, title: '' },
  ];
  return source.map((option) => {
    const kind = kindOf(option.id);
    const open = !option.reason && chosen.includes(option.id);
    return {
      id: option.id,
      kind,
      name: option.title,
      open,
      ...(option.reason ? { reason: option.reason } : {}),
      opensHere: !option.reason && (kind === 'run' || kind === 'foreign'),
    };
  });
}
