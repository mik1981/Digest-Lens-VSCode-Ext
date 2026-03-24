import * as vscode from 'vscode';
import * as path from 'path';
import picomatch from 'picomatch';

export type AlgoName =
  | 'CRC-32'
  | 'CRC-32C'
  | 'CRC-16/IBM'
  | 'CRC-16/MODBUS'
  | 'CRC-16/CCITT-FALSE'
  | 'CRC-8'
  | 'CRC-8-CCITT'
  | 'CRC-8/CCITT'
  | 'Fletcher-8'
  | 'Fletcher-16'
  | 'MD5'
  | 'SHA1'
  | 'SHA256'
  | 'SHA512'
  | 'BLAKE2b-512'
  | 'BLAKE2s-256'
  | 'BLAKE3'
  | 'xxHash32'
  | 'xxHash64';

export interface CRCParams {
  name?: string;
  width: number;       // 1..512 (in base all'algoritmo)
  poly: bigint;
  init: bigint;
  refIn: boolean;
  refOut: boolean;
  xorOut: bigint;
}

export interface RuleDisplay {
  badgeLength?: number; // 1..4 (UI tipicamente mostra 1..2)
  uppercase?: boolean;
}

export interface RuleConfig {
  pattern: string;   // glob
  algorithm: AlgoName | (Omit<CRCParams, 'poly'|'init'|'xorOut'> & {
    poly: string | number;
    init: string | number;
    xorOut: string | number;
  });
  display?: RuleDisplay;
  initialValue?: string | number; // Valore iniziale (solo CRC/Fletcher)
  rule_active?: boolean; // Proprietà opzionale per abilitare/disabilitare la regola
}

export interface CacheConfig {
  enabled: boolean;
  path: string; // percorso relativo alla workspace root, default: '.vscode/digestlens.json'
}

export interface EffectiveRule {
  patternStr: string;                 // glob originale, per matching
  pattern: vscode.GlobPattern;        // per watcher
  params: CRCParams;
  display: Required<RuleDisplay>;
  isOnSelection?: boolean;            // true quando pattern === 'onselection'
}

/** Pattern speciale che non corrisponde mai a file reali, usato come placeholder
 *  per le regole "onselection" che non devono creare watcher su file. */
const ONSELECTION_DUMMY_GLOB = '**/__crc_lens_onselection_never_match__';

function toBigIntFlexible(v: string | number): bigint {
  if (typeof v === 'number') return BigInt(v);
  const s = v.trim();
  if (/^0x/i.test(s)) return BigInt(s);
  return BigInt(s);
}

function supportsInitialValue(params: CRCParams): boolean {
  const name = params.name?.toLowerCase();
  if (!name) {
    return true;
  }

  return ![
    'md5',
    'sha1',
    'sha256',
    'sha512',
    'blake2b-512',
    'blake2s-256',
    'blake3',
    'xxhash32',
    'xxhash64'
  ].includes(name);
}

export function loadRules(output?: vscode.OutputChannel): EffectiveRule[] {
  const arr = vscode.workspace.getConfiguration().get<RuleConfig[]>('digestlens.rules') ?? [];
  const rules: EffectiveRule[] = [];
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) {
    output?.appendLine('[config] Nessun workspace folder, nessuna regola caricata.');
    return rules;
  }

  for (const item of arr) {
    // Se rule_active è false, salta questa regola
    if (item.rule_active === false) {
      output?.appendLine(`[config] Regola "${item.pattern}" saltata: rule_active è false.`);
      continue;
    }

    let params: CRCParams;
    if (typeof item.algorithm === 'string') {
      params = namedProfile(item.algorithm);
    } else {
      params = {
        name: item.algorithm.name,
        width: item.algorithm.width,
        poly: toBigIntFlexible(item.algorithm.poly),
        init: toBigIntFlexible(item.algorithm.init),
        refIn: item.algorithm.refIn,
        refOut: item.algorithm.refOut,
        xorOut: toBigIntFlexible(item.algorithm.xorOut)
      };
    }
    
    // Se specificato, initialValue si applica solo ad algoritmi CRC/Fletcher.
    if (item.initialValue !== undefined && supportsInitialValue(params)) {
      params.init = toBigIntFlexible(item.initialValue);
    }
    
    const display: Required<RuleDisplay> = {
      badgeLength: Math.max(1, Math.min(4, item.display?.badgeLength ?? 2)),
      uppercase: item.display?.uppercase ?? true
    };

    const isOnSelection = item.pattern === 'onselection';

    rules.push({
      patternStr: item.pattern,
      pattern: isOnSelection
        ? new vscode.RelativePattern(root, ONSELECTION_DUMMY_GLOB)
        : new vscode.RelativePattern(root, item.pattern),
      params,
      display,
      isOnSelection: isOnSelection || undefined
    });
  }

  output?.appendLine('[config] Regole caricate:');
  output?.appendLine(JSON.stringify(rules.map(r => ({
    pattern: r.patternStr,
    params: { ...r.params, poly: '0x'+r.params.poly.toString(16), init: '0x'+r.params.init.toString(16), xorOut: '0x'+r.params.xorOut.toString(16) },
    display: r.display
  })), null, 2));

  return rules;
}

