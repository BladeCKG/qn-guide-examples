const state = {
  snapshot: null,
  connected: false,
};

const els = {
  connectionPill: document.getElementById('connection-pill'),
  phaseText: document.getElementById('phase-text'),
  uptimeText: document.getElementById('uptime-text'),
  lastUpdated: document.getElementById('last-updated'),
  statsGrid: document.getElementById('stats-grid'),
  runtimeList: document.getElementById('runtime-list'),
  configList: document.getElementById('config-list'),
  positionCount: document.getElementById('position-count'),
  positionsBody: document.getElementById('positions-body'),
  tradesBody: document.getElementById('trades-body'),
  eventsList: document.getElementById('events-list'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtNumber(value, digits = 2) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value ?? 0);
}

function fmtUsd(value) {
  const n = Number(value || 0);
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${fmtNumber(Math.abs(n), 2)}`;
}

function fmtPct(value) {
  return `${fmtNumber((value || 0) * 100, 2)}%`;
}

function fmtDate(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString();
}

function fmtRelativeDuration(startedAt) {
  if (!startedAt) return '--';
  const diff = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const totalSeconds = Math.floor(diff / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function tag(text, kind) {
  return `<span class="tag tag-${escapeHtml(kind)}">${escapeHtml(text)}</span>`;
}

function renderMarketLink(label, eventUrl) {
  const safeLabel = escapeHtml(label);
  if (!eventUrl) {
    return safeLabel;
  }
  return `<a class="market-link" href="${escapeHtml(eventUrl)}" target="_blank" rel="noreferrer">${safeLabel}</a>`;
}

function renderStats(snapshot) {
  const stats = [
    ['Trades Detected', snapshot.stats.tradesDetected],
    ['Trades Copied', snapshot.stats.tradesCopied],
    ['Trades Simulated', snapshot.stats.tradesSimulated],
    ['Trades Failed', snapshot.stats.tradesFailed],
    ['Total Volume', `$${fmtNumber(snapshot.stats.totalVolume)}`],
    ['Session Notional', `$${fmtNumber(snapshot.stats.sessionNotional)}`],
    ['Open Positions', snapshot.stats.openPositions],
    ['Dry-Run P/L', fmtUsd(snapshot.stats.dryRunRealizedPnl)],
  ];

  els.statsGrid.innerHTML = stats
    .map(
      ([label, value]) => `
        <article class="stat">
          <span class="stat-label">${label}</span>
          <span class="stat-value">${value}</span>
        </article>
      `
    )
    .join('');
}

function renderKvList(target, rows) {
  target.innerHTML = rows
    .map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`)
    .join('');
}

function renderPositions(snapshot) {
  els.positionCount.textContent = `${snapshot.positions.length} position${snapshot.positions.length === 1 ? '' : 's'}`;

  if (!snapshot.positions.length) {
    els.positionsBody.innerHTML = `<tr><td colspan="6"><div class="empty-state">No positions yet.</div></td></tr>`;
    return;
  }

  els.positionsBody.innerHTML = snapshot.positions
    .map(
      (position) => `
        <tr>
          <td>${escapeHtml(position.market || position.tokenId)}</td>
          <td>${escapeHtml(position.outcome)}</td>
          <td>${fmtNumber(position.shares, 4)}</td>
          <td>${fmtNumber(position.avgPrice, 4)}</td>
          <td>$${fmtNumber(position.notional, 2)}</td>
          <td>${fmtDate(position.lastUpdated)}</td>
        </tr>
      `
    )
    .join('');
}

function renderTrades(snapshot) {
  if (!snapshot.recentTrades.length) {
    els.tradesBody.innerHTML = `<tr><td colspan="10"><div class="empty-state">Waiting for trade activity.</div></td></tr>`;
    return;
  }

  els.tradesBody.innerHTML = snapshot.recentTrades
    .map(
      (trade) => `
        <tr>
          <td>${fmtDate(trade.timestamp)}</td>
          <td>${tag(trade.status, trade.status)}</td>
          <td>${escapeHtml(trade.mode)}</td>
          <td>${tag(trade.side, trade.side.toLowerCase())}</td>
          <td>${renderMarketLink(trade.market, trade.eventUrl)}</td>
          <td>
            ${renderMarketRules(trade)}
          </td>
          <td>${trade.targetSize} USDC @ ${fmtNumber(trade.targetPrice, 3)}</td>
          <td>
            $${fmtNumber(trade.copyNotional, 2)}
            ${trade.copyShares ? `<br><span class="muted">${fmtNumber(trade.copyShares, 4)} shares</span>` : ''}
          </td>
          <td class="${(trade.realizedPnl || 0) >= 0 ? 'positive' : 'negative'}">
            ${trade.realizedPnl === undefined ? '--' : fmtUsd(trade.realizedPnl)}
          </td>
          <td>${escapeHtml(trade.message || '--')}</td>
        </tr>
      `
    )
    .join('');
}

