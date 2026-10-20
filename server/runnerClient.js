// ---------------------------------------------------------------------------
// Client for the Java runner (runner/, a separate service on the internal network).
// RUNNER_URL + RUNNER_TOKEN; without RUNNER_URL every call fails with code "not_configured".
// ---------------------------------------------------------------------------

class RunnerError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function createRunnerClient({ url = process.env.RUNNER_URL, token = process.env.RUNNER_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  const base = (url || '').replace(/\/+$/, '');

  async function call(method, path, body, { timeoutMs = 180000 } = {}) {
    if (!base) throw new RunnerError(503, 'Running code is not set up on this server yet.', 'not_configured');
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token || ''}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new RunnerError(503, 'The code runner is not reachable right now. Try again in a minute.', 'unavailable');
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const message = (data && data.error) || `Runner error (${res.status})`;
      const code = (data && data.code) || (res.status === 429 ? 'busy' : 'runner_error');
      // 401 means the tokens disagree: an operator problem, not something the user can fix
      if (res.status === 401) throw new RunnerError(503, 'The code runner refused this server. Check RUNNER_TOKEN.', 'misconfigured');
      throw new RunnerError(res.status >= 500 ? 503 : res.status, message, code);
    }
    return data;
  }

  return {
    configured: Boolean(base),
    run: (cells, requestId) => call('POST', '/run', { cells, requestId }),
    queue: (requestId) => call('GET', `/queue/${encodeURIComponent(requestId)}`, undefined, { timeoutMs: 5000 }),
    check: (files, tests, timeoutMs) => call('POST', '/check', { files, tests, timeoutMs }, { timeoutMs: 300000 }),
    openSession: (owner) => call('POST', '/sessions', { owner }),
    runInSession: (id, owner, source) => call('POST', `/sessions/${encodeURIComponent(id)}/cells`, { owner, source }),
    closeSession: (id, owner) => call('DELETE', `/sessions/${encodeURIComponent(id)}?owner=${encodeURIComponent(owner)}`),
    stats: () => call('GET', '/stats', undefined, { timeoutMs: 5000 }),
  };
}

module.exports = { createRunnerClient, RunnerError };
