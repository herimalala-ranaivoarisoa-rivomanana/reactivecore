import { browserQueue } from "../offline-store";
export { tokenFingerprint as inventoryScope } from "../offline-store";

export interface TransferArgs {
  sourcePharmacyId: string;
  destinationPharmacyId: string;
  medicineId: string;
  quantity: number;
}

export function inventoryQueue(scope: string) {
  return browserQueue<TransferArgs>("reactivecore-inventory", scope);
}
