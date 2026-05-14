import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

import {
  SendMessageInput,
  ZaloBaseResponse,
  ZaloBotInfo,
} from './zalo.types';

/**
 * Wrapper cho Zalo Bot Platform API.
 *
 * Base URL: https://bot-api.zapps.me/bot<TOKEN>/<method>
 *
 * Verified endpoints:
 *   ✅ GET  /getMe                 — bot info
 *   ✅ POST /sendMessage           — gửi text tới chat
 *   ❌ /getUpdates, /getWebhookInfo, /setWebhook — không support (404)
 *
 * Webhook URL phải config qua dashboard bot.zaloplatforms.com, không phải API.
 */
@Injectable()
export class ZaloService implements OnModuleInit {
  private readonly logger = new Logger(ZaloService.name);
  private http: AxiosInstance | null = null;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    const token = this.config.get<string>('ZALO_BOT_TOKEN');
    this.enabled = Boolean(token);
    if (!this.enabled) {
      this.logger.warn('ZALO_BOT_TOKEN trống — Zalo channel sẽ disabled');
      return;
    }

    const base = this.config.get<string>(
      'ZALO_BASE_URL',
      'https://bot-api.zapps.me/bot',
    );
    this.http = axios.create({
      baseURL: `${base}${token}`,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async onModuleInit() {
    if (!this.http) return;
    // Verify token bằng getMe ngay khi boot
    try {
      const info = await this.getMe();
      this.logger.log(
        `Zalo bot connected: ${info?.display_name} (${info?.account_name}, ${info?.account_type})`,
      );
    } catch (err) {
      this.logger.error(
        `Zalo getMe failed at boot: ${(err as Error).message}`,
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled && this.http !== null;
  }

  /**
   * Get bot info. Throws nếu token sai hoặc network fail.
   */
  async getMe(): Promise<ZaloBotInfo | null> {
    if (!this.http) return null;
    const res = await this.http.get<ZaloBaseResponse<ZaloBotInfo>>('/getMe');
    if (!res.data.ok || !res.data.result) {
      throw new Error(
        `Zalo getMe failed: ${res.data.description ?? 'unknown'} (code=${res.data.error_code})`,
      );
    }
    return res.data.result;
  }

  /**
   * Gửi text tới chat. Best-effort — log warn nếu fail, không throw lên caller.
   * (Tương tự pattern NotificationsService.send của Telegram channel.)
   */
  async sendMessage(input: SendMessageInput): Promise<boolean> {
    if (!this.http) {
      this.logger.warn('sendMessage skipped: Zalo channel disabled');
      return false;
    }
    try {
      const res = await this.http.post<ZaloBaseResponse>('/sendMessage', {
        chat_id: input.chatId,
        text: input.text,
      });
      if (!res.data.ok) {
        this.logger.warn(
          `Zalo sendMessage failed chat=${input.chatId}: ${res.data.description} (code=${res.data.error_code})`,
        );
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `Zalo sendMessage error chat=${input.chatId}: ${(err as Error).message}`,
      );
      return false;
    }
  }
}
