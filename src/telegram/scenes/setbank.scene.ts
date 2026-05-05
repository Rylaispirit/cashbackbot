import { Logger } from '@nestjs/common';
import { Wizard, WizardStep, Ctx, Message, Command } from 'nestjs-telegraf';
import { Scenes } from 'telegraf';

import { UsersService } from '../../users/users.service';

export const SETBANK_SCENE_ID = 'setbank-wizard';

type WizardCtx = Scenes.WizardContext;

interface BankWizardState {
  bankName?: string;
  bankAccount?: string;
  bankHolder?: string;
}

/**
 * Wizard 3 bước cho user nhập thông tin ngân hàng nhận tiền payout.
 * Vào scene này bằng `ctx.scene.enter(SETBANK_SCENE_ID)`.
 */
@Wizard(SETBANK_SCENE_ID)
export class SetBankScene {
  private readonly logger = new Logger(SetBankScene.name);

  constructor(private readonly usersService: UsersService) {}

  @WizardStep(1)
  async step1(@Ctx() ctx: WizardCtx) {
    await ctx.reply(
      [
        '🏦 Cài đặt tài khoản nhận tiền (3 bước)',
        '',
        'Bước 1/3: Tên ngân hàng',
        'Ví dụ: Vietcombank, Techcombank, MB Bank',
        '',
        'Gõ /cancel để huỷ.',
      ].join('\n'),
    );
    ctx.wizard.next();
  }

  @WizardStep(2)
  async step2(@Ctx() ctx: WizardCtx, @Message('text') text: string) {
    if (!text || text.length < 2 || text.length > 50) {
      await ctx.reply('Tên ngân hàng không hợp lệ. Nhập lại nhé.');
      return;
    }
    const state = ctx.wizard.state as BankWizardState;
    state.bankName = text.trim();

    await ctx.reply('Bước 2/3: Số tài khoản\n\nVí dụ: 0123456789');
    ctx.wizard.next();
  }

  @WizardStep(3)
  async step3(@Ctx() ctx: WizardCtx, @Message('text') text: string) {
    if (!text || !/^[0-9]{6,20}$/.test(text.trim())) {
      await ctx.reply('Số tài khoản chỉ chứa số (6–20 chữ số). Nhập lại nhé.');
      return;
    }
    const state = ctx.wizard.state as BankWizardState;
    state.bankAccount = text.trim();

    await ctx.reply('Bước 3/3: Tên chủ tài khoản (KHÔNG dấu)\n\nVí dụ: NGUYEN VAN A');
    ctx.wizard.next();
  }

  @WizardStep(4)
  async step4(@Ctx() ctx: WizardCtx, @Message('text') text: string) {
    if (!text || text.length < 3 || text.length > 60) {
      await ctx.reply('Tên chủ tài khoản không hợp lệ. Nhập lại nhé.');
      return;
    }
    const state = ctx.wizard.state as BankWizardState;
    state.bankHolder = text.trim().toUpperCase();

    const from = ctx.from;
    if (!from) {
      await ctx.scene.leave();
      return;
    }

    const user = await this.usersService.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply('Bạn chưa đăng ký. Gõ /start trước nhé.');
      await ctx.scene.leave();
      return;
    }

    await this.usersService.updateBankInfo(user.id, {
      bankName: state.bankName!,
      bankAccount: state.bankAccount!,
      bankHolder: state.bankHolder!,
    });

    await ctx.reply(
      [
        '✅ Đã lưu thông tin ngân hàng:',
        '',
        `🏦 ${state.bankName}`,
        `💳 ${state.bankAccount}`,
        `👤 ${state.bankHolder}`,
        '',
        'Có thể đổi bất kỳ lúc nào bằng lệnh /setbank.',
      ].join('\n'),
    );
    await ctx.scene.leave();
  }

  @Command('cancel')
  async onCancel(@Ctx() ctx: WizardCtx) {
    await ctx.reply('Đã huỷ thao tác cài đặt ngân hàng.');
    await ctx.scene.leave();
  }
}
