import axios from 'axios';

type LeaderboardPeriod = 'DAY' | 'WEEK' | 'MONTH' | 'ALL';
type LeaderboardCategory =
  | 'OVERALL'
  | 'POLITICS'
  | 'SPORTS'
  | 'CRYPTO'
  | 'CULTURE'
  | 'MENTIONS'
  | 'WEATHER'
  | 'ECONOMICS'
  | 'TECH'
  | 'FINANCE';

interface ScanOptions {
  category: LeaderboardCategory;
  leaderboardTimePeriod: LeaderboardPeriod;
  candidateLimit: number;
  skipPages: number;
  leaderboardOrderBy: 'PNL' | 'VOL';
  minAccountAgeMonths: number;
  lookbackDays: number;
  targetDailyProfitUsd: number;
  profitTolerancePct: number;
  minActiveProfitDays: number;
  minConsistencyRatio: number;
  concurrency: number;
  maxActivitiesPerUser: number;
}

interface LeaderboardTrader {
  rank: string;
  proxyWallet: string;
  userName?: string;
  xUsername?: string;
  verifiedBadge?: boolean;
  vol: number;
  pnl: number;
  profileImage?: string;
}

interface PublicProfile {
  createdAt: string | null;
  proxyWallet: string | null;
  pseudonym?: string | null;
  name?: string | null;
  xUsername?: string | null;
  verifiedBadge?: boolean | null;
}

interface Activity {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: 'TRADE' | 'SPLIT' | 'MERGE' | 'REDEEM' | 'REWARD' | 'CONVERSION' | 'MAKER_REBATE' | 'REFERRAL_REWARD';
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: 'BUY' | 'SELL' | '';
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
}

interface PositionLot {
  shares: number;
  cost: number;
  conditionId: string;
}

interface CandidateResult {
  trader: LeaderboardTrader;
  profile: PublicProfile;
  accountAgeDays: number;
  activityCount: number;
  recentTradingDays: number;
  historyTruncated: boolean;
  totalRealizedPnl: number;
  activeProfitDays: number;
  losingDays: number;
  profitableDaysInBand: number;
  consistencyRatio: number;
  averageProfitPerActiveDay: number;
  medianProfitPerActiveDay: number;
  maxProfitDay: number;
  minProfitDay: number;
  dailyPnl: Map<string, number>;
}

const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';
const LEADERBOARD_PAGE_SIZE = 50;
const PAGE_LIMIT = 500;
const MAX_ACTIVITY_OFFSET = 3000;
const EPSILON = 1e-8;

function parseArgs(argv: string[]): ScanOptions {
  const defaults: ScanOptions = {
    category: 'OVERALL',
    leaderboardTimePeriod: 'ALL',
    candidateLimit: 100000,
    skipPages: 0,
    leaderboardOrderBy: 'PNL',
    minAccountAgeMonths: 5,
    lookbackDays: 90,
    targetDailyProfitUsd: 1000,
    profitTolerancePct: 0.4,
    minActiveProfitDays: 20,
    minConsistencyRatio: 0.55,
    concurrency: 4,
    maxActivitiesPerUser: 10000,
  };

  const parsed = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token) continue;
    if (!token.startsWith('--')) continue;
    const [key, inlineValue] = token.slice(2).split('=');
    const candidateNext = argv[i + 1];
    const next = inlineValue ?? candidateNext;
    if (inlineValue === undefined && candidateNext && !candidateNext.startsWith('--')) {
      i++;
    }
    if (key && next !== undefined) {
      parsed.set(key, next);
    }
  }

  return {
    category: (parsed.get('category') as LeaderboardCategory) || defaults.category,
    leaderboardTimePeriod: (parsed.get('leaderboard-time-period') as LeaderboardPeriod) || defaults.leaderboardTimePeriod,
    candidateLimit: parseInt(parsed.get('candidate-limit') || String(defaults.candidateLimit), 10),
    skipPages: parseInt(parsed.get('skip-pages') || String(defaults.skipPages), 10),
    leaderboardOrderBy: (parsed.get('leaderboard-order-by') as 'PNL' | 'VOL') || defaults.leaderboardOrderBy,
    minAccountAgeMonths: parseFloat(parsed.get('min-account-age-months') || String(defaults.minAccountAgeMonths)),
    lookbackDays: parseInt(parsed.get('lookback-days') || String(defaults.lookbackDays), 10),
    targetDailyProfitUsd: parseFloat(parsed.get('target-daily-profit-usd') || String(defaults.targetDailyProfitUsd)),
    profitTolerancePct: parseFloat(parsed.get('profit-tolerance-pct') || String(defaults.profitTolerancePct)),
    minActiveProfitDays: parseInt(parsed.get('min-active-profit-days') || String(defaults.minActiveProfitDays), 10),
    minConsistencyRatio: parseFloat(parsed.get('min-consistency-ratio') || String(defaults.minConsistencyRatio)),
    concurrency: parseInt(parsed.get('concurrency') || String(defaults.concurrency), 10),
    maxActivitiesPerUser: parseInt(parsed.get('max-activities-per-user') || String(defaults.maxActivitiesPerUser), 10),
  };
}

