import type { PlatformStatus, PlatformConsumerOption } from '@agentdeck/contracts';

export interface ContourSectionsProps {
  status: PlatformStatus;
  /** Варианты из плана применения; нет — встроенные разделы по сохранённому. */
  options: readonly PlatformConsumerOption[] | undefined;
  /** Файлы CLI этого контура применены — у закрытого терминала это надо сказать. */
  filesApplied: boolean;
}
