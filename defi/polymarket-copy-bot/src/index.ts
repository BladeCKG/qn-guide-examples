import { calculateCopySize, config, validateConfig } from './config.js';
import { DashboardLinkResolver } from './dashboard/link-resolver.js';
import { DashboardServer } from './dashboard/server.js';
import { DashboardStore } from './dashboard/store.js';
import type { DashboardConfigSummary, DashboardStats, EventCategory, EventLevel } from './dashboard/types.js';
import { TradeMonitor } from './monitor.js';
import type { Trade } from './monitor.js';
import { PositionTracker } from './positions.js';
import { RiskManager } from './risk-manager.js';
import { TradeExecutor } from './trader.js';
import { WebSocketMonitor } from './websocket-monitor.js';

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
  private dashboardStore: DashboardStore;
  private dashboardServer?: DashboardServer;
  private dashboardLinkResolver: DashboardLinkResolver;
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
    dryRunRealizedPnl: 0,
  };

  constructor() {
    this.monitor = new TradeMonitor();
    this.positions = new PositionTracker();
    this.risk = new RiskManager(this.positions);
    this.dashboardLinkResolver = new DashboardLinkResolver();
    this.dashboardStore = new DashboardStore({
      status: {
        phase: 'idle',
        lastUpdatedAt: new Date().toISOString(),
        websocketMode: this.getWebSocketMode(),
        targetWallet: config.targetWallet,
        dashboardEnabled: config.dashboard.enabled,
        dashboardPort: config.dashboard.port,
      },
      stats: this.createDashboardStats(),
      config: this.createDashboardConfigSummary(),
    });
  }

  async initialize(): Promise<void> {
    this.dashboardStore.updateStatus({ phase: 'initializing' });
    this.recordEvent('info', 'system', 'Bot initialization started');

    if (config.dashboard.enabled) {
      try {
        const dashboardServer = new DashboardServer(this.dashboardStore, config.dashboard.port);
        await dashboardServer.start();
        this.dashboardServer = dashboardServer;
        console.log(`Dashboard available at ${dashboardServer.getUrl()}`);
        this.recordEvent('success', 'dashboard', 'Dashboard server started', dashboardServer.getUrl());
      } catch (error: any) {
        console.error('Failed to start dashboard server:', error?.message || error);
        this.recordEvent('error', 'dashboard', 'Dashboard server failed to start', error?.message || 'Unknown error');
      }
    }

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
    this.recordEvent('success', 'system', 'Configuration validated');

    this.botStartTime = Date.now();
    this.dashboardStore.updateStatus({ startedAt: new Date(this.botStartTime).toISOString() });
    console.log(`Bot start time: ${new Date(this.botStartTime).toISOString()}`);
    console.log('   (Only trades after this time will be copied)\n');

    await this.monitor.initialize();
    this.recordEvent('success', 'network', 'REST trade monitor initialized');

    const needsExecutor = !config.trading.dryRun || config.monitoring.useUserChannel;
    if (needsExecutor) {
      this.executor = new TradeExecutor();
      await this.executor.initialize({ enableTrading: !config.trading.dryRun });
      this.recordEvent(
        'success',
        'system',
        'Trade executor initialized',
        config.trading.dryRun ? 'Dry-run auth mode only' : 'Live trading enabled'
      );

      if (!config.trading.dryRun) {
        await this.reconcilePositions();
      }
    } else {
      console.log('Dry run without user-channel auth: skipping trader initialization');
      this.recordEvent('info', 'system', 'Skipping trader initialization in dry-run mode');
    }

    if (config.monitoring.useWebSocket) {
      this.wsMonitor = new WebSocketMonitor();
      try {
        const channel = config.monitoring.useUserChannel ? 'user' : 'market';
        const wsAuth = config.monitoring.useUserChannel ? this.executor?.getWsAuth() : undefined;
        await this.wsMonitor.initialize(this.handleNewTrade.bind(this), channel, wsAuth);
        console.log(`WebSocket monitor initialized (${channel} channel)\n`);
        this.recordEvent('success', 'network', `WebSocket monitor initialized (${channel})`);

        if (channel === 'market' && config.monitoring.wsAssetIds.length > 0) {
          for (const assetId of config.monitoring.wsAssetIds) {
            await this.wsMonitor.subscribeToMarket(assetId);
          }
          this.recordEvent('info', 'network', 'Seeded WebSocket market subscriptions', config.monitoring.wsAssetIds.join(', '));
        }

        if (channel === 'user' && config.monitoring.wsMarketIds.length > 0) {
          for (const marketId of config.monitoring.wsMarketIds) {
            await this.wsMonitor.subscribeToCondition(marketId);
          }
          this.recordEvent('info', 'network', 'Seeded WebSocket user subscriptions', config.monitoring.wsMarketIds.join(', '));
        }
      } catch (error: any) {
        console.error('WebSocket initialization failed, falling back to REST API only');
        console.error('   Error:', error);
        this.recordEvent('warning', 'network', 'WebSocket initialization failed, using REST only', error?.message || 'Unknown error');
        this.wsMonitor = undefined;
      }
    }

    this.refreshDashboardState();
  }

  async start(): Promise<void> {
    this.isRunning = true;
    this.dashboardStore.updateStatus({ phase: 'running' });
    const monitoringMethods = [];
    if (this.wsMonitor) monitoringMethods.push('WebSocket');
    monitoringMethods.push('REST API');

    console.log(`Bot started. Monitoring via: ${monitoringMethods.join(' + ')}\n`);
    this.recordEvent('success', 'system', 'Bot started', monitoringMethods.join(' + '));

    while (this.isRunning) {
      try {
        await this.monitor.pollForNewTrades(this.handleNewTrade.bind(this));
        this.monitor.pruneProcessedHashes();
      } catch (error: any) {
        console.error('Error in monitoring loop:', error);
        this.recordEvent('error', 'network', 'Error in monitoring loop', error?.message || 'Unknown error');
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
    this.refreshDashboardState();

    console.log('\n' + '='.repeat(50));
    console.log('NEW TRADE DETECTED');
    console.log(`   Time: ${new Date(trade.timestamp).toISOString()}`);
    console.log(`   Market: ${trade.market}`);
    console.log(`   Side: ${trade.side} ${trade.outcome}`);
    console.log(`   Size: ${trade.size} USDC @ ${trade.price.toFixed(3)}`);
    console.log(`   Token ID: ${trade.tokenId}`);
    console.log('='.repeat(50));
    this.recordEvent('info', 'trade', `Detected ${trade.side} trade`, `${trade.market} @ ${trade.price.toFixed(3)} for ${trade.size} USDC`);

    if (this.wsMonitor && !config.monitoring.useUserChannel) {
      await this.wsMonitor.subscribeToMarket(trade.tokenId);
    }

    const plan = this.buildExecutionPlan(trade);
    if (!plan) {
      await this.appendDashboardTrade(trade, {
        market: trade.market,
        tokenId: trade.tokenId,
        side: trade.side,
        outcome: trade.outcome,
        targetPrice: trade.price,
        targetSize: trade.size,
        copyNotional: 0,
        status: 'skipped',
        mode: config.trading.dryRun ? 'dry-run' : 'live',
        message: 'No executable plan for this trade',
      });
      return;
    }

    if (config.trading.dryRun) {
      this.handleDryRunTrade(trade, plan);
      return;
    }

    const riskCheck = this.risk.checkTrade(trade, plan.copyNotional);
    if (!riskCheck.allowed) {
      console.log(`Risk check blocked trade: ${riskCheck.reason}`);
      await this.appendDashboardTrade(trade, {
        market: trade.market,
        tokenId: trade.tokenId,
        side: trade.side,
        outcome: trade.outcome,
        targetPrice: trade.price,
        targetSize: trade.size,
        copyNotional: plan.copyNotional,
        status: 'blocked',
        mode: 'live',
        ...(plan.copySharesOverride === undefined ? {} : { copyShares: plan.copySharesOverride }),
        ...(riskCheck.reason === undefined ? {} : { message: riskCheck.reason }),
      });
      this.recordEvent('warning', 'risk', 'Risk check blocked trade', riskCheck.reason);
      return;
    }

    if (!this.executor) {
      this.stats.tradesFailed++;
      this.refreshDashboardState();
      console.log('Failed to copy trade');
      console.log('   Reason: trader not initialized');
      await this.appendDashboardTrade(trade, {
        market: trade.market,
        tokenId: trade.tokenId,
        side: trade.side,
        outcome: trade.outcome,
        targetPrice: trade.price,
        targetSize: trade.size,
        copyNotional: plan.copyNotional,
        status: 'failed',
        mode: 'live',
        message: 'Trader not initialized',
        ...(plan.copySharesOverride === undefined ? {} : { copyShares: plan.copySharesOverride }),
      });
      this.recordEvent('error', 'system', 'Trade execution failed', 'Trader not initialized');
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
      this.publishPositions();
      this.refreshDashboardState();

      console.log('Successfully copied trade');
      console.log(
        `Session Stats: ${this.stats.tradesCopied}/${this.stats.tradesDetected} copied, ${this.stats.tradesFailed} failed`
      );
      await this.appendDashboardTrade(trade, {
        market: trade.market,
        tokenId: trade.tokenId,
        side: result.side,
        outcome: trade.outcome,
        targetPrice: result.price,
        targetSize: trade.size,
        copyNotional: result.copyNotional,
        copyShares: result.copyShares,
        status: 'copied',
        mode: 'live',
        message: `Order ${result.orderId}`,
      });
      this.recordEvent('success', 'trade', 'Trade copied successfully', `${result.side} ${result.copyNotional.toFixed(2)} USDC`);
    } catch (error: any) {
      this.stats.tradesFailed++;
      this.refreshDashboardState();
      console.log('Failed to copy trade');
      if (error?.message) {
        console.log(`   Reason: ${error.message}`);
      }
      console.log(
        `Session Stats: ${this.stats.tradesCopied}/${this.stats.tradesDetected} copied, ${this.stats.tradesFailed} failed`
      );
      await this.appendDashboardTrade(trade, {
        market: trade.market,
        tokenId: trade.tokenId,
        side: trade.side,
        outcome: trade.outcome,
        targetPrice: trade.price,
        targetSize: trade.size,
        copyNotional: plan.copyNotional,
        status: 'failed',
        mode: 'live',
        message: error?.message || 'Unknown error',
        ...(plan.copySharesOverride === undefined ? {} : { copyShares: plan.copySharesOverride }),
      });
      this.recordEvent('error', 'trade', 'Trade copy failed', error?.message || 'Unknown error');
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
      this.recordEvent('warning', 'position', 'Skipped SELL copy', 'No tracked position for this token');
      return undefined;
    }

    const requestedShares = desiredCopyNotional / Math.max(trade.price, 0.0001);
    const sellShares = Math.min(position.shares, Math.round(requestedShares * 10000) / 10000);
    if (sellShares <= 0) {
      console.log('Skipping SELL copy: sell size resolves to 0 shares');
      this.recordEvent('warning', 'position', 'Skipped SELL copy', 'Sell size resolved to 0 shares');
      return undefined;
    }

    const cappedNotional = Math.round(sellShares * trade.price * 100) / 100;
    if (sellShares < requestedShares) {
      console.log(`Capping SELL copy to current position: ${sellShares} shares (~${cappedNotional.toFixed(2)} USDC)`);
      this.recordEvent('info', 'position', 'Capped SELL to current position', `${sellShares} shares`);
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
        this.publishPositions();
        this.recordEvent('info', 'position', 'No existing positions found');
        return;
      }

      const { loaded, skipped } = this.positions.loadFromClobPositions(positions);
      this.risk.syncWithPositions();
      this.publishPositions();
      const totalNotional = this.positions.getTotalNotional();
      console.log(`Positions loaded: ${loaded} (skipped ${skipped}), total notional ~= ${totalNotional.toFixed(2)} USDC`);
      this.recordEvent('success', 'position', 'Positions reconciled', `${loaded} loaded, ${skipped} skipped`);
    } catch (error: any) {
      console.log(`Positions reconciliation failed: ${error.message || 'Unknown error'}`);
      this.recordEvent('warning', 'position', 'Positions reconciliation failed', error?.message || 'Unknown error');
    }
  }

  stop(): void {
    this.isRunning = false;
    this.dashboardStore.updateStatus({ phase: 'stopped' });

    if (this.wsMonitor) {
      this.wsMonitor.close();
    }

    if (this.dashboardServer) {
      void this.dashboardServer.close().catch(() => undefined);
    }

    console.log('\nBot stopped');
    this.recordEvent('warning', 'system', 'Bot stopped');
    this.printStats();
  }

  printStats(): void {
    console.log('\nSession Statistics:');
    console.log(`   Trades detected: ${this.stats.tradesDetected}`);
    console.log(`   Trades copied: ${this.stats.tradesCopied}`);
    console.log(`   Trades simulated: ${this.stats.tradesSimulated}`);
    console.log(`   Trades failed: ${this.stats.tradesFailed}`);
    console.log(`   Total volume: ${this.stats.totalVolume.toFixed(2)} USDC`);
    if (config.trading.dryRun) {
      console.log(`   Dry-run realized P/L: ${this.formatUsd(this.stats.dryRunRealizedPnl)}`);
    }
  }

  private handleDryRunTrade(trade: Trade, plan: ExecutionPlan): void {
    const simulatedShares =
      plan.copySharesOverride ?? Math.round((plan.copyNotional / Math.max(trade.price, 0.0001)) * 10000) / 10000;
    const simulatedNotional = Math.round(simulatedShares * trade.price * 100) / 100;
    const fill = this.positions.recordFillWithResult({
      trade,
      notional: simulatedNotional,
      shares: simulatedShares,
      price: trade.price,
      side: trade.side,
    });

    this.stats.tradesSimulated++;
    this.stats.totalVolume += simulatedNotional;
    this.stats.dryRunRealizedPnl += fill.realizedPnl;
    this.publishPositions();
    this.refreshDashboardState();

    console.log(
      `DRY RUN: copied ${trade.side} ${simulatedNotional.toFixed(2)} USDC (${simulatedShares} shares) @ ${trade.price.toFixed(3)}`
    );
    if (trade.side === 'SELL') {
      console.log(
        `   Realized P/L: ${this.formatUsd(fill.realizedPnl)} | Session realized P/L: ${this.formatUsd(this.stats.dryRunRealizedPnl)}`
      );
    } else {
      console.log(
        `   Position: ${fill.position.shares.toFixed(4)} shares @ avg ${fill.position.avgPrice.toFixed(4)} | Session realized P/L: ${this.formatUsd(this.stats.dryRunRealizedPnl)}`
      );
    }

    void this.appendDashboardTrade(trade, {
      market: trade.market,
      tokenId: trade.tokenId,
      side: trade.side,
      outcome: trade.outcome,
      targetPrice: trade.price,
      targetSize: trade.size,
      copyNotional: simulatedNotional,
      copyShares: simulatedShares,
      status: 'simulated',
      mode: 'dry-run',
      message:
        trade.side === 'SELL'
          ? `Realized P/L ${this.formatUsd(fill.realizedPnl)}`
          : `Position avg ${fill.position.avgPrice.toFixed(4)}`,
      realizedPnl: fill.realizedPnl,
    });
    this.recordEvent(
      'success',
      'trade',
      `Dry-run ${trade.side} simulated`,
      `${simulatedNotional.toFixed(2)} USDC at ${trade.price.toFixed(3)}`
    );
  }

  private createDashboardConfigSummary(): DashboardConfigSummary {
    return {
      dryRun: config.trading.dryRun,
      rpcUrl: config.rpcUrl,
      orderType: config.trading.orderType,
      positionMultiplier: config.trading.positionSizeMultiplier,
      minTradeSize: config.trading.minTradeSize,
      maxTradeSize: config.trading.maxTradeSize,
      slippageTolerance: config.trading.slippageTolerance,
      pollInterval: config.monitoring.pollInterval,
      useWebSocket: config.monitoring.useWebSocket,
      useUserChannel: config.monitoring.useUserChannel,
      riskCaps: {
        maxSessionNotional: config.risk.maxSessionNotional,
        maxPerMarketNotional: config.risk.maxPerMarketNotional,
      },
    };
  }

  private createDashboardStats(): DashboardStats {
    return {
      tradesDetected: this.stats.tradesDetected,
      tradesCopied: this.stats.tradesCopied,
      tradesFailed: this.stats.tradesFailed,
      tradesSimulated: this.stats.tradesSimulated,
      totalVolume: this.stats.totalVolume,
      dryRunRealizedPnl: this.stats.dryRunRealizedPnl,
      sessionNotional: this.risk.getSessionNotional(),
      openPositions: this.positions.getPositions().filter((position) => position.shares > 0).length,
    };
  }

  private refreshDashboardState(): void {
    this.dashboardStore.updateStats(this.createDashboardStats());
    this.dashboardStore.updateStatus({ websocketMode: this.getWebSocketMode() });
  }

  private publishPositions(): void {
    this.dashboardStore.setPositions(this.positions.getPositions());
    this.refreshDashboardState();
  }

  private recordEvent(level: EventLevel, category: EventCategory, message: string, details?: string): void {
    this.dashboardStore.appendEvent(details === undefined ? { level, category, message } : { level, category, message, details });
  }

  private async appendDashboardTrade(trade: Trade, params: {
    market: string;
    tokenId: string;
    side: 'BUY' | 'SELL';
    outcome: Trade['outcome'];
    targetPrice: number;
    targetSize: number;
    copyNotional: number;
    copyShares?: number;
    status: 'copied' | 'simulated' | 'blocked' | 'failed' | 'skipped';
    mode: 'live' | 'dry-run';
    message?: string;
    realizedPnl?: number;
  }): Promise<void> {
    const tradePayload = {
      market: params.market,
      tokenId: params.tokenId,
      side: params.side,
      outcome: params.outcome,
      targetPrice: params.targetPrice,
      targetSize: params.targetSize,
      copyNotional: params.copyNotional,
      status: params.status,
      mode: params.mode,
      ...(params.copyShares === undefined ? {} : { copyShares: params.copyShares }),
      ...(await this.resolveDashboardTradeUrl(trade)),
      ...(params.message === undefined ? {} : { message: params.message }),
      ...(params.realizedPnl === undefined ? {} : { realizedPnl: params.realizedPnl }),
    };
    this.dashboardStore.appendTrade(tradePayload);
  }

  private async resolveDashboardTradeUrl(trade: Trade): Promise<{ eventUrl: string } | {}> {
    const eventUrl = await this.dashboardLinkResolver.resolveTradeUrl(trade);
    return eventUrl ? { eventUrl } : {};
  }

  private getWebSocketMode(): 'disabled' | 'market' | 'user' {
    if (!config.monitoring.useWebSocket) {
      return 'disabled';
    }
    return config.monitoring.useUserChannel ? 'user' : 'market';
  }

  private formatUsd(value: number): string {
    const rounded = Math.round(value * 100) / 100;
    const sign = rounded >= 0 ? '+' : '-';
    return `${sign}$${Math.abs(rounded).toFixed(2)}`;
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
  } catch (error: any) {
    console.error('Fatal error:', error);
    bot.stop();
    process.exit(1);
  }
}

main();
