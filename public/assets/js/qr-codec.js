/**
 * ISO/IEC 18004 QR Code Generator, Studio Renderer & Multi-Pass Scanner.
 *
 * - Encodes UTF-8 strings (vless://, vmess://, https:// subscriptions) up to
 *   Version 26 (1,367 bytes) with Reed-Solomon GF(256) error correction (L/M).
 * - Renders both "Modern Dots + Brand Shield" and "Classic High-Contrast" QR
 *   matrices onto HTML5 Canvas or raw RGBA buffers.
 * - Decodes QR codes from any RGBA ImageData / Canvas / Screenshot using:
 *     1. Native Chromium BarcodeDetector (when available) + multi-crop passes
 *     2. Pure-JS ISO/IEC 18004 Finder-Pattern locator, perspective grid sampler,
 *        BCH format error correction, Reed-Solomon syndrome decoder & Byte parser.
 */

// ---------------------------------------------------------------------------
// 1. Galois Field GF(2^8) & Reed-Solomon Error Correction (Primitive 0x11D)
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfDiv(a, b) {
  if (b === 0) throw new Error('GF division by zero');
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255];
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsComputeRemainder(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

/**
 * Corrects up to floor(ecLen / 2) byte errors in-place on `codewords`
 * using Berlekamp-Massey + Chien search + Forney algorithm.
 * Returns true if the block is error-free or successfully corrected.
 */
function rsCorrectErrors(codewords, ecLen) {
  const n = codewords.length;
  const syndromes = new Uint8Array(ecLen);
  let hasError = false;
  for (let i = 0; i < ecLen; i++) {
    let s = 0;
    const root = GF_EXP[i];
    for (let j = 0; j < n; j++) {
      s = gfMul(s, root) ^ codewords[j];
    }
    syndromes[i] = s;
    if (s !== 0) hasError = true;
  }
  if (!hasError) return true;

  // Berlekamp-Massey
  let C = new Uint8Array([1]);
  let B = new Uint8Array([1]);
  let L = 0;
  let m = 1;
  let b = 1;

  for (let r = 0; r < ecLen; r++) {
    let d = syndromes[r];
    for (let i = 1; i <= L; i++) {
      if (i < C.length) d ^= gfMul(C[i], syndromes[r - i]);
    }
    if (d === 0) {
      m++;
    } else {
      const T = new Uint8Array(Math.max(C.length, B.length + m));
      T.set(C);
      const scale = gfDiv(d, b);
      for (let i = 0; i < B.length; i++) {
        T[i + m] ^= gfMul(B[i], scale);
      }
      if (2 * L <= r) {
        L = r + 1 - L;
        B = C;
        b = d;
        m = 1;
      } else {
        m++;
      }
      C = T;
    }
  }

  if (L * 2 > ecLen) return false;

  // Chien search for error locations
  const errLocs = [];
  const errRoots = [];
  for (let i = 0; i < n; i++) {
    const xInv = GF_EXP[(255 - i) % 255];
    let sum = 0;
    let xPow = 1;
    for (let j = 0; j < C.length; j++) {
      sum ^= gfMul(C[j], xPow);
      xPow = gfMul(xPow, xInv);
    }
    if (sum === 0) {
      errLocs.push(n - 1 - i);
      errRoots.push(xInv);
    }
  }
  if (errLocs.length !== L) return false;

  // Error evaluator polynomial Omega(x) = S(x) * C(x) mod x^ecLen
  const omega = new Uint8Array(ecLen);
  for (let i = 0; i < ecLen; i++) {
    for (let j = 0; j < C.length && i + j < ecLen; j++) {
      omega[i + j] ^= gfMul(syndromes[i], C[j]);
    }
  }

  // Forney algorithm
  for (let k = 0; k < errLocs.length; k++) {
    const xInv = errRoots[k];
    let num = 0;
    let xPow = 1;
    for (let i = 0; i < ecLen; i++) {
      num ^= gfMul(omega[i], xPow);
      xPow = gfMul(xPow, xInv);
    }
    let den = 0;
    let xInv2 = gfMul(xInv, xInv);
    let dPow = 1;
    for (let i = 1; i < C.length; i += 2) {
      den ^= gfMul(C[i], dPow);
      dPow = gfMul(dPow, xInv2);
    }
    if (den === 0) return false;
    codewords[errLocs[k]] ^= gfDiv(num, den);
  }
  return true;
}

// ---------------------------------------------------------------------------
// 2. ISO/IEC 18004 Version & Error Correction Tables (Versions 1..26)
// ---------------------------------------------------------------------------

// Total codewords per version (1-indexed, v1..v26)
const TOTAL_CODEWORDS = [
  0,
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706,
];

// [ecCodewordsPerBlock, numBlocksGroup1, dataCodewordsGroup1, numBlocksGroup2, dataCodewordsGroup2]
const EC_TABLE = {
  L: [
    null,
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69],
    [20, 4, 81, 0, 0],
    [24, 2, 92, 2, 93],
    [26, 4, 107, 0, 0],
    [30, 3, 115, 1, 116],
    [22, 5, 87, 1, 88],
    [24, 5, 98, 1, 99],
    [28, 1, 107, 5, 108],
    [30, 5, 120, 1, 121],
    [28, 3, 113, 4, 114],
    [28, 3, 107, 5, 108],
    [28, 4, 116, 4, 117],
    [28, 2, 111, 7, 112],
    [30, 4, 121, 5, 122],
    [30, 6, 117, 4, 118],
    [26, 8, 106, 4, 107],
    [28, 10, 114, 2, 115],
  ],
  M: [
    null,
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
    [30, 1, 50, 4, 51],
    [22, 6, 36, 2, 37],
    [22, 8, 37, 1, 38],
    [24, 4, 40, 5, 41],
    [24, 5, 41, 5, 42],
    [28, 7, 45, 3, 46],
    [28, 10, 46, 1, 47],
    [26, 9, 43, 4, 44],
    [26, 3, 44, 11, 45],
    [26, 3, 41, 13, 42],
    [26, 17, 42, 0, 0],
    [28, 17, 46, 0, 0],
    [28, 4, 47, 14, 48],
    [28, 6, 45, 14, 46],
    [28, 8, 47, 13, 48],
    [28, 19, 46, 4, 47],
  ],
  Q: [
    null,
    [13, 1, 13, 0, 0],
    [22, 1, 22, 0, 0],
    [18, 2, 17, 0, 0],
    [26, 2, 24, 0, 0],
    [18, 2, 15, 2, 16],
    [24, 4, 19, 0, 0],
    [18, 2, 14, 4, 15],
    [22, 4, 18, 2, 19],
    [20, 4, 16, 4, 17],
    [24, 6, 19, 2, 20],
    [28, 4, 22, 4, 23],
    [26, 4, 20, 6, 21],
    [24, 8, 20, 4, 21],
    [20, 11, 16, 5, 17],
    [30, 5, 24, 7, 25],
    [24, 15, 19, 2, 20],
    [28, 1, 22, 15, 23],
    [28, 17, 22, 1, 23],
    [26, 17, 21, 4, 22],
    [30, 15, 24, 5, 25],
    [28, 17, 22, 6, 23],
    [30, 7, 24, 16, 25],
    [30, 11, 24, 14, 25],
    [30, 11, 24, 16, 25],
    [30, 7, 24, 22, 25],
    [28, 28, 22, 6, 23],
  ],
  H: [
    null,
    [17, 1, 9, 0, 0],
    [28, 1, 16, 0, 0],
    [22, 2, 13, 0, 0],
    [16, 4, 9, 0, 0],
    [22, 2, 11, 2, 12],
    [28, 4, 15, 0, 0],
    [26, 4, 13, 1, 14],
    [26, 4, 14, 2, 15],
    [24, 4, 12, 4, 13],
    [28, 6, 15, 2, 16],
    [24, 3, 12, 8, 13],
    [28, 7, 14, 4, 15],
    [22, 12, 11, 4, 12],
    [24, 11, 12, 5, 13],
    [24, 11, 12, 7, 13],
    [30, 3, 15, 13, 16],
    [28, 2, 14, 17, 15],
    [28, 2, 14, 19, 15],
    [26, 9, 13, 16, 14],
    [28, 15, 15, 10, 16],
    [30, 19, 16, 6, 17],
    [24, 34, 13, 0, 0],
    [30, 16, 15, 14, 16],
    [30, 30, 16, 2, 17],
    [30, 22, 15, 13, 16],
    [30, 33, 16, 4, 17],
  ],
};

