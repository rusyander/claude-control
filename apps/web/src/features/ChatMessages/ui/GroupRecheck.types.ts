/** «Перепроверить MR» в строке хаба: кому адресоваться и что с последней проверкой. */
export interface GroupRecheckState {
  parentChatId: string;
  index: number;
  /** Перепроверка идёт (ISO нажатия): ход группы ещё не кончился доставкой. */
  requestedAt?: string;
  /** Последняя перепроверка кончилась доставкой (ISO) — кнопка зелёная. */
  checkedAt?: string;
}

export interface GroupRecheckProps {
  recheck: GroupRecheckState;
}
