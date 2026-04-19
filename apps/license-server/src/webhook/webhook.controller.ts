import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { WebhookService } from './webhook.service';

/**
 * Payment webhooks — called by external merchants of record
 * (Lemon Squeezy, Gumroad, Paddle, etc) to auto-issue purchase codes
 * when a buyer completes checkout.
 *
 * Auth: each provider signs the request body with a shared secret.
 * The matching env var holds that secret, we recompute the HMAC
 * over the RAW bytes (not the parsed JSON — JSON re-serialization
 * loses whitespace the provider signed) and timing-safe compare.
 *
 * Idempotency: providers retry failed deliveries. We key on the
 * order/subscription ID from the payload; if a code was already
 * minted for that ID, we return the EXISTING one instead of
 * creating a duplicate.
 */
@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly service: WebhookService) {}

  /**
   * Lemon Squeezy event. Body is JSON; signature is base64 SHA256
   * HMAC in the `X-Signature` header.
   *
   * We only care about order_created / subscription_created events
   * — other event types get a 200 OK with {ok:true, skipped:true}
   * so Lemon Squeezy doesn't retry.
   */
  @Post('lemon-squeezy')
  @HttpCode(HttpStatus.OK)
  async lemonSqueezy(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature') signature: string | undefined,
    @Body() body: LemonSqueezyEvent,
  ) {
    const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
    if (!secret) {
      this.logger.error('LEMON_SQUEEZY_WEBHOOK_SECRET not set — refusing webhook');
      throw new UnauthorizedException({ result: 'WEBHOOK_NOT_CONFIGURED' });
    }
    if (!signature) throw new UnauthorizedException({ result: 'MISSING_SIGNATURE' });
    if (!req.rawBody) throw new BadRequestException({ result: 'RAW_BODY_REQUIRED' });

    // HMAC over the RAW request body — re-stringifying the parsed
    // JSON would lose the exact byte sequence Lemon Squeezy signed.
    const expected = createHmac('sha256', secret).update(req.rawBody).digest('hex');
    const got = signature.trim();
    if (expected.length !== got.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(got))) {
      this.logger.warn('Lemon Squeezy signature mismatch — dropping event');
      throw new UnauthorizedException({ result: 'BAD_SIGNATURE' });
    }

    const eventName = body?.meta?.event_name;
    if (!eventName) throw new BadRequestException({ result: 'BAD_PAYLOAD' });

    // Only act on the two event types that should mint a code.
    // Everything else (refund, subscription_updated, etc) acks
    // cleanly so Lemon Squeezy stops retrying, but does nothing.
    if (eventName !== 'order_created' && eventName !== 'subscription_created') {
      this.logger.log(`Lemon Squeezy event "${eventName}" — ignored`);
      return { ok: true, skipped: true, event: eventName };
    }

    const result = await this.service.handleLemonSqueezy(body);
    return { ok: true, ...result };
  }
}

// Payload shape we care about. Lemon Squeezy sends much more;
// we pull only what's needed to mint a code.
export interface LemonSqueezyEvent {
  meta: {
    event_name: string;
    // custom_data lets the checkout link pass a product SKU through
    // to the webhook without us having to maintain a variant-ID
    // → product-SKU mapping table. Seller sets custom_data when
    // creating the Lemon Squeezy buy link.
    custom_data?: { product_sku?: string; max_activations?: string | number };
  };
  data: {
    id: string; // order or subscription id — our idempotency key
    attributes: {
      identifier?: string; // order number
      store_id?: number;
      customer_id?: number;
      user_email?: string;
      user_name?: string;
      total?: number;
      currency?: string;
      status?: string;
      first_order_item?: {
        product_id?: number;
        variant_id?: number;
        product_name?: string;
        variant_name?: string;
      };
    };
  };
}
