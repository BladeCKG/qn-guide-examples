import { calculateCopySize, config, validateConfig } from './config.js';
import { TradeMonitor } from './monitor.js';
import { WebSocketMonitor } from './websocket-monitor.js';
import type { Trade } from './monitor.js';
import { PositionTracker } from './positions.js';
import { RiskManager } from './risk-manager.js';
import { TradeExecutor } from './trader.js';

interface ExecutionPlan {
  copyNotional: number;
  copySharesOverride?: number;
}

class PolymarketCopyBot {
  private monitor: TradeMonitor;
  private wsMonitor: WebSocketMonitor | undefined;
  private executor?: TradeExecutor;
  private positions: PositionTracker;
  private risk: RiskManager;
  private isRunning = false;
  private processedTrades: Set<string> = new Set();
  private botStartTime = 0;
  private readonly maxProcessedTrades = 10000;
  private stats = {
    tradesDetected: 0,
    tradesCopied: 0,
    tradesFailed: 0,
    tradesSimulated: 0,
    totalVolume: 0,
  };

  constructor() {
    this.monitor = new TradeMonitor();
    this.positions = new PositionTracker();
    this.risk = new RiskManager(this.positions);
  }

  async initialize(): Promise<void> {
    console.log('Polymarket Copy Trading Bot');
    console.log('================================');
    console.log(`Target wallet: ${config.targetWallet}`);
    console.log(`Dry run: ${config.trading.dryRun ? 'Enabled' : 'Disabled'}`);
    console.log(`Position multiplier: ${config.trading.positionSizeMultiplier * 100}%`);
    console.log(`Max trade size: ${config.trading.maxTradeSize} USDC`);
    console.log(`Order type: ${config.trading.orderType}`);
    console.log(`WebSocket: ${config.monitoring.useWebSocket ? 'Enabled' : 'Disabled'}`);
    if (config.risk.maxSessionNotional > 0 || config.risk.maxPerMarketNotional > 0) {
      console.log(
        `Risk caps: session=${config.risk.maxSessionNotional || 'inf'} USDC, per-market=${config.risk.maxPerMarketNotional || 'inf'} USDC`
      );
    }
    if (!config.trading.dryRun) {
      console.log('Auth mode: EOA (signature type 0)');
    }
    console.log('================================\n');

    validateConfig();

    this.botStartTime = Date.now();
    console.log(`Bot start time: ${new Date(this.botStartTime).toISOString()}`);
    console.log('   (Only trades after this time will be copied)\n');

    await this.monitor.initialize();

    const needsExecutor = !config.trading.dryRun || config.monitoring.useUserChannel;
    if (needsExecutor) {
      this.executor = new TradeExecutor();
      await this.executor.initialize({ enableTrading: !config.trading.dryRun });

      if (!config.trading.dryRun) {
        await this.reconcilePositions();
      }
    } else {
      console.log('Dry run without user-channel auth: skipping trader initialization');
    }

    if (config.monitoring.useWebSocket) {
      this.wsMonitor = new WebSocketMonitor();
      try {
        const channel = config.monitoring.useUserChannel ? 'user' : 'market';
        const wsAuth = config.monitoring.useUserChannel ? this.executor?.getWsAuth() : undefined;
        await this.wsMonitor.initialize(this.handleNewTrade.bind(this), channel, wsAuth);
        console.log(`WebSocket monitor initialized (${channel} channel)\n`);

        if (channel === 'market' && config.monitoring.wsAssetIds.length > 0) {
          for (const assetId of config.monitoring.wsAssetIds) {
            await this.wsMonitor.subscribeToMarket(assetId);
          }
        }

        if (channel === 'user' && config.monitoring.wsMarketIds.length > 0) {
          for (const marketId of config.monitoring.wsMarketIds) {
            await this.wsMonitor.subscribeToCondition(marketId);
          }
        }
      } catch (error) {
        console.error('WebSocket initialization failed, falling back to REST API only');
        console.error('   Error:', error);
        this.wsMonitor = undefined;
      }
    }
  }

  async start(): Promise<void> {
    this.isRunning = true;
    const monitoringMethods = [];
    if (this.wsMonitor) monitoringMethods.push('WebSocket');
    monitoringMethods.push('REST API');

    console.log(`Bot started. Monitoring via: ${monitoringMethods.join(' + ')}\n`);

    while (this.isRunning) {
      try {
        await this.monitor.pollForNewTrades(this.handleNewTrade.bind(this));
        this.monitor.pruneProcessedHashes();
      } catch (error) {
        console.error('Error in monitoring loop:', error);
      }

      await this.sleep(config.monitoring.pollInterval);
    }
  }

