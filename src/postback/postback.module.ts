import { Module } from '@nestjs/common';
import { PostbackController } from './postback.controller';
import { PostbackService } from './postback.service';

@Module({
  controllers: [PostbackController],
  providers: [PostbackService],
})
export class PostbackModule {}
