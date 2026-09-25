/** Приёмка группы в строке хаба: кому адресоваться и принята ли уже. */
export interface GroupAcceptanceState {
  parentChatId: string;
  index: number;
  /** Когда человек принял группу (ISO); нет — ещё не принята. */
  acceptedAt?: string;
}

export interface GroupAcceptanceProps {
  acceptance: GroupAcceptanceState;
}