// Alignment pattern center coordinates per version (1..26)
const ALIGNMENT_COORDS = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
];

const EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const FORMAT_BITS_TO_EC = ['M', 'L', 'H', 'Q'];

function computeFormatBits(ecLevel, mask) {
  const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | rem;
}

const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// ---------------------------------------------------------------------------
// 3. QR Code Encoder (ISO/IEC 18004)
// ---------------------------------------------------------------------------

export function encodeQrMatrix(text, preferredEc = 'M') {
  const utf8 = new TextEncoder().encode(String(text || ''));
  let ecLevel = EC_TABLE[preferredEc] ? preferredEc : 'M';
  let version = 0;

  const findVersion = (ec) => {
    const table = EC_TABLE[ec];
    for (let v = 1; v <= 26; v++) {
      const [, g1Blocks, g1Data, g2Blocks, g2Data] = table[v];
      const totalDataBytes = g1Blocks * g1Data + g2Blocks * g2Data;
      const countBits = v <= 9 ? 8 : 16;
      const maxPayload = Math.floor((totalDataBytes * 8 - 4 - countBits) / 8);
      if (utf8.length <= maxPayload) return v;
    }
    return 0;
  };

  version = findVersion(ecLevel);
  if (!version && ecLevel !== 'L') {
    ecLevel = 'L';
    version = findVersion('L');
  }
  if (!version) {
    throw new Error(`Payload too large for QR code (${utf8.length} bytes)`);
  }

  const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = EC_TABLE[ecLevel][version];
  const totalDataBytes = g1Blocks * g1Data + g2Blocks * g2Data;

  // Build bit stream: Mode 0100 (Byte), char count, payload, terminator, pad
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };

  pushBits(0b0100, 4);
  pushBits(utf8.length, version <= 9 ? 8 : 16);
  for (let i = 0; i < utf8.length; i++) pushBits(utf8[i], 8);

  const maxBits = totalDataBytes * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  pushBits(0, termLen);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes = new Uint8Array(totalDataBytes);
  for (let i = 0; i < bits.length / 8; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
    dataBytes[i] = b;
  }
  const pads = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < totalDataBytes; i++, p ^= 1) {
    dataBytes[i] = pads[p];
  }

  // Split into blocks and compute Reed-Solomon EC per block
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < g1Blocks + g2Blocks; b++) {
    const blockLen = b < g1Blocks ? g1Data : g2Data;
    const block = dataBytes.subarray(offset, offset + blockLen);
    offset += blockLen;
    dataBlocks.push(block);
    ecBlocks.push(rsComputeRemainder(block, ecPerBlock));
  }

  // Interleave data codewords then EC codewords
  const interleaved = [];
  const maxDataLen = Math.max(g1Data, g2Data);
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < dataBlocks.length; b++) {
      if (i < dataBlocks[b].length) interleaved.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < ecBlocks.length; b++) {
      interleaved.push(ecBlocks[b][i]);
    }
  }

  // Build base matrix
  const size = 17 + version * 4;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunctionModule = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark ? 1 : 0;
    isFunc[r][c] = 1;
  };

  // Finder patterns + separators
  const drawFinder = (topR, leftC) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = topR + dr;
        const c = leftC + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onRing = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunctionModule(r, c, inOuter && (onRing || inCore));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // Dark module
  setFunctionModule(4 * version + 9, 8, true);

  // Alignment patterns
  const align = ALIGNMENT_COORDS[version];
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const cr = align[i];
      const cc = align[j];
      if (
        (cr <= 8 && cc <= 8) ||
        (cr <= 8 && cc >= size - 8) ||
        (cr >= size - 8 && cc <= 8)
      ) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunctionModule(cr + dr, cc + dc, dark);
        }
      }
    }
  }

  // Reserve Format Information slots
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      isFunc[8][i] = 1;
      isFunc[i][8] = 1;
    }
  }
  for (let i = 0; i < 8; i++) {
    isFunc[8][size - 1 - i] = 1;
    isFunc[size - 1 - i][8] = 1;
  }

  // Write Version Information (for Version >= 7)
  if (version >= 7) {
    const vBits = computeVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vBits >>> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      setFunctionModule(r, c, bit === 1);
      setFunctionModule(c, r, bit === 1);
    }
  }

  // Place data & EC bits in zig-zag order
  let bitIdx = 0;
  const totalBits = interleaved.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!isFunc[r][c]) {
          let dark = 0;
          if (bitIdx < totalBits) {
            dark = (interleaved[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
            bitIdx++;
          }
          modules[r][c] = dark;
        }
      }
    }
  }

  // Write Format Information into a matrix copy
  const writeFormatBits = (mat, mask) => {
    const fBits = computeFormatBits(ecLevel, mask);
    for (let i = 0; i <= 5; i++) mat[8][i] = (fBits >>> i) & 1;
    mat[8][7] = (fBits >>> 6) & 1;
    mat[8][8] = (fBits >>> 7) & 1;
    mat[7][8] = (fBits >>> 8) & 1;
    for (let i = 9; i < 15; i++) mat[14 - i][8] = (fBits >>> i) & 1;

    for (let i = 0; i < 8; i++) mat[8][size - 1 - i] = (fBits >>> i) & 1;
    for (let i = 8; i < 15; i++) mat[size - 15 + i][8] = (fBits >>> i) & 1;
    mat[size - 8][8] = 1;
  };

  // Evaluate mask penalty score
  const scoreMatrix = (mat) => {
    let penalty = 0;
    // Rule 1: 5+ consecutive modules in row/col
    for (let r = 0; r < size; r++) {
      let runColor = mat[r][0];
      let runLen = 1;
      for (let c = 1; c < size; c++) {
        if (mat[r][c] === runColor) {
          runLen++;
          if (runLen === 5) penalty += 3;
          else if (runLen > 5) penalty += 1;
        } else {
          runColor = mat[r][c];
          runLen = 1;
        }
      }
    }
    for (let c = 0; c < size; c++) {
      let runColor = mat[0][c];
      let runLen = 1;
      for (let r = 1; r < size; r++) {
        if (mat[r][c] === runColor) {
          runLen++;
          if (runLen === 5) penalty += 3;
          else if (runLen > 5) penalty += 1;
        } else {
          runColor = mat[r][c];
          runLen = 1;
        }
      }
    }
    // Rule 2: 2x2 blocks
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = mat[r][c];
        if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) {
          penalty += 3;
        }
      }
    }
    return penalty;
  };

  let bestMask = 0;
  let bestScore = Infinity;
  let bestMatrix = null;

  for (let m = 0; m < 8; m++) {
    const candidate = modules.map((row) => new Uint8Array(row));
    const maskFn = MASK_FNS[m];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunc[r][c] && maskFn(r, c)) {
          candidate[r][c] ^= 1;
        }
      }
    }
    writeFormatBits(candidate, m);
    const sc = scoreMatrix(candidate);
    if (sc < bestScore) {
      bestScore = sc;
      bestMask = m;
      bestMatrix = candidate;
    }
  }

  return {
    version,
    size,
    ecLevel,
    mask: bestMask,
    modules: bestMatrix,
    isFunc,
  };
}

