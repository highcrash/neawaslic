-- Add WEBHOOK to PurchaseCodeSource enum for codes auto-minted by
-- payment-provider webhooks (Lemon Squeezy, Gumroad, Paddle, etc).
ALTER TYPE "PurchaseCodeSource" ADD VALUE IF NOT EXISTS 'WEBHOOK';
