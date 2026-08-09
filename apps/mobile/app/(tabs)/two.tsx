import { Redirect } from 'expo-router';

/**
 * Вторая вкладка шаблона Expo. Из панели вкладок она убрана (`href: null` в
 * `_layout`), а сам маршрут ведёт в разговор: попасть сюда можно только по
 * прямой ссылке, и упираться при этом в заготовку незачем.
 */
export default function TabTwoScreen() {
  return <Redirect href="/" />;
}