// ---------------------------------------------------------------------------
// 4. Studio QR Code Canvas Renderer (Modern Rounded Dots & Classic Crisp)
// ---------------------------------------------------------------------------

let cachedBrandLogoImg = null;
if (typeof Image !== 'undefined') {
  try {
    cachedBrandLogoImg = new Image();
    cachedBrandLogoImg.src = '/assets/logo.png';
  } catch {
    cachedBrandLogoImg = null;
  }
}

function isInFinderEye(r, c, size) {
  return (
    (r < 7 && c < 7) ||
    (r < 7 && c >= size - 7) ||
    (r >= size - 7 && c < 7)
  );
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/**
 * Renders a QR matrix onto an HTML5 Canvas (or offscreen canvas) with either:
 * - `style: 'modern'` (contoured squircle finder eyes, smooth rounded modules,
 *   and optional center brand badge when EC='M')
 * - `style: 'classic'` (razor-sharp ISO square modules)
 */
export function renderQrToCanvas(canvas, text, options = {}) {
  const style = options.style || 'modern';
  let showLogo = options.showLogo !== undefined ? Boolean(options.showLogo) : style === 'modern';
  const ecLevel = showLogo ? 'Q' : options.ecLevel || 'M';
  const qr = encodeQrMatrix(text, ecLevel);
  if (qr.ecLevel !== 'Q' && qr.ecLevel !== 'H') {
    showLogo = false;
  }
  const quiet = 4;
  const totalModules = qr.size + quiet * 2;
  const targetPx = options.sizePx || 340;
  const scale = Math.max(4, Math.floor(targetPx / totalModules));
  const canvasPx = totalModules * scale;

  canvas.width = canvasPx;
  canvas.height = canvasPx;
  const ctx = canvas.getContext('2d');

  // Crisp pure white background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvasPx, canvasPx);

  const darkColor = options.darkColor || '#152028';
  const accentColor = options.accentColor || '#00A896';

  // Optional center logo cutout zone (at most ~13% of area so EC 'M' 15% easily recovers all covered codewords)
  const centerIdx = qr.size / 2;
  const logoRadiusMod = showLogo ? Math.min(3.1, Math.max(2.1, qr.size * 0.068)) : 0;

  const isInLogoZone = (r, c) => {
    if (!showLogo) return false;
    return Math.abs(r + 0.5 - centerIdx) <= logoRadiusMod && Math.abs(c + 0.5 - centerIdx) <= logoRadiusMod;
  };

  if (style === 'classic') {
    ctx.fillStyle = darkColor;
    for (let r = 0; r < qr.size; r++) {
      for (let c = 0; c < qr.size; c++) {
        if (!qr.modules[r][c] || isInLogoZone(r, c)) continue;
        ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
  } else {
    // Draw custom contoured Finder Eyes
    const drawFinderEye = (topR, leftC) => {
      const x = (leftC + quiet) * scale;
      const y = (topR + quiet) * scale;
      const outer = 7 * scale;
      const innerWhite = 5 * scale;
      const core = 3 * scale;

      ctx.fillStyle = darkColor;
      drawRoundedRect(ctx, x, y, outer, outer, scale * 1.85);
      ctx.fill();

      ctx.fillStyle = '#FFFFFF';
      drawRoundedRect(ctx, x + scale, y + scale, innerWhite, innerWhite, scale * 1.25);
      ctx.fill();

      ctx.fillStyle = accentColor;
      drawRoundedRect(ctx, x + scale * 2, y + scale * 2, core, core, scale * 0.85);
      ctx.fill();
    };

    drawFinderEye(0, 0);
    drawFinderEye(0, qr.size - 7);
    drawFinderEye(qr.size - 7, 0);

    // Draw data & non-finder modules with rounded pill/dot geometry that still fills >=86% of each cell for 100% scanner compatibility
    ctx.fillStyle = darkColor;
    const pad = scale * 0.06;
    const modSize = scale - pad * 2;
    const radius = scale * 0.34;

    for (let r = 0; r < qr.size; r++) {
      for (let c = 0; c < qr.size; c++) {
        if (!qr.modules[r][c] || isInFinderEye(r, c, qr.size) || isInLogoZone(r, c)) continue;
        const x = (c + quiet) * scale + pad;
        const y = (r + quiet) * scale + pad;
        drawRoundedRect(ctx, x, y, modSize, modSize, radius);
        ctx.fill();
      }
    }
  }

  if (showLogo) {
    const cx = canvasPx / 2;
    const cy = canvasPx / 2;
    const boxSize = logoRadiusMod * 2 * scale;
    const bx = cx - boxSize / 2;
    const by = cy - boxSize / 2;

    // White quiet cushion
    ctx.fillStyle = '#FFFFFF';
    drawRoundedRect(ctx, bx - scale * 0.45, by - scale * 0.45, boxSize + scale * 0.9, boxSize + scale * 0.9, scale * 1.3);
    ctx.fill();

    if (cachedBrandLogoImg && cachedBrandLogoImg.complete && cachedBrandLogoImg.naturalWidth > 0) {
      const pad = boxSize * 0.06;
      ctx.drawImage(cachedBrandLogoImg, bx + pad, by + pad, boxSize - pad * 2, boxSize - pad * 2);
    } else {
      // Fallback brand tile (for headless Node tests or while image preloads)
      ctx.fillStyle = accentColor;
      drawRoundedRect(ctx, bx, by, boxSize, boxSize, scale * 1.05);
      ctx.fill();

      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = Math.max(1.6, boxSize * 0.075);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const s = boxSize * 0.28;
      ctx.beginPath();
      ctx.moveTo(cx, cy - s);
      ctx.lineTo(cx + s * 0.88, cy - s * 0.52);
      ctx.lineTo(cx + s * 0.88, cy + s * 0.18);
      ctx.quadraticCurveTo(cx + s * 0.88, cy + s * 0.82, cx, cy + s * 1.05);
      ctx.quadraticCurveTo(cx - s * 0.88, cy + s * 0.82, cx - s * 0.88, cy + s * 0.18);
      ctx.lineTo(cx - s * 0.88, cy - s * 0.52);
      ctx.closePath();
      ctx.stroke();
    }
  }

  return qr;
}

// ---------------------------------------------------------------------------
// 5. Pure-JS ISO/IEC 18004 QR Decoder (Works in Browser & Node.js)
// ---------------------------------------------------------------------------

// Precompute all 32 valid 15-bit masked Format Information words
const FORMAT_LOOKUP = [];
for (let ec = 0; ec < 4; ec++) {
  const ecName = FORMAT_BITS_TO_EC[ec];
  for (let mask = 0; mask < 8; mask++) {
    FORMAT_LOOKUP.push({
      bits: computeFormatBits(ecName, mask),
      ecLevel: ecName,
      mask,
    });
  }
}

function popcount15(x) {
  let c = 0;
  let v = x & 0x7fff;
  while (v) {
    v &= v - 1;
    c++;
  }
  return c;
}

function decodeFormatInfo(raw1, raw2) {
  let best = null;
  let bestDist = 4; // Correct up to 3 bit errors
  for (const entry of FORMAT_LOOKUP) {
    const d1 = popcount15(raw1 ^ entry.bits);
    if (d1 < bestDist) {
      bestDist = d1;
      best = entry;
    }
    if (raw2 !== undefined) {
      const d2 = popcount15(raw2 ^ entry.bits);
      if (d2 < bestDist) {
        bestDist = d2;
        best = entry;
      }
    }
  }
  return best;
}

/**
 * Decodes an extracted `size x size` QR module matrix (Uint8Array[] where 1=dark, 0=light)
 * into its UTF-8 string payload. Returns null if invalid.
 */
export function decodeQrMatrix(modules) {
  const size = modules.length;
  if (size < 21 || (size - 17) % 4 !== 0) return null;
  const version = (size - 17) / 4;
  if (version < 1 || version > 26) return null;

  // Read both copies of Format Information
  let f1 = 0;
  for (let i = 0; i <= 5; i++) f1 |= (modules[8][i] & 1) << i;
  f1 |= (modules[8][7] & 1) << 6;
  f1 |= (modules[8][8] & 1) << 7;
  f1 |= (modules[7][8] & 1) << 8;
  for (let i = 9; i < 15; i++) f1 |= (modules[14 - i][8] & 1) << i;

  let f2 = 0;
  for (let i = 0; i < 8; i++) f2 |= (modules[8][size - 1 - i] & 1) << i;
  for (let i = 8; i < 15; i++) f2 |= (modules[size - 15 + i][8] & 1) << i;

  const fmt = decodeFormatInfo(f1, f2);
  if (!fmt) return null;

  const { ecLevel, mask } = fmt;
  const ecInfo = EC_TABLE[ecLevel]?.[version];
  if (!ecInfo) return null;

  // Build function-module mask for this version
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size));
  const markBox = (r0, c0, h, w) => {
    for (let r = r0; r < r0 + h; r++) {
      for (let c = c0; c < c0 + w; c++) {
        if (r >= 0 && r < size && c >= 0 && c < size) isFunc[r][c] = 1;
      }
    }
  };
  markBox(0, 0, 9, 9);
  markBox(0, size - 8, 9, 8);
  markBox(size - 8, 0, 8, 9);
  for (let i = 8; i < size - 8; i++) {
    isFunc[6][i] = 1;
    isFunc[i][6] = 1;
  }
  const align = ALIGNMENT_COORDS[version];
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const cr = align[i];
      const cc = align[j];
      if (
        (cr <= 8 && cc <= 8) ||
        (cr <= 8 && cc >= size - 8) ||
        (cr >= size - 8 && cc <= 8)
      ) {
        continue;
      }
      markBox(cr - 2, cc - 2, 5, 5);
    }
  }
  if (version >= 7) {
    markBox(0, size - 11, 6, 3);
    markBox(size - 11, 0, 3, 6);
  }

  // Read and unmask codewords in zig-zag order
  const maskFn = MASK_FNS[mask];
  const totalCodewords = TOTAL_CODEWORDS[version];
  const rawCodewords = new Uint8Array(totalCodewords);
  let byteIdx = 0;
  let bitAcc = 0;
  let bitCount = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!isFunc[r][c]) {
          const bit = (modules[r][c] & 1) ^ (maskFn(r, c) ? 1 : 0);
          bitAcc = (bitAcc << 1) | bit;
          bitCount++;
          if (bitCount === 8) {
            if (byteIdx < totalCodewords) rawCodewords[byteIdx++] = bitAcc;
            bitAcc = 0;
            bitCount = 0;
          }
        }
      }
    }
  }

  // De-interleave into blocks & run Reed-Solomon error correction
  const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = ecInfo;
  const numBlocks = g1Blocks + g2Blocks;
  const blocks = [];
  for (let b = 0; b < numBlocks; b++) {
    const dataLen = b < g1Blocks ? g1Data : g2Data;
    blocks.push({ dataLen, codewords: new Uint8Array(dataLen + ecPerBlock) });
  }

  let cwIdx = 0;
  const maxDataLen = Math.max(g1Data, g2Data);
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < blocks[b].dataLen && cwIdx < rawCodewords.length) {
        blocks[b].codewords[i] = rawCodewords[cwIdx++];
      }
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (cwIdx < rawCodewords.length) {
        blocks[b].codewords[blocks[b].dataLen + i] = rawCodewords[cwIdx++];
      }
    }
  }

  const dataStream = [];
  for (let b = 0; b < numBlocks; b++) {
    const blk = blocks[b];
    if (!rsCorrectErrors(blk.codewords, ecPerBlock)) return null;
    for (let i = 0; i < blk.dataLen; i++) dataStream.push(blk.codewords[i]);
  }

  // Parse QR data segments (Byte mode 0100, Alphanumeric 0010, Numeric 0001, ECI 0111)
  let bitPos = 0;
  const readBits = (n) => {
    let val = 0;
    for (let i = 0; i < n; i++) {
      const bIdx = bitPos >>> 3;
      if (bIdx >= dataStream.length) return 0;
      val = (val << 1) | ((dataStream[bIdx] >>> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return val;
  };

  const outBytes = [];
  const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

  while (bitPos + 4 <= dataStream.length * 8) {
    const mode = readBits(4);
    if (mode === 0) break; // Terminator
    if (mode === 0b0111) {
      // ECI assignment value
      const b1 = readBits(8);
      if ((b1 & 0x80) !== 0) {
        readBits(8);
        if ((b1 & 0xc0) === 0xc0) readBits(8);
      }
      continue;
    }
    if (mode === 0b0100) {
      // Byte mode
      const count = readBits(version <= 9 ? 8 : 16);
      for (let i = 0; i < count; i++) outBytes.push(readBits(8));
    } else if (mode === 0b0010) {
      // Alphanumeric mode
      const count = readBits(version <= 9 ? 9 : 11);
      let rem = count;
      while (rem >= 2) {
        const v = readBits(11);
        outBytes.push(ALNUM.charCodeAt(Math.floor(v / 45)));
        outBytes.push(ALNUM.charCodeAt(v % 45));
        rem -= 2;
      }
      if (rem === 1) outBytes.push(ALNUM.charCodeAt(readBits(6)));
    } else if (mode === 0b0001) {
      // Numeric mode
      const count = readBits(version <= 9 ? 10 : version <= 26 ? 12 : 14);
      let rem = count;
      while (rem >= 3) {
        const s = String(readBits(10)).padStart(3, '0');
        for (let i = 0; i < 3; i++) outBytes.push(s.charCodeAt(i));
        rem -= 3;
      }
      if (rem === 2) {
        const s = String(readBits(7)).padStart(2, '0');
        outBytes.push(s.charCodeAt(0), s.charCodeAt(1));
      } else if (rem === 1) {
        outBytes.push(String(readBits(4)).charCodeAt(0));
      }
    } else {
      break;
    }
  }

  if (!outBytes.length) return null;
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(outBytes));
}

// ---------------------------------------------------------------------------
// 6. Image Binarizer, Finder-Pattern Locator & Grid Sampler
// ---------------------------------------------------------------------------

function binarizeImageData(imageData, invert = false) {
  const { width, height, data } = imageData;
  const luma = new Uint8Array(width * height);
  const integral = new Int32Array((width + 1) * (height + 1));

  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const yOff = y * width;
    const iOff = (y + 1) * (width + 1);
    const prevOff = y * (width + 1);
    for (let x = 0; x < width; x++) {
      const p = (yOff + x) * 4;
      const a = data[p + 3];
      const r = a < 128 ? 255 : data[p];
      const g = a < 128 ? 255 : data[p + 1];
      const b = a < 128 ? 255 : data[p + 2];
      const yVal = (r * 77 + g * 150 + b * 29) >>> 8;
      const v = invert ? 255 - yVal : yVal;
      luma[yOff + x] = v;
      rowSum += v;
      integral[iOff + x + 1] = integral[prevOff + x + 1] + rowSum;
    }
  }

  const bin = new Uint8Array(width * height);
  const win = Math.max(12, Math.floor(Math.min(width, height) / 16));
  const half = win >>> 1;

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(height, y + half);
    const r0 = y0 * (width + 1);
    const r1 = y1 * (width + 1);
    const yOff = y * width;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(width, x + half);
      const count = (x1 - x0) * (y1 - y0);
      const sum = integral[r1 + x1] - integral[r0 + x1] - integral[r1 + x0] + integral[r0 + x0];
      const mean = sum / count;
      bin[yOff + x] = luma[yOff + x] < mean - 7 ? 1 : 0;
    }
  }
  return bin;
}

