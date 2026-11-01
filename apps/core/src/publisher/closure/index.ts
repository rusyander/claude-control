/**
 * `publisher/closure` — закрытие пуша копии для сеанса и свой push публикатора (05 §Push closure).
 */
export { hooksDirOf } from './spec.ts';
export { aliasPublishes, CLOSED_PUSH_URL } from '../../lib/publish-alias.ts';
export { CHAINED_HOOKS, hookScript, hookScripts, REFUSING_HOOKS, SESSION_MARKER } from './hooks.ts';
export {
  publisherPushSpec,
  type PublisherPushInput,
  type PublisherPushSpec,
} from './push-config.ts';
