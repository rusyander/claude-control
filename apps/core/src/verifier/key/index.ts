/** Ключ проверки (04:10, D§3.3): чистый расчёт и его чтения через платформу. */
export { canonical, hmac, sha256 } from './canonical.ts';
export {
  absentKeyOf,
  closureOf,
  covers,
  defHash,
  diffParts,
  fingerprint,
  inputPatterns,
  KEY_VERSION,
  keyFromParts,
  keyOf,
  registryFp,
} from './key.ts';
export { envDigester, readKey, type KeyReadInput } from './read.ts';
export type { KeyContext, KeyOf } from './key.types.ts';