function isFinderRatio(counts) {
  const total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
  if (total < 7) return false;
  const mod = total / 7;
  const tol = mod * 0.72;
  return (
    Math.abs(mod - counts[0]) < tol &&
    Math.abs(mod - counts[1]) < tol &&
    Math.abs(3 * mod - counts[2]) < 3 * tol &&
    Math.abs(mod - counts[3]) < tol &&
    Math.abs(mod - counts[4]) < tol
  );
}

function crossCheckVertical(bin, width, height, startY, centerX, maxCount, totalH) {
  const counts = [0, 0, 0, 0, 0];
  let y = startY;
  while (y >= 0 && bin[y * width + centerX]) {
    counts[2]++;
    y--;
  }
  if (y < 0) return null;
  while (y >= 0 && !bin[y * width + centerX] && counts[1] <= maxCount) {
    counts[1]++;
    y--;
  }
  if (y < 0 || counts[1] > maxCount) return null;
  while (y >= 0 && bin[y * width + centerX] && counts[0] <= maxCount) {
    counts[0]++;
    y--;
  }
  if (counts[0] > maxCount) return null;

  y = startY + 1;
  while (y < height && bin[y * width + centerX]) {
    counts[2]++;
    y++;
  }
  if (y >= height) return null;
  while (y < height && !bin[y * width + centerX] && counts[3] <= maxCount) {
    counts[3]++;
    y++;
  }
  if (y >= height || counts[3] > maxCount) return null;
  while (y < height && bin[y * width + centerX] && counts[4] <= maxCount) {
    counts[4]++;
    y++;
  }
  if (counts[4] > maxCount) return null;

  const totalV = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
  if (Math.abs(totalV - totalH) * 5 >= totalH * 2) return null;
  if (!isFinderRatio(counts)) return null;
  return y - counts[4] - counts[3] - counts[2] / 2;
}

