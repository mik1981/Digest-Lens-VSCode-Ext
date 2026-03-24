const vscode = acquireVsCodeApi();

// ─── Algorithm profiles ───────────────────────────────────────────────────────
//   type: 'crc'         → table-driven CRC (step-by-step + lookup table)
//   type: 'fletcher'    → Fletcher-8 / Fletcher-16 (step-by-step, no table)
//   type: 'sha'         → SHA-1/256/512 via Web Crypto API
//   type: 'unavailable' → MD5, BLAKE*, xxHash* (need WebAssembly, computed by extension)

const CRC_PROFILES = [
  // ── CRC ──────────────────────────────────────────────────────────────────
  { name: 'CRC-32',             type: 'crc',         width: 32,  poly: 0x04C11DB7n, init: 0xFFFFFFFFn, refIn: true,  refOut: true,  xorOut: 0xFFFFFFFFn },
  { name: 'CRC-32C',            type: 'crc',         width: 32,  poly: 0x1EDC6F41n, init: 0xFFFFFFFFn, refIn: true,  refOut: true,  xorOut: 0xFFFFFFFFn },
  { name: 'CRC-16/IBM',         type: 'crc',         width: 16,  poly: 0x8005n,     init: 0x0000n,     refIn: true,  refOut: true,  xorOut: 0x0000n     },
  { name: 'CRC-16/MODBUS',      type: 'crc',         width: 16,  poly: 0x8005n,     init: 0xFFFFn,     refIn: true,  refOut: true,  xorOut: 0x0000n     },
  { name: 'CRC-16/CCITT-FALSE', type: 'crc',         width: 16,  poly: 0x1021n,     init: 0xFFFFn,     refIn: false, refOut: false, xorOut: 0x0000n     },
  { name: 'CRC-8',              type: 'crc',         width: 8,   poly: 0x07n,       init: 0x00n,       refIn: false, refOut: false, xorOut: 0x00n       },
  { name: 'CRC-8-CCITT',        type: 'crc',         width: 8,   poly: 0x07n,       init: 0x00n,       refIn: false, refOut: false, xorOut: 0x55n       },
  // ── Fletcher ─────────────────────────────────────────────────────────────
  { name: 'Fletcher-8',         type: 'fletcher',    width: 8  },
  { name: 'Fletcher-16',        type: 'fletcher',    width: 16 },
  // ── SHA (Web Crypto API) ─────────────────────────────────────────────────
  { name: 'SHA1',               type: 'sha',         width: 160, subtleAlgo: 'SHA-1'   },
  { name: 'SHA256',             type: 'sha',         width: 256, subtleAlgo: 'SHA-256' },
  { name: 'SHA512',             type: 'sha',         width: 512, subtleAlgo: 'SHA-512' },
  // ── WebAssembly-only (computed by extension, not inspectable in browser) ──
  { name: 'MD5',                type: 'unavailable', width: 128 },
  { name: 'BLAKE2b-512',        type: 'unavailable', width: 512 },
  { name: 'BLAKE2s-256',        type: 'unavailable', width: 256 },
  { name: 'BLAKE3',             type: 'unavailable', width: 256 },
  { name: 'xxHash32',           type: 'unavailable', width: 32  },
  { name: 'xxHash64',           type: 'unavailable', width: 64  },
];

const SUPERSCRIPT_MAP = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
};

// ─── Pure maths helpers ───────────────────────────────────────────────────────

function maskForWidth(width) {
  return (1n << BigInt(width)) - 1n;
}

function reflect(value, width) {
  let out = 0n;
  for (let i = 0; i < width; i++) {
    if (((value >> BigInt(i)) & 1n) !== 0n) {
      out |= 1n << BigInt(width - 1 - i);
    }
  }
  return out;
}

