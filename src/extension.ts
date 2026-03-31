import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import picomatch from 'picomatch';

import { computeFileCRC, computeBufferCRC, toHex } from './crc';
import { EffectiveRule, loadRules, loadCacheConfig, validateRules, RuleConfig, AlgoName } from './config';
import { CacheManager, CacheEntry } from './cache';
import { getGuideContent, createGuidePanel, createInspectorPanel } from './guidePreview';


type CrcEntry = {
  algoName: string;
  fullHex: string;
  mtimeMs: number;
  size: number;
  width: number;
};

/** Risultato del checksum calcolato sulla selezione corrente dell'editor. */
interface SelectionEntry {
  algoName: string;
  fullHex: string | null;  // null = selezione < 2 caratteri o nessuna selezione
  width: number;
}

/** Risultato del checksum calcolato sugli appunti. "--" = impossibile calcolare */
interface ClipboardEntry {
  algoName: string;
  fullHex: string | null | '--';
  width: number;
}

/** Item della tree che rappresenta un file con checksum calcolato. */
interface CrcFileItem extends vscode.TreeItem {
  uri: vscode.Uri;
  entry: CrcEntry;
}

/** Item della tree che rappresenta il checksum "on selection" (nessun file). */
interface CrcSelectionItem extends vscode.TreeItem {
  isSelection: true;
  selectionEntry: SelectionEntry;
}

/** Item della tree che rappresenta il checksum "on clipboard" (nessun file). */
interface CrcClipboardItem extends vscode.TreeItem {
  isClipboard: true;
  clipboardEntry: ClipboardEntry;
}

type CrcTreeItem = CrcFileItem | CrcSelectionItem | CrcClipboardItem;

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('DigestLens');
  context.subscriptions.push(output);
  output.appendLine('DigestLens attivato');

  const cache = new Map<string, CrcEntry>(); // key = uri.fsPath + '|' + algoName
/** Risultati live della selezione — key = algoName */
  const selectionResults = new Map<string, SelectionEntry>();
  /** Risultati live degli appunti — key = algoName */
  const clipboardResults = new Map<string, ClipboardEntry>();
  let selectionDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let clipboardPollTimer: ReturnType<typeof setInterval> | undefined;
  const CLIPBOARD_POLL_INTERVAL = 2000; // 2 secondi
  let rules: EffectiveRule[] = loadRules(output);
  let cacheManager: CacheManager | null = null;
  let cacheConfig = loadCacheConfig(output);
  
  // Diagnostic collector per segnalare errori di configurazione
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('Digestlens');
  context.subscriptions.push(diagnosticCollection);

  // --- Utils comuni
  function pathToPosix(rel: string): string {
    return rel.replace(/\\/g, '/');
  }

  function keyOf(uri: vscode.Uri, algoName: string) {
    return uri.fsPath + '|' + algoName;
  }

  function purgeForUri(uri: vscode.Uri) {
    for (const k of [...cache.keys()]) {
      if (k.startsWith(uri.fsPath + '|')) cache.delete(k);
    }
  }

  function describeParams(width: number): string {
    return `CRC-${width}`;
  }

  async function statOrUndefined(p: string) {
    try { return await fs.promises.stat(p); } catch { return undefined; }
  }