function crossCheckHorizontal(bin, width, centerY, startX, maxCount, totalV) {
  const counts = [0, 0, 0, 0, 0];
  const rowOff = Math.round(centerY) * width;
  let x = startX;
  while (x >= 0 && bin[rowOff + x]) {
    counts[2]++;
    x--;
  }
  if (x < 0) return null;
  while (x >= 0 && !bin[rowOff + x] && counts[1] <= maxCount) {
    counts[1]++;
    x--;
  }
  if (x < 0 || counts[1] > maxCount) return null;
  while (x >= 0 && bin[rowOff + x] && counts[0] <= maxCount) {
    counts[0]++;
    x--;
  }
  if (counts[0] > maxCount) return null;

  x = startX + 1;
  while (x < width && bin[rowOff + x]) {
    counts[2]++;
    x++;
  }
  if (x >= width) return null;
  while (x < width && !bin[rowOff + x] && counts[3] <= maxCount) {
    counts[3]++;
    x++;
  }
  if (x >= width || counts[3] > maxCount) return null;
  while (x < width && bin[rowOff + x] && counts[4] <= maxCount) {
    counts[4]++;
    x++;
  }
  if (counts[4] > maxCount) return null;

  const totalH = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
  if (Math.abs(totalH - totalV) * 5 >= totalV * 2) return null;
  if (!isFinderRatio(counts)) return null;
  return {
    cx: x - counts[4] - counts[3] - counts[2] / 2,
    modSize: (totalH + totalV) / 14,
  };
}

