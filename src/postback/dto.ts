import { IsOptional, IsString, IsNumberString } from 'class-validator';

/**
 * Payload từ Accesstrade postback. Tên field có thể khác tuỳ template
 * bạn cấu hình trên dashboard AT — verify lại bằng vài request thật.
 *
 * Tên field thường gặp:
 *   order_id, sub_id (hoặc aff_sub), commission, sale_amount, status, signature
 */
export class AccesstradePostbackDto {
  @IsString()
  order_id!: string;

  @IsString()
  @IsOptional()
  aff_sub?: string;

  @IsString()
  @IsOptional()
  sub_id?: string;

  @IsNumberString()
  @IsOptional()
  commission?: string;

  @IsNumberString()
  @IsOptional()
  sale_amount?: string;

  @IsString()
  status!: string;

  @IsString()
  @IsOptional()
  signature?: string;

  @IsString()
  @IsOptional()
  campaign?: string;

  @IsString()
  @IsOptional()
  timestamp?: string;
}