async function initializeCacheManager() {
    if (!cacheConfig.enabled || rules.length === 0) {
      if (!cacheConfig.enabled) {
        output.appendLine('[cache] Cache disabilitata nella configurazione');
      } else {
        output.appendLine('[cache] Nessuna regola definita, cache non inizializzata');
      }
      cacheManager = null;
      return;
    }

    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      output.appendLine('[cache] Nessun workspace folder, cache non inizializzata');
      return;
    }

    try {
      const cacheFilePath = path.resolve(root.uri.fsPath, cacheConfig.path);
      cacheManager = new CacheManager(cacheFilePath);
      await cacheManager.initialize(root.uri.fsPath);
      output.appendLine(`[cache] Cache inizializzata: ${cacheFilePath}`);
    } catch (error) {
      output.appendLine(`[cache] Errore inizializzazione cache: ${error}`);
      cacheManager = null;
    }
  }

  async function getCachedEntry(uri: vscode.Uri, algoName: string): Promise<CrcEntry | null> {
    if (!cacheManager || !cacheConfig.enabled) {
      return null;
    }

    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return null;
    }

    const relPath = vscode.workspace.asRelativePath(uri, false);
    if (!relPath) {
      return null;
    }

    const cacheEntry = await cacheManager.getEntry(relPath, algoName);
    if (!cacheEntry) {
      return null;
    }

    // Verifichiamo che il file esista e abbia lo stesso timestamp
    const st = await statOrUndefined(uri.fsPath);
    if (!st || st.mtimeMs !== cacheEntry.mtimeMs) {
      // File modificato o non esistente, rimuoviamo dalla cache
      await cacheManager.removeEntry(relPath, algoName);
      return null;
    }

    return {
      algoName: cacheEntry.algorithm,
      fullHex: cacheEntry.crc,
      mtimeMs: cacheEntry.mtimeMs,
      size: st.size,
      width: cacheEntry.width
    };
  }

  async function setCachedEntry(uri: vscode.Uri, entry: CrcEntry): Promise<void> {
    if (!cacheManager || !cacheConfig.enabled) {
      return;
    }

    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return;
    }

    const relPath = vscode.workspace.asRelativePath(uri, false);
    if (!relPath) {
      return;
    }

    const cacheEntry: CacheEntry = {
      relativePath: relPath,
      crc: entry.fullHex,
      mtimeMs: entry.mtimeMs,
      algorithm: entry.algoName,
      width: entry.width
    };

    await cacheManager.setEntry(cacheEntry);
  }

  async function removeCachedEntry(uri: vscode.Uri, algoName: string): Promise<void> {
    if (!cacheManager || !cacheConfig.enabled) {
      return;
    }

    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return;
    }

    const relPath = vscode.workspace.asRelativePath(uri, false);
    if (!relPath) {
      return;
    }

    await cacheManager.removeEntry(relPath, algoName);
  }

  function pickRulesFor(uri: vscode.Uri): EffectiveRule[] {
    if (uri.scheme !== 'file') return [];

    const rel = vscode.workspace.asRelativePath(uri, false);
    output.appendLine(`[pickRulesFor] File: ${rel || uri.fsPath}`);
    if (!rel || rel.trim().length === 0) return [];

    // Controlliamo se è il file di cache e lo escludiamo
    if (cacheConfig.enabled && cacheManager) {
      const root = vscode.workspace.workspaceFolders?.[0];
      if (root) {
        const cacheFilePath = path.resolve(root.uri.fsPath, cacheConfig.path);
        if (uri.fsPath === cacheFilePath) {
          output.appendLine(`[pickRulesFor] File di cache escluso: ${rel}`);
          return [];
        }
      }
    }

    const relPosix = pathToPosix(rel);
    const matchingRules: EffectiveRule[] = [];
    
    for (const r of rules) {
      if (r.isOnSelection) { continue; } // le regole onselection non matchano file
      const isMatch = picomatch.isMatch(relPosix, r.patternStr, {
        dot: true,
        nocase: process.platform === 'win32'
      });
      if (isMatch) {
        output.appendLine(`[pickRulesFor] MATCH: ${relPosix} ~ ${r.patternStr} ~ ${r.params.name}`);
        matchingRules.push(r);
      }
    }
    
    if (matchingRules.length === 0) {
      output.appendLine(`[pickRulesFor] NO MATCH: ${relPosix}`);
    }
    
    return matchingRules;
  }

  async function ensureComputed(uri: vscode.Uri): Promise<Array<{ entry: CrcEntry; rule: EffectiveRule }> | undefined> {
    const matchingRules = pickRulesFor(uri);
    if (matchingRules.length === 0) return undefined;

    const st = await statOrUndefined(uri.fsPath);
    if (!st || st.isDirectory()) return undefined;

    const results: Array<{ entry: CrcEntry; rule: EffectiveRule }> = [];

    for (const rule of matchingRules) {
      const algoName = rule.params.name ?? describeParams(rule.params.width);
      const key = keyOf(uri, algoName);

      // Prima controlliamo il cache persistente
      const persistentCacheEntry = await getCachedEntry(uri, algoName);
      if (persistentCacheEntry) {
        cache.set(key, persistentCacheEntry);
        results.push({ entry: persistentCacheEntry, rule });
        continue;
      }

      // Poi controlliamo il cache in memoria (per compatibilità)
      const cached = cache.get(key);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        results.push({ entry: cached, rule });
        continue;
      }

      try {
        output.appendLine(`[ensureComputed] Calcolo CRC per ${uri.fsPath} (${algoName})`);
        const controller = new AbortController();
        const crc = await computeFileCRC(uri.fsPath, rule.params, controller.signal);
        const fullHex = toHex(crc, rule.params.width, rule.display.uppercase);

        const entry: CrcEntry = {
          algoName,
          fullHex,
          mtimeMs: st.mtimeMs,
          size: st.size,
          width: rule.params.width
        };

        // Aggiorniamo entrambi i cache
        cache.set(key, entry);
        await setCachedEntry(uri, entry);
        
        output.appendLine(`[ensureComputed] OK ${algoName} = 0x${fullHex} (${uri.fsPath})`);
        results.push({ entry, rule });
      } catch (e) {
        output.appendLine(`[ensureComputed][ERROR] ${uri.fsPath} → ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return results.length > 0 ? results : undefined;
  }

  function pickBestEntry(uri: vscode.Uri) {
    // Evita cartelle in modo leggero: se non ha estensione, presumibilmente è una dir (euristica)
    const rel = vscode.workspace.asRelativePath(uri, false);
    if (!rel) return null;
    if (!rel.includes('.')) {
      // Potrebbe essere una cartella; non decoriamo
      return null;
    }

    const matchingRules = pickRulesFor(uri);
    if (matchingRules.length === 0) return null;
    
    // Per compatibilità con il vecchio comportamento, prendiamo la prima regola
    const rule = matchingRules[0];
    const algoName = rule.params.name ?? describeParams(rule.params.width);
    const key = keyOf(uri, algoName);
    const entry = cache.get(key);

    if (!entry) {
      scheduleCompute(uri);
      return null;
    }

    const badge = '0x.';
    const tooltip = `Checksum (${entry.algoName}): 0x${entry.fullHex}`;
    return { badge, tooltip };
  }

  function scheduleCompute(uri: vscode.Uri) {
    setTimeout(async () => {
      output.appendLine(`[scheduleCompute] ${uri.fsPath}`);
      const res = await ensureComputed(uri);
      if (res && Array.isArray(res) && res.length > 0) {
        // Se abbiamo più risultati, mostriamo il primo per il badge
        const firstResult = res[0];
        output.appendLine(
          `[scheduleCompute] DONE ${firstResult.entry.algoName} 0x${firstResult.entry.fullHex}`
        );
        provider.fire(uri);
      // } else if (res && !Array.isArray(res)) {
      //   // Se abbiamo un singolo risultato
      //   output.appendLine(
      //     `[scheduleCompute] DONE ${res.entry.algoName} 0x${res.entry.fullHex}`
      //   );
      //   provider.fire(uri);
      }
    }, 30);
  }

  async function warmupVisibleFiles() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;
    const LIMIT = 200;
    for (const r of rules) {
      if (r.isOnSelection) { continue; }
      try {
        const uris = await vscode.workspace.findFiles(
          r.pattern as vscode.GlobPattern,
          '**/node_modules/**',
          LIMIT
        );
        for (const u of uris) {
          await ensureComputed(u);
        }
      } catch (e) {
        output.appendLine(
          `[warmup][ERROR] ${String(r.pattern)} → ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }
    }
  }

  function refreshAll() {
    cache.clear();
    provider.fire();
    warmupVisibleFiles().then(() => provider.fire()).catch(() => { /* ignore */ });
  }

  // --- Funzione per invalidare la cache quando cambiano le regole
  async function invalidateCacheForRules() {
    if (!cacheManager || !cacheConfig.enabled) {
      return;
    }

    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return;
    }

    try {
      // Otteniamo tutti i file che potrebbero essere interessati dalle nuove regole
      const affectedFiles: string[] = [];
      for (const rule of rules) {
        try {
          const uris = await vscode.workspace.findFiles(
            rule.pattern as vscode.GlobPattern,
            '**/node_modules/**',
            1000 // Limite alto per essere sicuri di prendere tutti i file interessati
          );
          for (const uri of uris) {
            const relPath = vscode.workspace.asRelativePath(uri, false);
            if (relPath) {
              affectedFiles.push(relPath);
            }
          }
        } catch (e) {
          output.appendLine(`[invalidateCacheForRules][ERROR] ${String(rule.pattern)} → ${String(e)}`);
        }
      }

      // Rimuoviamo le entry della cache per i file interessati
      for (const relPath of affectedFiles) {
        await cacheManager.removeFileEntries(relPath);
      }

      // Puliamo anche la cache in memoria per sicurezza
      cache.clear();

      output.appendLine(`[invalidateCacheForRules] Cache invalidata per ${affectedFiles.length} file interessati`);
    } catch (error) {
      output.appendLine(`[invalidateCacheForRules][ERROR] ${String(error)}`);
    }
  }

  // --- Provider per i badge in Explorer
  class CrcDecorationProvider implements vscode.FileDecorationProvider {
    private _emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
    readonly onDidChangeFileDecorations = this._emitter.event;

    fire(uri?: vscode.Uri | vscode.Uri[]) { this._emitter.fire(uri ?? []); }

    async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
      output.appendLine(`[decorator] Badge richiesto per ${uri.fsPath}`);
      if (uri.scheme !== 'file') return undefined;

      const entry = pickBestEntry(uri);
      if (!entry) {
        output.appendLine(`[decorator] Nessun dato cached per ${uri.fsPath}`);
        return undefined;
      }

      const { badge, tooltip } = entry;
      return { badge, tooltip };
    }
  }

  const provider = new CrcDecorationProvider();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(provider));

  // --- Watchers per ogni regola
  const watchers: vscode.FileSystemWatcher[] = [];
  function setupWatchers() {
    watchers.forEach(w => w.dispose());
    watchers.length = 0;

    for (const r of rules) {
      if (r.isOnSelection) { continue; } // nessun file watcher per onselection
      const watcher = vscode.workspace.createFileSystemWatcher(r.pattern);
      watcher.onDidCreate(uri => {
        output.appendLine(`[watcher] CREATE: ${uri.fsPath}`);
        scheduleCompute(uri);
      });
      watcher.onDidChange(uri => {
        output.appendLine(`[watcher] CHANGE: ${uri.fsPath}`);
        scheduleCompute(uri);
      });
      watcher.onDidDelete(uri => {
        output.appendLine(`[watcher] DELETE: ${uri.fsPath}`);
        purgeForUri(uri);
        // Rimuoviamo anche dal cache persistente
        if (cacheManager && cacheConfig.enabled) {
          const root = vscode.workspace.workspaceFolders?.[0];
          if (root) {
            const relPath = vscode.workspace.asRelativePath(uri, false);
            if (relPath) {
              cacheManager.removeFileEntries(relPath).catch(err => {
                output.appendLine(`[watcher] Errore rimozione cache: ${err}`);
              });
            }
          }
        }
        provider.fire(uri);
      });
      watchers.push(watcher);
      context.subscriptions.push(watcher);
    }
  }

  setupWatchers();

  // --- Listener "onselection": calcola il checksum del testo selezionato in realtime
  function getOnSelectionRules(): EffectiveRule[] {
    return rules.filter(r => r.isOnSelection);
  }