function findFinderPatterns(bin, width, height) {
  const centers = [];

  const handleCandidate = (counts, row, endX) => {
    const total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
    const cxInit = Math.round(endX - counts[4] - counts[3] - counts[2] / 2);
    if (cxInit < 0 || cxInit >= width) return;
    const cy = crossCheckVertical(bin, width, height, row, cxInit, counts[2], total);
    if (cy === null) return;
    const hCheck = crossCheckHorizontal(bin, width, cy, cxInit, counts[2], total);
    if (!hCheck) return;
    const { cx, modSize } = hCheck;

    for (let i = 0; i < centers.length; i++) {
      const c = centers[i];
      const dist = Math.hypot(cx - c.x, cy - c.y);
      if (dist <= Math.max(modSize, c.modSize) * 2.5) {
        const w = c.count + 1;
        c.x = (c.x * c.count + cx) / w;
        c.y = (c.y * c.count + cy) / w;
        c.modSize = (c.modSize * c.count + modSize) / w;
        c.count = w;
        return;
      }
    }
    centers.push({ x: cx, y: cy, modSize, count: 1 });
  };

  for (let y = 0; y < height; y++) {
    const counts = [0, 0, 0, 0, 0];
    let state = 0;
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      if (bin[rowOff + x]) {
        if ((state & 1) === 1) state++;
        counts[state]++;
      } else {
        if ((state & 1) === 1) {
          counts[state]++;
        } else if (state === 4) {
          if (isFinderRatio(counts)) {
            handleCandidate(counts, y, x);
          }
          counts[0] = counts[2];
          counts[1] = counts[3];
          counts[2] = counts[4];
          counts[3] = 1;
          counts[4] = 0;
          state = 3;
        } else {
          state++;
          counts[state]++;
        }
      }
    }
    if (state === 4 && isFinderRatio(counts)) {
      handleCandidate(counts, y, width);
    }
  }

  return centers.sort((a, b) => b.count - a.count);
}

