import { IsOptional, IsString, IsNumberString } from 'class-validator';

/**
 * Payload từ Accesstrade postback. Tên field có thể khác tuỳ template
 * bạn cấu hình trên dashboard AT — verify lại bằng vài request thật.
 *
 * Tên field thường gặp:
 *   order_id, sub_id (hoặc aff_sub), commission, sale_amount, status, signature
 *
 * Accesstrade report/postback thực tế có thể gửi:
 *   utm_source, reward, product_price, transaction_id, campaign_id, is_confirmed
 */
export class AccesstradePostbackDto {
  @IsString()
  @IsOptional()
  order_id!: string;

  @IsString()
  @IsOptional()
  transaction_id?: string;

  @IsString()
  @IsOptional()
  campaign_id?: string;

  @IsString()
  @IsOptional()
  aff_sub?: string;

  @IsString()
  @IsOptional()
  sub_id?: string;

  @IsString()
  @IsOptional()
  sub1?: string;

  @IsString()
  @IsOptional()
  sub2?: string;

  @IsString()
  @IsOptional()
  sub3?: string;

  @IsString()
  @IsOptional()
  sub4?: string;

  @IsString()
  @IsOptional()
  sub5?: string;

  @IsString()
  @IsOptional()
  utm_source?: string;

  @IsNumberString()
  @IsOptional()
  commission?: string;

  @IsNumberString()
  @IsOptional()
  sale_amount?: string;

  @IsNumberString()
  @IsOptional()
  reward?: string;

  @IsNumberString()
  @IsOptional()
  product_price?: string;

  @IsString()
  @IsOptional()
  status!: string;

  @IsString()
  @IsOptional()
  is_confirmed?: string;

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