async function getJson<T>(url: string, params?: Record<string, string | number | boolean>): Promise<T> {
  const response = await axios.get<T>(url, {
    params,
    headers: {
      Accept: 'application/json',
    },
    timeout: 30000,
  });
  return response.data;
}

async function fetchLeaderboard(options: ScanOptions): Promise<LeaderboardTrader[]> {
  const traders: LeaderboardTrader[] = [];
  const pageSize = LEADERBOARD_PAGE_SIZE;
  const startingOffset = Math.max(0, options.skipPages) * pageSize;

  for (let offset = startingOffset; traders.length < options.candidateLimit; offset += pageSize) {
    const page = await getJson<LeaderboardTrader[]>(`${DATA_API}/v1/leaderboard`, {
      category: options.category,
      timePeriod: options.leaderboardTimePeriod,
      orderBy: options.leaderboardOrderBy,
      limit: Math.min(pageSize, options.candidateLimit - traders.length),
      offset,
    });

    if (!Array.isArray(page) || page.length === 0) {
      break;
    }

    traders.push(...page);
    if (page.length < pageSize) {
      break;
    }
  }

  return traders.slice(0, options.candidateLimit);
}

async function fetchProfile(wallet: string): Promise<PublicProfile | undefined> {
  try {
    return await getJson<PublicProfile>(`${GAMMA_API}/public-profile`, { address: wallet });
  } catch (error: any) {
    if (error?.response?.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function fetchActivityRange(
  wallet: string,
  startUnixSeconds: number,
  endUnixSeconds: number,
  maxActivities: number
): Promise<{ rows: Activity[]; truncated: boolean }> {
  const rows: Activity[] = [];

  for (let offset = 0; offset <= MAX_ACTIVITY_OFFSET && rows.length < maxActivities; offset += PAGE_LIMIT) {
    let page: Activity[];
    try {
      page = await getJson<Activity[]>(`${DATA_API}/activity`, {
        user: wallet,
        start: startUnixSeconds,
        end: endUnixSeconds,
        limit: Math.min(PAGE_LIMIT, maxActivities - rows.length),
        offset,
        sortBy: 'TIMESTAMP',
        sortDirection: 'ASC',
      });
    } catch (error: any) {
      const detail = error?.response?.data ? JSON.stringify(error.response.data) : error?.message || 'Unknown error';
      throw new Error(`Activity fetch failed for ${wallet} range ${startUnixSeconds}-${endUnixSeconds} at offset ${offset}: ${detail}`);
    }

    if (!Array.isArray(page) || page.length === 0) {
      return { rows, truncated: false };
    }

    rows.push(...page.map(normalizeActivity));
    if (page.length < PAGE_LIMIT) {
      return { rows, truncated: false };
    }
  }

  if (rows.length >= maxActivities) {
    return { rows, truncated: true };
  }

  if (startUnixSeconds >= endUnixSeconds || endUnixSeconds - startUnixSeconds <= 24 * 60 * 60) {
    return { rows, truncated: true };
  }

  const midpoint = Math.floor((startUnixSeconds + endUnixSeconds) / 2);
  const left = await fetchActivityRange(wallet, startUnixSeconds, midpoint, maxActivities);
  const remainingBudget = Math.max(0, maxActivities - left.rows.length);
  const right = remainingBudget > 0
    ? await fetchActivityRange(wallet, midpoint + 1, endUnixSeconds, remainingBudget)
    : { rows: [], truncated: true };

  const deduped = new Map<string, Activity>();
  for (const row of [...left.rows, ...right.rows]) {
    deduped.set(`${row.transactionHash}|${row.timestamp}|${row.type}|${row.asset}|${row.side}`, row);
  }

  const mergedRows = Array.from(deduped.values()).sort((a, b) => a.timestamp - b.timestamp);
  return {
    rows: mergedRows.slice(0, maxActivities),
    truncated: left.truncated || right.truncated || mergedRows.length >= maxActivities,
  };
}

async function fetchAllActivity(wallet: string, startUnixSeconds: number, maxActivities: number): Promise<{ rows: Activity[]; truncated: boolean }> {
  const nowUnixSeconds = Math.floor(Date.now() / 1000);
  return fetchActivityRange(wallet, startUnixSeconds, nowUnixSeconds, maxActivities);
}

function normalizeActivity(activity: Activity): Activity {
  return {
    ...activity,
    size: Number(activity.size || 0),
    usdcSize: Number(activity.usdcSize || 0),
    price: Number(activity.price || 0),
  };
}

function formatDateKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function getLotKey(asset: string, conditionId: string): string {
  return `${conditionId}::${asset || 'condition'}`;
}

function ensureBand(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

function sortedNumbers(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = sortedNumbers(values);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2;
  }
  return sorted[midpoint] ?? 0;
}

function consumePosition(lot: PositionLot, sharesToConsume: number): number {
  if (sharesToConsume <= EPSILON || lot.shares <= EPSILON) {
    return 0;
  }
  const shares = Math.min(lot.shares, sharesToConsume);
  const avgCost = lot.shares > EPSILON ? lot.cost / lot.shares : 0;
  const consumedCost = avgCost * shares;
  lot.shares -= shares;
  lot.cost -= consumedCost;
  if (lot.shares <= EPSILON) {
    lot.shares = 0;
    lot.cost = 0;
  }
  return consumedCost;
}

function analyzeActivities(activities: Activity[], lookbackStartMs: number): { dailyPnl: Map<string, number>; total: number } {
  const lots = new Map<string, PositionLot>();
  const conditionIndex = new Map<string, Set<string>>();
  const dailyPnl = new Map<string, number>();

  const addDailyPnl = (timestampSec: number, pnl: number) => {
    if (Math.abs(pnl) <= EPSILON) return;
    const timestampMs = timestampSec * 1000;
    if (timestampMs < lookbackStartMs) return;
    const key = formatDateKey(timestampMs);
    dailyPnl.set(key, round2((dailyPnl.get(key) || 0) + pnl));
  };

  const getConditionLotKeys = (conditionId: string): string[] => {
    const keys = Array.from(conditionIndex.get(conditionId) || []);
    keys.sort((a, b) => {
      const aLot = lots.get(a);
      const bLot = lots.get(b);
      return (bLot?.shares || 0) - (aLot?.shares || 0);
    });
    return keys;
  };

  for (const activity of activities) {
    if (activity.type === 'TRADE' && activity.side === 'BUY' && activity.asset) {
      const key = getLotKey(activity.asset, activity.conditionId);
      const lot = lots.get(key) || { shares: 0, cost: 0, conditionId: activity.conditionId };
      lot.shares += activity.size;
      lot.cost += activity.usdcSize;
      lots.set(key, lot);
      if (!conditionIndex.has(activity.conditionId)) {
        conditionIndex.set(activity.conditionId, new Set());
      }
      conditionIndex.get(activity.conditionId)!.add(key);
      continue;
    }

    if (activity.type === 'TRADE' && activity.side === 'SELL' && activity.asset) {
      const key = getLotKey(activity.asset, activity.conditionId);
      const lot = lots.get(key) || { shares: 0, cost: 0, conditionId: activity.conditionId };
      const consumedCost = consumePosition(lot, activity.size);
      lots.set(key, lot);
      addDailyPnl(activity.timestamp, activity.usdcSize - consumedCost);
      continue;
    }

    if ((activity.type === 'REDEEM' || activity.type === 'MERGE') && activity.conditionId) {
      let remainingShares = activity.size;
      let consumedCost = 0;
      for (const lotKey of getConditionLotKeys(activity.conditionId)) {
        if (remainingShares <= EPSILON) break;
        const lot = lots.get(lotKey);
        if (!lot || lot.shares <= EPSILON) continue;
        const sharesToConsume = Math.min(lot.shares, remainingShares);
        consumedCost += consumePosition(lot, sharesToConsume);
        remainingShares -= sharesToConsume;
        lots.set(lotKey, lot);
      }

      addDailyPnl(activity.timestamp, activity.usdcSize - consumedCost);
      continue;
    }

    if (activity.type === 'REWARD' || activity.type === 'MAKER_REBATE' || activity.type === 'REFERRAL_REWARD') {
      addDailyPnl(activity.timestamp, activity.usdcSize);
    }
  }

  const total = round2(Array.from(dailyPnl.values()).reduce((sum, value) => sum + value, 0));
  return { dailyPnl, total };
}

function buildResult(
  trader: LeaderboardTrader,
  profile: PublicProfile,
  activityRows: Activity[],
  historyTruncated: boolean,
  options: ScanOptions,
  now: Date
): CandidateResult {
  const lookbackStartMs = now.getTime() - options.lookbackDays * 24 * 60 * 60 * 1000;
  const createdAt = profile.createdAt ? new Date(profile.createdAt) : new Date(0);
  const accountAgeDays = Math.floor((now.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000));
  const analysis = analyzeActivities(activityRows, lookbackStartMs);
  const profitableDays = Array.from(analysis.dailyPnl.values()).filter((value) => value > 0);
  const losingDays = Array.from(analysis.dailyPnl.values()).filter((value) => value < 0);
  const recentTradingDays = analysis.dailyPnl.size;
  const bandMin = options.targetDailyProfitUsd * (1 - options.profitTolerancePct);
  const bandMax = options.targetDailyProfitUsd * (1 + options.profitTolerancePct);
  const profitableDaysInBand = profitableDays.filter((value) => ensureBand(value, bandMin, bandMax)).length;
  const activeProfitDays = profitableDays.length;
  const consistencyRatio = activeProfitDays === 0 ? 0 : profitableDaysInBand / activeProfitDays;
  const averageProfitPerActiveDay =
    activeProfitDays === 0 ? 0 : round2(profitableDays.reduce((sum, value) => sum + value, 0) / activeProfitDays);

  return {
    trader,
    profile,
    accountAgeDays,
    activityCount: activityRows.length,
    recentTradingDays,
    historyTruncated,
    totalRealizedPnl: analysis.total,
    activeProfitDays,
    losingDays: losingDays.length,
    profitableDaysInBand,
    consistencyRatio,
    averageProfitPerActiveDay,
    medianProfitPerActiveDay: round2(median(profitableDays)),
    maxProfitDay: profitableDays.length ? round2(Math.max(...profitableDays)) : 0,
    minProfitDay: profitableDays.length ? round2(Math.min(...profitableDays)) : 0,
    dailyPnl: analysis.dailyPnl,
  };
}

function passesFilters(result: CandidateResult, options: ScanOptions): boolean {
  return (
    result.accountAgeDays >= Math.floor(options.minAccountAgeMonths * 30) &&
    result.activityCount > 0 &&
    result.recentTradingDays > 0 &&
    result.totalRealizedPnl > 0 &&
    result.activeProfitDays >= options.minActiveProfitDays &&
    result.consistencyRatio >= options.minConsistencyRatio &&
    result.averageProfitPerActiveDay >= options.targetDailyProfitUsd * (1 - options.profitTolerancePct) &&
    result.averageProfitPerActiveDay <= options.targetDailyProfitUsd * (1 + options.profitTolerancePct)
  );
}

async function mapWithConcurrency<T, U>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      const item = items[current];
      if (item === undefined) {
        continue;
      }
      results[current] = await worker(item, current);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

function printSummary(results: CandidateResult[], options: ScanOptions): void {
  console.log('\nMatched traders:\n');
  if (results.length === 0) {
    console.log('No traders matched the filters.');
    return;
  }

  const rows = results.map((result) => ({
    wallet: result.trader.proxyWallet,
    user: result.trader.userName || result.profile.name || result.profile.pseudonym || 'unknown',
    ageDays: result.accountAgeDays,
    totalPnl90d: round2(result.totalRealizedPnl),
    recentTradingDays: result.recentTradingDays,
    activeProfitDays: result.activeProfitDays,
    inBandDays: result.profitableDaysInBand,
    consistency: `${(result.consistencyRatio * 100).toFixed(1)}%`,
    avgProfitDay: round2(result.averageProfitPerActiveDay),
    medianProfitDay: round2(result.medianProfitPerActiveDay),
    lossDays: result.losingDays,
    activities: result.activityCount,
    truncated: result.historyTruncated,
  }));

  console.table(rows);
  console.log(
    `Matched ${results.length} traders using lookback=${options.lookbackDays}d, age>=${options.minAccountAgeMonths} months, target daily profit ~$${options.targetDailyProfitUsd}`
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const now = new Date();
  const minCreatedAt = addMonths(now, -options.minAccountAgeMonths);
  console.log('Scanning Polymarket leaderboard candidates...');
  console.log(
    `Filters: category=${options.category}, candidates=${options.candidateLimit}, skipPages=${options.skipPages}, age<=${minCreatedAt.toISOString()} (created before), lookback=${options.lookbackDays}d`
  );
  if (options.candidateLimit >= 10000) {
    console.log('Large scan requested: expect this to take a long time and potentially hit public API rate limits.');
  }

  const candidates = await fetchLeaderboard(options);
  console.log(`Fetched ${candidates.length} leaderboard candidates`);

  const analyses = await mapWithConcurrency(candidates, options.concurrency, async (candidate, index) => {
    console.log(`Scanning candidate [${index + 1}/${candidates.length}] ${candidate.proxyWallet} ${candidate.userName || ''}`.trim());
    const profile = await fetchProfile(candidate.proxyWallet);
    if (!profile?.createdAt) {
      return undefined;
    }

    const createdAt = new Date(profile.createdAt);
    if (createdAt > minCreatedAt) {
      return undefined;
    }

    const lookbackStartUnixSeconds = Math.floor((now.getTime() - options.lookbackDays * 24 * 60 * 60 * 1000) / 1000);
    const { rows, truncated } = await fetchAllActivity(candidate.proxyWallet, lookbackStartUnixSeconds, options.maxActivitiesPerUser);
    return buildResult(candidate, profile, rows, truncated, options, now);
  });

  const filtered = analyses
    .filter((value): value is CandidateResult => Boolean(value))
    .filter((result) => passesFilters(result, options))
    .sort((a, b) => {
      if (b.consistencyRatio !== a.consistencyRatio) {
        return b.consistencyRatio - a.consistencyRatio;
      }
      return b.averageProfitPerActiveDay - a.averageProfitPerActiveDay;
    });

  printSummary(filtered, options);
}

main().catch((error) => {
  console.error('Scanner failed:', error?.message || error);
  process.exit(1);
});
