// DDS decoder for the SC2 UI editor.
//
// Supports the formats SC2 actually uses for its UI textures:
//   - DXT1 / BC1 (FourCC 'DXT1')   - opaque or 1-bit alpha, 8 bytes per 4x4 block
//   - DXT3 / BC2 (FourCC 'DXT3')   - explicit 4-bit alpha + DXT1 RGB, 16 bytes
//   - DXT5 / BC3 (FourCC 'DXT5')   - interpolated alpha + DXT1 RGB, 16 bytes
//   - Uncompressed RGBA / BGRA / RGB / BGR via the DDS_PIXELFORMAT flags
//
// Output: { width, height, imageData } where imageData is a Uint8ClampedArray
// of width*height*4 RGBA bytes ready for `new ImageData(...)` / canvas.putImageData.
//
// References:
//   - https://learn.microsoft.com/en-us/windows/win32/direct3ddds/dx-graphics-dds-pguide
//   - https://en.wikipedia.org/wiki/S3_Texture_Compression

const DDS_MAGIC = 0x20534444; // 'DDS '
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;

const FOURCC_DXT1 = makeFourCC('DXT1');
const FOURCC_DXT3 = makeFourCC('DXT3');
const FOURCC_DXT5 = makeFourCC('DXT5');
const FOURCC_DX10 = makeFourCC('DX10');

function makeFourCC(s) {
    return (s.charCodeAt(0)) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);
}

export class DdsDecodeError extends Error {}

export function decodeDds(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength < 128) throw new DdsDecodeError('DDS file too small');
    if (view.getUint32(0, true) !== DDS_MAGIC) throw new DdsDecodeError('not a DDS file');

    // DDS_HEADER (124 bytes) starts at offset 4. See MSDN doc above for layout.
    const height = view.getUint32(12, true);
    const width = view.getUint32(16, true);
    // PIXELFORMAT struct begins at offset 76, length 32 bytes.
    const pfFlags = view.getUint32(76 + 4, true);
    const pfFourCC = view.getUint32(76 + 8, true);
    const pfRGBBitCount = view.getUint32(76 + 12, true);
    const pfRMask = view.getUint32(76 + 16, true);
    const pfGMask = view.getUint32(76 + 20, true);
    const pfBMask = view.getUint32(76 + 24, true);
    const pfAMask = view.getUint32(76 + 28, true);

    let dataOffset = 128;
    if (pfFlags & DDPF_FOURCC && pfFourCC === FOURCC_DX10) {
        // DX10 header is another 20 bytes after the main header.
        dataOffset += 20;
        throw new DdsDecodeError('DX10/BC7 textures not yet supported');
    }

    const data = new Uint8Array(buffer, dataOffset);
    const out = new Uint8ClampedArray(width * height * 4);

    if (pfFlags & DDPF_FOURCC) {
        switch (pfFourCC) {
            case FOURCC_DXT1: decodeDxt1(data, width, height, out); break;
            case FOURCC_DXT3: decodeDxt3(data, width, height, out); break;
            case FOURCC_DXT5: decodeDxt5(data, width, height, out); break;
            default: throw new DdsDecodeError('unsupported FourCC ' + pfFourCC.toString(16));
        }
    } else if (pfFlags & DDPF_RGB) {
        decodeUncompressed(data, width, height, pfRGBBitCount, pfRMask, pfGMask, pfBMask, pfAMask, out);
    } else {
        throw new DdsDecodeError('unsupported pixel format flags ' + pfFlags.toString(16));
    }

    return { width, height, imageData: out };
}

// ----- BC1 / DXT1 ----------------------------------------------------------
function decodeDxt1(src, width, height, dst) {
    const blocksW = Math.max(1, (width + 3) >> 2);
    const blocksH = Math.max(1, (height + 3) >> 2);
    let off = 0;
    const colors = new Uint8Array(16); // 4 colors x RGBA
    for (let by = 0; by < blocksH; by++) {
        for (let bx = 0; bx < blocksW; bx++) {
            decodeColorBlock(src, off, colors, true);
            off += 8;
            writeBlockColors(dst, width, height, bx, by, colors, src, off - 4);
        }
    }
}

