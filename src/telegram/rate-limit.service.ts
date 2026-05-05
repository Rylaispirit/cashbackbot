import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Sliding-window rate limiter in-memory cho Telegram user.
 *
 * Giới hạn mặc định: 10 messages / 30s per user. Override qua env:
 *   RATE_LIMIT_MAX (default 10)
 *   RATE_LIMIT_WINDOW_MS (default 30000)
 *
 * Khi scale ra nhiều instance, thay bằng Redis-backed limiter (BullMQ
 * đã có Redis sẵn — dùng key `rl:<telegramId>`).
 */
@Injectable()
export class RateLimitService {
  private readonly buckets = new Map<number, number[]>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(config: ConfigService) {
    this.max = parseInt(config.get<string>('RATE_LIMIT_MAX', '10'), 10);
    this.windowMs = parseInt(config.get<string>('RATE_LIMIT_WINDOW_MS', '30000'), 10);
  }

  /**
   * Trả `true` nếu user còn slot, `false` nếu đã hit limit.
   * Không throw — caller tự reply user.
   */
  check(telegramId: number): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const arr = this.buckets.get(telegramId) ?? [];
    // Loại bỏ các timestamp cũ
    const fresh = arr.filter((t) => t > cutoff);

    if (fresh.length >= this.max) {
      this.buckets.set(telegramId, fresh);
      return false;
    }

    fresh.push(now);
    this.buckets.set(telegramId, fresh);
    return true;
  }

  /**
   * GC định kỳ (gọi từ cron nếu cần). Không bắt buộc với traffic nhỏ.
   */
  gc() {
    const cutoff = Date.now() - this.windowMs;
    for (const [k, v] of this.buckets) {
      const fresh = v.filter((t) => t > cutoff);
      if (fresh.length === 0) this.buckets.delete(k);
      else this.buckets.set(k, fresh);
    }
  }
}
