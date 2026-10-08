export interface CarrySectionProps {
  /** Все провайдеры парами «id — имя»: цель раздел называет САМ. */
  providers: readonly { value: string; label: string }[];
}
