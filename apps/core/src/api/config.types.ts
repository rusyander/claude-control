import type { ConfigView, SetConfigBody, SetConfigReply } from '@agentdeck/contracts/core/config';
import type { AuthorityDecision } from '../policy/authority/authority.ts';

/**
 * Порт настройки ядра для `GET|POST /v1/config` (00:58, G6, G11). Ручку держит API (суд
 * полномочий `set-config` — `human-strict`, ключ повтора), порт — зона настройки
 * (`bootstrap/core-config`): чтение, дрейф, запись. Нет порта — ручки отвечают 501.
 */

export type SetConfigOutcome =
  | { status: 200; reply: SetConfigReply }
  /** Отпечаток, от которого правил человек, уже не последний: правка поверх чужой — нет. */
  | { status: 409; code: 'stale-digest'; digest: string }
  /** Документ прошёл схему, но не годится (раздел, который ядро не примет). */
  | { status: 422; code: 'config-refused'; issues: ConfigView['issues'] };

export interface ConfigPort {
  /** Действующая настройка; не прочиталась — `unknown` с причиной (500), не «пусто». */
  view(): { value: ConfigView } | { unknown: string };
  /** Тот же `cmdId` уже применён — прежний ответ с `replayed: true`, без второй записи. */
  replay(cmdId: string): SetConfigOutcome | undefined;
  /** Запись после суда полномочий: `by` — чем человек доказан. */
  set(
    body: SetConfigBody,
    by: Extract<AuthorityDecision, { allow: true }>['by'],
  ): Promise<SetConfigOutcome>;
  /** Суд полномочий отказал (`forged-authority` и прочие): записать отказ в журнал ядра. */
  refused(cmdId: string, code: string, reason: string): void;
}
