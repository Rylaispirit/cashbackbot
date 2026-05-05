import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Whitelist admin theo Telegram user ID.
 * TELEGRAM_ADMIN_IDS có dạng "123456789,987654321".
 */
@Injectable()
export class AdminGuard {
  private readonly logger = new Logger(AdminGuard.name);
  private readonly adminIds: Set<bigint>;

  constructor(config: ConfigService) {
    const raw = config.get<string>('TELEGRAM_ADMIN_IDS', '');
    this.adminIds = new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s))
        .map((s) => BigInt(s)),
    );
    if (this.adminIds.size === 0) {
      this.logger.warn('Không có TELEGRAM_ADMIN_IDS - các lệnh /admin sẽ không khả dụng');
    } else {
      this.logger.log(`Loaded ${this.adminIds.size} admin id(s)`);
    }
  }

  isAdmin(telegramId: number | bigint): boolean {
    return this.adminIds.has(BigInt(telegramId));
  }
}
