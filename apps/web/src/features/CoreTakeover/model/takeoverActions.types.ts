/** Видимость действий перехвата на карточке задачи. */
export interface TakeoverActions {
  takeOver: boolean;
  handBack: boolean;
  rework: boolean;
  setStop: boolean;
}
