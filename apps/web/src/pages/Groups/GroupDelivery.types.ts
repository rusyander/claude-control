export interface GroupDeliveryProps {
  groupId: string;
  /** Активный чужой CLI: его id и имя для подписи. */
  provider: { id: string; name: string };
}
