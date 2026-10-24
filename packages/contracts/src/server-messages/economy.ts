/**
 * Коды текстов сервера, раздел «economy»: почему рычаг экономии групп у CLI не
 * действует, а у действующего — при каком условии, — подсказка к отметке «Где
 * действует» (`group-economy-support.ts`).
 * Причины общие, не по CLI: каталог каждого провайдера выбирает свою, и новому
 * CLI не нужен новый текст. Сборка всех — `../server-messages.ts`.
 */
export const economyMessageParams = {
  'economy-note-no-key': [],
  'economy-note-hardcoded-limit': [],
  'economy-note-config-only': [],
  'economy-note-no-ide': [],
  'economy-note-cache-implicit': [],
  'economy-note-anthropic-only': [],
  'economy-note-one-shot': [],
  'economy-note-live-session': [],
  'economy-note-no-model-ladder': [],
  'economy-note-keep-warm-cost': [],
  'economy-note-local-model': [],
  'economy-note-no-tool-loop': [],
  'economy-note-disproportionate': [],
  'economy-note-shared-tool-limit': [],
  'economy-note-keep-warm-short-ttl': [],
  'economy-note-admin-settings': [],
  'economy-note-provider-unknown': [],
  'economy-note-no-effect': [],
  'economy-note-not-runnable': [],
  'economy-note-shared-tool-limit-larger': [],
  'economy-note-window-known-only': [],
  'economy-note-cloud-only': [],
} as const;
