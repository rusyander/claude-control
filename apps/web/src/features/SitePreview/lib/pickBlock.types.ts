/** Подписи полей блока на языке панели — словарь `sitePreview.block`. */
export interface PickLabels {
  header: string;
  url: string;
  selector: string;
  tag: string;
  text: string;
  rect: string;
  html: string;
  empty: string;
}

/** Чип в поле ввода и блок агенту: подпись коротко, селектор подсказкой, блок целиком. */
export interface PickDescription {
  label: string;
  title: string;
  block: string;
}
