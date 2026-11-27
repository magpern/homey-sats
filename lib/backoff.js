'use strict';

const MINUTE = 60 * 1000;

const DEFAULTS = {
  intervalMs: 30 * MINUTE, // normal polling interval
  firstRetryMs: 2 * MINUTE, // first retry after an error
  maxRetryMs: 4 * 60 * MINUTE, // never wait longer than this between retries
  jitter: 0.1, // +-10 % so restarts don't line up exactly
};

/**
 * Delay before the next poll.
 * failures = 0 -> the normal interval.
 * failures = n -> firstRetry * 2^(n-1), capped at maxRetry (2, 4, 8, 16, 32, 64, 128, 240 min).
 */
function nextDelay(failures, options = {}, random = Math.random) {
  const o = { ...DEFAULTS, ...options };
  let base;
  if (!failures || failures <= 0) {
    base = o.intervalMs;
  } else {
    base = Math.min(o.firstRetryMs * 2 ** (failures - 1), o.maxRetryMs);
  }
  const spread = base * o.jitter;
  return Math.round(base - spread + random() * 2 * spread);
}

module.exports = { nextDelay, DEFAULTS, MINUTE };