/**
 * Selects the best 3 finder pattern centers forming an isosceles right triangle
 * and orders them as [TopLeft, TopRight, BottomLeft].
 */
function selectFinderTriplets(centers) {
  const top = centers.slice(0, 18);
  const triplets = [];

  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      for (let k = j + 1; k < top.length; k++) {
        const pts = [top[i], top[j], top[k]];
        const avgMod = (pts[0].modSize + pts[1].modSize + pts[2].modSize) / 3;
        if (
          Math.abs(pts[0].modSize - avgMod) > avgMod * 0.5 ||
          Math.abs(pts[1].modSize - avgMod) > avgMod * 0.5 ||
          Math.abs(pts[2].modSize - avgMod) > avgMod * 0.5
        ) {
          continue;
        }
        const d01 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const d12 = Math.hypot(pts[1].x - pts[2].x, pts[1].y - pts[2].y);
        const d02 = Math.hypot(pts[0].x - pts[2].x, pts[0].y - pts[2].y);

        // Identify the hypotenuse (between TR and BL); the opposite vertex is TL
        let tl, pA, pB, side1, side2, hyp;
        if (d01 >= d12 && d01 >= d02) {
          tl = pts[2]; pA = pts[0]; pB = pts[1]; side1 = d02; side2 = d12; hyp = d01;
        } else if (d12 >= d01 && d12 >= d02) {
          tl = pts[0]; pA = pts[1]; pB = pts[2]; side1 = d01; side2 = d02; hyp = d12;
        } else {
          tl = pts[1]; pA = pts[0]; pB = pts[2]; side1 = d01; side2 = d12; hyp = d02;
        }

        if (side1 < avgMod * 10 || Math.abs(side1 - side2) > Math.max(side1, side2) * 0.25) continue;
        const expectedHyp = Math.hypot(side1, side2);
        if (Math.abs(hyp - expectedHyp) > expectedHyp * 0.22) continue;

        // Cross product determines which of pA/pB is Top-Right vs Bottom-Left
        const cross = (pA.x - tl.x) * (pB.y - tl.y) - (pA.y - tl.y) * (pB.x - tl.x);
        const tr = cross > 0 ? pA : pB;
        const bl = cross > 0 ? pB : pA;

        const score =
          Math.abs(side1 - side2) / avgMod +
          Math.abs(hyp - expectedHyp) / avgMod -
          (tl.count + tr.count + bl.count) * 0.2;

        triplets.push({ tl, tr, bl, avgMod, side1, side2, score });
      }
    }
  }

  return triplets.sort((a, b) => a.score - b.score);
}

function sampleGridAndDecode(bin, width, height, triplet) {
  const { tl, tr, bl } = triplet;
  const distX = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const distY = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const estMod = (triplet.avgMod + (distX + distY) / 2 / 14) / 2;
  const rawDim = Math.round(((distX + distY) / 2) / ((distX + distY) / 2 / ((distX + distY) / (2 * triplet.avgMod)))) + 7;
  const approxDim = Math.round(((distX + distY) / 2) / triplet.avgMod) + 7;

  // Test nearest valid QR dimensions (4*v + 17)
  const baseV = Math.max(1, Math.min(26, Math.round((approxDim - 17) / 4)));
  const candidateVersions = [];
  for (let dv = 0; dv <= 3; dv++) {
    if (baseV + dv <= 26) candidateVersions.push(baseV + dv);
    if (dv > 0 && baseV - dv >= 1) candidateVersions.push(baseV - dv);
  }
  void rawDim;
  void estMod;

  for (const v of candidateVersions) {
    const dim = 17 + 4 * v;
    const span = dim - 7; // Finder centers are at 3.5 and dim - 3.5 -> distance = dim - 7
    const ux = (tr.x - tl.x) / span;
    const uy = (tr.y - tl.y) / span;
    const vx = (bl.x - tl.x) / span;
    const vy = (bl.y - tl.y) / span;

    const modules = Array.from({ length: dim }, () => new Uint8Array(dim));
    for (let r = 0; r < dim; r++) {
      const dr = r - 3;
      for (let c = 0; c < dim; c++) {
        const dc = c - 3;
        const px = Math.round(tl.x + dc * ux + dr * vx);
        const py = Math.round(tl.y + dc * uy + dr * vy);
        if (px >= 0 && px < width && py >= 0 && py < height) {
          // 5-point majority vote around module center for resilience against rounded dots
          let votes = bin[py * width + px] ? 2 : 0;
          const step = Math.max(1, Math.round(Math.hypot(ux, uy) * 0.18));
          if (px - step >= 0 && bin[py * width + (px - step)]) votes++;
          if (px + step < width && bin[py * width + (px + step)]) votes++;
          if (py - step >= 0 && bin[(py - step) * width + px]) votes++;
          if (py + step < height && bin[(py + step) * width + px]) votes++;
          modules[r][c] = votes >= 3 ? 1 : 0;
        }
      }
    }

    const decoded = decodeQrMatrix(modules);
    if (decoded) return decoded;
  }

  return null;
}

