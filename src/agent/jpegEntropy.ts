/**
 * jpegEntropy.ts — the front half of the JPEG decoder: markers, tables, huffman, entropy.
 *
 * It stops at **quantized coefficients**: nothing here knows what an image looks like.
 * That is the seam the split is built on — this half is bit-exact and checkable against
 * the byte stream, the other half (`jpegReconstruct.ts`) is the maths that turns
 * coefficients into pixels, and each can be verified on its own.
 *
 * Scope, deliberately: **baseline sequential** (`SOF0`), 8-bit precision, restart markers
 * (`DRI`/`RSTn`), 1 or 3 components. Progressive, 12-bit and arithmetic-coded files are
 * refused with a reason — the caller then passes the original bytes through rather than
 * guessing (`docs/agents/plans/image-budget.md`).
 *
 * Pure, `vscode`-free, no `crypto`.
 */

/** One component as the frame header declares it. */
export interface JpegComponent {
  id: number;
  /** Horizontal / vertical sampling factors (1–4). */
  h: number;
  v: number;
  /** Which of the four quantization tables this component uses. */
  quantTable: number;
}

/** Everything the reconstruction half needs, and nothing it does not. */
export interface JpegCoefficients {
  width: number;
  height: number;
  /** Sampling factors of the frame, and per component. */
  maxH: number;
  maxV: number;
  components: JpegComponent[];
  /** Up to four quantization tables, each 64 entries in **natural** (de-zigzagged) order. */
  quantTables: Array<Uint16Array | null>;
  /**
   * Per component, in frame order: one 64-entry block per 8×8 square of that component's
   * own plane, raster order, coefficients **still quantized** and de-zigzagged.
   */
  planes: Int16Array[];
  /** Blocks per line of the component's plane (the reconstruction half re-derives sizes). */
  blockCols: number[];
  blockRows: number[];
}

export interface JpegEntropyFailure {
  error: string;
}

/* ------------------------------------------------------------------ markers */

const MARKER_SOI = 0xd8;
const MARKER_EOI = 0xd9;
const MARKER_SOS = 0xda;
const MARKER_DQT = 0xdb;
const MARKER_DHT = 0xc4;
const MARKER_DRI = 0xdd;
const MARKER_SOF0 = 0xc0;

/** How a refused SOF marker is named in the reason, so the model knows what it has. */
const SOF_NAMES: Record<number, string | undefined> = {
  0xc0: 'baseline sequential (SOF0)',
  0xc1: 'extended sequential (SOF1)',
  0xc2: 'progressive (SOF2)',
  0xc3: 'lossless (SOF3)',
  0xc5: 'differential sequential (SOF5)',
  0xc6: 'differential progressive (SOF6)',
  0xc7: 'differential lossless (SOF7)',
  0xc9: 'arithmetic extended sequential (SOF9)',
  0xca: 'arithmetic progressive (SOF10)',
  0xcb: 'arithmetic lossless (SOF11)',
  0xcd: 'differential arithmetic sequential (SOF13)',
  0xce: 'differential arithmetic progressive (SOF14)',
  0xcf: 'differential arithmetic lossless (SOF15)',
};

/** RSTn, else the marker as 0xFFxx — the shape a log line and a reason both want. */
function markerName(marker: number): string {
  if (marker >= 0xd0 && marker <= 0xd7) return `RST${marker - 0xd0}`;
  return `0xFF${marker.toString(16).toUpperCase().padStart(2, '0')}`;
}

/*
 * How many 8x8 blocks of coefficients one file may claim — about 128 MiB of Int16Array.
 * A frame header is 20 bytes and can ask for 65535x65535 samples, so a lying (or merely
 * absurd) header must be refused *before* the planes are allocated: this runs on the
 * extension host's own thread, where a multi-gigabyte allocation is a hang. The ceiling is
 * far past anything the transform will ever upload, so a refusal costs nothing but the
 * pass-through it would have taken anyway.
 */
