import { describe, expect, it } from "vitest";
import { adjust, crop, inpaint, looksPhotographic, paperColor, paste, type Raster } from "../src/imageEditor/raster";

function solid(width: number, height: number, rgb: [number, number, number]): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return { width, height, data };
}

const at = (img: Raster, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));

describe("影像編輯的像素處理", () => {
  it("亮度、對比與黑白", () => {
    const img = solid(2, 1, [100, 150, 200]);
    adjust(img, 1, 1, false);
    expect(at(img, 0, 0)).toEqual([100, 150, 200]);
    adjust(img, 1.2, 1, false);
    expect(at(img, 0, 0)).toEqual([120, 180, 240]);
    const contrast = solid(1, 1, [64, 128, 192]);
    adjust(contrast, 1, 2, false);
    expect(at(contrast, 0, 0)).toEqual([0, 129, 255]);
    const gray = solid(1, 1, [255, 0, 0]);
    adjust(gray, 1, 1, true);
    expect(at(gray, 0, 0)).toEqual([54, 54, 54]);
  });

  it("修補：以周圍顏色填滿", () => {
    const img = solid(20, 20, [240, 230, 200]);
    const mask = new Uint8Array(400);
    for (let y = 5; y < 15; y++) {
      for (let x = 5; x < 15; x++) {
        img.data.set([0, 0, 0], (y * 20 + x) * 4);
        mask[y * 20 + x] = 1;
      }
    }
    inpaint(img, mask);
    expect(at(img, 10, 10)).toEqual([240, 230, 200]);
    expect(at(img, 5, 5)).toEqual([240, 230, 200]);
  });

  it("修補時左右不同顏色會漸變", () => {
    const img = solid(30, 3, [0, 0, 0]);
    for (let y = 0; y < 3; y++) for (let x = 15; x < 30; x++) img.data.set([200, 200, 200], (y * 30 + x) * 4);
    const mask = new Uint8Array(90);
    for (let y = 0; y < 3; y++) for (let x = 10; x < 20; x++) mask[y * 30 + x] = 1;
    inpaint(img, mask);
    const left = at(img, 10, 1)[0];
    const right = at(img, 19, 1)[0];
    expect(left).toBeLessThan(right);
  });

  it("紙張顏色、裁切與貼上", () => {
    const img = solid(100, 100, [250, 245, 230]);
    for (let y = 40; y < 60; y++) for (let x = 40; x < 60; x++) img.data.set([0, 0, 0], (y * 100 + x) * 4);
    expect(paperColor(img)).toEqual([250, 245, 230]);
    const piece = crop(img, [40, 40, 60, 60]);
    expect([piece.width, piece.height]).toEqual([20, 20]);
    expect(at(piece, 0, 0)).toEqual([0, 0, 0]);
    paste(img, piece, 90, 90);
    expect(at(img, 95, 95)).toEqual([0, 0, 0]);
    expect(at(img, 89, 89)).toEqual([250, 245, 230]);
  });

  it("判斷照片或文字頁", () => {
    expect(looksPhotographic(solid(100, 100, [255, 255, 255]))).toBe(false);
    const noise = solid(200, 200, [0, 0, 0]);
    let seed = 1;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 8) & 255;
    };
    for (let i = 0; i < noise.data.length; i += 4) noise.data.set([rand(), rand(), rand()], i);
    expect(looksPhotographic(noise)).toBe(true);
  });
});
