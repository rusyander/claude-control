import type { EndpointProbeResult, EndpointProfile } from '@claude-control/contracts';

export interface EndpointProfileFormProps {
  profile: EndpointProfile;
  /** Маска сохранённого токена; пусто — токен не задан. */
  tokenMask: string;
  /** Итог последней проверки связи этого профиля (в пределах открытой страницы). */
  probe?: EndpointProbeResult;
  onChange: (profile: EndpointProfile) => void;
}
