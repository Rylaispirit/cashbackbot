import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    this.logger.log('Connecting to Prisma datasource...');
    try {
      await this.$connect();
      this.logger.log('Prisma connected');
    } catch (err) {
      this.logger.error(
        `Prisma connection failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw err;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
