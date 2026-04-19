import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LogService } from '../log/log.service';
import type { LemonSqueezyEvent } from './webhook.controller';

/**
 * Purchase-code minter driven by payment-provider webhooks.
 *
 * Idempotency key: `<provider>:<order-id>`. Stored in the
 * PurchaseCode.notes field as a JSON blob so we can look up "has a
 * code already been issued for this order?" without a dedicated
 * column. Providers retry failed webhooks (bad network, our 5xx),
 * so idempotency is load-bearing.
 *
 * Product routing: the seller sets `custom_data.product_sku` on the
 * Lemon Squeezy buy link so one webhook endpoint can serve all
 * products. Fallback: if no sku is present, we try to match by
 * Lemon Squeezy variant_id via Product.envatoItemId (reusing that
 * column for any integer external ID — the name is legacy but the
 * column is opaque storage).
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly log: LogService,
  ) {}

  async handleLemonSqueezy(event: LemonSqueezyEvent): Promise<{
    code: string;
    productSku: string;
    email: string | null;
    reused: boolean;
  }> {
    const orderId = event.data.id;
    const idempotencyKey = `lemon-squeezy:${orderId}`;
    const email = event.data.attributes.user_email ?? null;
    const customerName = event.data.attributes.user_name ?? null;

    // Check for prior issuance.
    const prior = await this.prisma.purchaseCode.findFirst({
      where: { notes: { contains: idempotencyKey } },
    });
    if (prior) {
      this.logger.log(`idempotent replay: ${idempotencyKey} → existing code ${prior.code}`);
      return {
        code: prior.code,
        productSku: await this.skuFor(prior.productId),
        email,
        reused: true,
      };
    }

    // Resolve product. Prefer custom_data.product_sku (explicit),
    // fallback to variant_id via Product.envatoItemId.
    const requestedSku = event.meta.custom_data?.product_sku;
    const variantId = event.data.attributes.first_order_item?.variant_id;
    const product = requestedSku
      ? await this.prisma.product.findUnique({ where: { sku: requestedSku } })
      : variantId
        ? await this.prisma.product.findFirst({ where: { envatoItemId: String(variantId) } })
        : null;
    if (!product) {
      this.logger.error(
        `Lemon Squeezy webhook: can't resolve product (sku=${requestedSku ?? 'none'}, variant=${variantId ?? 'none'})`,
      );
      throw new NotFoundException({
        result: 'PRODUCT_NOT_FOUND',
        message:
          'No product matched this webhook. Set custom_data.product_sku on the Lemon Squeezy buy link, ' +
          'or configure Product.envatoItemId with the Lemon Squeezy variant_id.',
      });
    }

    // Max activations — mirrors the seller's pricing tiers. Default
    // to 1 for single-restaurant licenses.
    const maxRaw = event.meta.custom_data?.max_activations;
    const maxActivations = typeof maxRaw === 'number'
      ? maxRaw
      : typeof maxRaw === 'string' && !isNaN(parseInt(maxRaw, 10))
        ? parseInt(maxRaw, 10)
        : 1;

    // Generate + persist. Matches the admin-issue path's format.
    const code = generateCode();
    const codeHash = createHash('sha256').update(code, 'utf8').digest('hex');
    const notes = JSON.stringify({
      idempotencyKey,
      provider: 'lemon-squeezy',
      orderId,
      email,
      customerName,
      variantName: event.data.attributes.first_order_item?.variant_name,
      total: event.data.attributes.total,
      currency: event.data.attributes.currency,
    });

    const row = await this.prisma.purchaseCode.create({
      data: {
        productId: product.id,
        code,
        codeHash,
        source: 'WEBHOOK',
        maxActivations,
        envatoBuyer: email,           // reusing the column for buyer contact
        envatoSoldAt: new Date(),     // reusing the column for sold-at timestamp
        notes,
      },
    });

    this.log.write({
      action: 'ACTIVATE',  // closest existing enum; no new one needed just for issuance
      result: `webhook-issued:${row.code}`,
      productId: product.id,
      userAgent: 'lemon-squeezy-webhook',
      detail: { orderId, email, provider: 'lemon-squeezy' },
    });

    this.logger.log(`issued ${code} for product ${product.sku} (${email ?? 'no email'})`);
    return { code: row.code, productSku: product.sku, email, reused: false };
  }

  private async skuFor(productId: string): Promise<string> {
    const p = await this.prisma.product.findUnique({ where: { id: productId }, select: { sku: true } });
    return p?.sku ?? 'unknown';
  }
}

function generateCode(): string {
  // 32 chars, alphanumeric (no ambiguous 0/O/I/1), grouped like XXXX-XXXX-XXXX-XXXX.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const parts: string[] = [];
  for (let g = 0; g < 4; g++) {
    let grp = '';
    for (let i = 0; i < 8; i++) grp += chars[Math.floor(Math.random() * chars.length)];
    parts.push(grp);
  }
  return parts.join('-');
}
