import { describe, expect, it } from "vitest";
import { centeredOrigin, concat, invert, textMatrix, transformPoint } from "../src/engine/geometry";
import { chunk, indicesFromRanges, moveItems, parsePageRanges, renderPageNumber } from "../src/engine/pageRanges";
import type { Matrix } from "../src/engine/types";

describe("頁碼範圍", () => {
  it("解析各種格式", () => {
    expect(parsePageRanges("1-3, 5, 8-", 10)).toEqual([[0, 2], [4, 4], [7, 9]]);
    expect(parsePageRanges("2，4～5", 5)).toEqual([[1, 1], [3, 4]]);
    expect(parsePageRanges("-2", 5)).toEqual([[0, 1]]);
  });

  it("拒絕錯誤輸入", () => {
    for (const bad of ["0", "3-1", "6", "abc", "", "1-2-3", "1.5"]) {
      expect(parsePageRanges(bad, 5)).toBeNull();
    }
  });

  it("展開與分段", () => {
    expect(indicesFromRanges([[3, 4], [0, 1], [1, 2]])).toEqual([0, 1, 2, 3, 4]);
    expect(chunk(5, 2)).toEqual([[0, 1], [2, 3], [4, 4]]);
  });

  it("搬移項目", () => {
    const items = ["a", "b", "c", "d", "e"];
    expect(moveItems(items, [0], 3)).toEqual(["b", "c", "a", "d", "e"]);
    expect(moveItems(items, [4], 0)).toEqual(["e", "a", "b", "c", "d"]);
    expect(moveItems(items, [1, 3], 5)).toEqual(["a", "c", "e", "b", "d"]);
  });

  it("頁碼樣板", () => {
    expect(renderPageNumber("第 {n} 頁，共 {total} 頁", 3, 12)).toBe("第 3 頁，共 12 頁");
  });
});

describe("矩陣", () => {
  it("反矩陣與相乘", () => {
    const m: Matrix = [0, 1, -1, 0, 100, 50];
    const identity = concat(m, invert(m)).map((v) => Math.round(v * 1e6) / 1e6);
    expect(identity).toEqual([1, 0, 0, 1, 0, 0]);
    expect(transformPoint([10, 0], m)).toEqual([100, 60]);
  });

  it("文字矩陣在 y 向下座標中讓字正立", () => {
    const m = textMatrix([10, 100], 20);
    // 文字空間的「上」(0,1) 應往頁面上方（y 變小）
    expect(transformPoint([0, 1], m)).toEqual([10, 80]);
  });

  it("置中原點", () => {
    const [x, y] = centeredOrigin([300, 400], 200, 20, 0);
    expect(x).toBeCloseTo(200);
    expect(y).toBeCloseTo(407);
  });
});
