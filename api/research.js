const CHAIN_NETWORKS = {
  ethereum: { gecko: "eth", dex: "ethereum", evm: true, goplus: "1" },
  base: { gecko: "base", dex: "base", evm: true, goplus: "8453" },
  arbitrum: { gecko: "arbitrum", dex: "arbitrum", evm: true, goplus: "42161" },
  optimism: { gecko: "optimism", dex: "optimism", evm: true, goplus: "10" },
  polygon: { gecko: "polygon_pos", dex: "polygon", evm: true, goplus: "137" },
  bsc: { gecko: "bsc", dex: "bsc", evm: true, goplus: "56" },
  avalanche: { gecko: "avax", dex: "avalanche", evm: true, goplus: "43114" },
  solana: { gecko: "solana", dex: "solana", evm: false, goplus: "solana" }
};
const GOPLUS_EVM_FIELDS = [
  "is_open_source", "is_proxy", "is_mintable", "can_take_back_ownership",
  "owner_change_balance", "hidden_owner", "selfdestruct", "external_call",
  "is_honeypot", "is_blacklisted", "is_whitelisted", "cannot_sell_all",
  "slippage_modifiable", "transfer_pausable", "trading_cooldown",
  "is_anti_whale", "anti_whale_modifiable", "buy_tax", "sell_tax",
  "holder_count", "owner_address", "creator_address"
];

function reply(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.end(JSON.stringify(body));
}