const MAX_FRAME_BLOCKS = 1 << 20;

/** Zigzag order: position i in the file's scan is natural coefficient ZIGZAG[i]. */
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
  52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/**
 * Walk the marker segments and entropy-decode every scan. Returns a reason instead of
 * throwing for an unsupported or damaged file.
 *
 * The result is all-or-nothing by design: a half-filled plane would let the other half
 * paint pixels that look real, and a caller cannot tell those from a correct decode — so a
 * failure anywhere is a refusal of the whole file, never a partial coefficient set.
 * Coefficients come back de-zigzagged, once, at the only place that knows the file's scan
 * order; after this seam nothing needs to.
 */
export function decodeJpegEntropy(bytes: Uint8Array): JpegCoefficients | JpegEntropyFailure {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== MARKER_SOI) {
    return { error: 'JPEG: the data does not begin with the SOI marker (0xFFD8) — not a JPEG file' };
  }

  const quantTables: Array<Uint16Array | null> = [null, null, null, null];
  const dcTables: Array<HuffTable | null> = [null, null, null, null];
  const acTables: Array<HuffTable | null> = [null, null, null, null];

  let frame: Frame | null = null;
  let planes: Int16Array[] | null = null;
  let restartInterval = 0;
  let scans = 0;
  let eoi = false;
  let pos = 2;

  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) {
      return {
        error: `JPEG: expected a marker at byte ${pos}, found 0x${bytes[pos].toString(16).padStart(2, '0')} — the segments do not line up`,
      };
    }
    // A marker may be preceded by any number of extra 0xFF bytes.
    while (pos < bytes.length && bytes[pos] === 0xff) pos++;
    if (pos >= bytes.length) {
      return { error: 'JPEG: the file ends on a 0xFF fill byte (truncated)' };
    }
    const marker = bytes[pos++];
    if (marker === 0x00) {
      return {
        error: `JPEG: a stray 0xFF 0x00 pair at byte ${pos - 2} — outside a scan that is not a marker`,
      };
    }
    if (marker === MARKER_EOI) {
      eoi = true;
      break;
    }
    if (marker === MARKER_SOI) {
      return { error: 'JPEG: a second SOI marker appears in the middle of the file' };
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      return { error: `JPEG: ${markerName(marker)} appears outside an entropy-coded scan` };
    }
    if (marker === 0x01) continue; // TEM: a standalone marker with no payload.
    // Every other marker carries a two-byte length that counts those two bytes.
    if (pos + 2 > bytes.length) {
      return {
        error: `JPEG: marker ${markerName(marker)} at byte ${pos - 2} has no length field (truncated)`,
      };
    }
    const length = (bytes[pos] << 8) | bytes[pos + 1];
    if (length < 2 || pos + length > bytes.length) {
      return {
        error: `JPEG: marker ${markerName(marker)} at byte ${pos - 2} claims ${length} bytes past the end of the file (truncated or damaged)`,
      };
    }
    const start = pos + 2;
    const end = pos + length;
    let next = end;

    switch (marker) {
      case MARKER_DQT: {
        const failure = readQuantTables(bytes, start, end, quantTables);
        if (failure !== undefined) return failure;
        break;
      }
      case MARKER_DHT: {
        const failure = readHuffmanTables(bytes, start, end, dcTables, acTables);
        if (failure !== undefined) return failure;
        break;
      }
      case MARKER_DRI: {
        if (length !== 4) {
          return { error: `JPEG: the DRI segment must be 4 bytes long, not ${length}` };
        }
        restartInterval = (bytes[start] << 8) | bytes[start + 1];
        break;
      }
      case MARKER_SOF0: {
        if (frame !== null) {
          return { error: 'JPEG: a second SOF0 frame header' };
        }
        const parsed = readFrame(bytes, start, end);
        if ('error' in parsed) return parsed;
        frame = parsed.frame;
        planes = parsed.planes;
        break;
      }
      case MARKER_SOS: {
        if (frame === null || planes === null) {
          return { error: 'JPEG: a scan (SOS) appears before the frame header (SOF0)' };
        }
        scans++;
        if (scans > 1) {
          return {
            error: 'JPEG: a second scan (SOS) — sequential multi-scan and progressive files are not supported',
          };
        }
        const header = readScanHeader(bytes, start, end, frame);
        if ('error' in header) return header;
        for (const component of frame.components) {
          if (quantTables[component.quantTable] === null) {
            return {
              error: `JPEG: component ${component.id} uses quantization table ${component.quantTable}, which no DQT segment defined`,
            };
          }
        }
        const outcome = decodeScan(
          { bytes, frame, planes, dcTables, acTables },
          header.order,
          end,
          restartInterval,
        );
        if ('error' in outcome) return outcome;
        next = outcome.next;
        break;
      }
      default: {
        // APPn and COM carry metadata only: colour profiles, thumbnails, EXIF. The pixels
        // do not need them, so they are stepped over rather than interpreted.
        if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) break;
        const sof = SOF_NAMES[marker];
        if (sof !== undefined) {
          return {
            error: `JPEG: ${sof} files are not supported — only baseline sequential (SOF0), 8-bit precision, is decoded`,
          };
        }
        if (marker === 0xcc) {
          return { error: 'JPEG: arithmetic coding (DAC) is not supported' };
        }
        if (marker === 0xdc) {
          return { error: 'JPEG: a DNL segment (number of lines) is not supported' };
        }
        if (marker === 0xde || marker === 0xdf) {
          return {
            error: `JPEG: ${marker === 0xde ? 'hierarchical (DHP)' : 'EXP'} files are not supported`,
          };
        }
        return {
          error: `JPEG: marker ${markerName(marker)} at byte ${pos - 2} is not one this decoder handles`,
        };
      }
    }
    pos = next;
  }

  if (frame === null || planes === null) {
    return { error: 'JPEG: the file has no SOF0 frame header (missing SOF0)' };
  }
  if (scans === 0) {
    return { error: 'JPEG: the file has no scan (missing SOS)' };
  }
  if (!eoi) {
    return { error: 'JPEG: the file ends without an EOI marker (truncated)' };
  }
  return {
    width: frame.width,
    height: frame.height,
    maxH: frame.maxH,
    maxV: frame.maxV,
    components: frame.components,
    quantTables,
    planes,
    blockCols: frame.blockCols,
    blockRows: frame.blockRows,
  };
}

