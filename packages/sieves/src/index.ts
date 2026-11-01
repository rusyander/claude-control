/**
 * Сита исходящего содержимого (05 §Readiness): одни и те же для панели и публикатора ядра.
 * `sieve-scan` — механика по строкам и путям (её же держит двойник глобального слоя),
 * `outgoing` — сведение в находки с именем сита из контракта для `publisher/ready`.
 */
export * from './sieve-scan.ts';
export { scanOutgoing, type OutgoingScanInput } from './outgoing.ts';
