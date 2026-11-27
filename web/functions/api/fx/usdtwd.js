/**
 * @fileoverview GET /api/fx/usdtwd — Cached USD/TWD exchange rate for US stock holdings.
 */

import { WEB_CONFIG } from '../../_lib/core/config.mjs';
import { fetchUsdTwdRate } from '../../_lib/core/price-adapters.mjs';
import { edgeCacheGet, edgeCachePut, jsonResponse } from '../../_lib/http.js';

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  const cacheKey = `${new URL(request.url).origin}/api/fx/usdtwd`;
  const cached = await edgeCacheGet(cacheKey);
  if (cached) return cached;

  const fx = await fetchUsdTwdRate({ env, fetchFn: context.fetchFn, sleepFn: context.sleepFn });
  const resp = jsonResponse({ pair: 'USD/TWD', ...fx, fetchedAt: new Date().toISOString() });
  await edgeCachePut(cacheKey, resp, WEB_CONFIG.CACHE_TTL_SEC.FX_RATE, waitUntil);
  return resp;
}