// ----- BC2 / DXT3 ----------------------------------------------------------
function decodeDxt3(src, width, height, dst) {
    const blocksW = Math.max(1, (width + 3) >> 2);
    const blocksH = Math.max(1, (height + 3) >> 2);
    let off = 0;
    const colors = new Uint8Array(16);
    const alpha = new Uint8Array(16);
    for (let by = 0; by < blocksH; by++) {
        for (let bx = 0; bx < blocksW; bx++) {
            // 8 bytes explicit 4-bit alpha (no interpolation).
            for (let i = 0; i < 8; i++) {
                const b = src[off + i];
                alpha[i * 2 + 0] = (b & 0x0F) * 17;
                alpha[i * 2 + 1] = ((b >> 4) & 0x0F) * 17;
            }
            off += 8;
            decodeColorBlock(src, off, colors, false);
            off += 8;
            writeBlockAlpha3(dst, width, height, bx, by, colors, alpha, src, off - 4);
        }
    }
}

// ----- BC3 / DXT5 ----------------------------------------------------------
function decodeDxt5(src, width, height, dst) {
    const blocksW = Math.max(1, (width + 3) >> 2);
    const blocksH = Math.max(1, (height + 3) >> 2);
    let off = 0;
    const colors = new Uint8Array(16);
    const alphaTable = new Uint8Array(8);
    const alphaPixels = new Uint8Array(16);
    for (let by = 0; by < blocksH; by++) {
        for (let bx = 0; bx < blocksW; bx++) {
            const a0 = src[off];
            const a1 = src[off + 1];
            alphaTable[0] = a0;
            alphaTable[1] = a1;
            if (a0 > a1) {
                alphaTable[2] = (6 * a0 + 1 * a1) / 7;
                alphaTable[3] = (5 * a0 + 2 * a1) / 7;
                alphaTable[4] = (4 * a0 + 3 * a1) / 7;
                alphaTable[5] = (3 * a0 + 4 * a1) / 7;
                alphaTable[6] = (2 * a0 + 5 * a1) / 7;
                alphaTable[7] = (1 * a0 + 6 * a1) / 7;
            } else {
                alphaTable[2] = (4 * a0 + 1 * a1) / 5;
                alphaTable[3] = (3 * a0 + 2 * a1) / 5;
                alphaTable[4] = (2 * a0 + 3 * a1) / 5;
                alphaTable[5] = (1 * a0 + 4 * a1) / 5;
                alphaTable[6] = 0;
                alphaTable[7] = 255;
            }
            // 6 bytes of 3-bit indices = 48 bits across 16 pixels.
            let lo = src[off + 2] | (src[off + 3] << 8) | (src[off + 4] << 16);
            let hi = src[off + 5] | (src[off + 6] << 8) | (src[off + 7] << 16);
            for (let i = 0; i < 8; i++)  alphaPixels[i] = alphaTable[(lo >> (i * 3)) & 0x7];
            for (let i = 0; i < 8; i++)  alphaPixels[8 + i] = alphaTable[(hi >> (i * 3)) & 0x7];
            off += 8;
            decodeColorBlock(src, off, colors, false);
            off += 8;
            writeBlockAlpha5(dst, width, height, bx, by, colors, alphaPixels, src, off - 4);
        }
    }
}

// Shared color-block decode: produces 4 candidate colors (RGBA) in `out`.
function decodeColorBlock(src, off, out, allow1bitAlpha) {
    const c0 = src[off] | (src[off + 1] << 8);
    const c1 = src[off + 2] | (src[off + 3] << 8);
    const r0 = ((c0 >> 11) & 0x1F) * 255 / 31;
    const g0 = ((c0 >> 5) & 0x3F) * 255 / 63;
    const b0 = (c0 & 0x1F) * 255 / 31;
    const r1 = ((c1 >> 11) & 0x1F) * 255 / 31;
    const g1 = ((c1 >> 5) & 0x3F) * 255 / 63;
    const b1 = (c1 & 0x1F) * 255 / 31;
    out[0] = r0; out[1] = g0; out[2] = b0; out[3] = 255;
    out[4] = r1; out[5] = g1; out[6] = b1; out[7] = 255;
    if (c0 > c1 || !allow1bitAlpha) {
        out[8]  = (2 * r0 + r1) / 3;
        out[9]  = (2 * g0 + g1) / 3;
        out[10] = (2 * b0 + b1) / 3;
        out[11] = 255;
        out[12] = (r0 + 2 * r1) / 3;
        out[13] = (g0 + 2 * g1) / 3;
        out[14] = (b0 + 2 * b1) / 3;
        out[15] = 255;
    } else {
        out[8]  = (r0 + r1) / 2;
        out[9]  = (g0 + g1) / 2;
        out[10] = (b0 + b1) / 2;
        out[11] = 255;
        out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 0;
    }
}

