/** Часть `MessageEvent`, которую читает приём выбора: тестам не нужен настоящий объект события. */
export interface FrameMessage {
  source: MessageEventSource | null;
  origin: string;
  data: unknown;
}
