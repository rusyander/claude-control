export interface ProviderProjectPermissionsHeaderProps {
  /** Путь проектного файла прав — он у каждого провайдера свой. */
  filePath: string;
  /** Формат файла не распознан — писать нельзя, кнопки сохранения нет. */
  readOnly: boolean;
  /** Есть несохранённые правки. */
  dirty: boolean;
  isPending: boolean;
  onSubmit: () => void;
}