/* ------------------------------------------------------------- frame header */

/** A parsed SOF0, with the two derived block grids the planes are cut into. */
interface Frame {
  width: number;
  height: number;
  maxH: number;
  maxV: number;
  components: JpegComponent[];
  blockCols: number[];
  blockRows: number[];
}

interface FrameParse {
  frame: Frame;
  planes: Int16Array[];
}

function readFrame(bytes: Uint8Array, start: number, end: number): FrameParse | JpegEntropyFailure {
  if (end - start < 6) {
    return { error: 'JPEG: the SOF0 segment is too short for a frame header (truncated)' };
  }
  const precision = bytes[start];
  const height = (bytes[start + 1] << 8) | bytes[start + 2];
  const width = (bytes[start + 3] << 8) | bytes[start + 4];
  const count = bytes[start + 5];
  if (precision !== 8) {
    return { error: `JPEG: ${precision}-bit sample precision is not supported (only 8-bit baseline)` };
  }
  if (end - start !== 6 + count * 3) {
    return {
      error: `JPEG: the SOF0 segment does not fit its ${count} component descriptors (truncated or damaged)`,
    };
  }
  if (count !== 1 && count !== 3) {
    return {
      error: `JPEG: a frame with ${count} components is not supported (only 1 grayscale or 3 YCbCr)`,
    };
  }
  if (width === 0 || height === 0) {
    return { error: `JPEG: the frame is ${width}x${height} — a zero-sized image is not decodable` };
  }

  const components: JpegComponent[] = [];
  let maxH = 0;
  let maxV = 0;
  for (let i = 0; i < count; i++) {
    const at = start + 6 + i * 3;
    const id = bytes[at];
    const h = bytes[at + 1] >> 4;
    const v = bytes[at + 1] & 15;
    const quantTable = bytes[at + 2];
    if (h < 1 || h > 4 || v < 1 || v > 4) {
      return { error: `JPEG: component ${id} declares sampling factors ${h}x${v} (only 1–4 are valid)` };
    }
    if (quantTable > 3) {
      return { error: `JPEG: component ${id} names quantization table ${quantTable} (only 0–3 exist)` };
    }
    if (components.some((c) => c.id === id)) {
      return { error: `JPEG: two frame components share the id ${id}` };
    }
    components.push({ id, h, v, quantTable });
    if (h > maxH) maxH = h;
    if (v > maxV) maxV = v;
  }

  // MCUs tile the frame in units of the largest sampling factor; a component's own plane is
  // padded up to whole blocks, which is why these are counts of blocks and not of pixels.
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerColumn = Math.ceil(height / (8 * maxV));
  const blockCols = components.map((c) => mcusPerLine * c.h);
  const blockRows = components.map((c) => mcusPerColumn * c.v);
  let blocks = 0;
  for (let i = 0; i < components.length; i++) blocks += blockCols[i] * blockRows[i];
  if (blocks > MAX_FRAME_BLOCKS) {
    return {
      error: `JPEG: the ${width}x${height} frame needs ${blocks} coefficient blocks, past the ${MAX_FRAME_BLOCKS}-block ceiling this decoder allocates`,
    };
  }

  const planes = components.map((_, i) => new Int16Array(blockCols[i] * blockRows[i] * 64));
  return {
    frame: { width, height, maxH, maxV, components, blockCols, blockRows },
    planes,
  };
}

