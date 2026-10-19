/** Приёмка группы в строке хаба: кому адресоваться и принята ли уже. */
export interface GroupAcceptanceState {
  parentChatId: string;
  index: number;
  /** Группа не доставлена конвейером — кнопка «Отметить готовой», а не «Принять». */
  markable?: boolean;
  /** Когда человек принял группу (ISO); нет — ещё не принята. */
  acceptedAt?: string;
  /** «Готово» поставил человек сам (ISO, владелец 20.10). */
  markedDoneAt?: string;
}

export interface GroupAcceptanceProps {
  acceptance: GroupAcceptanceState;
}
