import { workspace, ExtensionContext, TextDocument } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions
} from 'vscode-languageclient/node';
import * as net from 'net';

interface SidecarEntry {
  name: string;
  host: string;
  port: number;
  languages?: string[];
  token?: string;
}

// Trust model
// ===========
// The connection to a language server is a plain TCP socket with no TLS and no
// server authentication. On a flat/shared network a rogue pod could impersonate
// the intended language server and drive `workspace/applyEdit` to plant files in
// the user's workspace.
//
// The primary control is network isolation (a Helm NetworkPolicy that keeps the
// language server reachable only from its own pod). As defense in depth, this
// client:
//   - defaults the host to loopback, matching the intended same-pod sidecar
//     deployment, so a missing/empty host never resolves to an arbitrary peer;
//   - pins the endpoint: any non-loopback host must be explicitly allowlisted
//     via the LS_ALLOWED_HOSTS env var, otherwise the client refuses to connect;
//   - optionally sends a shared handshake token (LS_AUTH_TOKEN or a per-entry
//     `token`) so a cooperating server can reject unauthenticated clients.
//
// Follow-up: real server authentication needs mTLS (or an equivalent
// authenticated channel). That is intentionally out of scope for this client
// change and tracked separately.

const DEFAULT_HOST = '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const clients: Map<string, LanguageClient> = new Map();

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

// Turns an LS_ALLOWED_HOSTS entry into a matcher. Entries are exact host names,
// optionally with `*` wildcards (e.g. `*.svc.cluster.local`).
function hostPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function getAllowedHostMatchers(): RegExp[] {
  const raw = process.env.LS_ALLOWED_HOSTS;
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(hostPatternToRegExp);
}

// Pins the endpoint: loopback is always allowed (the intended sidecar), any
// other host must match the configured allowlist.
function isHostAllowed(host: string): boolean {
  if (isLoopbackHost(host)) {
    return true;
  }
  return getAllowedHostMatchers().some(re => re.test(host));
}

function resolveAuthToken(entry: SidecarEntry): string | undefined {
  return entry.token || process.env.LS_AUTH_TOKEN || undefined;
}

function getSidecarConfig(): SidecarEntry[] {
  const raw = process.env.SIDECAR_CONFIG;
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as SidecarEntry[];
    // Default a missing/empty host to loopback (the intended same-pod sidecar)
    // instead of letting it resolve to an arbitrary peer.
    return parsed.map(entry => ({
      ...entry,
      host: entry.host && entry.host.trim().length > 0 ? entry.host : DEFAULT_HOST
    }));
  } catch (e) {
    console.error('[SIDECAR] Failed to parse SIDECAR_CONFIG:', e);
    return [];
  }
}

function getLegacySidecarConfig(): SidecarEntry[] {
  const legacyConfigs: { lang: string; hostEnv: string; portEnv: string }[] = [
    { lang: 'java', hostEnv: 'LS_JAVA_HOST', portEnv: 'LS_JAVA_PORT' },
    { lang: 'rust', hostEnv: 'LS_RUST_HOST', portEnv: 'LS_RUST_PORT' }
  ];

  const entries: SidecarEntry[] = [];
  for (const cfg of legacyConfigs) {
    const host = process.env[cfg.hostEnv] || process.env['LS_HOST'] || DEFAULT_HOST;
    const port = process.env[cfg.portEnv] || process.env['LS_PORT'];
    if (port) {
      entries.push({
        name: cfg.lang + '-langserver',
        host,
        port: parseInt(port, 10),
        languages: [cfg.lang]
      });
    }
  }
  return entries;
}

