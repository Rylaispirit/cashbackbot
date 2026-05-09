import { IsOptional } from 'class-validator';

export type PostbackScalar = string | number;

/**
 * Payload từ Accesstrade postback. Real shape verified từ production data:
 *   transaction_id (unique), order_id, utm_source (= sub_id),
 *   reward (commission), product_price (sale_amount),
 *   status (integer), is_confirmed, confirmed_date, click_time, sales_time, ...
 */
export class AccesstradePostbackDto {
  @IsOptional()
  order_id?: PostbackScalar;

  @IsOptional()
  transaction_id?: PostbackScalar;

  @IsOptional()
  campaign_id?: PostbackScalar;

  @IsOptional()
  aff_sub?: PostbackScalar;

  @IsOptional()
  sub_id?: PostbackScalar;

  @IsOptional()
  sub1?: PostbackScalar;

  @IsOptional()
  sub2?: PostbackScalar;

  @IsOptional()
  sub3?: PostbackScalar;

  @IsOptional()
  sub4?: PostbackScalar;

  @IsOptional()
  sub5?: PostbackScalar;

  @IsOptional()
  utm_source?: PostbackScalar;

  @IsOptional()
  commission?: PostbackScalar;

  @IsOptional()
  sale_amount?: PostbackScalar;

  @IsOptional()
  reward?: PostbackScalar;

  @IsOptional()
  product_price?: PostbackScalar;

  @IsOptional()
  status?: PostbackScalar;

  @IsOptional()
  is_confirmed?: PostbackScalar;

  @IsOptional()
  signature?: string;

  @IsOptional()
  campaign?: PostbackScalar;

  @IsOptional()
  timestamp?: PostbackScalar;
}