async function computeSelectionCrc(selectedText: string): Promise<void> {
  const onSelRules = getOnSelectionRules();
  if (onSelRules.length === 0) { return; }

  if (selectedText.length < 2) {
    for (const rule of onSelRules) {
      const algoName = rule.params.name ?? `CRC-${rule.params.width}`;
      selectionResults.set(algoName, { algoName, fullHex: null, width: rule.params.width });
    }
    treeProvider.refresh();
    return;
  }

  const buf = Buffer.from(selectedText, 'utf8');
  for (const rule of onSelRules) {
    const algoName = rule.params.name ?? `CRC-${rule.params.width}`;
    try {
      const crc = await computeBufferCRC(buf, rule.params);
      const hex = toHex(crc, rule.params.width, rule.display.uppercase);
      selectionResults.set(algoName, { algoName, fullHex: hex, width: rule.params.width });
      output.appendLine(`[selection] ${algoName} = 0x${hex} (${selectedText.length} chars)`);
    } catch (e) {
      selectionResults.set(algoName, { algoName, fullHex: null, width: rule.params.width });
      output.appendLine(`[selection] Errore calcolo ${algoName}: ${e}`);
    }
  }
  treeProvider.refresh();
}

async function computeClipboardCrc(): Promise<void> {
  const onSelRules = getOnSelectionRules();
  if (onSelRules.length === 0) { return; }

  let clipboardText = '';
  try {
    clipboardText = await vscode.env.clipboard.readText();
    output.appendLine(`[clipboard] Lettura testo: ${clipboardText.length} chars`);
  } catch (e) {
    output.appendLine(`[clipboard] readText() fallito: ${e}`);
  }

  if (clipboardText.length === 0) {
    output.appendLine('[clipboard] Appunti vuoti → "--"');
    for (const rule of onSelRules) {
      const algoName = rule.params.name ?? `CRC-${rule.params.width}`;
      clipboardResults.set(algoName, { algoName, fullHex: '--', width: rule.params.width });
    }
    treeProvider.refresh();
    return;
  }

  const buf = Buffer.from(clipboardText, 'utf8');
  for (const rule of onSelRules) {
    const algoName = rule.params.name ?? `CRC-${rule.params.width}`;
    try {
      const crc = await computeBufferCRC(buf, rule.params);
      const hex = toHex(crc, rule.params.width, rule.display.uppercase);
      clipboardResults.set(algoName, { algoName, fullHex: hex, width: rule.params.width });
      output.appendLine(`[clipboard] ${algoName} = 0x${hex} (${buf.length} bytes)`);
    } catch (e) {
      clipboardResults.set(algoName, { algoName, fullHex: '--', width: rule.params.width });
      output.appendLine(`[clipboard] Errore calcolo ${algoName}: ${e}`);
    }
  }
  treeProvider.refresh();
}

  // --- Tree View (classe con dipendenze iniettate e dispose())