function value(query, key, maxLength) {
  const raw = query[key];
  return typeof raw === "string" ? raw.trim().slice(0, maxLength) : "";
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(8000),
    headers: { Accept: "application/json", ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`);
  return response.json();
}

async function sourceResult(name, run) {
  try {
    const data = await run();
    return { source: name, status: "ok", receivedAt: new Date().toISOString(), data };
  } catch (error) {
    console.error(`${name} research source failed:`, error);
    return { source: name, status: "unavailable", error: "조회에 실패했습니다. 잠시 후 해당 출처에서 직접 확인해 주세요." };
  }
}

function lastTvlPoint(data) {
  if (!Array.isArray(data)) return null;
  const point = [...data].reverse().find((entry) => Number.isFinite(entry?.totalLiquidityUSD));
  return point ? { usd: point.totalLiquidityUSD, timestamp: point.date ? new Date(point.date * 1000).toISOString() : null } : null;
}

function movingAverage(values, length) {
  if (values.length < length) return null;
  const window = values.slice(-length);
  return window.reduce((sum, value) => sum + value, 0) / length;
}

function analyzePriceTrend(points, volumes) {
  if (!Array.isArray(points)) return { status: "insufficient_data", label: "추세 확인 불가", observations: [], disclaimer: "CoinGecko 가격 이력이 제공되지 않았습니다." };
  const daily = new Map();
  points.forEach((point) => {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || point[1] <= 0) return;
    daily.set(new Date(point[0]).toISOString().slice(0, 10), point[1]);
  });
  const dailyVol = new Map();
  (Array.isArray(volumes) ? volumes : []).forEach((point) => {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || point[1] < 0) return;
    dailyVol.set(new Date(point[0]).toISOString().slice(0, 10), point[1]);
  });
  const entries = [...daily.entries()].sort(([dateA], [dateB]) => dateA.localeCompare(dateB)).slice(-365);
  const closes = entries.map(([, price]) => price);
  const vols = entries.map(([date]) => dailyVol.get(date) ?? null);
  if (closes.length < 20) {
    return {
      status: "insufficient_data",
      label: "추세 확인 불가",
      sampleDays: closes.length,
      observations: ["일별 가격 이력이 20일 미만이라 보수적인 판단 기준을 적용할 수 없습니다."],
      disclaimer: "짧은 이력이나 상장 초기 데이터만으로 추세 전환을 단정하지 않습니다."
    };
  }
  const latest = closes.at(-1);
  const returnOver = (days) => closes.length > days ? (latest / closes[closes.length - 1 - days] - 1) * 100 : null;
  const sma20 = movingAverage(closes, 20);
  const sma50 = movingAverage(closes, 50);
  const sma200 = movingAverage(closes, 200);
  const sma20Prior = closes.length >= 27 ? movingAverage(closes.slice(0, -7), 20) : null;
  const rollingSma = (values, length) => {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= length) sum -= values[i - length];
      if (i >= length - 1) out[i] = sum / length;
    }
    return out;
  };
  const r20 = rollingSma(closes, 20);
  const r50 = rollingSma(closes, 50);
  let daysSinceGolden = null;
  let daysSinceDead = null;
  for (let i = closes.length - 1; i >= Math.max(1, closes.length - 15); i--) {
    if (r20[i] === null || r50[i] === null || r20[i - 1] === null || r50[i - 1] === null) continue;
    const diff = r20[i] - r50[i];
    const prev = r20[i - 1] - r50[i - 1];
    if (daysSinceGolden === null && prev <= 0 && diff > 0) daysSinceGolden = closes.length - 1 - i;
    if (daysSinceDead === null && prev >= 0 && diff < 0) daysSinceDead = closes.length - 1 - i;
    if (daysSinceGolden !== null && daysSinceDead !== null) break;
  }
  const sma100 = movingAverage(closes, 100);
  const distToSma100Pct = sma100 === null ? null : (latest / sma100 - 1) * 100;
  const nearSma100 = distToSma100Pct !== null && Math.abs(distToSma100Pct) <= 3;
  const recentLow = Math.min(...closes.slice(-7));
  const priorLow = Math.min(...closes.slice(-14, -7));
  const high30 = Math.max(...closes.slice(-30));
  const drawdownFrom30dHighPct = (latest / high30 - 1) * 100;
  const return7dPct = returnOver(7);
  const return30dPct = returnOver(30);
  const return90dPct = returnOver(90);
  const higherLow = recentLow > priorLow;
  const risingSma20 = sma20Prior !== null && sma20 > sma20Prior;
  const weeklyCloses = [];
  for (let i = entries.length - 1; i >= 0 && weeklyCloses.length < 60; i -= 7) weeklyCloses.unshift(entries[i][1]);
  const weeklySma20 = movingAverage(weeklyCloses, 20);
  const weeklySma50 = movingAverage(weeklyCloses, 50);
  const priceVsWeekly20Pct = weeklySma20 === null ? null : (latest / weeklySma20 - 1) * 100;
  let weeklyBreakout = false;
  if (weeklyCloses.length >= 21) {
    const priorWeekly20 = movingAverage(weeklyCloses.slice(0, -1), 20);
    if (priorWeekly20 !== null) {
      weeklyBreakout = weeklyCloses.at(-2) <= priorWeekly20 && latest > weeklySma20;
    }
  }
  const correctionDetected = drawdownFrom30dHighPct <= -8 + 1e-9 || (return30dPct !== null && return30dPct <= -8 + 1e-9);
  const reboundStructure = return7dPct > 0 && higherLow && risingSma20;
  const avgVol = (list) => {
    const valid = list.filter((v) => Number.isFinite(v) && v >= 0);
    if (!valid.length) return null;
    return valid.reduce((sum, v) => sum + v, 0) / valid.length;
  };
  const volRecent = vols.length >= 3 ? avgVol(vols.slice(-3)) : null;
  const volBase = vols.length >= 23 ? avgVol(vols.slice(-23, -3)) : null;
  const volSurge20x = (volRecent !== null && volBase !== null && volBase > 0) ? volRecent / volBase : null;
  const volumeConfirmed = volSurge20x !== null && volSurge20x >= 1.5;
  const stdev = (list) => {
    if (list.length < 2) return null;
    const mean = list.reduce((sum, v) => sum + v, 0) / list.length;
    return Math.sqrt(list.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / (list.length - 1));
  };
  const dailyReturns = closes.slice(1).map((c, i) => (c / closes[i] - 1) * 100);
  const volRecentSd = dailyReturns.length >= 5 ? stdev(dailyReturns.slice(-5)) : null;
  const volPriorSd = dailyReturns.length >= 25 ? stdev(dailyReturns.slice(-25, -5)) : null;
  const volContraction = (volRecentSd !== null && volPriorSd !== null && volPriorSd > 0)
    ? volRecentSd < 0.7 * volPriorSd : null;
  const lastReturn = closes.length >= 2 ? (latest / closes[closes.length - 2] - 1) * 100 : null;
  const lastDayVol = vols.at(-1);
  const powerCandle = lastReturn !== null && lastReturn >= 3 && lastDayVol !== null && volBase !== null && volBase > 0
    ? lastDayVol >= 1.5 * volBase : false;
  const aligned = latest > sma20 && sma50 !== null && sma20 > sma50;
  const sma20Strong = (() => {
    if (closes.length < 25) return false;
    const sma20FiveAgo = movingAverage(closes.slice(0, -5), 20);
    return sma20FiveAgo !== null && sma20 > sma20FiveAgo && risingSma20;
  })();
  const boxTop20 = closes.length >= 22 ? Math.max(...closes.slice(-21, -1)) : null;
  const boxPosition = boxTop20 !== null && boxTop20 > 0 ? latest / boxTop20 : null;
  const condensed = boxPosition !== null && boxPosition >= 0.97 && boxPosition <= 1.10;
  const dayOneBase = vols.length >= 22 ? avgVol(vols.slice(-21, -1)) : null;
  const maxClose30 = closes.length >= 32 ? Math.max(...closes.slice(-31, -1)) : null;
  const dayOne = (dayOneBase !== null && dayOneBase > 0 && maxClose30 !== null && Number.isFinite(lastReturn))
    ? (lastDayVol !== null && lastDayVol >= 3.0 * dayOneBase && latest > maxClose30 ? "partial" : false)
    : null;
  const reversalParts = { volume: 0, vcp: 0, align: 0, box: 0 };
  const reversalWhy = [];
  if (volSurge20x !== null) {
    if (volSurge20x >= 2.0) { reversalParts.volume = 30; reversalWhy.push("거래량 2.0배+"); }
    else if (volSurge20x >= 1.5) { reversalParts.volume = 18; reversalWhy.push("거래량 1.5배+"); }
    else if (volSurge20x >= 1.2) { reversalParts.volume = 8; reversalWhy.push("거래량 1.2배+"); }
    else reversalWhy.push("거래량 미동반");
  } else reversalWhy.push("거래량 확인불가");
  if (volContraction === true) { reversalParts.vcp = 25; reversalWhy.push("VCP 변동폭 축소"); }
  else if (volContraction === false) reversalWhy.push("변동폭 축소 없음");
  else reversalWhy.push("VCP 확인불가");
  if (aligned && sma20Strong) { reversalParts.align = 25; reversalWhy.push("정배열+20일선 변곡"); }
  else if (aligned) { reversalParts.align = 12; reversalWhy.push("정배열(변곡 미확인)"); }
  else if (risingSma20) { reversalParts.align = 6; reversalWhy.push("20일선 상승 중"); }
  else reversalWhy.push("정배열 아님");
  if (condensed) { reversalParts.box = 20; reversalWhy.push("박스 상단 응축"); }
  else if (boxPosition !== null && boxPosition > 1.10) { reversalParts.box = 8; reversalWhy.push("박스 상단 이탈(추격 주의)"); }
  else if (boxPosition !== null) reversalWhy.push("박스 하단");
  else reversalWhy.push("박스 확인불가");
  const reversalScore = reversalParts.volume + reversalParts.vcp + reversalParts.align + reversalParts.box;
  const reversalClass = reversalScore >= 60 ? "ignition" : reversalScore >= 40 ? "watch" : "noise";
  let status = "mixed";
  let label = "혼조·추세 전환 확인 중";
  if (reversalScore >= 60 && volumeConfirmed && aligned) {
    status = "momentum_ignition";
    label = (dayOne === "partial" || dayOne === true)
      ? `Day 1 점화 ${reversalScore}점 — 거래량 폭발·신고점 돌파 (추가 확인 필요)`
      : `상승 모멘텀 초입 ${reversalScore}점 — 거래량·VCP·정배열 충족 (추가 확인 필요)`;
  } else if (daysSinceGolden !== null && daysSinceGolden <= 10 && volumeConfirmed) {
    status = "golden_cross_daily";
    label = `20일선→50일선 골든크로스 ${daysSinceGolden}일 전 — 전환 지속 여부는 추가 확인 필요`;
  } else if (dayOne && aligned) {
    status = "momentum_ignition";
    label = "Day 1 점화 후보 — 거래량 폭발·신고점 돌파 (정배열, 추가 확인 필요)";
  } else if (correctionDetected && aligned && sma20Strong && volumeConfirmed && reboundStructure) {
    status = "post_correction_early_reversal";
    label = "조정 후 상승 전환 초입 — 정배열·거래량·반등 구조 충족 (추가 확인 필요)";
  } else if (correctionDetected && latest > sma20 && volumeConfirmed && (reboundStructure || powerCandle)) {
    status = "volume_breakout_watch";
    label = "조정 후 거래량 동반 돌파 관찰 — 정배열 완성 전";
  } else if (dayOne) {
    status = "volume_breakout_watch";
    label = "수급 폭발 초입 — 신고점 돌파 (정배열 미완성, 추가 확인 필요)";
  } else if (correctionDetected && reboundStructure) {
    status = "post_correction_recovery_watch";
    label = "조정 후 초기 회복 관찰 — 20일선 회복 전";
  } else if (sma50 !== null && aligned && sma20Strong && return7dPct > 0 && higherLow && (volumeConfirmed || volSurge20x === null)) {
    status = "trend_reversal_conditions";
    label = "상승 모멘텀 조건 충족 — 최근 조정 후 전환은 미확인";
  } else if (return7dPct > 0 && latest < sma20 && (!risingSma20 || !volumeConfirmed)) {
    status = "noise_bounce";
    label = "일시 반등(데드캣 주의) — 이평 아래·거래량 미동반";
  } else if (reboundStructure && volumeConfirmed) {
    status = "early_reversal_attempt";
    label = "초기 반등 시도 — 거래량 동반 (조정 후 전환은 미확인)";
  } else if (latest < sma20 && return7dPct < 0) {
    status = "correction_possible";
    label = "조정·약세 진행 가능성";
  } else if (reboundStructure) {
    status = "early_reversal_attempt";
    label = "초기 반등 조건 일부 충족 — 명확한 조정 후 전환은 미확인";
  }
  return {
    status,
    label,
    sampleDays: closes.length,
    weeklySamples: weeklyCloses.length,
    asOf: new Date().toISOString(),
    correctionDetected,
    metrics: {
      return7dPct,
      return30dPct,
      return90dPct,
      priceVsSma20Pct: (latest / sma20 - 1) * 100,
      sma20VsSma50Pct: sma50 === null ? null : (sma20 / sma50 - 1) * 100,
      priceVsSma200Pct: sma200 === null ? null : (latest / sma200 - 1) * 100,
      priceVsWeekly20Pct,
      weekly20VsWeekly50Pct: (weeklySma20 === null || weeklySma50 === null) ? null : (weeklySma20 / weeklySma50 - 1) * 100,
      distToSma100Pct,
      nearSma100,
      daysSinceGoldenCross: daysSinceGolden,
      daysSinceDeadCross: daysSinceDead,
      weeklyBreakout,
      volSurge20x,
      volumeConfirmed,
      volContraction,
      powerCandle,
      aligned,
      sma20Strong,
      dayOne,
      reversalScore,
      reversalWhy,
      reversalClass,
      boxTop20,
      drawdownFrom30dHighPct,
      higherLow,
      risingSma20
    },
    observations: [
      "일봉 종가와 거래량으로 7일·30일·90일 수익률, 20일·50일·200일선, 거래량 20일 평균 대비 최근 3일 배율, VCP 축소, 박스 위치를 계산했습니다.",
      volSurge20x === null
        ? "거래량 자료가 없어 거래량 동반 여부를 확인하지 못했습니다. 거래량 필요 조건은 미충족으로 처리합니다."
        : `최근 3일 평균 거래량은 직전 20일 평균의 ${volSurge20x.toFixed(2)}배입니다(2.0배 이상이면 폭증, Day 1은 3.0배).`,
      volContraction === null
        ? "변동성 축소(VCP) 계산에 필요한 이력이 부족합니다."
        : (volContraction ? "최근 5일 변동폭이 직전 20일 대비 30% 이상 줄었습니다(매물 건조 가능)." : "최근 변동폭 축소가 관측되지 않았습니다."),
      dayOne === true
        ? "Day 1 충족: 당일 거래량 3배+·30일 신고점 돌파·깨끗한 양봉(OHLC 확인)."
        : dayOne === "partial"
          ? "Day 1 부분 충족: 거래량 3배+·30일 신고점 돌파 (윗꼬리는 OHLC 부족으로 미확인, 바이낸스 화면에서 확인 필요)."
          : "Day 1 조건(거래량 3배+신고점 돌파+깨끗한 양봉)을 충족하지 못했습니다.",
      "마지막 봉은 미확정일 수 있어 다음날 종가로 재확인이 필요합니다."
    ],
    disclaimer: "거래량·변동성·이평 정배열을 함께 본 규칙 참고치이며 조정 종료나 미래 상승을 확정하지 않습니다. 마지막 봉은 미확정일 수 있습니다."
  };
}

function normalizePairs(payload, chain) {
  const chainId = CHAIN_NETWORKS[chain]?.dex;
  const pairs = Array.isArray(payload) ? payload : payload?.pairs || [];
  return pairs
    .filter((pair) => !chainId || pair.chainId?.toLowerCase() === chainId)
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
    .slice(0, 8)
    .map((pair) => ({
      chain: pair.chainId,
      dex: pair.dexId,
      pairAddress: pair.pairAddress,
      baseToken: pair.baseToken,
      quoteToken: pair.quoteToken,
      priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
      marketCapUsd: pair.marketCap ?? null,
      fdvUsd: pair.fdv ?? null,
      liquidityUsd: pair.liquidity?.usd ?? null,
      volume24hUsd: pair.volume?.h24 ?? null,
      priceChange24hPct: pair.priceChange?.h24 ?? null,
      buys24h: pair.txns?.h24?.buys ?? null,
      sells24h: pair.txns?.h24?.sells ?? null,
      pairCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null,
      url: pair.url
    }));
}

function normalizeGeckoTerminal(payload) {
  const pools = payload?.data;
  if (!Array.isArray(pools)) return [];
  return pools.slice(0, 8).map((pool) => {
    const item = pool.attributes || {};
    return {
      name: item.name,
      address: item.address,
      priceUsd: item.token_price_usd ? Number(item.token_price_usd) : null,
      marketCapUsd: item.market_cap_usd ?? null,
      fdvUsd: item.fdv_usd ?? null,
      liquidityUsd: item.reserve_in_usd ? Number(item.reserve_in_usd) : null,
      volume24hUsd: item.volume_usd?.h24 ? Number(item.volume_usd.h24) : null,
      transactions24h: item.transactions?.h24 ?? null,
      createdAt: item.pool_created_at ?? null,
      url: item.address ? `https://www.geckoterminal.com/${encodeURIComponent(pool.relationships?.network?.data?.id || "")}/pools/${encodeURIComponent(item.address)}` : null
    };
  });
}

