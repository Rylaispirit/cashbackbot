import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';

import { PostbackService } from './postback.service';
import { AccesstradePostbackDto } from './dto';

/**
 * Endpoint nhận postback từ Accesstrade.
 *
 * Cấu hình URL trong AT dashboard, ví dụ:
 *   POST  https://your-domain.com/api/postback/accesstrade
 *
 * AT thường gửi qua GET với query string. Mình hỗ trợ cả GET lẫn POST cho an toàn.
 */
@Controller('postback')
export class PostbackController {
  private readonly logger = new Logger(PostbackController.name);

  constructor(private readonly postbackService: PostbackService) {}

  @Get('accesstrade')
  @HttpCode(200)
  async handleGet(@Query() query: AccesstradePostbackDto, @Req() req: Request) {
    return this.handle(query, req);
  }

  @Post('accesstrade')
  @HttpCode(200)
  async handlePost(@Body() body: AccesstradePostbackDto, @Req() req: Request) {
    return this.handle(body, req);
  }

  private async handle(payload: AccesstradePostbackDto, req: Request) {
    this.logger.log(
      `Postback received: order=${payload.order_id} status=${payload.status} sub=${payload.aff_sub ?? payload.sub_id}`,
    );

    const verified = this.postbackService.verifySignature(payload, req);
    if (!verified) {
      this.logger.warn(`Postback signature invalid: order=${payload.order_id}`);
      throw new UnauthorizedException('Invalid signature');
    }

    await this.postbackService.processPostback(payload);
    // AT cần response 200 + body "ok" để confirm received
    return { ok: true };
  }
}