function toHex(value, width) {
  const digits = Math.ceil(width / 4);
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

function toBitString(value, width) {
  const bits = (value & maskForWidth(width)).toString(2).padStart(width, '0');
  return bits.replace(/(.{8})(?=.)/g, '$1 ');
}

function toSuperscript(value) {
  return String(value).split('').map(ch => SUPERSCRIPT_MAP[ch] ?? ch).join('');
}

function polynomialExpansion(poly, width) {
  const terms = [`x${toSuperscript(width)}`];
  for (let bit = width - 1; bit >= 0; bit--) {
    if (((poly >> BigInt(bit)) & 1n) === 0n) { continue; }
    if (bit === 0)      { terms.push('1'); }
    else if (bit === 1) { terms.push('x'); }
    else                { terms.push(`x${toSuperscript(bit)}`); }
  }
  return terms.join(' + ');
}

// ─── CRC (table-driven) ───────────────────────────────────────────────────────

function buildTable(profile) {
  const { width, poly, refIn } = profile;
  const mask   = maskForWidth(width);
  const topBit = 1n << BigInt(width - 1);
  const table  = new Array(256).fill(0n);

  if (refIn) {
    const rpoly = reflect(poly, width) & mask;
    for (let i = 0; i < 256; i++) {
      let crc = BigInt(i);
      for (let j = 0; j < 8; j++) {
        crc = (crc & 1n) !== 0n ? (crc >> 1n) ^ rpoly : crc >> 1n;
      }
      table[i] = crc & mask;
    }
  } else {
    for (let i = 0; i < 256; i++) {
      let crc = BigInt(i) << BigInt(width - 8);
      for (let j = 0; j < 8; j++) {
        crc = (crc & topBit) !== 0n ? ((crc << 1n) & mask) ^ poly : (crc << 1n) & mask;
      }
      table[i] = crc & mask;
    }
  }
  return table;
}

function updateByte(profile, table, state, byte) {
  const mask = maskForWidth(profile.width);
  if (profile.refIn) {
    const tableIndex = Number((state ^ BigInt(byte)) & 0xFFn);
    return { tableIndex, tableValue: table[tableIndex], nextState: ((state >> 8n) ^ table[tableIndex]) & mask };
  }
  const shift = BigInt(profile.width - 8);
  const tableIndex = Number(((state >> shift) ^ BigInt(byte)) & 0xFFn);
  return { tableIndex, tableValue: table[tableIndex], nextState: (((state << 8n) & mask) ^ table[tableIndex]) & mask };
}

function finalize(profile, state) {
  const mask = maskForWidth(profile.width);
  let out = state & mask;
  if (profile.refIn !== profile.refOut) { out = reflect(out, profile.width) & mask; }
  return (out ^ profile.xorOut) & mask;
}

function computeStepsCRC(profile, bytes) {
  const table = buildTable(profile);
  const mask  = maskForWidth(profile.width);
  let state   = profile.init & mask;
  const steps = [];

  for (let i = 0; i < bytes.length; i++) {
    const beforeState = state;
    const upd = updateByte(profile, table, state, bytes[i]);
    state = upd.nextState;
    steps.push({ index: i, byte: bytes[i], beforeState, tableIndex: upd.tableIndex, tableValue: upd.tableValue, afterState: state });
  }

  return { table, steps, preFinalState: state, finalState: finalize(profile, state) };
}

// ─── Fletcher ─────────────────────────────────────────────────────────────────

function computeStepsFletcher(profile, bytes) {
  const isF8    = profile.width === 8;
  const modulus = isF8 ? 15 : 255;
  let sum1 = 0, sum2 = 0;
  const steps = [];

  for (let i = 0; i < bytes.length; i++) {
    const s1Before = sum1;
    const s2Before = sum2;
    if (isF8) {
      const hi = (bytes[i] >> 4) & 0x0f;
      const lo =  bytes[i]       & 0x0f;
      sum1 = (sum1 + hi) % modulus;
      sum2 = (sum2 + sum1) % modulus;
      sum1 = (sum1 + lo) % modulus;
      sum2 = (sum2 + sum1) % modulus;
    } else {
      sum1 = (sum1 + bytes[i]) % modulus;
      sum2 = (sum2 + sum1)     % modulus;
    }
    steps.push({ index: i, byte: bytes[i], s1Before, s2Before, sum1After: sum1, sum2After: sum2 });
  }

  const halfWidth  = profile.width / 2;
  const finalValue = (sum2 << halfWidth) | sum1;
  return { steps, sum1, sum2, finalValue, modulus };
}

// ─── SHA via Web Crypto ───────────────────────────────────────────────────────

async function computeSHA(subtleAlgo, bytes) {
  const buf  = new Uint8Array(bytes).buffer;
  const hash = await crypto.subtle.digest(subtleAlgo, buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// ─── Input parsing ────────────────────────────────────────────────────────────

function parseHexBytes(value) {
  const clean = value.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  if (!clean) { return []; }
  if (clean.length % 2 !== 0) { throw new Error('Hex input must have an even number of digits.'); }
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) { bytes.push(parseInt(clean.slice(i, i + 2), 16)); }
  return bytes;
}

function parseInputBytes(mode, data) {
  return mode === 'hex' ? parseHexBytes(data) : Array.from(new TextEncoder().encode(data));
}

function parseHexBigInt(value) {
  const clean = value.trim().replace(/\s+/g, '');
  if (!clean) { return 0n; }
  const normalized = clean.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(normalized)) { throw new Error('Invalid hex value for reflection.'); }
  return BigInt(`0x${normalized}`);
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

function renderStepRowsCRC(tbody, steps, width) {
  const maxRows = 512;
  const visible = steps.slice(0, maxRows);
  const rows = visible.map(step => {
    const idxHex  = step.index.toString(16).toUpperCase().padStart(2, '0');
    const byteHex = step.byte.toString(16).toUpperCase().padStart(2, '0');
    return `
      <tr>
        <td class="inspector-mono">${step.index} (0x${idxHex})</td>
        <td class="inspector-mono">0x${byteHex}</td>
        <td class="inspector-mono">0x${toHex(step.beforeState, width)}</td>
        <td class="inspector-mono">0x${step.tableIndex.toString(16).toUpperCase().padStart(2, '0')}</td>
        <td class="inspector-mono">0x${toHex(step.tableValue, width)}</td>
        <td class="inspector-mono">0x${toHex(step.afterState, width)}</td>
      </tr>`;
  });
  if (steps.length > maxRows) {
    rows.push(`<tr><td colspan="6" style="opacity:.7">Showing first ${maxRows} of ${steps.length} bytes.</td></tr>`);
  }
  tbody.innerHTML = rows.join('');
}

function renderStepRowsFletcher(tbody, steps) {
  const maxRows = 512;
  const visible = steps.slice(0, maxRows);
  const rows = visible.map(step => {
    const idxHex  = step.index.toString(16).toUpperCase().padStart(2, '0');
    const byteHex = step.byte.toString(16).toUpperCase().padStart(2, '0');
    return `
      <tr>
        <td class="inspector-mono">${step.index} (0x${idxHex})</td>
        <td class="inspector-mono">0x${byteHex}</td>
        <td class="inspector-mono">${step.s1Before}</td>
        <td class="inspector-mono">${step.s2Before}</td>
        <td class="inspector-mono">${step.sum1After}</td>
        <td class="inspector-mono">${step.sum2After}</td>
      </tr>`;
  });
  if (steps.length > maxRows) {
    rows.push(`<tr><td colspan="6" style="opacity:.7">Showing first ${maxRows} of ${steps.length} bytes.</td></tr>`);
  }
  tbody.innerHTML = rows.join('');
}

function renderLookupTable(tbody, table, width) {
  const rows = [];
  for (let row = 0; row < 16; row++) {
    const cells = [`<th class="inspector-mono">${row.toString(16).toUpperCase()}</th>`];
    for (let col = 0; col < 16; col++) {
      const idx    = row * 16 + col;
      const idxHex = idx.toString(16).toUpperCase().padStart(2, '0');
      cells.push(`<td class="inspector-mono" title="Index 0x${idxHex}">0x${toHex(table[idx], width)}</td>`);
    }
    rows.push(`<tr>${cells.join('')}</tr>`);
  }
  tbody.innerHTML = rows.join('');
}

function renderReflection(valueInput, widthInput, beforeEl, afterEl, reflectedHexEl, errorEl) {
  try {
    const width = Number(widthInput.value);
    if (!Number.isFinite(width) || width < 1 || width > 128) { throw new Error('Reflection width must be between 1 and 128.'); }
    const original  = parseHexBigInt(valueInput.value) & maskForWidth(width);
    const reflected = reflect(original, width) & maskForWidth(width);
    beforeEl.textContent      = toBitString(original,  width);
    afterEl.textContent       = toBitString(reflected, width);
    reflectedHexEl.textContent = `0x${toHex(reflected, width)}`;
    errorEl.textContent = '';
  } catch (error) {
    beforeEl.textContent = afterEl.textContent = reflectedHexEl.textContent = '-';
    errorEl.textContent  = error instanceof Error ? error.message : String(error);
  }
}

// ─── Inspector initialisation ─────────────────────────────────────────────────

function initializeInspector(root) {
  const anchor = root.querySelector('#crc-inspector-anchor');
  if (!anchor) { return; }

  anchor.innerHTML = `
    <div class="inspector-shell">

      <!-- ── Controls ──────────────────────────────────────────────────────── -->
      <section class="inspector-card full">
        <h4>Inspector Controls</h4>
        <div class="inspector-controls">
          <label>
            Algorithm
            <select id="inspector-profile"></select>
          </label>
          <label>
            Input Mode
            <select id="inspector-input-mode">
              <option value="ascii">ASCII / UTF-8</option>
              <option value="hex">Hex bytes</option>
            </select>
          </label>
          <label class="full">
            Input Data
            <textarea id="inspector-input-data">123456789</textarea>
          </label>
        </div>
        <div id="inspector-error" style="color:var(--vscode-errorForeground);margin-top:8px;"></div>
      </section>

      <!-- ── Algorithm Internals (CRC / Fletcher) ───────────────────────── -->
      <section class="inspector-card" id="section-internals">
        <h4>Algorithm Internals</h4>
        <div id="inspector-kv" class="inspector-kv"></div>
      </section>

      <!-- ── Hash / unavailable result ─────────────────────────────────── -->
      <section class="inspector-card full" id="section-hash" style="display:none">
        <h4>Hash Result</h4>
        <div id="inspector-hash-content" class="inspector-kv"></div>
      </section>

      <!-- ── Step-by-step (CRC / Fletcher) ─────────────────────────────── -->
      <section class="inspector-card full" id="section-steps">
        <h4>Step-by-step Calculation</h4>
        <div class="inspector-scroll">
          <table>
            <thead id="steps-thead"></thead>
            <tbody id="inspector-steps"></tbody>
          </table>
        </div>
      </section>

      <!-- ── Lookup table (CRC only) ────────────────────────────────────── -->
      <section class="inspector-card full" id="section-lookup">
        <h4>Pre-generated Table (256 entries)</h4>
        <div class="inspector-scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>0</th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>7</th>
                <th>8</th><th>9</th><th>A</th><th>B</th><th>C</th><th>D</th><th>E</th><th>F</th>
              </tr>
            </thead>
            <tbody id="inspector-lookup-table"></tbody>
          </table>
        </div>
      </section>

      <!-- ── Bit Reflection (always visible) ───────────────────────────── -->
      <section class="inspector-card full">
        <h4>Bit Reflection (Realtime)</h4>
        <div class="inspector-controls">
          <label>
            Value (hex)
            <input id="inspector-reflect-value" value="0x1021" />
          </label>
          <label>
            Width
            <input id="inspector-reflect-width" type="number" min="1" max="128" value="16" />
          </label>
        </div>
        <div id="inspector-reflect-error" style="color:var(--vscode-errorForeground);margin-top:8px;"></div>
        <div class="inspector-reflect-row">
          <div>Original bits  <code id="inspector-reflect-before"></code></div>
          <div>Reflected bits <code id="inspector-reflect-after"></code></div>
          <div>Reflected hex  <code id="inspector-reflect-hex"></code></div>
        </div>
      </section>

    </div>
  `;

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const profileSelect  = anchor.querySelector('#inspector-profile');
  const inputMode      = anchor.querySelector('#inspector-input-mode');
  const inputData      = anchor.querySelector('#inspector-input-data');
  const errorBox       = anchor.querySelector('#inspector-error');

  const sectionInternals = anchor.querySelector('#section-internals');
  const sectionHash      = anchor.querySelector('#section-hash');
  const sectionSteps     = anchor.querySelector('#section-steps');
  const sectionLookup    = anchor.querySelector('#section-lookup');

  const kvContent    = anchor.querySelector('#inspector-kv');
  const hashContent  = anchor.querySelector('#inspector-hash-content');
  const stepsThead   = anchor.querySelector('#steps-thead');
  const stepBody     = anchor.querySelector('#inspector-steps');
  const lookupBody   = anchor.querySelector('#inspector-lookup-table');

  const reflectValue  = anchor.querySelector('#inspector-reflect-value');
  const reflectWidth  = anchor.querySelector('#inspector-reflect-width');
  const reflectBefore = anchor.querySelector('#inspector-reflect-before');
  const reflectAfter  = anchor.querySelector('#inspector-reflect-after');
  const reflectHex    = anchor.querySelector('#inspector-reflect-hex');
  const reflectError  = anchor.querySelector('#inspector-reflect-error');

  // ── Populate profile <select> with <optgroup> ───────────────────────────────
  const groups = [
    { label: 'CRC',             types: ['crc']         },
    { label: 'Fletcher',        types: ['fletcher']    },
    { label: 'SHA (Web Crypto)',types: ['sha']          },
    { label: 'Other (extension-only)', types: ['unavailable'] },
  ];

  profileSelect.innerHTML = groups.map(g => {
    const opts = CRC_PROFILES
      .filter(p => g.types.includes(p.type))
      .map(p => `<option value="${p.name}">${p.name}</option>`)
      .join('');
    return `<optgroup label="${g.label}">${opts}</optgroup>`;
  }).join('');
  profileSelect.value = 'CRC-16/CCITT-FALSE';

  function findProfile(name) {
    return CRC_PROFILES.find(p => p.name === name) ?? CRC_PROFILES[0];
  }

  // ── CRC step header ─────────────────────────────────────────────────────────
  function setCRCStepHeader() {
    stepsThead.innerHTML = `<tr>
      <th>Byte Index</th><th>Byte</th>
      <th>State Before</th><th>Table Index</th><th>Table Value</th><th>State After</th>
    </tr>`;
  }

  // ── Fletcher step header ────────────────────────────────────────────────────
  function setFletcherStepHeader() {
    stepsThead.innerHTML = `<tr>
      <th>Byte Index</th><th>Byte</th>
      <th>sum1 Before</th><th>sum2 Before</th><th>sum1 After</th><th>sum2 After</th>
    </tr>`;
  }

  // ── Main computation (async for SHA) ────────────────────────────────────────
  async function recomputeMain() {
    const profile    = findProfile(profileSelect.value);
    const isCRC      = profile.type === 'crc';
    const isFletcher = profile.type === 'fletcher';
    const isSHA      = profile.type === 'sha';

    // Show / hide sections
    sectionInternals.style.display = (isCRC || isFletcher) ? '' : 'none';
    sectionHash.style.display      = (isSHA || profile.type === 'unavailable') ? '' : 'none';
    sectionSteps.style.display     = (isCRC || isFletcher) ? '' : 'none';
    sectionLookup.style.display    = isCRC ? '' : 'none';

    errorBox.textContent = '';

    try {
      const bytes = parseInputBytes(inputMode.value, inputData.value);

      if (isCRC) {
        const r = computeStepsCRC(profile, bytes);

        kvContent.innerHTML = `
          <div>Polynomial (hex)</div>     <div class="inspector-mono">0x${toHex(profile.poly, profile.width)}</div>
          <div>Polynomial (expanded)</div><div class="inspector-mono">${polynomialExpansion(profile.poly, profile.width)}</div>
          <div>Init</div>                 <div class="inspector-mono">0x${toHex(profile.init, profile.width)}</div>
          <div>XOR Out</div>              <div class="inspector-mono">0x${toHex(profile.xorOut, profile.width)}</div>
          <div>RefIn / RefOut</div>       <div class="inspector-mono">${profile.refIn} / ${profile.refOut}</div>
          <div>Input Bytes</div>          <div class="inspector-mono">${bytes.length}</div>
          <div>Pre-final State</div>      <div class="inspector-mono">0x${toHex(r.preFinalState, profile.width)}</div>
          <div>Final CRC</div>            <div class="inspector-mono">0x${toHex(r.finalState, profile.width)}</div>
        `;

        setCRCStepHeader();
        renderStepRowsCRC(stepBody, r.steps, profile.width);
        renderLookupTable(lookupBody, r.table, profile.width);

      } else if (isFletcher) {
        const r = computeStepsFletcher(profile, bytes);
        const halfWidth = profile.width / 2;
        const finalHex  = r.finalValue.toString(16).toUpperCase().padStart(Math.ceil(profile.width / 4), '0');

        kvContent.innerHTML = `
          <div>Width</div>         <div class="inspector-mono">${profile.width} bit</div>
          <div>Modulus</div>       <div class="inspector-mono">${r.modulus}</div>
          <div>Input Bytes</div>   <div class="inspector-mono">${bytes.length}</div>
          <div>sum1 (final)</div>  <div class="inspector-mono">${r.sum1} (0x${r.sum1.toString(16).toUpperCase().padStart(Math.ceil(halfWidth / 4), '0')})</div>
          <div>sum2 (final)</div>  <div class="inspector-mono">${r.sum2} (0x${r.sum2.toString(16).toUpperCase().padStart(Math.ceil(halfWidth / 4), '0')})</div>
          <div>Final Value</div>   <div class="inspector-mono">0x${finalHex}</div>
        `;

        setFletcherStepHeader();
        renderStepRowsFletcher(stepBody, r.steps);

      } else if (isSHA) {
        const hex = await computeSHA(profile.subtleAlgo, bytes);
        const chunked = hex.match(/.{1,32}/g).join('\n');
        hashContent.innerHTML = `
          <div>Algorithm</div>    <div class="inspector-mono">${profile.name} (${profile.width} bit)</div>
          <div>Input Bytes</div>  <div class="inspector-mono">${bytes.length}</div>
          <div>Hash</div>         <div class="inspector-mono" style="word-break:break-all;grid-column:1/-1;margin-top:4px">0x${hex}</div>
        `;

      } else {
        // unavailable
        hashContent.innerHTML = `
          <div style="grid-column:1/-1;padding:8px 0">
            <strong>${profile.name}</strong> (${profile.width} bit) requires WebAssembly and cannot be
            computed directly in the browser inspector.<br>
            The extension calculates it correctly when applied to files in your workspace.
          </div>
        `;
      }

    } catch (error) {
      errorBox.textContent = error instanceof Error ? error.message : String(error);
      kvContent.innerHTML = '';
      hashContent.innerHTML = '';
      stepBody.innerHTML  = '';
      lookupBody.innerHTML = '';
    }
  }

  function recomputeReflection() {
    renderReflection(reflectValue, reflectWidth, reflectBefore, reflectAfter, reflectHex, reflectError);
  }

  // ── Event listeners ─────────────────────────────────────────────────────────
  profileSelect.addEventListener('change', () => {
    const profile = findProfile(profileSelect.value);
    // Keep reflection width in sync for CRC profiles
    if (profile.type === 'crc' || profile.type === 'fletcher') {
      reflectWidth.value = String(Math.min(128, Math.max(1, profile.width)));
      recomputeReflection();
    }
    recomputeMain();
  });
  inputMode.addEventListener('change', recomputeMain);
  inputData.addEventListener('input',  recomputeMain);
  reflectValue.addEventListener('input', recomputeReflection);
  reflectWidth.addEventListener('input', recomputeReflection);

  recomputeMain();
  recomputeReflection();
}

// ─── Guide rendering ──────────────────────────────────────────────────────────

function renderGuide(md) {
  const html = marked.parse(md, { gfm: true, breaks: true });
  const content = document.getElementById('content');
  if (!content) { return; }
  content.innerHTML = html;
  content.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
  initializeInspector(content);
}

window.addEventListener('message', event => {
  const message = event.data;
  if (message.command === 'render') { renderGuide(message.md); }
});