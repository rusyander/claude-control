import type { KitProviderView } from '@agentdeck/contracts/kit';

import type { ReactNode } from 'react';

export interface KitModesCardProps {
  providers: KitProviderView[];
  /** Под карточкой — например, ссылка на страницу набора из настроек. */
  footer?: ReactNode;
}