/* ----------------------------------------------------------------- segments */

function readQuantTables(
  bytes: Uint8Array,
  start: number,
  end: number,
  tables: Array<Uint16Array | null>,
): JpegEntropyFailure | undefined {
  let at = start;
  while (at < end) {
    const spec = bytes[at++];
    const precision = spec >> 4;
    const id = spec & 15;
    if (id > 3) {
      return { error: `JPEG: a quantization table is numbered ${id} (only 0–3 exist)` };
    }
    if (precision !== 0) {
      return {
        error:
          precision === 1
            ? 'JPEG: 16-bit quantization tables are not supported (baseline files use 8-bit)'
            : `JPEG: quantization table precision ${precision} is not defined`,
      };
    }
    if (at + 64 > end) {
      return { error: 'JPEG: a DQT segment ends in the middle of its 64-entry table (truncated)' };
    }
    const table = new Uint16Array(64);
    for (let i = 0; i < 64; i++) table[ZIGZAG[i]] = bytes[at + i];
    tables[id] = table;
    at += 64;
  }
  return undefined;
}

function readHuffmanTables(
  bytes: Uint8Array,
  start: number,
  end: number,
  dc: Array<HuffTable | null>,
  ac: Array<HuffTable | null>,
): JpegEntropyFailure | undefined {
  let at = start;
  while (at < end) {
    const spec = bytes[at++];
    const tableClass = spec >> 4;
    const id = spec & 15;
    if (tableClass > 1) {
      return { error: `JPEG: Huffman table class ${tableClass} is not defined` };
    }
    if (id > 3) {
      return { error: `JPEG: a Huffman table is numbered ${id} (only 0–3 exist)` };
    }
    if (at + 16 > end) {
      return { error: 'JPEG: a DHT segment ends before its 16 code-length counts (truncated)' };
    }
    const counts = bytes.subarray(at, at + 16);
    at += 16;
    let symbols = 0;
    for (let i = 0; i < 16; i++) symbols += counts[i];
    if (symbols === 0 || symbols > 256) {
      return { error: 'JPEG: a Huffman table declares an impossible number of symbols' };
    }
    if (at + symbols > end) {
      return { error: 'JPEG: a DHT segment ends before its symbol list (truncated)' };
    }
    const table = buildHuffmanTable(counts, bytes.subarray(at, at + symbols));
    if (typeof table === 'string') return { error: table };
    (tableClass === 0 ? dc : ac)[id] = table;
    at += symbols;
  }
  return undefined;
}

