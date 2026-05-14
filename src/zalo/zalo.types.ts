/**
 * Zalo Bot Platform API types.
 *
 * Verified from production data:
 *   - id is STRING (large number, không fit BigInt JS)
 *   - error_code = 0 success, 404 endpoint missing, 410 invalid input
 *   - typo "invaild" trong response của họ — đừng sửa parse
 */

export interface ZaloBaseResponse<T = unknown> {
  ok: boolean;
  description?: string;
  result?: T;
  error_code: number;
}

export interface ZaloBotInfo {
  id: string;
  account_name: string;
  account_type: 'BASIC' | 'STANDARD' | 'GROWTH' | string;
  can_join_groups: boolean;
  display_name: string;
}

export interface ZaloUser {
  id: string;
  display_name?: string;
  is_bot?: boolean;
}

export interface ZaloChat {
  id: string;
  type?: 'private' | 'group';
}

export interface ZaloMessage {
  message_id?: string;
  from: ZaloUser;
  chat: ZaloChat;
  text?: string;
  date?: number;
}

/**
 * Webhook update payload từ Zalo Bot Platform.
 * Shape kế thừa từ Telegram-style API nhưng có thể có biến thể.
 * Sẽ refine sau khi nhận webhook đầu tiên từ Zalo.
 */
export interface ZaloUpdate {
  update_id?: number | string;
  message?: ZaloMessage;
  /** Một số platform gửi event riêng cho follow/unfollow */
  event_name?: string;
  [k: string]: unknown;
}

export interface SendMessageInput {
  chatId: string;
  text: string;
  /** Future: support quick_reply, attachments */
}
