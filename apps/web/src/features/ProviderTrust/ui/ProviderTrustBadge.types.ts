export interface ProviderTrustBadgeProps {
  /** Провайдер; по умолчанию — активный. */
  providerId?: string;
  /** Показывать ли бейдж для Claude (по умолчанию нет — он дефолт и не шумит). */
  showForClaude?: boolean;
}
