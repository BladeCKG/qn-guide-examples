import { EventEmitter } from 'node:events';
import type {
  DashboardConfigSummary,
  DashboardEvent,
  DashboardPosition,
  DashboardState,
  DashboardStats,
  DashboardStatus,
  DashboardTrade,
  EventCategory,
  EventLevel,
} from './types.js';
const DEFAULT_RECENT_ITEMS = 100;

function isoNow(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class DashboardStore {
  private readonly emitter = new EventEmitter();
  private state: DashboardState;

  constructor(initial: {
    status: DashboardStatus;
    stats: DashboardStats;
    config: DashboardConfigSummary;
  }) {
    this.state = {
      status: initial.status,
      stats: initial.stats,
      config: initial.config,
      positions: [],
      recentTrades: [],
      recentEvents: [],
    };
  }

  getState(): DashboardState {
    return structuredClone(this.state);
  }

  subscribe(listener: (state: DashboardState) => void): () => void {
    this.emitter.on('update', listener);
    return () => {
      this.emitter.off('update', listener);
    };
  }

  updateStatus(patch: Partial<DashboardStatus>): void {
    this.state.status = {
      ...this.state.status,
      ...patch,
      lastUpdatedAt: isoNow(),
    };
    this.emit();
  }

  updateStats(patch: Partial<DashboardStats>): void {
    this.state.stats = {
      ...this.state.stats,
      ...patch,
    };
    this.touch();
    this.emit();
  }

  setPositions(positions: DashboardPosition[]): void {
    this.state.positions = positions
      .slice()
      .sort((a, b) => b.notional - a.notional);
    this.state.stats.openPositions = this.state.positions.filter((position) => position.shares > 0).length;
    this.touch();
    this.emit();
  }

  appendTrade(trade: Omit<DashboardTrade, 'id' | 'timestamp'> & { id?: string; timestamp?: string }): void {
    const entry: DashboardTrade = {
      id: trade.id ?? makeId('trade'),
      timestamp: trade.timestamp ?? isoNow(),
      ...trade,
    };
    this.state.recentTrades = [entry, ...this.state.recentTrades].slice(0, DEFAULT_RECENT_ITEMS);
    this.touch();
    this.emit();
  }

  appendEvent(params: {
    level: EventLevel;
    category: EventCategory;
    message: string;
    details?: string;
  }): void {
    const entry: DashboardEvent = {
      id: makeId('event'),
      timestamp: isoNow(),
      level: params.level,
      category: params.category,
      message: params.message,
      ...(params.details === undefined ? {} : { details: params.details }),
    };
    this.state.recentEvents = [entry, ...this.state.recentEvents].slice(0, DEFAULT_RECENT_ITEMS);
    this.touch();
    this.emit();
  }

  private touch(): void {
    this.state.status.lastUpdatedAt = isoNow();
  }

  private emit(): void {
    this.emitter.emit('update', this.getState());
  }
}
