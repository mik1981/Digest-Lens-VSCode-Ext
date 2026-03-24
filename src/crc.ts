import { CRCParams } from './config';
import * as fs from 'fs';
import {
  createBLAKE2b,
  createBLAKE2s,
  createBLAKE3,
  createMD5,
  createSHA1,
  createSHA256,
  createSHA512,
  createXXHash32,
  createXXHash64,
  type IHasher,
} from 'hash-wasm';

type Table = bigint[]; // 256 voci
type StreamHashFactory = () => Promise<IHasher>;

function maskForWidth(width: number): bigint {
  return (1n << BigInt(width)) - 1n;
}

function reflect(value: bigint, width: number): bigint {
  let res = 0n;
  for (let i = 0; i < width; i++) {
    if (((value >> BigInt(i)) & 1n) !== 0n) {
      res |= 1n << BigInt(width - 1 - i);
    }
  }
  return res;
}

function isFletcherProfile(params: CRCParams): boolean {
  const name = params.name?.toLowerCase();
  return name === 'fletcher-8' || name === 'fletcher-16';
}

function getStreamHashFactory(params: CRCParams): StreamHashFactory | undefined {
  const name = params.name?.toLowerCase();
  if (!name) {
    return undefined;
  }

  switch (name) {
    case 'md5':
      return createMD5;
    case 'sha1':
      return createSHA1;
    case 'sha256':
      return createSHA256;
    case 'sha512':
      return createSHA512;
    case 'blake2b-512':
      return () => createBLAKE2b(512);
    case 'blake2s-256':
      return () => createBLAKE2s(256);
    case 'blake3':
      return () => createBLAKE3(256);
    case 'xxhash32':
      return createXXHash32;
    case 'xxhash64':
      return createXXHash64;
    default:
      return undefined;
  }
}

function toBigIntFromHex(hex: string): bigint {
  if (!hex) {
    return 0n;
  }
  return BigInt(`0x${hex}`);
}

async function computeFileStreamHash(
  filePath: string,
  createHasher: StreamHashFactory,
  signal?: AbortSignal,
): Promise<bigint> {
  const hasher = await createHasher();
  hasher.init();

  await new Promise<void>((resolve, reject) => {
    const rs = fs.createReadStream(filePath, { encoding: undefined });

    rs.on('error', (e: unknown) => reject(e));

    rs.on('data', (chunk: Buffer) => {
      if (signal?.aborted) {
        rs.close();
        reject(new Error('Aborted'));
        return;
      }

      try {
        hasher.update(chunk);
      } catch (e) {
        rs.close();
        reject(e);
      }
    });

    rs.on('end', () => {
      resolve();
    });
  });

  return toBigIntFromHex(hasher.digest('hex'));
}

function buildTable(params: CRCParams): Table {
  const { width, poly, refIn } = params;
  const mask = maskForWidth(width);
  const topBit = 1n << BigInt(width - 1);
  const table: Table = new Array(256).fill(0n);

  if (refIn) {
    const rpoly = reflect(poly, width) & mask;
    for (let i = 0; i < 256; i++) {
      let crc = BigInt(i);
      for (let j = 0; j < 8; j++) {
        if ((crc & 1n) !== 0n) {
          crc = (crc >> 1n) ^ rpoly;
        } else {
          crc >>= 1n;
        }
      }
      table[i] = crc & mask;
    }
  } else {
    for (let i = 0; i < 256; i++) {
      let crc = BigInt(i) << BigInt(width - 8);
      for (let j = 0; j < 8; j++) {
        if ((crc & topBit) !== 0n) {
          crc = ((crc << 1n) & mask) ^ poly;
        } else {
          crc = (crc << 1n) & mask;
        }
      }
      table[i] = crc & mask;
    }
  }
  return table;
}

function updateCRCChunk(params: CRCParams, table: Table, state: bigint, chunk: Buffer): bigint {
  const { width, refIn } = params;
  const mask = maskForWidth(width);

  if (refIn) {
    for (let i = 0; i < chunk.length; i++) {
      const idx = Number((state ^ BigInt(chunk[i])) & 0xFFn);
      state = (state >> 8n) ^ table[idx];
    }
  } else {
    const shift = BigInt(width - 8);
    for (let i = 0; i < chunk.length; i++) {
      const idx = Number(((state >> shift) ^ BigInt(chunk[i])) & 0xFFn);
      state = ((state << 8n) & mask) ^ table[idx];
    }
  }
  return state & mask;
}

function finalizeCRC(params: CRCParams, state: bigint): bigint {
  const mask = maskForWidth(params.width);
  let out = state & mask;
  if (params.refIn !== params.refOut) {
    out = reflect(out, params.width) & mask;
  }
  out = (out ^ params.xorOut) & mask;
  return out;
}

type FletcherState = {
  sum1: number;
  sum2: number;
};

