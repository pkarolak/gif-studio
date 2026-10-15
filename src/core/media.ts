import {open} from 'node:fs/promises';

export interface Dimensions {
  width: number;
  height: number;
}

export async function readDimensions(file: string): Promise<Dimensions | null> {
  const lower = file.toLowerCase();
  try {
    if (lower.endsWith('.svg')) return svgDimensions(await readHead(file, 4096));
    const head = await readHead(file, 65536);
    if (lower.endsWith('.png')) return pngDimensions(head);
    if (lower.endsWith('.gif')) return gifDimensions(head);
    if (lower.endsWith('.webp')) return webpDimensions(head);
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return jpegDimensions(head);
  } catch {
    return null;
  }
  return null;
}

async function readHead(file: string, bytes: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const {bytesRead} = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function pngDimensions(b: Buffer): Dimensions | null {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return {width: b.readUInt32BE(16), height: b.readUInt32BE(20)};
}

function gifDimensions(b: Buffer): Dimensions | null {
  if (b.length < 10 || b.toString('ascii', 0, 3) !== 'GIF') return null;
  return {width: b.readUInt16LE(6), height: b.readUInt16LE(8)};
}

function webpDimensions(b: Buffer): Dimensions | null {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return {width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff};
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return {width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1};
  }
  if (chunk === 'VP8X') return {width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1};
  return null;
}

function jpegDimensions(b: Buffer): Dimensions | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) return null;
    const marker = b[offset + 1]!;
    const length = b.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7)};
    }
    offset += 2 + length;
  }
  return null;
}

function svgDimensions(b: Buffer): Dimensions | null {
  const text = b.toString('utf8');
  const width = /<svg[^>]*\swidth="([\d.]+)/.exec(text)?.[1];
  const height = /<svg[^>]*\sheight="([\d.]+)/.exec(text)?.[1];
  if (width && height) return {width: Number(width), height: Number(height)};
  const viewBox = /viewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"/.exec(text);
  if (viewBox) return {width: Number(viewBox[1]), height: Number(viewBox[2])};
  return null;
}
