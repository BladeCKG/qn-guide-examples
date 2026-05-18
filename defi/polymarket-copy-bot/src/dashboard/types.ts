import type { PositionState } from '../positions.js';
import type { TradeOutcome } from '../monitor.js';

export type BotPhase = 'idle' | 'initializing' | 'running' | 'stopped' | 'error';
export type EventLevel = 'info' | 'success' | 'warning' | 'error';
export type EventCategory = 'system' | 'trade' | 'risk' | 'position' | 'dashboard' | 'network';
export type TradeLifecycleStatus = 'detected' | 'copied' | 'simulated' | 'blocked' | 'failed' | 'skipped';

export interface DashboardStatus {
  phase: BotPhase;
  startedAt?: string;
  lastUpdatedAt: string;
  websocketMode: 'disabled' | 'market' | 'user';
  targetWallet: string;
  dashboardEnabled: boolean;
  dashboardPort: number;
}

export interface DashboardStats {
  tradesDetected: number;
  tradesCopied: number;
  tradesFailed: number;
  tradesSimulated: number;
  totalVolume: number;
  dryRunRealizedPnl: number;
  sessionNotional: number;
  openPositions: number;
}

export interface DashboardConfigSummary {
  dryRun: boolean;
  rpcUrl: string;
  orderType: 'LIMIT' | 'FOK' | 'FAK';
  positionMultiplier: number;
  minTradeSize: number;
  maxTradeSize: number;
  slippageTolerance: number;
  pollInterval: number;
  useWebSocket: boolean;
  useUserChannel: boolean;
  riskCaps: {
    maxSessionNotional: number;
    maxPerMarketNotional: number;
  };
}

export interface DashboardEvent {
  id: string;
  timestamp: string;
  level: EventLevel;
  category: EventCategory;
  message: string;
  details?: string;
}

export interface DashboardTrade {
  id: string;
  timestamp: string;
  market: string;
  tokenId: string;
  eventUrl?: string;
  minOrderSize?: number;
  tickSize?: number;
  side: 'BUY' | 'SELL';
  outcome: TradeOutcome;
  targetPrice: number;
  copyPrice?: number;
  targetSize: number;
  copyNotional: number;
  copyShares?: number;
  status: TradeLifecycleStatus;
  mode: 'live' | 'dry-run';
  message?: string;
  realizedPnl?: number;
}

export interface DashboardPosition extends PositionState {
  eventUrl?: string;
}

export interface DashboardState {
  status: DashboardStatus;
  stats: DashboardStats;
  config: DashboardConfigSummary;
  positions: DashboardPosition[];
  recentTrades: DashboardTrade[];
  recentEvents: DashboardEvent[];
}