class CrcTreeProvider implements vscode.TreeDataProvider<CrcTreeItem>, vscode.Disposable {
  private _onDidChangeTreeData: vscode.EventEmitter<CrcTreeItem | undefined | null | void> =
    new vscode.EventEmitter<CrcTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<CrcTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  constructor(
    private readonly getRules: () => EffectiveRule[],
    private readonly ensureComputedFn: (uri: vscode.Uri) => Promise<Array<{ entry: CrcEntry; rule: EffectiveRule }> | undefined>,
    private readonly getSelectionResults: () => Map<string, SelectionEntry>,
    private readonly getClipboardResults: () => Map<string, ClipboardEntry>, // NEW
    private readonly out: vscode.OutputChannel
  ) {}

    refresh(): void {
      this._onDidChangeTreeData.fire();
    }

    dispose(): void {
      this._onDidChangeTreeData.dispose();
    }

    getTreeItem(element: CrcTreeItem): vscode.TreeItem {
      // ── Item "on clipboard" ──────────────────────────────────────────────
      if ('isClipboard' in element && element.isClipboard) {
        const ce = element.clipboardEntry;
        const isDash = ce.fullHex === '--';
        const hasValue = ce.fullHex !== null && ce.fullHex !== '--';
        return {
          label: '⟨on clipboard⟩',
          description: hasValue
            ? `${ce.algoName}: 0x${ce.fullHex}`
            : isDash ? `${ce.algoName}: --` : `${ce.algoName} — copia negli appunti`,
          tooltip: hasValue
            ? `Checksum (${ce.algoName}) sugli appunti: 0x${ce.fullHex}`
            : isDash ? `Impossibile calcolare checksum sugli appunti (${ce.algoName})` : `Copia testo/binary negli appunti per calcolare il checksum (${ce.algoName})`,
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          iconPath: new vscode.ThemeIcon(hasValue ? 'symbol-string' : isDash ? 'error' : 'loading~spin'),
          contextValue: 'crcClipboard',
        };
      }

      // ── Item "on selection" ──────────────────────────────────────────────
      if ('isSelection' in element && element.isSelection) {
        const se = element.selectionEntry;
        const hasValue = se.fullHex !== null;
        return {
          label: '⟨on selection⟩',
          description: hasValue
            ? `${se.algoName}: 0x${se.fullHex}`
            : `${se.algoName} — seleziona ≥ 2 caratteri`,
          tooltip: hasValue
            ? `Checksum (${se.algoName}) sulla selezione corrente: 0x${se.fullHex}`
            : `Seleziona almeno 2 caratteri per calcolare il checksum (${se.algoName})`,
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          iconPath: new vscode.ThemeIcon(hasValue ? 'symbol-string' : 'loading~spin'),
          contextValue: 'crcSelection',
        };
      }

      // ── Item file standard ───────────────────────────────────────────────
      const fileItem = element as CrcFileItem;
      return {
        label: path.basename(fileItem.uri.fsPath),
        description: `${fileItem.entry.algoName} 0x${fileItem.entry.fullHex}`,
        command: {
          command: 'digestlens.openFile',
          title: 'Open File',
          arguments: [element]
        },
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        iconPath: new vscode.ThemeIcon('file'),
        contextValue: 'crcFile'
      };
    }

async getChildren(element?: CrcTreeItem): Promise<CrcTreeItem[]> {
      if (element) return [];

      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) return [];

