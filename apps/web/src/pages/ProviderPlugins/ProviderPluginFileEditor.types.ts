export interface ProviderPluginFileEditorProps {
  /** Путь файла относительно каталога плагинов. */
  path: string;
  projectId?: string;
  onClose: () => void;
}
