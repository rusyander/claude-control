export interface ComposeDangerZoneProps {
  /** Именованные тома из файла — их и удалит `down -v`. */
  volumes: string[];
  /** Над стеком идёт действие — второе сервер не примет. */
  isBusy: boolean;
  onDown: () => void;
  onDownVolumes: () => void;
}