      const items: CrcTreeItem[] = [];

      // ── Item "on clipboard" ─────────────────────────────────────────────
      const onSelRules = this.getRules().filter(r => r.isOnSelection);
      for (const rule of onSelRules) {
        const algoName = rule.params.name ?? `CRC-${rule.params.width}`;
        const clipEntry = this.getClipboardResults().get(algoName)
          ?? { algoName, fullHex: '--', width: rule.params.width };
        const clipItem: CrcClipboardItem = { isClipboard: true, clipboardEntry: clipEntry };
        items.push(clipItem);
      }

      // ── Item "on selection" ─────────────────────────────────────────────
      for (const rule of onSelRules) {
        const algoName = rule.params.name ?? `CRC-${rule.params.width}`;
        const selEntry = this.getSelectionResults().get(algoName)
          ?? { algoName, fullHex: null, width: rule.params.width };
        const selItem: CrcSelectionItem = { isSelection: true, selectionEntry: selEntry };
        items.push(selItem);
      }

      // ── Item file standard ───────────────────────────────────────────────
      const LIMIT = 500;

      const seen = new Set<string>();
      const allUris: vscode.Uri[] = [];

      // 🔹 raccogli tutti gli uri senza duplicati
      for (const rule of this.getRules()) {
        if (rule.isOnSelection) { continue; }
        try {
          const uris = await vscode.workspace.findFiles(
            rule.pattern as vscode.GlobPattern,
            '**/node_modules/**',
            LIMIT
          );

          for (const uri of uris) {
            if (!seen.has(uri.fsPath)) {
              seen.add(uri.fsPath);
              allUris.push(uri);
            }
          }
        } catch (e) {
          this.out.appendLine(`[tree][ERROR] ${rule.patternStr} → ${String(e)}`);
        }
      }

      // 🔹 ora processi ogni file UNA sola volta
      const fileItems: CrcFileItem[] = [];
      for (const uri of allUris) {
        const info = await this.ensureComputedFn(uri);
        if (info) {
          for (const result of info) {
            const treeItem: CrcFileItem = {
              uri,
              entry: result.entry
            } as CrcFileItem;

            treeItem.label = path.basename(uri.fsPath);
            treeItem.description = `${result.entry.algoName} 0x${result.entry.fullHex}`;
            fileItems.push(treeItem);
          }
        }
      }

