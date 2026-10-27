export interface ForkConfirmProps {
  isOpen: boolean;
  /** `true` — отправить веткой, `false` — не отправлять: текст остаётся в поле. */
  onAnswer: (ok: boolean) => void;
}