/* ---------------------------------------------------------------- huffman */

/**
 * One Huffman table, packed for decoding.
 *
 * `minCode`/`maxCode`/`valPtr` are the canonical code (spec figure C.3) — enough to decode
 * bit by bit. The `fast` pair is what keeps the hot loop cheap: nine bits resolve in one
 * lookup, and only the rare longer code falls back to the walk. A zero length is the miss
 * marker, which is why the tables are `Uint8Array` and not an encoded int.
 */
interface HuffTable {
  minCode: Int32Array;
  maxCode: Int32Array;
  valPtr: Int32Array;
  values: Uint8Array;
  fastLength: Uint8Array;
  fastSymbol: Uint8Array;
}

/** Bits resolved by one table lookup — nine covers every code a baseline encoder emits often. */
const FAST_BITS = 9;

function buildHuffmanTable(counts: Uint8Array, values: Uint8Array): HuffTable | string {
  const minCode = new Int32Array(17);
  const maxCode = new Int32Array(17).fill(-1);
  const valPtr = new Int32Array(17);
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length++) {
    const n = counts[length - 1];
    if (n > 0) {
      minCode[length] = code;
      valPtr[length] = index;
      code += n;
      index += n;
      maxCode[length] = code - 1;
    }
    // The code space halves with every extra bit: more codes than fit would let a lookup
    // run past `values`, so an over-subscribed table is refused rather than indexed.
    if (code > 1 << length) {
      return 'JPEG: a Huffman table is over-subscribed (its codes cannot all be assigned)';
    }
    code <<= 1;
  }

  const fastLength = new Uint8Array(1 << FAST_BITS);
  const fastSymbol = new Uint8Array(1 << FAST_BITS);
  for (let length = 1; length <= FAST_BITS; length++) {
    for (let c = minCode[length]; c <= maxCode[length]; c++) {
      const from = c << (FAST_BITS - length);
      const span = 1 << (FAST_BITS - length);
      const symbol = values[valPtr[length] + c - minCode[length]];
      fastLength.fill(length, from, from + span);
      fastSymbol.fill(symbol, from, from + span);
    }
  }
  return { minCode, maxCode, valPtr, values, fastLength, fastSymbol };
}

/**
 * One Huffman code from the stream. The fast table resolves any code of `FAST_BITS` bits or
 * fewer in a single lookup; a miss there means the code is longer, and the canonical walk
 * from one bit up finds it. -1 is "no code of 16 bits or fewer matches" — damaged data.
 */
function decodeSymbol(reader: EntropyReader, table: HuffTable): number {
  const index = reader.peek(FAST_BITS);
  const length = table.fastLength[index];
  if (length !== 0) {
    reader.drop(length);
    return table.fastSymbol[index];
  }
  let code = 0;
  for (let bits = 1; bits <= 16; bits++) {
    code = (code << 1) | reader.readBit();
    if (code <= table.maxCode[bits]) {
      const at = table.valPtr[bits] + code - table.minCode[bits];
      return at >= 0 && at < table.values.length ? table.values[at] : -1;
    }
  }
  return -1;
}

