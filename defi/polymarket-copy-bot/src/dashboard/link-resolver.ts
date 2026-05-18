import axios from 'axios';
import { config } from '../config.js';
import type { Trade } from '../monitor.js';

function toEventUrl(slug: string): string {
  return `https://polymarket.com/event/${slug}`;
}

export class DashboardLinkResolver {
  private readonly eventUrlByMarket = new Map<string, string>();
  private readonly eventUrlByToken = new Map<string, string>();

  async resolveTradeUrl(trade: Trade): Promise<string | undefined> {
    const directSlug = trade.eventSlug || trade.slug;
    if (directSlug) {
      const url = toEventUrl(directSlug);
      this.cache(trade, url);
      return url;
    }

    const cached = this.eventUrlByToken.get(trade.tokenId) || this.eventUrlByMarket.get(trade.market);
    if (cached) {
      return cached;
    }

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
      if (!slug) {
        return undefined;
      }

      const url = toEventUrl(slug);
      this.cache(trade, url);
      return url;
    } catch {
      return undefined;
    }
  }

  private cache(trade: Trade, url: string): void {
    this.eventUrlByMarket.set(trade.market, url);
    this.eventUrlByToken.set(trade.tokenId, url);
  }
}
