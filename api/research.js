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

function analyzePriceTrend(points) {
  if (!Array.isArray(points)) return { status: "insufficient_data", label: "추세 확인 불가", observations: [], disclaimer: "CoinGecko 가격 이력이 제공되지 않았습니다." };
  const daily = new Map();
  points.forEach((point) => {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || point[1] <= 0) return;
    daily.set(new Date(point[0]).toISOString().slice(0, 10), point[1]);
  });
  const closes = [...daily.entries()]
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
    .slice(-90)
    .map(([, price]) => price);
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
  const sma20Prior = closes.length >= 27 ? movingAverage(closes.slice(0, -7), 20) : null;
  const recentLow = Math.min(...closes.slice(-7));
  const priorLow = Math.min(...closes.slice(-14, -7));
  const high30 = Math.max(...closes.slice(-30));
  const drawdownFrom30dHighPct = (latest / high30 - 1) * 100;
  const return7dPct = returnOver(7);
  const return30dPct = returnOver(30);
  const higherLow = recentLow > priorLow;
  const risingSma20 = sma20Prior !== null && sma20 > sma20Prior;
  const correctionDetected = drawdownFrom30dHighPct <= -8 + 1e-9 || (return30dPct !== null && return30dPct <= -8 + 1e-9);
  const reboundStructure = return7dPct > 0 && higherLow && risingSma20;
  let status = "mixed";
  let label = "혼조·추세 전환 확인 중";
  if (correctionDetected && latest > sma20 && reboundStructure) {
    status = "post_correction_early_reversal";
    label = "조정 후 상승 전환 초입 후보 — 추가 확인 필요";
  } else if (correctionDetected && reboundStructure) {
    status = "post_correction_recovery_watch";
    label = "조정 후 초기 회복 관찰 — 20일선 회복 전";
  } else if (sma50 !== null && latest > sma20 && sma20 > sma50 && return7dPct > 0 && higherLow && risingSma20) {
    status = "trend_reversal_conditions";
    label = "상승 모멘텀 조건 충족 — 최근 조정 후 전환은 미확인";
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
    asOf: new Date().toISOString(),
    correctionDetected,
    metrics: {
      return7dPct,
      return30dPct,
      priceVsSma20Pct: (latest / sma20 - 1) * 100,
      sma20VsSma50Pct: sma50 === null ? null : (sma20 / sma50 - 1) * 100,
      drawdownFrom30dHighPct,
      higherLow,
      risingSma20
    },
    observations: [
      "일별 종가로 7일·30일 수익률, 20일·50일 단순이동평균, 7일 저점의 저점 높임 여부를 계산했습니다.",
      "상방 조건은 종가 > 20일선 > 50일선, 7일 수익률 양수, 최근 저점 높임, 20일선 상승을 모두 요구합니다.",
      "조정 가능성은 종가가 20일선 아래이고 7일 수익률이 음수일 때 표시합니다."
    ],
    disclaimer: "규칙 기반 가격 모멘텀 참고치입니다. 조정 종료나 미래 상승을 확정하지 않으며, 변동성·유동성·시장 구조·거래소별 가격 차이를 반영하지 않습니다."
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
  if (mode && !["rank", "overview", "trend"].includes(mode)) errors.push("지원되지 않는 조회 모드입니다.");
  if (mode === "rank" && (!/^\d{1,4}$/.test(page) || Number(page) < 1 || Number(page) > 100)) errors.push("시총 순위 페이지는 1~100 사이여야 합니다.");
  if (mode && mode !== "trend" && (symbol || geckoId || address || protocol || cmcId)) errors.push("시장 요약·시총 순위 요청에는 개별 자산 조건을 함께 보낼 수 없습니다.");
  if (mode === "trend" && (!geckoId || symbol || address || protocol || cmcId)) errors.push("추세 분석에는 CoinGecko ID만 지정해야 합니다.");
  if (!mode && !symbol && !geckoId && !address && !protocol && !cmcId) errors.push("종목 티커, GeckoTerminal ID, 컨트랙트 주소, DefiLlama 프로토콜 ID 또는 CoinMarketCap ID가 필요합니다.");
  if (symbol && !/^[A-Z0-9]{1,16}$/.test(symbol)) errors.push("티커 형식이 올바르지 않습니다.");
  if (geckoId && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(geckoId)) errors.push("CoinGecko ID 형식이 올바르지 않습니다.");
  if (protocol && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(protocol)) errors.push("DefiLlama 프로토콜 ID 형식이 올바르지 않습니다.");
  if (cmcId && !/^\d{1,12}$/.test(cmcId)) errors.push("CoinMarketCap ID는 숫자여야 합니다.");
  if (chain && !CHAIN_NETWORKS[chain]) errors.push("지원되지 않는 체인입니다.");
  if (address && !chain) errors.push("컨트랙트 주소를 조회할 때 체인을 선택해야 합니다.");
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
      const history = await fetchJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(geckoId)}/market_chart?vs_currency=usd&days=90&interval=daily`);
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
        trend: analyzePriceTrend(history.prices),
        disclaimer: "CoinGecko 90일 일별 가격의 규칙 기반 분석입니다. 초단기 체결·거래량, 거래소별 유동성, 온체인 활동을 반영하지 않으며 매매 신호가 아닙니다."
      });
    } catch (error) {
      console.error("CoinGecko trend scan failed:", error);
      return reply(res, 502, { error: "90일 가격 이력을 불러오지 못했습니다. 이 종목의 추세는 확인 불가입니다." });
    }
  }

  if (mode === "rank") {
    try {
      const coins = await fetchJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${Number(page)}&sparkline=false&price_change_percentage=24h%2C7d%2C30d`);
      if (!Array.isArray(coins)) throw new Error("CoinGecko returned an unexpected market-list shape.");
      return reply(res, 200, {
        mode: "rank",
        page: Number(page),
        returned: coins.length,
        fetchedAt: new Date().toISOString(),
        cache: "disabled",
        source: "CoinGecko /coins/markets",
        sourceUrl: "https://www.coingecko.com/en/coins/markets",
        disclaimer: "CoinGecko가 시가총액 순으로 제공한 페이지 자료입니다. 전체 암호자산 수·순위가 매겨지지 않은 종목은 포함되지 않을 수 있으며, 실시간 순위는 변동합니다.",
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
      const data = await fetchJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(geckoId)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`);
      const market = data.market_data || {};
      return {
        name: data.name,
        symbol: data.symbol?.toUpperCase(),
        marketCapRank: data.market_cap_rank ?? null,
        url: `https://www.coingecko.com/en/coins/${encodeURIComponent(geckoId)}`,
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
        lastUpdated: market.last_updated ?? null
      };
    }));
    jobs.push(sourceResult("CoinGecko 90-day trend", async () => {
      const history = await fetchJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(geckoId)}/market_chart?vs_currency=usd&days=90&interval=daily`);
      if (!Array.isArray(history.prices)) throw new Error("CoinGecko returned an unexpected price-history shape.");
      return {
        trend: analyzePriceTrend(history.prices),
        latestPricePointAt: history.prices?.at(-1)?.[0] ? new Date(history.prices.at(-1)[0]).toISOString() : null,
        source: `https://www.coingecko.com/en/coins/${encodeURIComponent(geckoId)}`,
        disclaimer: "90일 가격 이력 기반의 규칙 분석이며 매매 신호나 조정 종료 판정이 아닙니다."
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
