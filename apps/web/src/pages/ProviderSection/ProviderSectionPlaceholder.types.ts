import type { Capability } from '@claude-control/contracts';
import type { SectionAccess } from '@entities/Provider';

export interface ProviderSectionPlaceholderProps {
  /** Возможность, к которой привязан раздел, — для подписи/иконки. */
  capability: Capability;
  /** Имя активного провайдера для текста «раздел для X». */
  providerName?: string;
  /** planned → «в разработке»; иначе (unsupported при прямом заходе) → «недоступен». */
  access: SectionAccess;
}
