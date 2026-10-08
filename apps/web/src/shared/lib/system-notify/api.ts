export function api(): typeof Notification | undefined {
  return typeof Notification === 'undefined' ? undefined : Notification;
}