/** EXTEND (spec F.1.2.1.1): `size` bits name a value in the signed range they stand for. */
function receiveExtend(reader: EntropyReader, size: number): number {
  if (size === 0) return 0;
  const value = reader.readBits(size);
  return value < 1 << (size - 1) ? value - (1 << size) + 1 : value;
}

/* ------------------------------------------------------------- entropy bits */

/**
 * Bit reader over one entropy-coded segment.
 *
 * It stops at the marker that ends the segment instead of reading through it, and it counts
 * the zero bits it had to invent past the end of the data. *Peeking* at invented bits is
 * normal — a code is looked up nine bits wide, so the last symbol of a scan can see them —
 * but *consuming* one proves the encoder never wrote a bit the decoder needed, which is
 * exactly what a truncated file looks like.
 */
class EntropyReader {
  private readonly bytes: Uint8Array;
  private position: number;
  private bits = 0;
  private bitCount = 0;
  private invented = 0;

  constructor(bytes: Uint8Array, start: number) {
    this.bytes = bytes;
    this.position = start;
  }

  /** Byte offset of the next byte not yet pulled — for a marker, its leading 0xFF. */
  get offset(): number {
    return this.position;
  }

  /** True once a symbol used an invented bit: the entropy data ended too early. */
  get exhausted(): boolean {
    return this.invented > this.bitCount;
  }

  /** Drop the bits of the current byte: restart markers always sit on a byte boundary. */
  align(): void {
    this.bits = 0;
    this.bitCount = 0;
    this.invented = 0;
  }

  /** The marker byte at the current offset (fill bytes skipped), or -1 when none follows. */
  markerAt(): number {
    if (this.position >= this.bytes.length || this.bytes[this.position] !== 0xff) return -1;
    let at = this.position;
    while (at < this.bytes.length && this.bytes[at] === 0xff) at++;
    return at < this.bytes.length ? this.bytes[at] : -1;
  }

  /** Step over the marker `markerAt` reported, so the marker walk resumes after it. */
  takeMarker(): void {
    while (this.position < this.bytes.length && this.bytes[this.position] === 0xff) this.position++;
    this.position++;
  }

  /** The next `width` bits without consuming them. */
  peek(width: number): number {
    this.fill(width);
    return (this.bits >>> (this.bitCount - width)) & ((1 << width) - 1);
  }

  /** Consume `width` bits already peeked. */
  drop(width: number): void {
    this.bitCount -= width;
  }

  readBit(): number {
    return this.readBits(1);
  }

  readBits(width: number): number {
    const value = this.peek(width);
    this.bitCount -= width;
    return value;
  }

  /** Pull whole bytes until `width` bits are buffered, inventing zeros past the data. */
  private fill(width: number): void {
    while (this.bitCount < width) {
      this.bits = ((this.bits << 8) | this.nextByte()) >>> 0;
      this.bitCount += 8;
    }
  }

  private nextByte(): number {
    if (this.position >= this.bytes.length) {
      this.invented += 8;
      return 0;
    }
    const byte = this.bytes[this.position++];
    if (byte !== 0xff) return byte;
    // A 0xFF run is fill bytes, 0xFF 0x00 is a data byte (the encoder's escape), and
    // anything else is a marker — which belongs to the marker walk, not to this reader.
    while (this.position < this.bytes.length && this.bytes[this.position] === 0xff) this.position++;
    if (this.position >= this.bytes.length) {
      this.invented += 8;
      return 0;
    }
    const following = this.bytes[this.position];
    if (following === 0x00) {
      this.position++;
      return 0xff;
    }
    this.position--; // Leave the marker in place for the marker walk.
    this.invented += 8;
    return 0;
  }
}

/* ------------------------------------------------------------------- scans */

/** A scan's view of one component: where its plane is, and which tables decode it. */
interface ResolvedComponent {
  index: number;
  component: JpegComponent;
  plane: Int16Array;
  blockCols: number;
  dc: HuffTable;
  ac: HuffTable;
}