function writeBlockColors(dst, w, h, bx, by, colors, src, indicesOff) {
    const indices = src[indicesOff] | (src[indicesOff + 1] << 8) | (src[indicesOff + 2] << 16) | (src[indicesOff + 3] << 24);
    for (let py = 0; py < 4; py++) {
        const yy = by * 4 + py;
        if (yy >= h) break;
        for (let px = 0; px < 4; px++) {
            const xx = bx * 4 + px;
            if (xx >= w) break;
            const idx = (indices >> (2 * (py * 4 + px))) & 0x3;
            const co = idx * 4;
            const di = (yy * w + xx) * 4;
            dst[di + 0] = colors[co + 0];
            dst[di + 1] = colors[co + 1];
            dst[di + 2] = colors[co + 2];
            dst[di + 3] = colors[co + 3];
        }
    }
}

function writeBlockAlpha3(dst, w, h, bx, by, colors, alpha, src, indicesOff) {
    const indices = src[indicesOff] | (src[indicesOff + 1] << 8) | (src[indicesOff + 2] << 16) | (src[indicesOff + 3] << 24);
    for (let py = 0; py < 4; py++) {
        const yy = by * 4 + py;
        if (yy >= h) break;
        for (let px = 0; px < 4; px++) {
            const xx = bx * 4 + px;
            if (xx >= w) break;
            const idx = (indices >> (2 * (py * 4 + px))) & 0x3;
            const co = idx * 4;
            const di = (yy * w + xx) * 4;
            dst[di + 0] = colors[co + 0];
            dst[di + 1] = colors[co + 1];
            dst[di + 2] = colors[co + 2];
            dst[di + 3] = alpha[py * 4 + px];
        }
    }
}

function writeBlockAlpha5(dst, w, h, bx, by, colors, alphaPixels, src, indicesOff) {
    const indices = src[indicesOff] | (src[indicesOff + 1] << 8) | (src[indicesOff + 2] << 16) | (src[indicesOff + 3] << 24);
    for (let py = 0; py < 4; py++) {
        const yy = by * 4 + py;
        if (yy >= h) break;
        for (let px = 0; px < 4; px++) {
            const xx = bx * 4 + px;
            if (xx >= w) break;
            const idx = (indices >> (2 * (py * 4 + px))) & 0x3;
            const co = idx * 4;
            const di = (yy * w + xx) * 4;
            dst[di + 0] = colors[co + 0];
            dst[di + 1] = colors[co + 1];
            dst[di + 2] = colors[co + 2];
            dst[di + 3] = alphaPixels[py * 4 + px];
        }
    }
}

function decodeUncompressed(src, w, h, bitCount, rMask, gMask, bMask, aMask, dst) {
    if (bitCount !== 32 && bitCount !== 24) {
        throw new DdsDecodeError('unsupported uncompressed bit count ' + bitCount);
    }
    const bytesPerPixel = bitCount / 8;
    const rShift = maskShift(rMask);
    const gShift = maskShift(gMask);
    const bShift = maskShift(bMask);
    const aShift = aMask ? maskShift(aMask) : 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const si = (y * w + x) * bytesPerPixel;
            let pixel;
            if (bytesPerPixel === 4) {
                pixel = src[si] | (src[si + 1] << 8) | (src[si + 2] << 16) | (src[si + 3] << 24);
                pixel >>>= 0;
            } else {
                pixel = src[si] | (src[si + 1] << 8) | (src[si + 2] << 16);
            }
            const di = (y * w + x) * 4;
            dst[di + 0] = (pixel & rMask) >>> rShift;
            dst[di + 1] = (pixel & gMask) >>> gShift;
            dst[di + 2] = (pixel & bMask) >>> bShift;
            dst[di + 3] = aMask ? ((pixel & aMask) >>> aShift) : 255;
        }
    }
}

function maskShift(mask) {
    if (!mask) return 0;
    let s = 0;
    while (((mask >>> s) & 1) === 0) s++;
    return s;
}

// Convenience: decode + paint to a canvas, return the canvas.
export function ddsToCanvas(buffer) {
    const { width, height, imageData } = decodeDds(buffer);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const img = new ImageData(imageData, width, height);
    ctx.putImageData(img, 0, 0);
    return canvas;
}
