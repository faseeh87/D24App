'use strict';
// A small, dependency-free HTTP layer: routing, JSON bodies, cookies,
// static files, security headers and CSRF protection.
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./util');
const config = require('./config');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', CSP);
  if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, { maxAge, clear } = {}) {
  const bits = [`${name}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (config.production) bits.push('Secure');
  bits.push(`Max-Age=${clear ? 0 : maxAge}`);
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...prev, bits.join('; ')]);
}

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  patch(p, ...h) { this.add('PATCH', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }
  match(method, pathname) {
    let allowed = false;
    for (const r of this.routes) {
      const m = pathname.match(r.re);
      if (!m) continue;
      if (r.method !== method) { allowed = true; continue; }
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return allowed ? 'method' : null;
  }
}

function serveStatic(publicDir, req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (stat.isDirectory()) return serveStatic(publicDir, req, res, pathname + '/');
  const ext = path.extname(file);
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size };
  headers['Cache-Control'] = rel.startsWith('/assets/') ? 'public, max-age=604800' : ext === '.html' ? 'no-cache' : 'public, max-age=300';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}

function createHandler({ router, publicDir }) {
  return async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/')) {
        const hit = router.match(req.method, pathname);
        if (hit === 'method') throw new HttpError(405, 'Method not allowed');
        if (!hit) throw new HttpError(404, 'Not found');
        if (req.method !== 'GET') {
          // CSRF: require a custom header (not settable cross-site without CORS) and same-origin Origin.
          if (req.headers['x-d24'] !== '1') throw new HttpError(403, 'Forbidden');
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Forbidden');
        }
        const ctx = {
          req, res, url, params: hit.params, query: Object.fromEntries(url.searchParams),
          cookies: parseCookies(req.headers.cookie),
          ip: (config.production && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress,
          body: req.method === 'GET' ? {} : await readJson(req),
        };
        let out;
        for (const h of hit.route.handlers) {
          out = await h(ctx);
          if (out !== undefined) break;
        }
        if (!res.headersSent) send(res, 200, out ?? { ok: true });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (serveStatic(publicDir, req, res, pathname)) return;
      // SPA fallback
      const base = pathname.startsWith('/admin') ? '/admin/' : '/';
      if (!serveStatic(publicDir, req, res, base)) throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong. Please try again.' : e.message });
    }
  };
}

module.exports = { Router, createHandler, setCookie, send };
