export interface ProviderChatGroupPickerProps {
  providerId: string;
  chatId: string;
  /** Каталог разговора: проектные группы — только его проекта. */
  workdir: string | undefined;
}
