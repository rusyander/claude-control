export interface AtlassianSearchPickerProps {
  /** Что ищем: задачи Jira или страницы Confluence. */
  kind: 'jira' | 'confluence';
  /** Что уже выбрано — подписью над списком, чтобы выбор не терялся. */
  chosen: string;
  /** Ключ задачи или id страницы вместе с заголовком. */
  onChoose: (id: string, title: string) => void;
  onClear: () => void;
}