  private async handleNewTrade(trade: Trade): Promise<void> {
    if (trade.timestamp && trade.timestamp < this.botStartTime) {
      return;
    }

    const tradeKeys = this.getTradeKeys(trade);
    if (tradeKeys.some((key) => this.processedTrades.has(key))) {
      return;
    }

    for (const key of tradeKeys) {
      this.processedTrades.add(key);
    }
    this.pruneProcessedTrades();
    this.stats.tradesDetected++;

    console.log('\n' + '='.repeat(50));
    console.log('NEW TRADE DETECTED');
    console.log(`   Time: ${new Date(trade.timestamp).toISOString()}`);
    console.log(`   Market: ${trade.market}`);
    console.log(`   Side: ${trade.side} ${trade.outcome}`);
    console.log(`   Size: ${trade.size} USDC @ ${trade.price.toFixed(3)}`);
    console.log(`   Token ID: ${trade.tokenId}`);
    console.log('='.repeat(50));

    if (this.wsMonitor && !config.monitoring.useUserChannel) {
      await this.wsMonitor.subscribeToMarket(trade.tokenId);
    }

    const plan = this.buildExecutionPlan(trade);
    if (!plan) {
      return;
    }

    if (config.trading.dryRun) {
      this.stats.tradesSimulated++;
      console.log(
        `DRY RUN: would copy ${trade.side} ${plan.copyNotional.toFixed(2)} USDC` +
          (plan.copySharesOverride ? ` (${plan.copySharesOverride} shares)` : '')
      );
      return;
    }

    const riskCheck = this.risk.checkTrade(trade, plan.copyNotional);
    if (!riskCheck.allowed) {
      console.log(`Risk check blocked trade: ${riskCheck.reason}`);
      return;
    }

    if (!this.executor) {
      this.stats.tradesFailed++;
      console.log('Failed to copy trade');
      console.log('   Reason: trader not initialized');
      return;
    }

    try {
      const executionOptions =
        plan.copySharesOverride === undefined
          ? { copyNotionalOverride: plan.copyNotional }
          : { copyNotionalOverride: plan.copyNotional, copySharesOverride: plan.copySharesOverride };
      const result = await this.executor.executeCopyTrade(trade, executionOptions);
      this.risk.recordFill({
        trade,
        notional: result.copyNotional,
        shares: result.copyShares,
        price: result.price,
        side: result.side,
      });
      this.stats.tradesCopied++;
      this.stats.totalVolume += result.copyNotional;
      console.log('Successfully copied trade');
      console.log(
        `Session Stats: ${this.stats.tradesCopied}/${this.stats.tradesDetected} copied, ${this.stats.tradesFailed} failed`
      );
    } catch (error: any) {
      this.stats.tradesFailed++;
      console.log('Failed to copy trade');
      if (error?.message) {
        console.log(`   Reason: ${error.message}`);
      }
      console.log(
        `Session Stats: ${this.stats.tradesCopied}/${this.stats.tradesDetected} copied, ${this.stats.tradesFailed} failed`
      );
    }
  }

  private buildExecutionPlan(trade: Trade): ExecutionPlan | undefined {
    const desiredCopyNotional = calculateCopySize(trade.size);

    if (trade.side === 'BUY') {
      return { copyNotional: desiredCopyNotional };
    }

    if (config.trading.dryRun) {
      return {
        copyNotional: desiredCopyNotional,
        copySharesOverride: Math.round((desiredCopyNotional / Math.max(trade.price, 0.0001)) * 10000) / 10000,
      };
    }

    const position = this.positions.getPosition(trade.tokenId);
    if (!position || position.shares <= 0) {
      console.log('Skipping SELL copy: no tracked position for this token');
      return undefined;
    }

    const requestedShares = desiredCopyNotional / Math.max(trade.price, 0.0001);
    const sellShares = Math.min(position.shares, Math.round(requestedShares * 10000) / 10000);
    if (sellShares <= 0) {
      console.log('Skipping SELL copy: sell size resolves to 0 shares');
      return undefined;
    }

    const cappedNotional = Math.round(sellShares * trade.price * 100) / 100;
    if (sellShares < requestedShares) {
      console.log(
        `Capping SELL copy to current position: ${sellShares} shares (~${cappedNotional.toFixed(2)} USDC)`
      );
    }

    return {
      copyNotional: cappedNotional,
      copySharesOverride: sellShares,
    };
  }

  private async reconcilePositions(): Promise<void> {
    if (!this.executor) {
      return;
    }

    try {
      const positions = await this.executor.getPositions();
      if (!positions || positions.length === 0) {
        console.log('Positions: none found (fresh session)');
        this.risk.syncWithPositions();
        return;
      }

      const { loaded, skipped } = this.positions.loadFromClobPositions(positions);
      this.risk.syncWithPositions();
      const totalNotional = this.positions.getTotalNotional();
      console.log(`Positions loaded: ${loaded} (skipped ${skipped}), total notional ~= ${totalNotional.toFixed(2)} USDC`);
    } catch (error: any) {
      console.log(`Positions reconciliation failed: ${error.message || 'Unknown error'}`);
    }
  }

  stop(): void {
    this.isRunning = false;

    if (this.wsMonitor) {
      this.wsMonitor.close();
    }

    console.log('\nBot stopped');
    this.printStats();
  }

  printStats(): void {
    console.log('\nSession Statistics:');
    console.log(`   Trades detected: ${this.stats.tradesDetected}`);
    console.log(`   Trades copied: ${this.stats.tradesCopied}`);
    console.log(`   Trades simulated: ${this.stats.tradesSimulated}`);
    console.log(`   Trades failed: ${this.stats.tradesFailed}`);
    console.log(`   Total volume: ${this.stats.totalVolume.toFixed(2)} USDC`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getTradeKeys(trade: Trade): string[] {
    const keys: string[] = [];

    if (trade.txHash) {
      keys.push(trade.txHash);
    }

    const fallbackKey = `${trade.tokenId}|${trade.side}|${trade.size}|${trade.price}|${trade.timestamp}`;
    keys.push(fallbackKey);

    return keys;
  }

  private pruneProcessedTrades(): void {
    if (this.processedTrades.size <= this.maxProcessedTrades) {
      return;
    }

    const entries = Array.from(this.processedTrades);
    this.processedTrades = new Set(entries.slice(-Math.floor(this.maxProcessedTrades / 2)));
  }
}

async function main() {
  const bot = new PolymarketCopyBot();

  process.on('SIGINT', () => {
    console.log('\n\nReceived SIGINT, shutting down...');
    bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    bot.stop();
    process.exit(0);
  });

  try {
    await bot.initialize();
    await bot.start();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
