import axios from 'axios';
import { config } from '../config.js';
import type { Trade } from '../monitor.js';

export interface DashboardTradeMetadata {
  eventUrl?: string;
  minOrderSize?: number;
  tickSize?: number;
}

function toEventUrl(slug: string): string {
  return `https://polymarket.com/event/${slug}`;
}

export class DashboardTradeMetadataResolver {
  private readonly metadataByMarket = new Map<string, DashboardTradeMetadata>();
  private readonly metadataByToken = new Map<string, DashboardTradeMetadata>();

  async resolve(trade: Trade): Promise<DashboardTradeMetadata> {
    const cached = this.metadataByToken.get(trade.tokenId) || this.metadataByMarket.get(trade.market);
    const next: DashboardTradeMetadata = { ...(cached || {}) };

    const directSlug = trade.eventSlug || trade.slug;
    if (directSlug && !next.eventUrl) {
      next.eventUrl = toEventUrl(directSlug);
    }

    if (next.minOrderSize === undefined || next.tickSize === undefined) {
      const orderbook = await this.fetchOrderbookSummary(trade.tokenId);
      if (orderbook) {
        const minOrderSize = this.parseMaybeNumber(orderbook.min_order_size);
        const tickSize = this.parseMaybeNumber(orderbook.tick_size);
        if (minOrderSize !== undefined) {
          next.minOrderSize = minOrderSize;
        }
        if (tickSize !== undefined) {
          next.tickSize = tickSize;
        }
      }
    }

    if (!next.eventUrl) {
      const activityInfo = await this.fetchActivityInfo(trade);
      if (activityInfo?.eventUrl) {
        next.eventUrl = activityInfo.eventUrl;
      }
    }

    this.cache(trade, next);
    return next;
  }

  private async fetchOrderbookSummary(tokenId: string): Promise<{ min_order_size?: string; tick_size?: string } | undefined> {
    try {
      const response = await axios.get('https://clob.polymarket.com/book', {
        params: {
          token_id: tokenId,
        },
        headers: {
          Accept: 'application/json',
        },
      });
      return response.data;
    } catch {
      return undefined;
    }
  }

  private async fetchActivityInfo(trade: Trade): Promise<{ eventUrl?: string } | undefined> {
    try {
      const response = await axios.get('https://data-api.polymarket.com/activity', {
        params: {
          user: config.targetWallet.toLowerCase(),
          type: 'TRADE',
          market: trade.market,
          limit: 5,
          sortBy: 'TIMESTAMP',
          sortDirection: 'DESC',
        },
        headers: {
          Accept: 'application/json',
        },
      });

      const match = Array.isArray(response.data)
        ? response.data.find((item: any) => item?.asset === trade.tokenId) || response.data[0]
        : undefined;
      const slug = match?.eventSlug || match?.slug;
      return slug ? { eventUrl: toEventUrl(slug) } : undefined;
    } catch {
      return undefined;
    }
  }

  private cache(trade: Trade, metadata: DashboardTradeMetadata): void {
    this.metadataByMarket.set(trade.market, metadata);
    this.metadataByToken.set(trade.tokenId, metadata);
  }

  private parseMaybeNumber(value: unknown): number | undefined {
    const parsed = typeof value === 'string' ? parseFloat(value) : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}
