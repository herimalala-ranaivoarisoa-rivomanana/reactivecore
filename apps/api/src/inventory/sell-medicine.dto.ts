import { IsInt, IsPositive, IsUUID, Max } from 'class-validator';

export class SellMedicineDto {
  @IsUUID()
  pharmacyId!: string;

  @IsUUID()
  medicineId!: string;

  @IsInt()
  @IsPositive()
  @Max(1000000)
  quantity!: number;
}
