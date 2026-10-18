#!/usr/bin/env python3
"""當沖戰情室 本機報價服務

只用 Python 標準函式庫，不需安裝任何套件：
    python3 daytrade_server.py            # 開啟 http://127.0.0.1:8787
    python3 daytrade_server.py --port 9000

資料來源
- 即時報價／五檔：證交所基本市況報導 (mis.twse.com.tw)，上市、上櫃皆可
- 分 K 與昨日高低收：Yahoo Finance chart API（失敗時改用本機輪詢累積的分 K）

證交所對過於頻繁的請求會暫時封鎖 IP，本服務會快取 3 秒，請勿把更新間隔調得更短。
"""
import argparse
import http.cookiejar
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TPE = timezone(timedelta(hours=8))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "daytrade.html")
CODE_RE = re.compile(r"^[0-9A-Z]{4,6}$")

_jar = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_jar))
_lock = threading.Lock()
_cache = {}          # key -> (expires_at, value)
_exchange = {}       # code -> "tse" | "otc"
_ticks = {}          # code -> list of (epoch, price, cum_volume_shares)
_mis_ready = False


def fetch(url, timeout=8, referer=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json,text/plain,*/*",
                                               "Accept-Language": "zh-TW,zh;q=0.9", **({"Referer": referer} if referer else {})})
    with _opener.open(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def cached(key, ttl, fn):
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    val = fn()
    with _lock:
        _cache[key] = (now + ttl, val)
    return val


def num(s):
    try:
        v = float(s)
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


def levels(s):
    return [num(x) for x in (s or "").strip("_").split("_") if x]


# ---------------- 證交所即時報價 ----------------
def mis_raw(channels):
    global _mis_ready
    if not _mis_ready:
        try:  # 先取得 session cookie，部分時段沒有 cookie 會回空資料
            fetch("https://mis.twse.com.tw/stock/index.jsp")
        except Exception:
            pass
        _mis_ready = True
    url = ("https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&_=%d&ex_ch=%s"
           % (int(time.time() * 1000), urllib.parse.quote("|".join(channels), safe="|_.")))
    data = json.loads(fetch(url, referer="https://mis.twse.com.tw/stock/fibest.jsp"))
    return data.get("msgArray") or []


def parse_mis(m):
    bids, asks = levels(m.get("b")), levels(m.get("a"))
    bidv = [int(float(x)) for x in (m.get("g") or "").strip("_").split("_") if x]
    askv = [int(float(x)) for x in (m.get("f") or "").strip("_").split("_") if x]
    price = num(m.get("z"))
    # 該筆快照沒有成交價時（z 為 "-"），以最佳買賣價中間值估計
    est = False
    if price is None and bids and asks and bids[0] and asks[0]:
        price, est = round((bids[0] + asks[0]) / 2, 2), True
    prev = num(m.get("y"))
    vol_lots = num(m.get("v")) or 0
    return {
        "code": m.get("c"), "name": m.get("n"), "ex": m.get("ex"),
        "price": price, "estimated": est, "prev": prev,
        "open": num(m.get("o")), "high": num(m.get("h")), "low": num(m.get("l")),
        "limitUp": num(m.get("u")), "limitDown": num(m.get("w")),
        "volume": int(vol_lots),               # 累計成交量（張）
        "lastVol": int(num(m.get("tv")) or 0),  # 最近一筆成交量（張）
        "change": round(price - prev, 2) if price and prev else None,
        "changePct": round((price - prev) / prev * 100, 2) if price and prev else None,
        "bids": [{"p": p, "v": v} for p, v in zip(bids, bidv)],
        "asks": [{"p": p, "v": v} for p, v in zip(asks, askv)],
        "time": m.get("t"), "date": m.get("d"),
    }


def quotes(codes):
    """回傳 {code: quote}；未知市場別的代號會同時查上市與上櫃。"""
    chans = []
    for c in codes:
        ex = _exchange.get(c)
        chans += [f"{ex}_{c}.tw"] if ex else [f"tse_{c}.tw", f"otc_{c}.tw"]
    rows = cached("mis:" + ",".join(sorted(chans)), 3, lambda: mis_raw(chans))
    out = {}
    now = time.time()
    for m in rows:
        q = parse_mis(m)
        if not q["code"]:
            continue
        _exchange[q["code"]] = q["ex"]
        out[q["code"]] = q
        if q["price"] and not q["estimated"]:
            with _lock:
                t = _ticks.setdefault(q["code"], [])
                if not t or t[-1][2] != q["volume"] * 1000 or t[-1][1] != q["price"]:
                    t.append((now, q["price"], q["volume"] * 1000))
                    del t[:-20000]
    return out


# ---------------- 分 K ----------------
def yahoo_symbol(code):
    ex = _exchange.get(code)
    if not ex:
        try:
            quotes([code])
        except Exception:
            pass
        ex = _exchange.get(code, "tse")
    return f"{code}.TWO" if ex == "otc" else f"{code}.TW"


def yahoo_chart(sym, interval, rng):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval={interval}&range={rng}&includePrePost=false"
    res = json.loads(fetch(url))["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    rows = []
    for i, ts in enumerate(res.get("timestamp") or []):
        o, h, l, c, v = (q[k][i] for k in ("open", "high", "low", "close", "volume"))
        if None in (o, h, l, c):
            continue
        rows.append((datetime.fromtimestamp(ts, TPE), o, h, l, c, v or 0))
    return res.get("meta", {}), rows


def bars_from_ticks(code):
    with _lock:
        t = list(_ticks.get(code, []))
    today = datetime.now(TPE).date()
    bars, prev_cum = {}, None
    for ts, p, cum in t:
        dt = datetime.fromtimestamp(ts, TPE)
        if dt.date() != today:
            continue
        key = dt.strftime("%H:%M")
        dv = 0 if prev_cum is None else max(0, cum - prev_cum)
        prev_cum = cum
        b = bars.get(key)
        if b is None:
            bars[key] = [key, p, p, p, p, dv]
        else:
            b[2], b[3], b[4], b[5] = max(b[2], p), min(b[3], p), p, b[5] + dv
    return list(bars.values())


def bars(code):
    def load():
        sym = yahoo_symbol(code)
        try:
            _, rows = yahoo_chart(sym, "1m", "1d")
            today = datetime.now(TPE).date()
            last_day = rows[-1][0].date() if rows else None
            out = [[r[0].strftime("%H:%M"), *[round(x, 2) for x in r[1:5]], int(r[5])]
                   for r in rows if r[0].date() == last_day]
            src = "yahoo" if last_day == today else "yahoo（最近交易日）"
        except Exception as e:
            out, src = bars_from_ticks(code), f"本機輪詢（Yahoo 失敗：{type(e).__name__}）"
        prev = None
        try:
            _, days = yahoo_chart(sym, "1d", "10d")
            ref_day = datetime.now(TPE).date()
            if out and src.startswith("yahoo（"):
                ref_day = days[-1][0].date() if days else ref_day
            past = [d for d in days if d[0].date() < ref_day]
            if past:
                d = past[-1]
                prev = {"date": d[0].strftime("%Y-%m-%d"), "high": round(d[2], 2), "low": round(d[3], 2), "close": round(d[4], 2)}
        except Exception:
            pass
        return {"code": code, "symbol": sym, "source": src, "bars": out, "prev": prev}
    return cached("bars:" + code, 20, load)


# ---------------- HTTP ----------------
class Handler(BaseHTTPRequestHandler):
    server_version = "DaytradeLocal/1.0"

    def log_message(self, fmt, *args):
        if "/api/" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        try:
            if u.path in ("/", "/index.html"):
                with open(PAGE, "rb") as f:
                    body = f.read()
                # 單檔頁面以片段形式撰寫，本機提供時補上完整文件骨架
                if not body.lstrip().lower().startswith(b"<!doctype"):
                    body = (b'<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">'
                            b'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
                            b'<style>body{margin:0}[hidden]{display:none!important}</style></head><body>'
                            + body + b"</body></html>")
                return self.send(200, body, "text/html; charset=utf-8")
            if u.path == "/api/ping":
                return self.send(200, {"ok": True, "version": 1, "time": datetime.now(TPE).isoformat()})
            if u.path == "/api/quote":
                codes = [c.strip().upper() for c in ",".join(qs.get("codes", [])).split(",") if c.strip()]
                codes = [c for c in codes if CODE_RE.match(c)][:30]
                if not codes:
                    return self.send(400, {"error": "請提供股票代號，例如 ?codes=2330,2317"})
                return self.send(200, {"quotes": quotes(codes), "fetchedAt": datetime.now(TPE).strftime("%H:%M:%S")})
            if u.path == "/api/bars":
                code = (qs.get("code") or [""])[0].strip().upper()
                if not CODE_RE.match(code):
                    return self.send(400, {"error": "股票代號格式不正確"})
                return self.send(200, bars(code))
            return self.send(404, {"error": "not found"})
        except Exception as e:
            return self.send(502, {"error": f"報價來源暫時無法連線：{type(e).__name__}: {e}"})


def main():
    ap = argparse.ArgumentParser(description="當沖戰情室 本機報價服務")
    ap.add_argument("--host", default="127.0.0.1", help="綁定位址（預設只允許本機連線）")
    ap.add_argument("--port", type=int, default=8787)
    a = ap.parse_args()
    if not os.path.exists(PAGE):
        raise SystemExit(f"找不到 {PAGE}，請把 daytrade.html 放在同一個資料夾")
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"當沖戰情室已啟動： http://{'127.0.0.1' if a.host in ('0.0.0.0', '') else a.host}:{a.port}  （Ctrl+C 結束）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
