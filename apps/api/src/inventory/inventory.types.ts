export interface SellMedicineCommand {
  tenantId: string;
  pharmacyId: string;
  medicineId: string;
  quantity: number;
  idempotencyKey: string;
}

export interface SaleResult {
  saleId: string;
  stockId: string;
  remainingQuantity: number;
  stockVersion: string;
}

export interface StockRow {
  id: string;
  quantity: number;
  version: string;
}
