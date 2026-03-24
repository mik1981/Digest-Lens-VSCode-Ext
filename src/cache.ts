import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface CacheEntry {
  relativePath: string;  // percorso relativo alla workspace root
  crc: string;           // CRC in esadecimale
  mtimeMs: number;       // timestamp ultima modifica
  algorithm: string;     // nome algoritmo
  width: number;         // larghezza CRC
}

export interface CacheFile {
  version: number;
  workspaceRoot: string;
  entries: CacheEntry[];
  lastUpdated: number;
}

export class CacheManager {
  private cacheFile: string;
  private cacheData: CacheFile | null = null;
  private isDirty = false;

  constructor(cacheFilePath: string) {
    this.cacheFile = cacheFilePath;
  }

  private getCacheDir(): string {
    return path.dirname(this.cacheFile);
  }

  private ensureCacheDir(): void {
    const dir = this.getCacheDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private async loadCache(): Promise<CacheFile | null> {
    try {
      if (!fs.existsSync(this.cacheFile)) {
        return null;
      }

      const content = await fs.promises.readFile(this.cacheFile, 'utf8');
      const data = JSON.parse(content) as CacheFile;

      // Validazione base
      if (!data.version || !data.entries || !Array.isArray(data.entries)) {
        return null;
      }

      return data;
    } catch (error) {
      console.warn(`[cache] Errore lettura cache: ${error}`);
      return null;
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.isDirty || !this.cacheData) {
      return;
    }

    try {
      this.ensureCacheDir();
      this.cacheData.lastUpdated = Date.now();
      await fs.promises.writeFile(this.cacheFile, JSON.stringify(this.cacheData, null, 2));
      this.isDirty = false;
    } catch (error) {
      console.error(`[cache] Errore scrittura cache: ${error}`);
    }
  }

  async initialize(workspaceRoot: string): Promise<void> {
    this.cacheData = await this.loadCache();
    
    if (!this.cacheData || this.cacheData.workspaceRoot !== workspaceRoot) {
      // Creiamo una nuova cache o resettiamo se il workspace è cambiato
      this.cacheData = {
        version: 1,
        workspaceRoot,
        entries: [],
        lastUpdated: Date.now()
      };
      this.isDirty = true;
      await this.saveCache();
    }
  }

  async getEntry(relativePath: string, algorithm: string): Promise<CacheEntry | null> {
    if (!this.cacheData) {
      return null;
    }

    return this.cacheData.entries.find(
      entry => entry.relativePath === relativePath && entry.algorithm === algorithm
    ) || null;
  }

  async setEntry(entry: CacheEntry): Promise<void> {
    if (!this.cacheData) {
      return;
    }

    // Rimuoviamo eventuali entry esistenti per lo stesso file e algoritmo
    this.cacheData.entries = this.cacheData.entries.filter(
      e => !(e.relativePath === entry.relativePath && e.algorithm === entry.algorithm)
    );

    // Aggiungiamo la nuova entry
    this.cacheData.entries.push(entry);
    this.isDirty = true;
    
    // Salviamo immediatamente per sicurezza
    await this.saveCache();
  }

  async removeEntry(relativePath: string, algorithm: string): Promise<void> {
    if (!this.cacheData) {
      return;
    }

    this.cacheData.entries = this.cacheData.entries.filter(
      entry => !(entry.relativePath === relativePath && entry.algorithm === algorithm)
    );
    this.isDirty = true;
    await this.saveCache();
  }

  async removeFileEntries(relativePath: string): Promise<void> {
    if (!this.cacheData) {
      return;
    }

    this.cacheData.entries = this.cacheData.entries.filter(
      entry => entry.relativePath !== relativePath
    );
    this.isDirty = true;
    await this.saveCache();
  }

  async cleanup(): Promise<void> {
    if (!this.cacheData) {
      return;
    }

    const root = this.cacheData.workspaceRoot;
    const validEntries: CacheEntry[] = [];

    for (const entry of this.cacheData.entries) {
      const fullPath = path.join(root, entry.relativePath);
      try {
        const stats = await fs.promises.stat(fullPath);
        // Manteniamo solo i file che esistono e hanno lo stesso timestamp
        if (stats.mtimeMs === entry.mtimeMs) {
          validEntries.push(entry);
        }
      } catch {
        // File non esistente, saltiamo
      }
    }

    this.cacheData.entries = validEntries;
    this.isDirty = true;
    await this.saveCache();
  }

  async clear(): Promise<void> {
    if (!this.cacheData) {
      return;
    }

    this.cacheData.entries = [];
    this.isDirty = true;
    await this.saveCache();
  }

  getStats(): { totalEntries: number; lastUpdated: Date | null } {
    if (!this.cacheData) {
      return { totalEntries: 0, lastUpdated: null };
    }

    return {
      totalEntries: this.cacheData.entries.length,
      lastUpdated: new Date(this.cacheData.lastUpdated)
    };
  }
}