interface DecodeContext {
  bytes: Uint8Array;
  frame: Frame;
  planes: Int16Array[];
  dcTables: Array<HuffTable | null>;
  acTables: Array<HuffTable | null>;
}

interface ScanComponent {
  /** Index into the frame's component list. */
  index: number;
  dc: number;
  ac: number;
}

type ScanOutcome = { next: number } | JpegEntropyFailure;

function readScanHeader(
  bytes: Uint8Array,
  start: number,
  end: number,
  frame: Frame,
): { order: ScanComponent[] } | JpegEntropyFailure {
  if (end - start < 1) {
    return { error: 'JPEG: the SOS segment is empty (truncated)' };
  }
  const count = bytes[start];
  if (end - start !== 1 + count * 2 + 3) {
    return {
      error: `JPEG: the SOS segment does not fit its ${count} component descriptors (truncated or damaged)`,
    };
  }
  const spectralStart = bytes[end - 3];
  const spectralEnd = bytes[end - 2];
  const approximation = bytes[end - 1];
  // Baseline sequential is exactly this and no more: every coefficient, no refinement bits.
  if (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0) {
    return {
      error: `JPEG: the scan selects coefficients ${spectralStart}–${spectralEnd} at approximation ${approximation} — that is a progressive scan, not baseline sequential`,
    };
  }
  if (count !== frame.components.length) {
    return {
      error: `JPEG: this scan covers ${count} of the frame's ${frame.components.length} components — non-interleaved multi-scan baseline files are not supported`,
    };
  }

  const order: ScanComponent[] = [];
  for (let i = 0; i < count; i++) {
    const id = bytes[start + 1 + i * 2];
    const tables = bytes[start + 2 + i * 2];
    const dc = tables >> 4;
    const ac = tables & 15;
    if (dc > 3 || ac > 3) {
      return { error: `JPEG: component ${id} in the scan names Huffman tables ${dc}/${ac} (only 0–3 exist)` };
    }
    const index = frame.components.findIndex((c) => c.id === id);
    if (index < 0) {
      return { error: `JPEG: the scan names component ${id}, which the frame does not declare` };
    }
    if (order.some((o) => o.index === index)) {
      return { error: `JPEG: the scan names component ${id} twice` };
    }
    order.push({ index, dc, ac });
  }
  return { order };
}

/**
 * One interleaved scan: every MCU holds each component's blocks in scan order, and the
 * coefficients land in that component's own plane at its own block grid.
 */
function decodeScan(
  ctx: DecodeContext,
  order: ScanComponent[],
  start: number,
  restartInterval: number,
): ScanOutcome {
  const { frame } = ctx;
  const plan: ResolvedComponent[] = [];
  for (const sc of order) {
    const dc = ctx.dcTables[sc.dc];
    const ac = ctx.acTables[sc.ac];
    if (dc === null || ac === null) {
      return {
        error: `JPEG: the scan uses Huffman table ${sc.dc}/${sc.ac}, which no DHT segment defined`,
      };
    }
    plan.push({
      index: sc.index,
      component: frame.components[sc.index],
      plane: ctx.planes[sc.index],
      blockCols: frame.blockCols[sc.index],
      dc,
      ac,
    });
  }

  const mcusPerLine = Math.ceil(frame.width / (8 * frame.maxH));
  const mcusPerColumn = Math.ceil(frame.height / (8 * frame.maxV));
  const totalMcus = mcusPerLine * mcusPerColumn;
  const reader = new EntropyReader(ctx.bytes, start);
  // One DC predictor per component, reset by every restart marker.
  const predictors = new Int32Array(frame.components.length);
  let expectedRestart = 0;

  for (let mcu = 0; mcu < totalMcus; mcu++) {
    const mcuCol = mcu % mcusPerLine;
    const mcuRow = (mcu - mcuCol) / mcusPerLine;
    for (const entry of plan) {
      for (let by = 0; by < entry.component.v; by++) {
        for (let bx = 0; bx < entry.component.h; bx++) {
          const blockRow = mcuRow * entry.component.v + by;
          const blockCol = mcuCol * entry.component.h + bx;
          const failure = decodeBlock(
            reader,
            entry,
            predictors,
            (blockRow * entry.blockCols + blockCol) * 64,
          );
          if (failure !== undefined) return { error: failure };
        }
      }
    }
    // Restart markers sit between intervals, so the one after the final interval is
    // optional — encoders differ, and it carries no data either way.
    if (restartInterval > 0 && (mcu + 1) % restartInterval === 0) {
      const failure = synchroniseRestart(reader, expectedRestart, mcu + 1 === totalMcus);
      if (failure !== undefined) return { error: failure };
      expectedRestart = (expectedRestart + 1) & 7;
      predictors.fill(0);
    }
  }

  if (reader.exhausted) {
    return { error: 'JPEG: the entropy data ends before the last coefficient was read (truncated scan)' };
  }
  return { next: reader.offset };
}

