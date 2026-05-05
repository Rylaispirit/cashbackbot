import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('/')
  root() {
    return { name: 'cashbackbot', status: 'ok' };
  }

  @Get('/health')
  health() {
    return { status: 'ok', ts: new Date().toISOString() };
  }
}