function initFletcherState(params: CRCParams): FletcherState {
  const halfWidth = Math.floor(params.width / 2);
  const wordMask = (1 << halfWidth) - 1;
  const init = Number(params.init & maskForWidth(params.width));
  return {
    sum1: init & wordMask,
    sum2: (init >> halfWidth) & wordMask
  };
}

function updateFletcher16Chunk(state: FletcherState, chunk: Buffer): void {
  for (let i = 0; i < chunk.length; i++) {
    state.sum1 = (state.sum1 + chunk[i]) % 255;
    state.sum2 = (state.sum2 + state.sum1) % 255;
  }
}

function updateFletcher8Chunk(state: FletcherState, chunk: Buffer): void {
  for (let i = 0; i < chunk.length; i++) {
    const hi = (chunk[i] >> 4) & 0x0f;
    const lo = chunk[i] & 0x0f;

    state.sum1 = (state.sum1 + hi) % 15;
    state.sum2 = (state.sum2 + state.sum1) % 15;
    state.sum1 = (state.sum1 + lo) % 15;
    state.sum2 = (state.sum2 + state.sum1) % 15;
  }
}

function finalizeFletcher(params: CRCParams, state: FletcherState): bigint {
  const halfWidth = Math.floor(params.width / 2);
  const out = (BigInt(state.sum2) << BigInt(halfWidth)) | BigInt(state.sum1);
  return (out ^ params.xorOut) & maskForWidth(params.width);
}

async function computeFileFletcher(
  filePath: string,
  params: CRCParams,
  signal?: AbortSignal,
): Promise<bigint> {
  if (params.width !== 8 && params.width !== 16) {
    throw new Error(`Fletcher supporta solo width 8 o 16 (ricevuto: ${params.width})`);
  }

  const state = initFletcherState(params);

  await new Promise<void>((resolve, reject) => {
    const rs = fs.createReadStream(filePath, { encoding: undefined });

    rs.on('error', (e: unknown) => reject(e));

    rs.on('data', (chunk: Buffer) => {
      if (signal?.aborted) {
        rs.close();
        reject(new Error('Aborted'));
        return;
      }

      if (params.width === 16) {
        updateFletcher16Chunk(state, chunk);
      } else {
        updateFletcher8Chunk(state, chunk);
      }
    });

    rs.on('end', () => {
      resolve();
    });
  });

  return finalizeFletcher(params, state);
}

export async function computeFileCRC(
  filePath: string,
  params: CRCParams,
  signal?: AbortSignal,
): Promise<bigint> {
  const streamHashFactory = getStreamHashFactory(params);
  if (streamHashFactory) {
    return computeFileStreamHash(filePath, streamHashFactory, signal);
  }

  if (isFletcherProfile(params)) {
    return computeFileFletcher(filePath, params, signal);
  }

  const table = buildTable(params);
  let state = params.init & maskForWidth(params.width);

  // Se serve: per file molto grandi potremmo interrompere con signal.aborted
  await new Promise<void>((resolve, reject) => {
    // Forza modalita binaria (chunk === Buffer)
    const rs = fs.createReadStream(filePath, { encoding: undefined });

    rs.on('error', (e: unknown) => reject(e));

    rs.on('data', (chunk: Buffer) => {
      if (signal?.aborted) {
        rs.close();
        reject(new Error('Aborted'));
        return;
      }
      state = updateCRCChunk(params, table, state, chunk);
    });

    rs.on('end', () => {
      resolve();
    });
  });

  return finalizeCRC(params, state);
}

/**
 * Calcola il checksum su un Buffer in memoria (usato per "onselection").
 * Riusa tutta la logica di computeFileCRC senza I/O.
 */
export async function computeBufferCRC(buf: Buffer, params: CRCParams): Promise<bigint> {
  // SHA / BLAKE / xxHash — usa l'IHasher di hash-wasm
  const streamHashFactory = getStreamHashFactory(params);
  if (streamHashFactory) {
    const hasher = await streamHashFactory();
    hasher.init();
    hasher.update(buf);
    return toBigIntFromHex(hasher.digest('hex'));
  }

  // Fletcher
  if (isFletcherProfile(params)) {
    if (params.width !== 8 && params.width !== 16) {
      throw new Error(`Fletcher supporta solo width 8 o 16 (ricevuto: ${params.width})`);
    }
    const state = initFletcherState(params);
    if (params.width === 16) {
      updateFletcher16Chunk(state, buf);
    } else {
      updateFletcher8Chunk(state, buf);
    }
    return finalizeFletcher(params, state);
  }

  // CRC table-driven
  const table = buildTable(params);
  const mask  = maskForWidth(params.width);
  let state   = params.init & mask;
  state = updateCRCChunk(params, table, state, buf);
  return finalizeCRC(params, state);
}

export function toHex(value: bigint, width: number, uppercase: boolean): string {
  const digits = Math.ceil(width / 4);
  let s = value.toString(16).padStart(digits, '0');
  if (uppercase) {
    s = s.toUpperCase();
  }
  return s;
}
