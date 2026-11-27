'use strict';

const https = require('https');
const { URL } = require('url');

/**
 * Minimal HTTPS transport (no dependencies, works on every Node version Homey ships).
 * Resolves with { status, headers, text } and never logs request or response bodies.
 */
function request(url, {
  method = 'GET', headers = {}, body, timeoutMs = 20000,
} = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: `${u.pathname}${u.search}`,
      headers: body !== undefined
        ? { ...headers, 'Content-Length': Buffer.byteLength(body) }
        : headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request to ${u.hostname} timed out`)));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

module.exports = { request };
