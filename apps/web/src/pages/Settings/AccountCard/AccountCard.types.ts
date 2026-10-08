export interface AccountInfo {
  email?: string;
  displayName?: string;
  organization?: string;
  billingType?: string;
  isSubscription: boolean;
  hasExtraUsage?: boolean;
}