/**
 * Decode one 8x8 block straight into its plane, at `base` — no per-block allocation, which
 * is what makes a 160x120 file (and a 12 megapixel one) affordable on the host thread.
 * Returns a reason, or undefined when the block decoded.
 */
function decodeBlock(
  reader: EntropyReader,
  entry: ResolvedComponent,
  predictors: Int32Array,
  base: number,
): string | undefined {
  const dcLength = decodeSymbol(reader, entry.dc);
  if (dcLength < 0) {
    return 'JPEG: the next bits match no code in the DC Huffman table (damaged or non-baseline data)';
  }
  const dc = predictors[entry.index] + receiveExtend(reader, dcLength);
  // The predictor is a running sum of differences, so garbage data can carry it out of the
  // 16-bit range, where Int16Array would wrap it into small, plausible-looking coefficients.
  if (dc < -32768 || dc > 32767) {
    return 'JPEG: a DC coefficient left the 16-bit range (damaged entropy data)';
  }
  predictors[entry.index] = dc;
  entry.plane[base] = dc;

  let k = 1;
  while (k < 64) {
    const rs = decodeSymbol(reader, entry.ac);
    if (rs < 0) {
      return 'JPEG: the next bits match no code in the AC Huffman table (damaged or non-baseline data)';
    }
    const run = rs >> 4;
    const size = rs & 15;
    if (size === 0) {
      if (run !== 15) break; // EOB: everything left in the block is zero.
      k += 16; // ZRL: sixteen zeros, and the loop continues.
      continue;
    }
    k += run;
    if (k > 63) {
      return 'JPEG: an AC run in a block runs past coefficient 63 (damaged entropy data)';
    }
    entry.plane[base + ZIGZAG[k]] = receiveExtend(reader, size);
    k++;
  }
  return undefined;
}

/** Drop to the byte boundary and require the RSTn the DRI segment promised. */
function synchroniseRestart(reader: EntropyReader, expected: number, last: boolean): string | undefined {
  if (reader.exhausted) {
    return `JPEG: the entropy data ends before the promised restart marker ${markerName(0xd0 + expected)} (truncated scan)`;
  }
  reader.align();
  const marker = reader.markerAt();
  if (last) {
    if (marker >= 0xd0 && marker <= 0xd7) reader.takeMarker();
    return undefined;
  }
  if (marker !== 0xd0 + expected) {
    const found = marker < 0 ? 'the end of the file' : markerName(marker);
    return `JPEG: restart marker ${markerName(0xd0 + expected)} is missing where the DRI segment promised one (found ${found})`;
  }
  reader.takeMarker();
  return undefined;
}

/** Narrow without a cast at every call site. */
export function isCoefficients(
  value: JpegCoefficients | JpegEntropyFailure,
): value is JpegCoefficients {
  return (value as JpegEntropyFailure).error === undefined;
}