function connectWithRetry(host: string, port: number, languageId: string, token?: string, maxRetries = 10): Promise<{ reader: net.Socket; writer: net.Socket }> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function tryConnect() {
      attempt++;
      const socket = net.connect({ host, port });
      socket.on('connect', () => {
        console.log(`[SIDECAR] Connected to ${languageId} LS at ${host}:${port} (attempt ${attempt})`);
        // Optional shared-token handshake, sent before the LSP stream starts.
        // A cooperating server consumes this line and rejects clients without a
        // valid token. Off by default; no token means the stream is unchanged.
        if (token) {
          socket.write(`X-LS-Auth: ${token}\r\n`);
        }
        resolve({ reader: socket, writer: socket });
      });
      socket.on('error', (err) => {
        if (attempt >= maxRetries) {
          reject(new Error(`[SIDECAR] Failed to connect to ${languageId} LS at ${host}:${port} after ${maxRetries} attempts: ${err.message}`));
          return;
        }
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        console.log(`[SIDECAR] Connection to ${languageId} at ${host}:${port} attempt ${attempt} failed, retrying in ${delay}ms...`);
        setTimeout(tryConnect, delay);
      });
    }
    tryConnect();
  });
}

function startClient(languageId: string, entry: SidecarEntry, context: ExtensionContext): void {
  // Pin the endpoint before connecting. Refuse any host that is neither loopback
  // nor explicitly allowlisted, so a rogue peer on the network cannot be reached.
  if (!isHostAllowed(entry.host)) {
    console.error(
      `[SIDECAR] Refusing to connect '${languageId}' to untrusted host '${entry.host}'. ` +
      `Only loopback is allowed by default; add it to LS_ALLOWED_HOSTS to permit it.`
    );
    return;
  }
  if (!Number.isInteger(entry.port) || entry.port <= 0 || entry.port > 65535) {
    console.error(`[SIDECAR] Refusing to connect '${languageId}': invalid port '${entry.port}'.`);
    return;
  }

  const token = resolveAuthToken(entry);
  console.log(`[SIDECAR] Starting client for '${languageId}' → ${entry.host}:${entry.port}`);

  const serverOptions: ServerOptions = () => connectWithRetry(entry.host, entry.port, languageId, token);

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: languageId }]
  };

  const client = new LanguageClient(
    `${languageId}-sidecar-lsp`,
    `${entry.name} (${languageId})`,
    serverOptions,
    clientOptions
  );

  client.start();
  clients.set(languageId, client);
  context.subscriptions.push({ dispose: () => { client.stop(); } });
}

export function activate(context: ExtensionContext): void {
  console.log('[SIDECAR] Sidecar LSP connector activating...');

  let sidecars = getSidecarConfig();
  if (sidecars.length === 0) {
    console.log('[SIDECAR] No SIDECAR_CONFIG found, trying legacy env vars...');
    sidecars = getLegacySidecarConfig();
  }

  // Filter to sidecars that have languages (these are language servers)
  const lsSidecars = sidecars.filter(s => s.languages && s.languages.length > 0);
  if (lsSidecars.length === 0) {
    console.log('[SIDECAR] No language server sidecars configured. Extension inactive.');
    return;
  }

  console.log(`[SIDECAR] Found ${lsSidecars.length} language server sidecar(s)`);

  // Build language → sidecar mapping
  const languageMap = new Map<string, SidecarEntry>();
  for (const sidecar of lsSidecars) {
    for (const lang of sidecar.languages!) {
      languageMap.set(lang, sidecar);
      console.log(`[SIDECAR] Registered: ${lang} → ${sidecar.host}:${sidecar.port}`);
    }
  }

  function ensureClient(doc: TextDocument): void {
    const entry = languageMap.get(doc.languageId);
    if (entry && !clients.has(doc.languageId)) {
      startClient(doc.languageId, entry, context);
    }
  }

  // Lazy connect on file open
  context.subscriptions.push(workspace.onDidOpenTextDocument(ensureClient));

  // Check already-open documents
  workspace.textDocuments.forEach(ensureClient);
}

export function deactivate(): Thenable<void> {
  const promises: Thenable<void>[] = [];
  for (const client of clients.values()) {
    promises.push(client.stop());
  }
  return Promise.all(promises).then(() => undefined);
}
