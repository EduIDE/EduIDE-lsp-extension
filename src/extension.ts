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
}

const clients: Map<string, LanguageClient> = new Map();

function getSidecarConfig(): SidecarEntry[] {
  const raw = process.env.SIDECAR_CONFIG;
  if (!raw) {
    return [];
  }
  try {
    return JSON.parse(raw);
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
    const host = process.env[cfg.hostEnv] || process.env['LS_HOST'];
    const port = process.env[cfg.portEnv] || process.env['LS_PORT'];
    if (host && port) {
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

function connectWithRetry(host: string, port: number, languageId: string, maxRetries = 10): Promise<{ reader: net.Socket; writer: net.Socket }> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function tryConnect() {
      attempt++;
      const socket = net.connect({ host, port });
      socket.on('connect', () => {
        console.log(`[SIDECAR] Connected to ${languageId} LS at ${host}:${port} (attempt ${attempt})`);
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
  console.log(`[SIDECAR] Starting client for '${languageId}' → ${entry.host}:${entry.port}`);

  const serverOptions: ServerOptions = () => connectWithRetry(entry.host, entry.port, languageId);

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
