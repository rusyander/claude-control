export interface TestMutationCheckProps {
  path: string | undefined;
  /** Идёт прогон агента или автотестов — копия гоняла бы тесты рядом, кнопка закрыта. */
  isBusy: boolean;
}
