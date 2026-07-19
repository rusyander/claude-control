export interface AttachedFile {
  name: string;
  sizeBytes: number;
  /** Содержимое в base64 — сервер положит файл в папку чата. */
  base64: string;
}

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (files: AttachedFile[]) => void;
  onStop: () => void;
  isRunning: boolean;
}
