import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { ZaloModule } from '../zalo/zalo.module';

@Global()
@Module({
  imports: [ZaloModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
