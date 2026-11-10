// Minimal client for the n8n public REST API (/api/v1), using an API key.
// Works with n8n 1.x and 2.x. `fetchImpl` is injectable for tests.

export class N8nError extends Error {
  constructor(method, path, status, body) {
    const detail = body && typeof body === 'object' ? body.message || JSON.stringify(body) : String(body || '');
    super(`n8n ${method} ${path} failed: HTTP ${status}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
    this.status = status;
    this.body = body;
  }
}

export class N8nClient {
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch, retries = 3, log = () => {} }) {
    if (!baseUrl) throw new Error('N8N_BASE_URL is not set');
    if (!apiKey) throw new Error('N8N_API_KEY is not set');
    // Accept "https://x.app.n8n.cloud", ".../", or ".../api/v1".
    this.base = `${String(baseUrl).replace(/\/+$/, '').replace(/\/api\/v1$/, '')}/api/v1`;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.retries = retries;
    this.log = log;
  }

  async request(method, path, { query, body } = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    // Only retry requests that are safe to repeat; a retried POST could create twice.
    const tries = method === 'GET' || method === 'PUT' ? this.retries : 1;
    for (let attempt = 1; ; attempt += 1) {
      let res;
      try {
        res = await this.fetch(url.toString(), {
          method,
          headers: {
            'X-N8N-API-KEY': this.apiKey,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (attempt < tries) {
          await sleep(1000 * 2 ** (attempt - 1));
          continue;
        }
        throw new Error(`n8n ${method} ${path}: network error: ${err.message}`);
      }
      const text = await res.text();
      let data = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }
      if (res.ok) return data;
      if ((res.status === 429 || res.status >= 500) && attempt < tries) {
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      throw new N8nError(method, path, res.status, data);
    }
  }

  async listAll(path, query = {}) {
    const out = [];
    let cursor;
    for (let page = 0; page < 100; page += 1) {
      const data = await this.request('GET', path, { query: { ...query, limit: 100, cursor } });
      const rows = Array.isArray(data) ? data : data?.data || [];
      out.push(...rows);
      cursor = data?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  listProjects() {
    return this.listAll('/projects');
  }

  listWorkflows(query = {}) {
    return this.listAll('/workflows', query);
  }

  getWorkflow(id) {
    return this.request('GET', `/workflows/${encodeURIComponent(id)}`);
  }

  createWorkflow(body) {
    return this.request('POST', '/workflows', { body });
  }

  updateWorkflow(id, body) {
    return this.request('PUT', `/workflows/${encodeURIComponent(id)}`, { body });
  }

  transferWorkflow(id, destinationProjectId) {
    return this.request('PUT', `/workflows/${encodeURIComponent(id)}/transfer`, { body: { destinationProjectId } });
  }

  // n8n 2.x calls turning a workflow on "publish"; 1.x calls it "activate".
  async publishWorkflow(id) {
    try {
      return await this.request('POST', `/workflows/${encodeURIComponent(id)}/publish`, { body: {} });
    } catch (err) {
      if (err.status !== 404 && err.status !== 405) throw err;
      return this.request('POST', `/workflows/${encodeURIComponent(id)}/activate`);
    }
  }

  async unpublishWorkflow(id) {
    try {
      return await this.request('POST', `/workflows/${encodeURIComponent(id)}/deactivate`);
    } catch (err) {
      if (err.status !== 404 && err.status !== 405) throw err;
      return this.request('POST', `/workflows/${encodeURIComponent(id)}/unpublish`, { body: {} });
    }
  }

  listCredentials() {
    return this.listAll('/credentials');
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