export function loadCacheConfig(output?: vscode.OutputChannel): CacheConfig {
  const config = vscode.workspace.getConfiguration().get<CacheConfig>('digestlens.json');
  const defaultConfig: CacheConfig = {
    enabled: true,
    path: '.vscode/digestlens.json'
  };
  
  const result = {
    enabled: config?.enabled ?? defaultConfig.enabled,
    path: config?.path ?? defaultConfig.path
  };
  
  if (output) {
    output.appendLine('[config] Cache configurazione:');
    output.appendLine(`  enabled: ${result.enabled}`);
    output.appendLine(`  path: ${result.path}`);
  }
  
  return result;
}

export function getCacheFilePath(cacheConfig: CacheConfig, workspaceRoot: string): string {
  return path.resolve(workspaceRoot, cacheConfig.path);
}

export function validateRules(rules: RuleConfig[], cacheConfig: CacheConfig, workspaceRoot: string, output?: vscode.OutputChannel): string[] {
  const errors: string[] = [];
  
  if (!cacheConfig.enabled) {
    return errors;
  }
  
  const cacheFilePath = getCacheFilePath(cacheConfig, workspaceRoot);
  const cacheFileUri = vscode.Uri.file(cacheFilePath);
  const cacheFileRel = vscode.workspace.asRelativePath(cacheFileUri, false);
  
  for (const rule of rules) {
    // Le regole "onselection" non producono file: nessuna validazione necessaria
    if (rule.pattern === 'onselection') { continue; }

    const isMatch = picomatch.isMatch(cacheFileRel, rule.pattern, {
      dot: true,
      nocase: process.platform === 'win32'
    });
    
    if (isMatch) {
      const error = `Regola "${rule.pattern}" include il file di cache "${cacheConfig.path}". Questo potrebbe causare problemi. Si consiglia di escludere il file di cache dalle regole CRC.`;
      errors.push(error);
      if (output) {
        output.appendLine(`[config] ERRORE: ${error}`);
      }
    }
  }
  
  return errors;
}

export function namedProfile(name: AlgoName): CRCParams {
  switch (name) {
    case 'CRC-32': return {
      name, width: 32,
      poly: 0x04C11DB7n, init: 0xFFFFFFFFn,
      refIn: true, refOut: true, xorOut: 0xFFFFFFFFn
    };
    case 'CRC-32C': return {
      name, width: 32,
      poly: 0x1EDC6F41n, init: 0xFFFFFFFFn,
      refIn: true, refOut: true, xorOut: 0xFFFFFFFFn
    };
    case 'CRC-16/IBM': return {
      name, width: 16,
      poly: 0x8005n, init: 0x0000n,
      refIn: true, refOut: true, xorOut: 0x0000n
    };
    case 'CRC-16/MODBUS': return {
      name, width: 16,
      poly: 0x8005n, init: 0xFFFFn,
      refIn: true, refOut: true, xorOut: 0x0000n
    };
    case 'CRC-16/CCITT-FALSE': return {
      name, width: 16,
      poly: 0x1021n, init: 0xFFFFn,
      refIn: false, refOut: false, xorOut: 0x0000n
    };
    case 'CRC-8': return {
      name, width: 8,
      poly: 0x07n, init: 0x00n,
      refIn: false, refOut: false, xorOut: 0x00n
    };
    case 'CRC-8-CCITT': return {
      name, width: 8,
      poly: 0x07n, init: 0x00n,
      refIn: false, refOut: false, xorOut: 0x55n
    };
    case 'CRC-8/CCITT': return {
      name, width: 8,
      poly: 0x07n, init: 0x00n,
      refIn: false, refOut: false, xorOut: 0x55n
    };
    case 'Fletcher-8': return {
      name, width: 8,
      poly: 0x00n, init: 0x00n,
      refIn: false, refOut: false, xorOut: 0x00n
    };
    case 'Fletcher-16': return {
      name, width: 16,
      poly: 0x0000n, init: 0x0000n,
      refIn: false, refOut: false, xorOut: 0x0000n
    };
    case 'MD5': return {
      name, width: 128,
      poly: 0x0n, init: 0x0n,
      refIn: false, refOut: false, xorOut: 0x0n
    };
    case 'SHA1': return {
      name, width: 160,
      poly: 0x0n, init: 0x0n,
      refIn: false, refOut: false, xorOut: 0x0n
    };
    case 'SHA256': return {
      name, width: 256,
      poly: 0x0n, init: 0x0n,
      refIn: false, refOut: false, xorOut: 0x0n
    };
    case 'SHA512': return {
      name, width: 512,
      poly: 0x0n, init: 0x0n,
      refIn: false, refOut: false, xorOut: 0x0n
    };
    case 'BLAKE2b-512': return {
      name, width: 512,
      poly: 0x0n, init: 0x0n,
      refIn: false, refOut: false, xorOut: 0x0n
    };
    case 'BLAKE2s-256': return {
      name, width: 256,
      poly: 0x0n, init: 0x0n,
      refIn: false, refOut: false, xorOut: 0x0n
    };
    case 'BLAKE3': return {
      name, width: 256,
      poly: 0x0n, init: 0x0n,
      refIn: false, refOut: false, xorOut: 0x0n
    };
    case 'xxHash32': return {
      name, width: 32,
      poly: 0x0n, init: 0x0n,
      refIn: false, refOut: false, xorOut: 0x0n
    };
    case 'xxHash64': return {
      name, width: 64,
      poly: 0x0n, init: 0x0n,
      refIn: false, refOut: false, xorOut: 0x0n
    };
  }
  // fallback per sicurezza (non raggiunto se AlgoName è esaustivo)
  return {
    name, width: 8,
    poly: 0x07n, init: 0x00n,
    refIn: false, refOut: false, xorOut: 0x00n
  };
}