function normalizeGoPlusRecord(record, chain) {
  if (!record || typeof record !== "object") return null;
  if (chain === "solana") {
    const fields = [
      "mintable", "freezable", "closable", "balance_mutable_authority",
      "mutable_metadata", "non_transferable", "transfer_fee", "trusted_token",
      "holder_count", "creator_address"
    ];
    return {
      network: "Solana (Beta API)",
      flags: Object.fromEntries(fields.filter((key) => record[key] !== undefined).map((key) => [key, record[key]])),
      disclaimer: "GoPlus 제공자 원자료의 일부입니다. Beta 결과는 포괄적 감사·안전 판정이 아니며, 필드 정의와 결과를 직접 확인하세요."
    };
  }
  return {
    network: chain,
    flags: Object.fromEntries(GOPLUS_EVM_FIELDS.filter((key) => record[key] !== undefined).map((key) => [key, record[key]])),
    disclaimer: "GoPlus가 제공한 자동 보안 탐지 원자료입니다. 미탐지·오탐 가능성이 있으며 스마트컨트랙트 감사나 안전 보증이 아닙니다."
  };
}

let cmcMapCache = null;
let cmcMapLoading = null;
async function loadCmcMap() {
  if (cmcMapCache && Date.now() - cmcMapCache.at < 24 * 60 * 60 * 1000) return cmcMapCache;
  if (!cmcMapLoading) {
    cmcMapLoading = (async () => {
      const payload = await fetchJson("https://api.coinmarketcap.com/data-api/v3/map/all?listing_status=active");
      const list = Array.isArray(payload?.data?.cryptoCurrencyMap) ? payload.data.cryptoCurrencyMap : null;
      if (!list) throw new Error("CMC map returned an unexpected shape.");
      const bySymbol = new Map();
      for (const entry of list) {
        const sym = String(entry?.symbol || "").toUpperCase();
        const slug = String(entry?.slug || "");
        if (!sym || !slug) continue;
        if (!bySymbol.has(sym)) bySymbol.set(sym, []);
        bySymbol.get(sym).push({
          id: entry.id ?? null,
          name: entry.name ?? "",
          symbol: entry.symbol ?? "",
          slug,
          rank: Number.isFinite(entry.rank) ? entry.rank : null,
          active: entry.is_active === 1 && entry.status === "active"
        });
      }
      cmcMapCache = { at: Date.now(), bySymbol };
      return cmcMapCache;
    })();
    cmcMapLoading.catch(() => {}).finally(() => { cmcMapLoading = null; });
  }
  return cmcMapLoading;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return reply(res, 405, { error: "Only GET is supported." });
  }

  const query = req.query || {};
  const mode = value(query, "mode", 12).toLowerCase();
  const page = value(query, "page", 4);
  const symbol = value(query, "symbol", 16).toUpperCase();
  const chain = value(query, "chain", 20).toLowerCase();
  const address = value(query, "address", 64);
  const geckoId = value(query, "geckoId", 80).toLowerCase();
  const protocol = value(query, "protocol", 80).toLowerCase();
  const cmcId = value(query, "cmcId", 12);
  const tradingViewSymbol = value(query, "tradingViewSymbol", 40).toUpperCase();
  const requestHeaders = req.headers || {};
  const rawPersonalCmcKey = requestHeaders["x-user-cmc-api-key"];
  const rawPersonalCoinGlassKey = requestHeaders["x-user-coinglass-api-key"];
  const personalCmcKey = typeof rawPersonalCmcKey === "string" ? rawPersonalCmcKey.trim() : "";
  const personalCoinGlassKey = typeof rawPersonalCoinGlassKey === "string" ? rawPersonalCoinGlassKey.trim() : "";
  const errors = [];

  if ((rawPersonalCmcKey !== undefined && (typeof rawPersonalCmcKey !== "string" || personalCmcKey.length > 512)) ||
      (rawPersonalCoinGlassKey !== undefined && (typeof rawPersonalCoinGlassKey !== "string" || personalCoinGlassKey.length > 512))) {
    errors.push("API 키 헤더 형식이 올바르지 않습니다.");
  }
  if (mode && !["rank", "overview", "trend", "news", "cmcresolve"].includes(mode)) errors.push("지원되지 않는 조회 모드입니다.");
  if (mode === "rank" && (!/^\d{1,4}$/.test(page) || Number(page) < 1 || Number(page) > 100)) errors.push("시총 순위 페이지는 1~100 사이여야 합니다.");
  const category = value(query, "category", 80).toLowerCase();
  if (category && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(category)) errors.push("섹터 카테고리 ID 형식이 올바르지 않습니다.");
  if (mode && ["rank", "overview"].includes(mode) && (symbol || geckoId || address || protocol || cmcId)) errors.push("시장 요약·시총 순위 요청에는 개별 자산 조건을 함께 보낼 수 없습니다.");
  if (mode === "trend" && (!geckoId || symbol || address || protocol || cmcId)) errors.push("추세 분석에는 CoinGecko ID만 지정해야 합니다.");
  if (!mode && !symbol && !geckoId && !address && !protocol && !cmcId) errors.push("종목 티커, GeckoTerminal ID, 컨트랙트 주소, DefiLlama 프로토콜 ID 또는 CoinMarketCap ID가 필요합니다.");
  if (symbol && !/^[A-Z0-9]{1,16}$/.test(symbol)) errors.push("티커 형식이 올바르지 않습니다.");
  if (geckoId && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(geckoId)) errors.push("CoinGecko ID 형식이 올바르지 않습니다.");
  if (protocol && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(protocol)) errors.push("DefiLlama 프로토콜 ID 형식이 올바르지 않습니다.");
  if (cmcId && !/^\d{1,12}$/.test(cmcId)) errors.push("CoinMarketCap ID는 숫자여야 합니다.");
  if (chain && !CHAIN_NETWORKS[chain]) errors.push("지원되지 않는 체인입니다.");
  if (address && chain && CHAIN_NETWORKS[chain]?.evm && !/^0x[a-fA-F0-9]{40}$/.test(address)) errors.push("EVM 토큰 주소 형식이 올바르지 않습니다.");
  if (address && chain === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) errors.push("Solana 토큰 주소 형식이 올바르지 않습니다.");
  if (tradingViewSymbol && !/^[A-Z0-9:_-]{1,40}$/.test(tradingViewSymbol)) errors.push("TradingView 심볼 형식이 올바르지 않습니다.");
  if (errors.length) return reply(res, 400, { error: errors.join(" ") });

  if (mode === "overview") {
    const [marketResult, fxResult] = await Promise.allSettled([
      fetchJson("https://api.coingecko.com/api/v3/global"),
      fetchJson("https://open.er-api.com/v6/latest/USD")
    ]);
    const marketData = marketResult.status === "fulfilled" ? marketResult.value?.data : null;
    const fxData = fxResult.status === "fulfilled" ? fxResult.value : null;
    const totalMarketCap = marketData?.total_market_cap;
    const totalVolume = marketData?.total_volume;
    const marketHasValues = Number.isFinite(totalMarketCap?.usd) && Number.isFinite(totalMarketCap?.krw);
    const fxHasValues = fxData?.result === "success" && Number.isFinite(fxData.rates?.KRW) && Number.isFinite(fxData.time_last_update_unix);
    if (marketResult.status === "rejected") console.error("CoinGecko global market summary failed:", marketResult.reason);
    else if (!marketHasValues) console.error("CoinGecko global market summary returned an unexpected data shape.");
    if (fxResult.status === "rejected" || !fxHasValues) console.error("USD/KRW exchange-rate source unavailable:", fxResult.status === "rejected" ? fxResult.reason : "Unexpected response shape.");
    return reply(res, 200, {
      mode: "overview",
      fetchedAt: new Date().toISOString(),
      markets: marketHasValues
        ? {
          status: "ok",
          source: "CoinGecko /global",
          totalMarketCapUsd: totalMarketCap.usd,
          totalMarketCapKrw: totalMarketCap.krw,
          totalVolume24hUsd: Number.isFinite(totalVolume?.usd) ? totalVolume.usd : null,
          totalVolume24hKrw: Number.isFinite(totalVolume?.krw) ? totalVolume.krw : null,
          marketCapChange24hPct: marketData.market_cap_change_percentage_24h_usd ?? null,
          btcDominancePct: marketData.market_cap_percentage?.btc ?? null,
          ethDominancePct: marketData.market_cap_percentage?.eth ?? null,
          activeCryptocurrencies: marketData.active_cryptocurrencies ?? null,
          updatedAt: Number.isFinite(marketData.updated_at) ? new Date(marketData.updated_at * 1000).toISOString() : null
        }
        : { status: "unavailable", error: marketResult.status === "rejected" ? "전세계 시총 제공자에 연결하지 못했습니다." : "전세계 시총 응답에 필수 값이 없어 표시할 수 없습니다." },
      fx: fxHasValues
        ? {
          status: "ok",
          source: "ExchangeRate-API open.er-api.com",
          usdKrw: fxData.rates.KRW,
          updatedAt: new Date(fxData.time_last_update_unix * 1000).toISOString(),
          nextUpdateAt: Number.isFinite(fxData.time_next_update_unix) ? new Date(fxData.time_next_update_unix * 1000).toISOString() : null
        }
        : { status: "unavailable", error: "USD/KRW 환율을 확인할 수 없습니다. 한화 환산은 표시하지 않습니다." },
      disclaimer: "암호자산 API 시세와 환율은 제공자 갱신주기에 따르며 거래소 틱 실시간 시세를 보장하지 않습니다. 환율은 ExchangeRate-API가 갱신한 USD/KRW 기준값이며, KRW 환산은 표시용 참고치입니다."
    });
  }

  if (mode === "trend") {
    try {
      const history = await fetchJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(geckoId)}/market_chart?vs_currency=usd&days=365&interval=daily`);
      if (!Array.isArray(history.prices)) throw new Error("CoinGecko returned an unexpected price-history shape.");
      const latestPricePointAt = history.prices.at(-1)?.[0]
        ? new Date(history.prices.at(-1)[0]).toISOString()
        : null;
      return reply(res, 200, {
        mode: "trend",
        id: geckoId,
        fetchedAt: new Date().toISOString(),
        source: `https://www.coingecko.com/en/coins/${encodeURIComponent(geckoId)}`,
        latestPricePointAt,
        trend: analyzePriceTrend(history.prices, history.total_volumes),
        disclaimer: "CoinGecko 365일 일봉 + 주봉 재표본 규칙 분석입니다. 초단기 체결·거래량, 거래소별 유동성, 온체인 활동을 반영하지 않으며 매매 신호가 아닙니다."
      });
    } catch (error) {
      console.error("CoinGecko trend scan failed:", error);
      return reply(res, 502, { error: "365일 가격 이력을 불러오지 못했습니다. 이 종목의 추세는 확인 불가입니다." });
    }
  }

  if (mode === "news") {
    const q = value(query, "q", 80);
    if (!q) return reply(res, 400, { error: "뉴스 검색어를 입력해 주세요." });
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR%3Ako`;
      const response = await fetch(rssUrl, { headers: { Accept: "application/rss+xml, application/xml" }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`News provider returned HTTP ${response.status}`);
      const xml = await response.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10).map((m) => {
        const block = m[1];
        const pick = (tag) => {
          const found = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\/${tag}>`));
          if (!found) return null;
          return found[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() || null;
        };
        return { title: pick("title"), link: pick("link"), publishedAt: pick("pubDate"), source: pick("source") };
      }).filter((item) => item.title && item.link);
      return reply(res, 200, {
        mode: "news",
        query: q,
        fetchedAt: new Date().toISOString(),
        source: "Google News RSS",
        sourceUrl: rssUrl,
        items,
        disclaimer: "뉴스 제목·링크·게시시각 원문 그대로입니다. 요약·감정 분석을 하지 않으며, 기사 내용을 검증하지 않습니다."
      });
    } catch (error) {
      console.error("News lookup failed:", error);
      return reply(res, 502, { error: "뉴스를 불러오지 못했습니다. 잠시 후 다시 시도하거나 포털에서 직접 검색해 주세요." });
    }
  }

  if (mode === "cmcresolve") {
    const q = value(query, "q", 16).toUpperCase();
    const hint = typeof query.name === "string" ? query.name.trim().slice(0, 80) : "";
    if (!q || !/^[A-Z0-9]{1,16}$/.test(q)) return reply(res, 400, { error: "티커 형식이 올바르지 않습니다." });
    try {
      const map = await loadCmcMap();
      const pool = ((map.bySymbol || new Map()).get(q) || []).filter((e) => e.slug);
      if (!pool.length) return reply(res, 404, { error: "CoinMarketCap 등록 종목에서 해당 티커를 찾지 못했습니다. CoinGecko 원문과 DEX 검색으로 확인해 주세요." });
      const hintWords = hint.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
      const scored = pool.map((e) => {
        const nameWords = String(e.name).toLowerCase().split(/[^a-z0-9]+/);
        const overlap = hintWords.filter((w) => nameWords.includes(w)).length;
        return { e, overlap };
      }).sort((a, b) => (b.overlap - a.overlap) || ((a.e.rank ?? 1e9) - (b.e.rank ?? 1e9)) || ((a.e.id ?? 1e12) - (b.e.id ?? 1e12)));
      const best = scored[0].e;
      const inactiveNote = pool.some((e) => e.active) && !best.active ? " (비활성 종목일 수 있음)" : "";
      return reply(res, 200, {
        mode: "cmcresolve",
        query: q,
        id: best.id,
        name: best.name,
        symbol: best.symbol,
        slug: best.slug,
        cmcRank: best.rank,
        url: `https://coinmarketcap.com/currencies/${encodeURIComponent(best.slug)}/`,
        candidates: pool.length,
        fetchedAt: new Date().toISOString(),
        mapAt: new Date(map.at).toISOString(),
        disclaimer: `CoinMarketCap 공개 종목 지도의 티커·이름 대조 결과${inactiveNote}입니다. 동명 티커가 있으면 이름이 가장 겹치는 종목을 고르며, 최종 신원은 페이지에서 직접 확인하세요.`
      });
    } catch (error) {
      console.error("CMC resolve failed:", error);
      return reply(res, 502, { error: "CoinMarketCap 종목 지도에 연결하지 못했습니다. 잠시 후 다시 시도하거나 찾기 링크를 이용해 주세요." });
    }
  }

  if (mode === "rank") {
    try {
      const categoryParam = category ? `&category=${encodeURIComponent(category)}` : "";
      const coins = await fetchJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${Number(page)}&sparkline=false&price_change_percentage=24h%2C7d%2C30d${categoryParam}`);
      if (!Array.isArray(coins)) throw new Error("CoinGecko returned an unexpected market-list shape.");
      return reply(res, 200, {
        mode: "rank",
        page: Number(page),
        category: category || null,
        returned: coins.length,
        fetchedAt: new Date().toISOString(),
        cache: "disabled",
        source: "CoinGecko /coins/markets",
        sourceUrl: "https://www.coingecko.com/en/coins/markets",
        disclaimer: category
          ? "CoinGecko 분야(category) 필터를 적용한 순위 자료입니다. ID가 틀리면 제공자가 오류를 반환하며 임의 분류로 대체하지 않습니다."
          : "CoinGecko가 시가총액 순으로 제공한 페이지 자료입니다. 전체 암호자산 수·순위가 매겨지지 않은 종목은 포함되지 않을 수 있으며, 실시간 순위는 변동합니다.",
        coins: coins.map((coin) => ({
          rank: coin.market_cap_rank ?? null,
          id: coin.id,
          name: coin.name,
          symbol: coin.symbol?.toUpperCase() || "",
          priceUsd: coin.current_price ?? null,
          marketCapUsd: coin.market_cap ?? null,
          volume24hUsd: coin.total_volume ?? null,
          fullyDilutedValuationUsd: coin.fully_diluted_valuation ?? null,
          circulatingSupply: coin.circulating_supply ?? null,
          totalSupply: coin.total_supply ?? null,
          maxSupply: coin.max_supply ?? null,
          change24hPct: coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h ?? null,
          change7dPct: coin.price_change_percentage_7d_in_currency ?? null,
          change30dPct: coin.price_change_percentage_30d_in_currency ?? null,
          lastUpdated: coin.last_updated ?? null,
          url: coin.id ? `https://www.coingecko.com/en/coins/${encodeURIComponent(coin.id)}` : null
        }))
      });
    } catch (error) {
      console.error("CoinGecko market ranking failed:", error);
      return reply(res, 502, { error: "CoinGecko 시총 순위를 불러오지 못했습니다. 잠시 후 다시 시도하거나 제공자 페이지에서 직접 확인해 주세요." });
    }
  }

  const sources = [];
  const jobs = [];

  if (geckoId) {
    jobs.push(sourceResult("CoinGecko", async () => {
      const data = await fetchJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(geckoId)}?localization=false&tickers=true&market_data=true&community_data=false&developer_data=false`);
      const market = data.market_data || {};
      const tickers = Array.isArray(data.tickers) ? data.tickers.slice(0, 30).map((t) => ({
        exchange: t.market?.name ?? null,
        base: t.base ?? null,
        target: t.target ?? null,
        pair: t.base && t.target ? `${t.base}/${t.target}` : null,
        volumeUsd: t.converted_volume?.usd ?? t.volume ?? null,
        trust: t.trust_score ?? null,
        tradeUrl: typeof t.trade_url === "string" && t.trade_url.startsWith("https://") ? t.trade_url : null
      })) : [];
      return {
        name: data.name,
        symbol: data.symbol?.toUpperCase(),
        marketCapRank: data.market_cap_rank ?? null,
        url: `https://www.coingecko.com/en/coins/${encodeURIComponent(geckoId)}`,
        cmcSearchUrl: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:coinmarketcap.com/currencies ${data.symbol || data.name || ""}`)}`,
        priceUsd: market.current_price?.usd ?? null,
        priceKrw: market.current_price?.krw ?? null,
        marketCapUsd: market.market_cap?.usd ?? null,
        marketCapKrw: market.market_cap?.krw ?? null,
        fdvUsd: market.fully_diluted_valuation?.usd ?? null,
        fdvKrw: market.fully_diluted_valuation?.krw ?? null,
        circulatingSupply: market.circulating_supply ?? null,
        totalSupply: market.total_supply ?? null,
        maxSupply: market.max_supply ?? null,
        volume24hUsd: market.total_volume?.usd ?? null,
        volume24hKrw: market.total_volume?.krw ?? null,
        categories: Array.isArray(data.categories) ? data.categories : [],
        marketNetworks: Object.entries(data.platforms || {}).filter(([, contract]) => typeof contract === "string" && contract.trim()).map(([network]) => network),
        assetPlatformId: data.asset_platform_id ?? null,
        homepage: Array.isArray(data.links?.homepage) ? data.links.homepage.find((url) => typeof url === "string" && url.startsWith("https://")) || null : null,
        tickers,
        tickerCount: Array.isArray(data.tickers) ? data.tickers.length : null,
        lastUpdated: market.last_updated ?? null
      };
    }));
    jobs.push(sourceResult("CoinGecko 365-day trend", async () => {
      const history = await fetchJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(geckoId)}/market_chart?vs_currency=usd&days=365&interval=daily`);
      if (!Array.isArray(history.prices)) throw new Error("CoinGecko returned an unexpected price-history shape.");
      return {
        trend: analyzePriceTrend(history.prices, history.total_volumes),
        latestPricePointAt: history.prices?.at(-1)?.[0] ? new Date(history.prices.at(-1)[0]).toISOString() : null,
        source: `https://www.coingecko.com/en/coins/${encodeURIComponent(geckoId)}`,
        disclaimer: "365일 일봉 + 주봉 재표본 기반 규칙 분석이며 매매 신호나 조정 종료 판정이 아닙니다."
      };
    }));
  }

  if (address && chain) {
    const network = CHAIN_NETWORKS[chain];
    jobs.push(sourceResult("DEX Screener", async () => {
      const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`);
      return { pairs: normalizePairs(data, chain), verifiedBy: "address + selected chain", disclaimer: "Pair listing is not proof of official token identity." };
    }));
    jobs.push(sourceResult("GeckoTerminal", async () => {
      const data = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${network.gecko}/tokens/${encodeURIComponent(address)}/pools?page=1`);
      return { pools: normalizeGeckoTerminal(data), disclaimer: "Pool and token-reported market data; verify contract identity independently." };
    }));
    jobs.push(sourceResult("GoPlus Token Security", async () => {
      const url = network.evm
        ? `https://api.gopluslabs.io/api/v1/token_security/${network.goplus}?contract_addresses=${encodeURIComponent(address)}`
        : `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(address)}`;
      const payload = await fetchJson(url);
      if (payload.code !== 1 && payload.code !== "1") throw new Error("GoPlus returned a non-success status.");
      const record = Object.entries(payload.result || {}).find(([key]) => key.toLowerCase() === address.toLowerCase())?.[1];
      return normalizeGoPlusRecord(record, chain);
    }));
  } else if (address) {
    jobs.push(sourceResult("DEX Screener", async () => {
      const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`);
      return { pairs: normalizePairs(data, ""), verifiedBy: "address only, all chains", disclaimer: "체인 미지정 전 체인 검색입니다. 쌍 목록의 체인을 확인해 체인을 선택하면 GeckoTerminal·GoPlus까지 조회됩니다." };
    }));
    jobs.push(Promise.resolve({ source: "GeckoTerminal", status: "not_configured", error: "체인을 선택하면 해당 체인의 풀로 조회됩니다. 쌍 목록의 체인 표시를 확인하세요." }));
    jobs.push(Promise.resolve({ source: "GoPlus Token Security", status: "not_configured", error: "체인을 선택하면 컨트랙트 보안 원자료를 조회됩니다." }));
  } else if (symbol) {
    jobs.push(sourceResult("DEX Screener", async () => {
      const data = await fetchJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`);
      return { pairs: normalizePairs(data, chain), verifiedBy: "ticker search only", disclaimer: "Ticker search can return impersonators. Verify chain and token contract before relying on any result." };
    }));
  }

  if (protocol) {
    jobs.push(sourceResult("DefiLlama", async () => {
      const [protocolResult, feesResult] = await Promise.allSettled([
        fetchJson(`https://api.llama.fi/protocol/${encodeURIComponent(protocol)}`),
        fetchJson(`https://api.llama.fi/summary/fees/${encodeURIComponent(protocol)}`)
      ]);
      if (protocolResult.status === "rejected") throw protocolResult.reason;
      const protocolData = protocolResult.value;
      const feesPayload = feesResult.status === "fulfilled" ? feesResult.value : null;
      const hasFeeShape = feesPayload && typeof feesPayload === "object" &&
        ["total24h", "total7d", "total30d", "totalDataChart"].some((key) => Object.prototype.hasOwnProperty.call(feesPayload, key));
      const feesStatus = feesResult.status === "fulfilled" && hasFeeShape ? "ok" : "unavailable";
      const feesData = feesStatus === "ok" ? feesPayload : null;
      if (feesStatus === "unavailable") {
        console.error("DefiLlama fee summary unavailable:", feesResult.status === "rejected" ? feesResult.reason : "Unexpected response shape.");
      }
      const latest = lastTvlPoint(protocolData.tvl);
      return {
        name: protocolData.name || feesData?.name || protocol,
        url: protocolData.url || feesData?.url || null,
        chains: protocolData.chains || [],
        category: protocolData.category || feesData?.category || null,
        tvlUsd: latest?.usd ?? null,
        tvlAsOf: latest?.timestamp ?? null,
        totalFees24hUsd: feesData?.total24h ?? null,
        totalFees7dUsd: feesData?.total7d ?? null,
        totalFees30dUsd: feesData?.total30d ?? null,
        totalFees30dPeriodEnd: feesData?.totalDataChart?.at(-1)?.[0] ? new Date(feesData.totalDataChart.at(-1)[0] * 1000).toISOString() : null,
        feesStatus,
        feesError: feesStatus === "unavailable" ? "수수료 자료 조회에 실패했거나 예상치 못한 응답 형식입니다. 수수료가 0이거나 없는 것으로 해석하지 마세요." : null,
        revenueMethodology: feesData?.methodology?.Revenue || null,
        holderRevenueMethodology: feesData?.methodology?.HoldersRevenue || null,
        warning: "Fees, protocol revenue, net earnings and tokenholder value are different measures."
      };
    }));
  }

  if (cmcId) {
    const cmcApiKey = personalCmcKey || process.env.CMC_API_KEY;
    jobs.push(cmcApiKey
      ? sourceResult("CoinMarketCap", async () => {
        const data = await fetchJson(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?id=${encodeURIComponent(cmcId)}&convert=USD`, {
          headers: { "X-CMC_PRO_API_KEY": cmcApiKey }
        });
        const coin = data.data?.[cmcId];
        const quote = coin?.quote?.USD;
        if (!coin || !quote) throw new Error("CoinMarketCap asset not found.");
        return {
          name: coin.name,
          symbol: coin.symbol,
          priceUsd: quote.price ?? null,
          marketCapUsd: quote.market_cap ?? null,
          volume24hUsd: quote.volume_24h ?? null,
          circulatingSupply: coin.circulating_supply ?? null,
          totalSupply: coin.total_supply ?? null,
          maxSupply: coin.max_supply ?? null,
          lastUpdated: quote.last_updated ?? null,
          slug: coin.slug
        };
      })
      : Promise.resolve({ source: "CoinMarketCap", status: "not_configured", error: "앱에서 본인 CoinMarketCap 키를 입력하거나 배포 서버에 CMC_API_KEY를 설정해야 합니다." }));
  }

  if (symbol) {
    const coinGlassApiKey = personalCoinGlassKey || process.env.COINGLASS_API_KEY;
    jobs.push(coinGlassApiKey
      ? sourceResult("CoinGlass", async () => {
        const data = await fetchJson(`https://open-api-v4.coinglass.com/api/futures/coins-markets?symbol=${encodeURIComponent(symbol)}`, {
          headers: { "CG-API-KEY": coinGlassApiKey }
        });
        const rows = Array.isArray(data.data) ? data.data : data.data ? [data.data] : [];
        const match = rows.find((row) => row.symbol?.toUpperCase() === symbol) || rows[0];
        if (data.code && data.code !== "0") throw new Error("CoinGlass rejected the request.");
        return match || null;
      })
      : Promise.resolve({ source: "CoinGlass", status: "not_configured", error: "앱에서 본인 CoinGlass 키를 입력하거나 배포 서버에 COINGLASS_API_KEY를 설정해야 합니다. API 요금제 권한을 확인하세요." }));
  }

  const results = await Promise.all(jobs);
  sources.push(...results);
  return reply(res, 200, {
    requested: { symbol: symbol || null, chain: chain || null, address: address || null, geckoId: geckoId || null, protocol: protocol || null, cmcId: cmcId || null },
    fetchedAt: new Date().toISOString(),
    cache: "disabled",
    sources,
    limits: [
      "공개 무료 API는 호출 제한·지연·누락이 있을 수 있으며 응답 실패를 빈 값으로 대신하지 않습니다.",
      "티커 검색 결과는 동명·사칭 토큰을 포함할 수 있습니다. 체인·컨트랙트의 공식 검증을 대신하지 않습니다.",
      "미래 언락 일정, 상위 보유자 집중, 계약 관리자 권한, 실제 바이백·소각은 이 시세·DEX 조회만으로 판정되지 않습니다."
    ]
  });
};