/**
 * Pure-JS QR code decoder from an RGBA `{ width, height, data }` ImageData object.
 * Also returns candidate bounding boxes if a full-screen screenshot contains small QR codes.
 */
export function decodeQrFromImageData(imageData) {
  for (const invert of [false, true]) {
    const bin = binarizeImageData(imageData, invert);
    const centers = findFinderPatterns(bin, imageData.width, imageData.height);
    const triplets = selectFinderTriplets(centers);
    for (let i = 0; i < Math.min(8, triplets.length); i++) {
      const text = sampleGridAndDecode(bin, imageData.width, imageData.height, triplets[i]);
      if (text) return { text, triplet: triplets[i] };
    }
  }
  return null;
}

/**
 * Locates candidate QR bounding boxes in a large screenshot so the scanner can
 * automatically crop and zoom into small QR codes on a 1080p/1440p monitor.
 */
export function findCandidateQrRegions(imageData) {
  const bin = binarizeImageData(imageData, false);
  const centers = findFinderPatterns(bin, imageData.width, imageData.height);
  const triplets = selectFinderTriplets(centers);
  const regions = [];

  for (const t of triplets.slice(0, 5)) {
    const pad = t.avgMod * 8;
    const brX = t.tr.x + t.bl.x - t.tl.x;
    const brY = t.tr.y + t.bl.y - t.tl.y;
    const minX = Math.max(0, Math.floor(Math.min(t.tl.x, t.tr.x, t.bl.x, brX) - pad));
    const minY = Math.max(0, Math.floor(Math.min(t.tl.y, t.tr.y, t.bl.y, brY) - pad));
    const maxX = Math.min(imageData.width, Math.ceil(Math.max(t.tl.x, t.tr.x, t.bl.x, brX) + pad));
    const maxY = Math.min(imageData.height, Math.ceil(Math.max(t.tl.y, t.tr.y, t.bl.y, brY) + pad));
    const w = maxX - minX;
    const h = maxY - minY;
    if (w >= 32 && h >= 32) {
      regions.push({ x: minX, y: minY, width: w, height: h });
    }
  }
  return regions;
}

/**
 * High-level browser QR scanner: runs native BarcodeDetector + multi-crop + pure-JS
 * ISO/IEC 18004 decoder on any HTMLCanvasElement or HTMLImageElement.
 */
export async function scanQrFromCanvas(sourceCanvas) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  if (!w || !h) return null;

  const hasDetector = typeof window !== 'undefined' && 'BarcodeDetector' in window;
  let detector = null;
  if (hasDetector) {
    try {
      detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    } catch {
      detector = null;
    }
  }

  // 1. Direct native BarcodeDetector pass on full canvas
  if (detector) {
    try {
      const codes = await detector.detect(sourceCanvas);
      if (codes?.length && codes[0].rawValue) {
        return {
          text: codes[0].rawValue.trim(),
          bounds: codes[0].boundingBox || null,
        };
      }
    } catch {
      /* fallback */
    }
  }

  // 2. Direct Pure-JS pass on full canvas (scaled to <= 1200px for speed)
  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const fullData = ctx.getImageData(0, 0, w, h);
  const direct = decodeQrFromImageData(fullData);
  if (direct?.text) {
    return { text: direct.text.trim(), bounds: null };
  }

  // 3. Candidate region zoom-crop pass (critical when scanning a small QR on a 1920x1080 desktop screenshot)
  const regions = findCandidateQrRegions(fullData);
  // Also add 3x3 overlapping grid crops if the screenshot is large
  if (w >= 700 || h >= 500) {
    const cols = 3;
    const rows = 2;
    const cw = Math.floor(w * 0.52);
    const ch = Math.floor(h * 0.62);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        regions.push({
          x: Math.floor((c * (w - cw)) / Math.max(1, cols - 1)),
          y: Math.floor((r * (h - ch)) / Math.max(1, rows - 1)),
          width: cw,
          height: ch,
        });
      }
    }
  }

  const cropCanvas = document.createElement('canvas');
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });

  for (const reg of regions) {
    const scale = reg.width < 320 ? 2 : 1;
    cropCanvas.width = reg.width * scale;
    cropCanvas.height = reg.height * scale;
    cropCtx.imageSmoothingEnabled = false;
    cropCtx.drawImage(sourceCanvas, reg.x, reg.y, reg.width, reg.height, 0, 0, cropCanvas.width, cropCanvas.height);

    if (detector) {
      try {
        const codes = await detector.detect(cropCanvas);
        if (codes?.length && codes[0].rawValue) {
          return { text: codes[0].rawValue.trim(), bounds: reg };
        }
      } catch {
        /* fallback */
      }
    }

    const subData = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
    const subRes = decodeQrFromImageData(subData);
    if (subRes?.text) {
      return { text: subRes.text.trim(), bounds: reg };
    }
  }

  return null;
}
