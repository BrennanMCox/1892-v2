// Code node "Config" (Run Once for All Items).
// The build script inlines n8n/config/secretary.json here. Edit that file in
// GitHub, not this node: every deploy overwrites it.

const cfg = __CONFIG__;
const graphBase = `https://graph.microsoft.com/v1.0/${String(cfg.mailboxPath || 'me').replace(/^\/+|\/+$/g, '')}`;
const since = new Date(
  Math.max(Date.parse(cfg.processReceivedAfter) || 0, Date.now() - cfg.maxAgeHours * 3600 * 1000),
).toISOString();

return [{ json: { ...cfg, graphBase, since } }];