function renderMarketRules(trade) {
  const rules = [];

  if (trade.minOrderSize !== undefined) {
    rules.push(`Min ${fmtNumber(trade.minOrderSize, 4)} shares`);
    if (trade.targetPrice !== undefined) {
      const approxUsd = trade.minOrderSize * trade.targetPrice;
      rules.push(`<span class="muted">~$${fmtNumber(approxUsd, 2)} at target price</span>`);
    }
  }

  if (trade.tickSize !== undefined) {
    rules.push(`<span class="muted">Tick ${fmtNumber(trade.tickSize, 4)}</span>`);
  }

  if (!rules.length) {
    return '--';
  }

  return rules.join('<br>');
}

function renderEvents(snapshot) {
  if (!snapshot.recentEvents.length) {
    els.eventsList.innerHTML = `<div class="empty-state">No events yet.</div>`;
    return;
  }

  els.eventsList.innerHTML = snapshot.recentEvents
    .map(
      (event) => `
        <article class="event">
          <div class="event-time">${fmtDate(event.timestamp)}</div>
          <div>${tag(event.level, event.level)}</div>
          <div class="event-message">
            <strong>${escapeHtml(event.message)}</strong>
            <span class="event-details">${escapeHtml(event.category)}${event.details ? ` | ${escapeHtml(event.details)}` : ''}</span>
          </div>
        </article>
      `
    )
    .join('');
}

function render(snapshot) {
  state.snapshot = snapshot;
  els.phaseText.textContent = `Phase: ${snapshot.status.phase}`;
  els.uptimeText.textContent = `Uptime: ${fmtRelativeDuration(snapshot.status.startedAt)}`;
  els.lastUpdated.textContent = `Last updated ${fmtDate(snapshot.status.lastUpdatedAt)}`;

  renderStats(snapshot);
  renderKvList(els.runtimeList, [
    ['Target Wallet', snapshot.status.targetWallet || '--'],
    ['WebSocket Mode', snapshot.status.websocketMode],
    ['Dashboard', snapshot.status.dashboardEnabled ? `Enabled on :${snapshot.status.dashboardPort}` : 'Disabled'],
    ['Started At', fmtDate(snapshot.status.startedAt)],
  ]);
  renderKvList(els.configList, [
    ['Dry Run', String(snapshot.config.dryRun)],
    ['Order Type', snapshot.config.orderType],
    ['Multiplier', fmtPct(snapshot.config.positionMultiplier)],
    ['Min Trade', `$${fmtNumber(snapshot.config.minTradeSize)}`],
    ['Max Trade', `$${fmtNumber(snapshot.config.maxTradeSize)}`],
    ['Slippage', fmtPct(snapshot.config.slippageTolerance)],
    ['Poll Interval', `${snapshot.config.pollInterval} ms`],
    ['RPC URL', snapshot.config.rpcUrl],
    ['Risk Caps', `Session $${fmtNumber(snapshot.config.riskCaps.maxSessionNotional)} / Market $${fmtNumber(snapshot.config.riskCaps.maxPerMarketNotional)}`],
  ]);
  renderPositions(snapshot);
  renderTrades(snapshot);
  renderEvents(snapshot);
}

function setConnection(isConnected) {
  state.connected = isConnected;
  els.connectionPill.textContent = isConnected ? 'Live stream connected' : 'Reconnecting stream';
  els.connectionPill.className = `status-pill ${isConnected ? 'connected' : 'disconnected'}`;
}

async function fetchInitialState() {
  const response = await fetch('/api/state');
  if (!response.ok) {
    throw new Error(`Failed to fetch state: ${response.status}`);
  }
  const snapshot = await response.json();
  render(snapshot);
}

function connectStream() {
  const stream = new EventSource('/api/events');

  stream.addEventListener('open', () => {
    setConnection(true);
  });

  stream.addEventListener('state', (event) => {
    setConnection(true);
    render(JSON.parse(event.data));
  });

  stream.addEventListener('error', () => {
    setConnection(false);
  });
}

setConnection(false);
fetchInitialState()
  .catch((error) => {
    els.eventsList.innerHTML = `<div class="empty-state">${error.message}</div>`;
  })
  .finally(() => {
    connectStream();
  });

setInterval(() => {
  if (state.snapshot) {
    els.uptimeText.textContent = `Uptime: ${fmtRelativeDuration(state.snapshot.status.startedAt)}`;
  }
}, 1000);
