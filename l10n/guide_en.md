# DigestLens User Guide

## 1. Setting Up Checksum Rules

DigestLens uses **glob patterns** and **checksum/hash algorithms** (CRC, Fletcher, MD5/SHA, BLAKE and xxHash) to automatically compute and display values for **files**, **text selection** and **clipboard content**.

### Special Patterns
- `**/*.bin` - Standard glob (file matching)
- `"onselection"` - Live CRC on text selection (min 2 chars)
- `"onclipboard"` - Live CRC on clipboard content (polls every 2s)


### Configuration Location
All rules are configured in your workspace `.vscode/settings.json`:

```json
{
  "digestlens.rules": [
    {
      "pattern": "**/*.bin",
      "algorithm": "CRC-32"
    }
  ]
}
```

### Glob Pattern Examples
| Pattern | Matches |
|---------|---------|
| `**/*.bin` | All `.bin` files recursively |
| `src/**/*.hex` | All `.hex` files in `src/` and subfolders |
| `assets/*.{png,jpg}` | PNG/JPG files in `assets/` |
| `build/*.exe` | EXE files in `build/` |
| `{data,firmware}/*.bin` | BIN files in `data/` or `firmware/` |

**Tip**: Patterns are relative to workspace root. Supported tokens include `**`, `*`, `?`, `{a,b}`, `[abc]`.

## 2. Supported Algorithms

| Algorithm | Width | Main Parameters | Common Use |
|-----------|-------|-----------------|------------|
| **CRC-32** | 32 | `poly=0x04C11DB7`, `init=0xFFFFFFFF`, `refIn/refOut=true`, `xorOut=0xFFFFFFFF` | ZIP, PNG, Ethernet |
| **CRC-32C** | 32 | `poly=0x1EDC6F41`, `init=0xFFFFFFFF`, `refIn/refOut=true`, `xorOut=0xFFFFFFFF` | iSCSI, SCTP |
| **CRC-16/IBM** | 16 | `poly=0x8005`, `init=0x0000`, `refIn/refOut=true`, `xorOut=0x0000` | Modbus, USB |
| **CRC-16/MODBUS** | 16 | `poly=0x8005`, `init=0xFFFF`, `refIn/refOut=true`, `xorOut=0x0000` | Modbus RTU |
| **CRC-16/CCITT-FALSE** | 16 | `poly=0x1021`, `init=0xFFFF`, `refIn/refOut=false`, `xorOut=0x0000` | X.25, V.41 |
| **CRC-8** | 8 | `poly=0x07`, `init=0x00`, `refIn/refOut=false`, `xorOut=0x00` | Generic |
| **CRC-8-CCITT** | 8 | `poly=0x07`, `init=0x00`, `refIn/refOut=false`, `xorOut=0x55` | CCITT |
| **CRC-8/CCITT** | 8 | Alias of `CRC-8-CCITT` | Backward compatibility |
| **Fletcher-8** | 8 | `sum1/sum2` modulo `15` (4-bit words) | Lightweight integrity checks |
| **Fletcher-16** | 16 | `sum1/sum2` modulo `255` (8-bit words) | Embedded protocols |
| **MD5** | 128 | Cryptographic digest | Legacy fingerprinting |
| **SHA1** | 160 | Cryptographic digest | Legacy fingerprinting |
| **SHA256** | 256 | SHA-2 digest | Integrity verification |
| **SHA512** | 512 | SHA-2 digest | Integrity verification |
| **BLAKE2b-512** | 512 | BLAKE2b digest | Fast cryptographic hash |
| **BLAKE2s-256** | 256 | BLAKE2s digest | Fast cryptographic hash |
| **BLAKE3** | 256 | BLAKE3 digest | Very fast modern hash |
| **xxHash32** | 32 | Non-cryptographic digest | Fast checks and indexing |
| **xxHash64** | 64 | Non-cryptographic digest | Fast checks and indexing |

## 3. CRC Inspector Avanzato

Use the integrated inspector to debug CRC internals like DevTools:
- Step-by-step byte processing (state before/after, table index, table value)
- Polynomial expansion (for example `0x1021 -> x^16 + x^12 + x^5 + 1`)
- Pre-generated CRC lookup table
- Real-time bit reflection preview

<div id="crc-inspector-anchor"></div>

## 4. Manual/Custom CRC Configuration

### Custom CRC (Non-Standard Polynomials)
For proprietary/legacy CRC implementations:

```json
{
  "pattern": "firmware/*.bin",
  "algorithm": {
    "name": "LegacyCRC-16",
    "width": 16,
    "poly": "0x18005",
    "init": "0xFFFF",
    "refIn": true,
    "refOut": true, 
    "xorOut": "0x0000"
  }
}
```

### Full Parameter Reference
| Parameter | Description | Range/Example |
|-----------|-------------|---------------|
| `width` | Register bit width | `1-64` |
| `poly` | Generator polynomial | `"0x04C11DB7"`, `0x1021` |
| `init` | Starting register value | `"0xFFFFFFFF"`, `0x0000` |
| `refIn` | Reflect input bytes | `true`/`false` |
| `refOut` | Reflect output bits | `true`/`false` |
| `xorOut` | Final XOR mask | `"0x0000"`, `"0xFFFF"` |

### Parameter Override (Built-in Algorithms)
Override `init` for specific files (CRC/Fletcher only):

```json
{
  "pattern": "special.bin",
  "algorithm": "CRC-32",
  "initialValue": "0x87654321"
}
```

### Display Customization
```json
{
  "pattern": "**/*.bin",
  "algorithm": "xxHash64",
  "display": {
    "uppercase": false   // Lowercase hex
  }
}
```

## 5. Quick Setup

1. In the **DIGEST FILES** section, click the `+` button on the desired file and select *Quick Setup CRC Rule*.
2. Select the desired **algorithm**.
3. The extension automatically adds the new rule to your workspace settings.

## 6. Cache Management

Cache is enabled by default (`.vscode/digestlens.json`):
- Commands: **Clear Cache**, **Cache Statistics**
- Avoid rules that match the cache file

## 7. Troubleshooting

| Issue | Solution |
|-------|----------|
| Wrong checksum | Verify algorithm parameters and file freshness |
| Slow load | Narrow patterns, keep cache enabled |
| Empty tree | Run **DigestLens: Refresh** |

## 8. Commands Reference

- **Copy CRC**: Copy full hex value to clipboard
- **Refresh**: Recompute values
- **CRC Inspector**: Open dedicated CRC Inspector panel
- **Open Rule in Settings**: Jump to matching rule
- **Delete Rule**: Remove matching rule
- **Clear Cache**: Reset persistent cache

**Support**: Report issues via GitHub.

---
*DigestLens v0.1.0*