      fileItems.sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
      return [...items, ...fileItems];
    }
  }


  const treeProvider = new CrcTreeProvider(
    () => rules,
    ensureComputed,
    () => selectionResults,
    () => clipboardResults,
    output
  );
  const treeView = vscode.window.createTreeView('digestlensTree', { treeDataProvider: treeProvider });
  context.subscriptions.push(treeView, treeProvider);

  // --- Clipboard poll setup
  clipboardPollTimer = setInterval(() => {
    computeClipboardCrc().catch(e => output.appendLine(`[clipboard-poll] Errore: ${e}`));
  }, CLIPBOARD_POLL_INTERVAL);
  context.subscriptions.push({
    dispose: () => {
      if (clipboardPollTimer) clearInterval(clipboardPollTimer);
    }
  });
  output.appendLine(`[clipboard] Poll avviato ogni ${CLIPBOARD_POLL_INTERVAL}ms`);

  // --- Event listener selezione (richiede treeProvider)
  context.subscriptions.push(
    // Cambio selezione: debounce 150 ms per non sovraccaricare su selezioni veloci
    vscode.window.onDidChangeTextEditorSelection(event => {
      if (getOnSelectionRules().length === 0) { return; }
      if (selectionDebounceTimer) { clearTimeout(selectionDebounceTimer); }
      selectionDebounceTimer = setTimeout(() => {
        const text = event.textEditor.document.getText(event.textEditor.selection);
        computeSelectionCrc(text).catch(() => { /* ignore */ });
      }, 150);
    }),

    // Cambio editor attivo: azzera i risultati precedenti
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (getOnSelectionRules().length === 0) { return; }
      for (const rule of getOnSelectionRules()) {
        const algoName = rule.params.name ?? `CRC-${rule.params.width}`;
        selectionResults.set(algoName, { algoName, fullHex: null, width: rule.params.width });
      }
      treeProvider.refresh();
    })
  );

  function resolveUriFromResource(resource?: vscode.Uri | CrcTreeItem): vscode.Uri | undefined {
    if (resource instanceof vscode.Uri) {
      return resource;
    }
    if (resource && typeof resource === 'object' && 'uri' in resource) {
      return (resource as CrcFileItem).uri;
    }
    // Se è un CrcSelectionItem non ha uri — non restituiamo nulla
    if (treeView.selection.length > 0) {
      const sel = treeView.selection[0];
      if ('uri' in sel) { return (sel as CrcFileItem).uri; }
      return undefined;
    }
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === 'file') {
      return activeEditor.document.uri;
    }
    return undefined;
  }

  function findRuleIndexForUri(uri: vscode.Uri): { index: number; rule: RuleConfig } | null {
    const relPath = vscode.workspace.asRelativePath(uri, false);
    if (!relPath) return null;

    const relPosix = pathToPosix(relPath);
    const existingRules = getWorkspaceRules();

    for (let i = 0; i < existingRules.length; i++) {
      const rule = existingRules[i];
      if (!rule || typeof rule.pattern !== 'string') continue;
      try {
        const isMatch = picomatch.isMatch(relPosix, rule.pattern, {
          dot: true,
          nocase: process.platform === 'win32'
        });
        if (isMatch) {
          return { index: i, rule };
        }
      } catch {
        // Ignore invalid glob
      }
    }
    return null;
  }

  function getWorkspaceRules(): RuleConfig[] {
    const config = vscode.workspace.getConfiguration();
    const inspected = config.inspect<RuleConfig[]>('digestlens.rules');
    const workspaceValue = inspected?.workspaceValue;
    if (Array.isArray(workspaceValue)) {
      return [...workspaceValue];
    }
    return [];
  }

  // --- Funzioni per la configurazione rapida delle regole
  async function quickSetupRuleForFile(resource?: vscode.Uri | CrcTreeItem): Promise<void> {
    try {
      const uri = resolveUriFromResource(resource);

      // Controllo robusto dell'URI
      if (!uri || !uri.fsPath) {
        vscode.window.showWarningMessage('Nessun file selezionato per la configurazione CRC.');
        return;
      }

      // Otteniamo il percorso relativo
      const relPath = vscode.workspace.asRelativePath(uri, false);
      if (!relPath || relPath.trim().length === 0) {
        vscode.window.showWarningMessage('Impossibile determinare il percorso relativo del file.');
        return;
      }

      // Algoritmi predefiniti disponibili
      const algorithms = [
        { label: 'CRC-32', description: 'CRC-32 standard', detail: 'Polynomial: 0x04C11DB7' },
        { label: 'CRC-32C', description: 'CRC-32C (Castagnoli)', detail: 'Polynomial: 0x1EDC6F41' },
        { label: 'CRC-16/IBM', description: 'CRC-16 IBM', detail: 'Polynomial: 0x8005' },
        { label: 'CRC-16/MODBUS', description: 'CRC-16 Modbus', detail: 'Polynomial: 0x8005' },
        { label: 'CRC-16/CCITT-FALSE', description: 'CRC-16 CCITT False', detail: 'Polynomial: 0x1021' },
        { label: 'CRC-8', description: 'CRC-8 standard', detail: 'Polynomial: 0x07' },
        { label: 'CRC-8-CCITT', description: 'CRC-8 CCITT', detail: 'Polynomial: 0x07, XOROut: 0x55' },
        { label: 'Fletcher-8', description: 'Fletcher checksum 8 bit', detail: 'Sums modulo 15 su nibble (4 bit)' },
        { label: 'Fletcher-16', description: 'Fletcher checksum 16 bit', detail: 'Sums modulo 255 su byte (8 bit)' },
        { label: 'MD5', description: 'Message Digest 5', detail: 'Hash crittografico a 128 bit (legacy)' },
        { label: 'SHA1', description: 'Secure Hash Algorithm 1', detail: 'Hash a 160 bit (legacy)' },
        { label: 'SHA256', description: 'SHA-2 256 bit', detail: 'Hash crittografico a 256 bit' },
        { label: 'SHA512', description: 'SHA-2 512 bit', detail: 'Hash crittografico a 512 bit' },
        { label: 'BLAKE2b-512', description: 'BLAKE2b 512 bit', detail: 'Hash BLAKE2 con output 512 bit' },
        { label: 'BLAKE2s-256', description: 'BLAKE2s 256 bit', detail: 'Hash BLAKE2 con output 256 bit' },
        { label: 'BLAKE3', description: 'BLAKE3 256 bit', detail: 'Hash moderno ad alte prestazioni' },
        { label: 'xxHash32', description: 'xxHash 32 bit', detail: 'Hash non crittografico molto veloce' },
        { label: 'xxHash64', description: 'xxHash 64 bit', detail: 'Hash non crittografico molto veloce' }
      ];

      // Chiediamo all'utente quale algoritmo vuole usare
      const selected = await vscode.window.showQuickPick(algorithms, {
        placeHolder: 'Seleziona un algoritmo di checksum per questo file',
        title: 'Configurazione Rapida Regola Checksum'
      });

      if (!selected) {
        return; // L'utente ha annullato
      }

      // Creiamo il pattern per includere solo questo file specifico
      const pattern = relPath;

      // Creiamo la nuova regola
      const newRule: RuleConfig = {
        pattern: pattern,
        algorithm: selected.label as AlgoName,
        display: {
          badgeLength: 2,
          uppercase: true
        }
      };

      // Leggiamo le regole esistenti
      const config = vscode.workspace.getConfiguration();
      const existingRules = getWorkspaceRules();

      // Controlliamo se esiste già una regola per questo file
      const existingIndex = existingRules.findIndex(rule => rule.pattern === pattern);
      
      if (existingIndex !== -1) {
        // Chiediamo se vuole sovrascrivere
        const overwrite = await vscode.window.showWarningMessage(
          `Esiste già una regola per il file ${pattern}. Sovrascrivere?`,
          'Sì', 'No'
        );
        
        if (overwrite === 'Sì') {
          existingRules[existingIndex] = newRule;
        } else {
          return;
        }
      } else {
        // Aggiungiamo la nuova regola
        existingRules.push(newRule);
      }

      // Salviamo la configurazione
      await config.update('digestlens.rules', existingRules, vscode.ConfigurationTarget.Workspace);

      // Aggiorniamo le regole in memoria
      rules = loadRules(output);
      setupWatchers();
      refreshAll();
      treeProvider.refresh();

      vscode.window.showInformationMessage(
        `Regola aggiunta per ${pattern} con algoritmo ${selected.label}`
      );

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Errore durante la configurazione della regola: ${errorMessage}`);
    }
  }

  async function openRuleInSettingsForFile(resource?: vscode.Uri | CrcTreeItem): Promise<void> {
    const uri = resolveUriFromResource(resource);
    if (!uri) {
      vscode.window.showWarningMessage('Nessun file selezionato.');
      return;
    }

    const found = findRuleIndexForUri(uri);
    if (!found) {
      vscode.window.showWarningMessage('Nessuna regola locale trovata per il file selezionato.');
    }

    const workspaceRules = getWorkspaceRules();
    if (workspaceRules.length === 0) {
      vscode.window.showWarningMessage('Nessuna regola definita. Crea prima una regola CRC.');
      return;
    }

    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      vscode.window.showWarningMessage('Nessun workspace aperto.');
      return;
    }

    const settingsUri = vscode.Uri.joinPath(root.uri, '.vscode', 'settings.json');

    try {
      await fs.promises.mkdir(path.join(root.uri.fsPath, '.vscode'), { recursive: true });
      if (!fs.existsSync(settingsUri.fsPath)) {
        await fs.promises.writeFile(settingsUri.fsPath, '{\n  "digestlens.rules": []\n}\n', 'utf8');
      }
      const doc = await vscode.workspace.openTextDocument(settingsUri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });

      const text = doc.getText();
      const pattern = found?.rule.pattern;
      let match: RegExpExecArray | null = null;
      if (pattern) {
        const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`"pattern"\\s*:\\s*"${escapedPattern.replace(/"/g, '\\"')}"`, 'm');
        match = regex.exec(text);
      }

      let pos = -1;
      if (match && typeof match.index === 'number') {
        pos = match.index;
      } else {
        pos = text.indexOf('"digestlens.rules"');
      }

      if (pos >= 0) {
        const position = doc.positionAt(pos);
        const range = new vscode.Range(position, position);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Errore apertura settings.json: ${error}`);
    }
  }

  async function deleteRuleForFile(resource?: vscode.Uri | CrcTreeItem): Promise<void> {
    const uri = resolveUriFromResource(resource);
    if (!uri) {
      vscode.window.showWarningMessage('Nessun file selezionato.');
      return;
    }

    const found = findRuleIndexForUri(uri);
    if (!found) {
      vscode.window.showWarningMessage('Nessuna regola locale trovata per il file selezionato.');
      return;
    }

    const relPath = vscode.workspace.asRelativePath(uri, false);
    const confirm = await vscode.window.showWarningMessage(
      `Eliminare la regola "${found.rule.pattern}" per ${relPath}?`,
      'Elimina',
      'Annulla'
    );
    if (confirm !== 'Elimina') {
      return;
    }

    const config = vscode.workspace.getConfiguration();
    const existingRules = getWorkspaceRules();
    existingRules.splice(found.index, 1);
    await config.update('digestlens.rules', existingRules, vscode.ConfigurationTarget.Workspace);

    rules = loadRules(output);
    setupWatchers();
    refreshAll();
    treeProvider.refresh();

    vscode.window.showInformationMessage('Regola eliminata.');
  }

  // --- Comandi
  context.subscriptions.push(
    vscode.commands.registerCommand('digestlens.quickSetupRule', quickSetupRuleForFile),
    vscode.commands.registerCommand('digestlens.openRuleInSettings', openRuleInSettingsForFile),
    vscode.commands.registerCommand('digestlens.deleteRule', deleteRuleForFile),
    vscode.commands.registerCommand('digestlens.openGuide', async () => {
      const content = await getGuideContent(context);
      // output.appendLine(`contenuto in ${content.lang} con titolo ${content.title}\n${content.rawMd}`);
      createGuidePanel(context, content, output);
    }),
    vscode.commands.registerCommand('digestlens.openInspector', async () => {
      createInspectorPanel(context, output);
    }),

    vscode.commands.registerCommand('digestlens.refresh', () => {
      refreshAll();
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('digestlens.copyDigest', async (resource?: vscode.Uri | CrcTreeItem) => {
      let crcValue: string | undefined;
      let fileName: string | undefined;

      // Item "on clipboard" dalla tree view
      if (resource && typeof resource === 'object' && 'isClipboard' in resource && resource.isClipboard) {
        const clipItem = resource as CrcClipboardItem;
        if (clipItem.clipboardEntry.fullHex && clipItem.clipboardEntry.fullHex !== '--') {
          crcValue = `0x${clipItem.clipboardEntry.fullHex}`;
          fileName = `⟨appunti — ${clipItem.clipboardEntry.algoName}⟩`;
        }
      }
      // Item "on selection" dalla tree view
      else if (resource && typeof resource === 'object' && 'isSelection' in resource) {
        const selItem = resource as CrcSelectionItem;
        if (selItem.selectionEntry.fullHex) {
          crcValue = `0x${selItem.selectionEntry.fullHex}`;
          fileName = `⟨selezione — ${selItem.selectionEntry.algoName}⟩`;
        }
      }
      // CrcFileItem dalla tree view
      else if (resource && typeof resource === 'object' && 'entry' in resource && 'uri' in resource) {
        const treeItem = resource as CrcFileItem;
        crcValue = `0x${treeItem.entry.fullHex}`;
        fileName = path.basename(treeItem.uri.fsPath);
      }
      // URI dal menu contestuale dell'Explorer
      else if (resource instanceof vscode.Uri) {
        const uri = resource;
        const result = await ensureComputed(uri);
        if (result && result.length > 0) {
          crcValue = `0x${result[0].entry.fullHex}`;
          fileName = path.basename(uri.fsPath);
        }
      }
      // Nessun argomento: prova l'editor attivo
      else {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.scheme === 'file') {
          const uri = activeEditor.document.uri;
          const result = await ensureComputed(uri);
          if (result && result.length > 0) {
            crcValue = `0x${result[0].entry.fullHex}`;
            fileName = path.basename(uri.fsPath);
          }
        }
      }

      if (crcValue) {
        await vscode.env.clipboard.writeText(crcValue);
        vscode.window.showInformationMessage(`Checksum copiato negli appunti: ${crcValue}${fileName ? ` (${fileName})` : ''}`);
      } else {
        vscode.window.showWarningMessage('Nessun checksum disponibile da copiare.');
      }
    }),
    vscode.commands.registerCommand('digestlens.openFile', async (item: CrcTreeItem) => {
      if ('uri' in item) {
        // Qui 'item' è trattato come CrcFileItem
        await vscode.workspace.openTextDocument(item.uri);
        await vscode.window.showTextDocument(item.uri);
      }
    }),
    vscode.commands.registerCommand('digestlens.clearCache', async () => {
      if (!cacheManager || !cacheConfig.enabled) {
        vscode.window.showWarningMessage('Cache non abilitata o non inizializzata.');
        return;
      }

      try {
        await cacheManager.clear();
        cache.clear();
        provider.fire();
        treeProvider.refresh();
        vscode.window.showInformationMessage('Cache locale cancellata con successo.');
      } catch (error) {
        vscode.window.showErrorMessage(`Errore durante la cancellazione della cache: ${error}`);
      }
    }),
    vscode.commands.registerCommand('digestlens.cacheStats', async () => {
      if (!cacheManager || !cacheConfig.enabled) {
        vscode.window.showWarningMessage('Cache non abilitata o non inizializzata.');
        return;
      }

      const stats = cacheManager.getStats();
      const message = `Cache locale: ${stats.totalEntries} entry, ultimo aggiornamento: ${stats.lastUpdated?.toLocaleString() || 'N/A'}`;
      vscode.window.showInformationMessage(message);
      output.appendLine(`[cache] Statistiche: ${message}`);
    })
  );


  // --- Warmup iniziale per popolare i badge velocemente
  warmupVisibleFiles().then(() => provider.fire()).catch(() => { /* ignore */ });

  function reportConfigurationErrors() {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return;
    }

    // Carichiamo le regole grezze per la validazione
    const rawRules = vscode.workspace.getConfiguration().get<RuleConfig[]>('digestlens.rules') ?? [];
    
    const errors = validateRules(rawRules, cacheConfig, root.uri.fsPath, output);
    
    // Creiamo diagnostics per gli errori
    const diagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [];
    
    if (errors.length > 0) {
      // Creiamo un diagnostic per il file settings.json
      const settingsUri = vscode.Uri.joinPath(root.uri, '.vscode', 'settings.json');
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 0),
        errors.join('\n'),
        vscode.DiagnosticSeverity.Error
      );
      diagnostic.source = 'DigestLens';
      diagnostics.push([settingsUri, [diagnostic]]);
    }
    
    diagnosticCollection.set(diagnostics);
  }

  // --- Reload config on change
  const cfgWatcher = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('digestlens.rules')) {
      output.appendLine('[config] Cambiamento configurazione: ricarico regole.');
      rules = loadRules(output);
      setupWatchers();
      // Invalidiamo la cache per i file che potrebbero essere interessati
      invalidateCacheForRules();
      refreshAll();
      reportConfigurationErrors();
    }
    if (e.affectsConfiguration('digestlens.json')) {
      output.appendLine('[config] Cambiamento configurazione cache: ricarico cache.');
      cacheConfig = loadCacheConfig(output);
      initializeCacheManager();
      reportConfigurationErrors();
    }
  });
  context.subscriptions.push(cfgWatcher);

  // --- Inizializziamo il cache manager all'avvio
  initializeCacheManager();
  
  // --- Controlliamo errori di configurazione all'avvio
  reportConfigurationErrors();
}

export function deactivate() {}
