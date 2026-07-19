import '@tanstack/react-query';

/**
 * Метаданные мутации для тостов. Их читает глобальный `MutationCache` в корне
 * приложения: об ошибках он сообщает сам (по всему приложению, ничего не
 * пропуская), а тост об успехе показывает только там, где задан `successMessage`
 * — так уведомления появляются на осмысленных действиях, а не на каждом запросе.
 */
export interface ToastMutationMeta {
  /** Ключ перевода для тоста об успехе. Не задан — тоста об успехе нет. */
  successMessage?: string;
  /** Ключ перевода для тоста об ошибке. По умолчанию — текст ошибки от сервера. */
  errorMessage?: string;
  /** Не показывать тост об ошибке: она обрабатывается на месте (инлайн). */
  silentError?: boolean;
  /** Индекс-сигнатура — требование типа meta в TanStack Query. */
  [key: string]: unknown;
}

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: ToastMutationMeta;
  }
}
