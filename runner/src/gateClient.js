'use strict';
// HTTP client for the gate (src/gate.js). The runner never talks to Docker directly.
const http = require('http');

class GateClient {
  constructor({ url, token }) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = parseInt(u.port || '80', 10);
    this.token = token;
  }

  request(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({
        host: this.host,
        port: this.port,
        method,
        path,
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { json = null; }
          if (res.statusCode >= 400) {
            reject(Object.assign(new Error(`gate ${method} ${path} -> ${res.statusCode} ${json && json.error ? json.error : ''}`.trim()), { status: res.statusCode }));
          } else resolve(json);
        });
      });
      req.on('timeout', () => req.destroy(new Error('gate timeout')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  create(profile) { return this.request('POST', '/sandboxes', { profile }).then((r) => r.id); }
  start(id) { return this.request('POST', `/sandboxes/${id}/start`); }
  inspect(id) { return this.request('GET', `/sandboxes/${id}`); }
  remove(id) { return this.request('DELETE', `/sandboxes/${id}`).catch((err) => { if (err.status !== 404) throw err; }); }
  list() { return this.request('GET', '/sandboxes'); }

  /** Resolves with the raw duplex socket of the container's attach stream. */
  attach(id) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: this.host,
        port: this.port,
        method: 'POST',
        path: `/sandboxes/${id}/attach`,
        headers: { Authorization: `Bearer ${this.token}`, Connection: 'Upgrade', Upgrade: 'tcp' },
      });
      req.on('upgrade', (res, socket, head) => {
        if (head && head.length) socket.unshift(head);
        resolve(socket);
      });
      req.on('response', (res) => {
        res.resume();
        reject(new Error(`attach refused: ${res.statusCode}`));
      });
      req.on('error', reject);
      req.end();
    });
  }
}

module.exports = { GateClient };
