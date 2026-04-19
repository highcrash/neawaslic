import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

/**
 * Inbound payment-provider webhooks. Only uses PrismaModule — the
 * LogService is available globally via LogModule already being
 * @Global() elsewhere in the app.
 */
@Module({
  imports: [PrismaModule],
  controllers: [WebhookController],
  providers: [WebhookService],
})
export class WebhookModule {}
