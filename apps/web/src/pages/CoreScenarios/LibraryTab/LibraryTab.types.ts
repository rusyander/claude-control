import type { ScenariosReply } from '@agentdeck/contracts/core/panel-api';

export interface LibraryTabProps {
  listing: ScenariosReply;
  /** Ссылка `id@v` выбранного сценария из адреса. */
  selected: string | undefined;
  onSelect: (ref: string) => void;
  /** Открыть новый сценарий на основе `ref`. */
  onBase: (ref: string) => void;
}
