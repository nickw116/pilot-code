#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
金融技术分析图生成器 —— 缠论 + 头肩底 + 筹码 + 三档理论 + 综合K线 + 竖版信息图

Usage:
    python generate_analysis.py --symbol sh000001 --name 上证指数 --days 60
    python generate_analysis.py --symbol 000001 --name 平安银行 --days 40 --output-dir ./charts
    python generate_analysis.py --symbol sh000001 --name 上证指数 --days 60 --no-upload
"""

import argparse
import json
import math
import os
import shutil
import ssl
import subprocess
import sys
import warnings
from datetime import datetime, timedelta
from urllib.parse import urlencode
from urllib import request as urllib_request

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

# =============================================================================
# 0. 字体设置
# =============================================================================

def setup_chinese_font():
    """设置中文字体，优先 SC/CN 中文字体，自动 fallback。

    采用标准 matplotlib 字体配置方式：font.family='sans-serif' + font.sans-serif 列表。
    此方式兼容 mplfinance 等会恢复 rcParams 的库。
    """
    from matplotlib import font_manager

    # 清理 matplotlib 字体缓存，确保能找到系统新安装的字体
    cache_dir = matplotlib.get_cachedir()
    for fname in os.listdir(cache_dir):
        if "font" in fname.lower():
            try:
                os.remove(os.path.join(cache_dir, fname))
            except Exception:
                pass
    font_manager.fontManager = font_manager._load_fontmanager(try_read_cache=False)

    candidates = [
        "WenQuanYi Zen Hei",
        "WenQuanYi Micro Hei",
        "SimHei",
        "Noto Sans CJK SC",
        "Noto Serif CJK SC",
        "Source Han Sans CN",
        "Source Han Serif CN",
        "AR PL UMing CN",
        "DejaVu Sans",
    ]

    # 强制注册系统字体路径（解决 mplfinance 工厂模式下的 font cache 问题）
    font_dirs = ["/usr/share/fonts/truetype/wqy", "/usr/share/fonts/opentype/noto"]
    for fd in font_dirs:
        if os.path.isdir(fd):
            for fname in os.listdir(fd):
                fpath = os.path.join(fd, fname)
                if os.path.isfile(fpath) and fname.lower().endswith((".ttf", ".ttc", ".otf")):
                    try:
                        font_manager.fontManager.addfont(fpath)
                    except Exception:
                        pass

    chosen = None
    for fam in candidates:
        try:
            fp = font_manager.findfont(font_manager.FontProperties(family=fam))
            if fp and os.path.exists(fp) and "DejaVu" not in fp:
                chosen = fam
                break
        except Exception:
            continue

    if chosen is None:
        # Fallback: 从已注册字体中优先选 SC/CN 变体
        try:
            avail = [f.name for f in font_manager.fontManager.ttflist]
            sc_preferred = [n for n in avail if "SC" in n or "CN" in n or "Chinese" in n or "文泉" in n or "Zen" in n or "Song" in n or "Hei" in n]
            if sc_preferred:
                chosen = sc_preferred[0]
            else:
                for name in avail:
                    if any(k in name for k in ["CJK", "Hei", "Ming", "Micro"]):
                        chosen = name
                        break
        except Exception:
            pass

    if chosen:
        # 标准方式：font.family 设为通用族名，中文字体放在 sans-serif 列表首位
        plt.rcParams["font.family"] = "sans-serif"
        plt.rcParams["font.sans-serif"] = [chosen, "DejaVu Sans"]
        plt.rcParams["axes.unicode_minus"] = False
        print(f"[font] 使用字体: {chosen}")
        return chosen

    print("[font] 警告: 未找到合适中文字体，图表标签可能显示为方块")
    return None


# =============================================================================
# 1. 参数解析 & 数据获取
# =============================================================================

def parse_args():
    parser = argparse.ArgumentParser(description="Stock technical analysis chart generator")
    parser.add_argument("--symbol", type=str, default="sh000001", help="股票/指数代码")
    parser.add_argument("--name", type=str, default="上证指数", help="中文名称")
    parser.add_argument("--days", type=int, default=60, help="回溯天数")
    parser.add_argument("--output-dir", type=str, default="/tmp/stock_charts", help="输出目录")
    parser.add_argument("--no-charts", action="store_true", help="仅输出分析报告，不生成图表")
    parser.add_argument("--upload", action="store_true", default=True, help="上传图表到COS")
    parser.add_argument("--no-upload", dest="upload", action="store_false", help="跳过COS上传")
    return parser.parse_args()


def normalize_symbol(symbol: str):
    """标准化代码，返回 (code, market, is_index)。兼容 sh000001 / 000001.SH / 纯数字 000001。"""
    s = symbol.strip().lower()
    if s.startswith("sh"):
        code = s[2:]
        is_idx = code.startswith("0") or code.startswith("9")
        return code, "sh", is_idx
    if s.startswith("sz"):
        code = s[2:]
        is_idx = code.startswith("3") or code.startswith("9")
        return code, "sz", is_idx
        return s, "sz", s.startswith("3")
    return s, "sh", True


def _get_listing_date(code: str, market: str, is_index: bool):
    """获取个股上市日期，用于全历史拉取。指数返回一个很早的日期。"""
    import akshare as ak
    if is_index:
        return "19900101"
    try:
        info = ak.stock_info_a_code_name()
        if info is not None and not info.empty:
            # 列名兼容
            info.columns = [c.lower().strip() for c in info.columns]
            code_col = None
            for c in info.columns:
                if "code" in c or "\u80a1\u7968\u4ee3\u7801" in c or "\u4ee3\u7801" in c:
                    code_col = c
                    break
            if code_col:
                row = info[info[code_col] == code]
                if not row.empty:
                    for c in row.columns:
                        if "list" in c or "\u4e0a\u5e02" in c or "time" in c or "date" in c:
                            val = row[c].iloc[0]
                            if pd.notna(val):
                                try:
                                    d = pd.to_datetime(val)
                                    return d.strftime("%Y%m%d")
                                except Exception:
                                    continue
    except Exception as e:
        print(f"[fetch] 获取上市日期失败: {e}")
    # fallback：直接拉全部
    return "19900101"


# ── 国信证券 API ────────────────────────────────────────────────

_GS_BASE_URL = "https://dgzt.guosen.com.cn/skills"


def _gs_make_request(endpoint, params, timeout=15):
    """国信证券 HTTPS 请求（宽松 SSL + curl fallback）。"""
    api_key = os.environ.get("GS_API_KEY", "")
    if not api_key:
        # 尝试从 memory.md 读取
        for candidate in [
            os.path.join(os.path.dirname(__file__), "..", "gs-stock-market-query", "memory.md"),
            os.path.join(os.path.dirname(__file__), "..", "gs-stock-financial-query", "memory.md"),
        ]:
            if os.path.exists(candidate):
                for line in open(candidate):
                    if line.startswith("GS_API_KEY="):
                        api_key = line.strip().split("=", 1)[1]
                        break
            if api_key:
                break
    if not api_key:
        return None

    params = {**params, "softName": "agent_skills", "apiKey": api_key}
    url = f"{_GS_BASE_URL}{endpoint}?{urlencode(params)}"

    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.set_ciphers("ALL:@SECLEVEL=0")
        ctx.options |= ssl.OP_LEGACY_SERVER_CONNECT
        req = urllib_request.Request(url)
        with urllib_request.urlopen(req, context=ctx, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        try:
            r = subprocess.run(["curl", "-s", "-k", url], capture_output=True, text=True, timeout=timeout)
            if r.returncode == 0 and r.stdout.strip():
                return json.loads(r.stdout)
        except Exception:
            pass
    return None


def fetch_gs_fund_flow(code, set_code, period=10):
    """国信资金流向。set_code: 0=深, 1=沪。返回主力净流入等指标。"""
    resp = _gs_make_request(
        "/gsnews/market/agentbot/queryFundFlow/1.0",
        {"code": code, "setCode": str(set_code), "period": str(period)},
    )
    if not resp:
        return {}
    result = resp.get("result", {})
    if isinstance(result, list):
        result = result[0] if result else {}
    if result.get("code") != 0:
        return {}
    # 数据在 object 或 data 字段中
    data = resp.get("object") or resp.get("data", {})
    if isinstance(data, dict):
        return {
            "main_net_inflow": _safe_float(data.get("mainNetInflow")),
            "net_inflow": _safe_float(data.get("netInflow")),
            "period": data.get("period", ""),
        }
    return {}


def fetch_gs_financials(code, market):
    """国信利润表关键指标。market: SH/SZ。"""
    resp = _gs_make_request(
        "/gsnews/gsf10/financial/incomeStatement/1.0",
        {"code": code, "market": market.upper(), "reportType": "Q0", "count": "2"},
    )
    if not resp:
        return {}
    result = resp.get("result", {})
    if isinstance(result, list):
        result = result[0] if result else {}
    if result.get("code") != 0:
        return {}
    # 数据在 income 或 data.info 字段中
    info = resp.get("income") or resp.get("data", {}).get("info", [])
    if not isinstance(info, list) or len(info) == 0:
        return {}

    def _field(rec, *keys):
        for k in keys:
            v = rec.get(k)
            if v is not None and v != "" and v != "-":
                return v
        return None

    latest = info[0] if isinstance(info[0], dict) else {}
    prev = info[1] if len(info) > 1 and isinstance(info[1], dict) else {}

    revenue = _safe_float(_field(latest, "totalOperateRevenue", "operatingRevenue", "revenue"))
    prev_revenue = _safe_float(_field(prev, "totalOperateRevenue", "operatingRevenue", "revenue"))
    net_profit = _safe_float(_field(latest, "netProfit", "parentNetProfit", "attributableNetProfit", "totalCompositeIncome"))
    prev_net_profit = _safe_float(_field(prev, "netProfit", "parentNetProfit", "attributableNetProfit", "totalCompositeIncome"))
    gross_margin = _safe_float(_field(latest, "grossProfitMargin", "grossMargin"))
    roe = _safe_float(_field(latest, "roe", "ROE", "weightedRoe"))
    eps = _safe_float(_field(latest, "basicEps", "eps", "EPS", "basiceEps"))

    revenue_yoy = ((revenue - prev_revenue) / prev_revenue) if prev_revenue and prev_revenue != 0 else None
    profit_yoy = ((net_profit - prev_net_profit) / prev_net_profit) if prev_net_profit and prev_net_profit != 0 else None

    return {
        "revenue": revenue,
        "revenue_yoy": round(revenue_yoy, 4) if revenue_yoy is not None else None,
        "net_profit": net_profit,
        "net_profit_yoy": round(profit_yoy, 4) if profit_yoy is not None else None,
        "gross_margin": gross_margin,
        "roe": roe,
        "eps": eps,
        "report_date": latest.get("year", latest.get("reportDate", latest.get("endDate", ""))),
    }


def fetch_gs_balance_sheet(code, market):
    """国信资产负债表关键指标。market: SH/SZ。"""
    resp = _gs_make_request(
        "/gsnews/gsf10/financial/balanceSheet/1.0",
        {"code": code, "market": market.upper(), "reportType": "Q0", "count": "2"},
    )
    if not resp:
        return {}
    result = resp.get("result", {})
    if isinstance(result, list):
        result = result[0] if result else {}
    if result.get("code") != 0:
        return {}
    info = resp.get("balance") or resp.get("data", {}).get("info", [])
    if not isinstance(info, list) or len(info) == 0:
        return {}

    def _field(rec, *keys):
        for k in keys:
            v = rec.get(k)
            if v is not None and v != "" and v != "-":
                return v
        return None

    latest = info[0] if isinstance(info[0], dict) else {}
    total_assets = _safe_float(_field(latest, "totalAssets", "total_assets"))
    total_liab = _safe_float(_field(latest, "totalLiab", "total_liabilities", "totalLiability"))
    current_assets = _safe_float(_field(latest, "totalCurrentAssets", "currentAssets"))
    current_liab = _safe_float(_field(latest, "totalCurrentLiab", "currentLiabilities", "currentLiability"))
    net_assets = _safe_float(_field(latest, "totalParentEquity", "totalEquity", "totalShareholderEquity"))
    bvps = _safe_float(_field(latest, "bvps", "bookValuePerShare", "netAssetPerShare"))

    debt_ratio = (total_liab / total_assets) if total_assets and total_liab and total_assets > 0 else None
    current_ratio = (current_assets / current_liab) if current_assets and current_liab and current_liab > 0 else None

    return {
        "total_assets": total_assets,
        "total_liabilities": total_liab,
        "debt_ratio": round(debt_ratio, 4) if debt_ratio is not None else None,
        "current_ratio": round(current_ratio, 2) if current_ratio is not None else None,
        "net_assets": net_assets,
        "bvps": bvps,
        "report_date": latest.get("year", latest.get("reportDate", latest.get("endDate", ""))),
    }


def fetch_gs_cashflow(code, market):
    """国信现金流量表关键指标。market: SH/SZ。"""
    resp = _gs_make_request(
        "/gsnews/gsf10/financial/cashFlowStatement/1.0",
        {"code": code, "market": market.upper(), "reportType": "Q0", "count": "2"},
    )
    if not resp:
        return {}
    result = resp.get("result", {})
    if isinstance(result, list):
        result = result[0] if result else {}
    if result.get("code") != 0:
        return {}
    info = resp.get("cashflow") or resp.get("data", {}).get("info", [])
    if not isinstance(info, list) or len(info) == 0:
        return {}

    def _field(rec, *keys):
        for k in keys:
            v = rec.get(k)
            if v is not None and v != "" and v != "-":
                return v
        return None

    latest = info[0] if isinstance(info[0], dict) else {}
    prev = info[1] if len(info) > 1 and isinstance(info[1], dict) else {}

    ocf = _safe_float(_field(latest, "netCashOperate", "operatingCashFlow", "operateCashFlow"))
    icf = _safe_float(_field(latest, "netCashInvest", "investingCashFlow", "investCashFlow"))
    fcf = _safe_float(_field(latest, "netCashFinance", "financingCashFlow", "financeCashFlow"))
    prev_ocf = _safe_float(_field(prev, "netCashOperate", "operatingCashFlow", "operateCashFlow"))

    fcf_yield = None
    if ocf is not None and icf is not None:
        free_cash_flow = ocf + icf
    else:
        free_cash_flow = None

    ocf_yoy = ((ocf - prev_ocf) / abs(prev_ocf)) if ocf and prev_ocf and prev_ocf != 0 else None

    return {
        "operating_cash_flow": ocf,
        "investing_cash_flow": icf,
        "financing_cash_flow": fcf,
        "free_cash_flow": free_cash_flow,
        "ocf_yoy": round(ocf_yoy, 4) if ocf_yoy is not None else None,
        "report_date": latest.get("year", latest.get("reportDate", latest.get("endDate", ""))),
    }


def _safe_float(val):
    if val is None or val == "" or val == "-":
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _parse_westock_table(output):
    """解析 WeStock markdown 表格输出为 DataFrame。"""
    lines = output.strip().split("\n")
    if len(lines) < 2:
        return None
    # 跳过 separator 行（| --- | ...）
    data_lines = [l for l in lines if l.strip() and "---" not in l]
    if len(data_lines) < 2:
        return None
    # 解析 header
    header = [c.strip() for c in data_lines[0].strip("|").split("|")]
    rows = []
    for line in data_lines[1:]:
        vals = [c.strip() for c in line.strip("|").split("|")]
        if len(vals) == len(header):
            rows.append(vals)
    if not rows:
        return None
    df = pd.DataFrame(rows, columns=header)
    return df


def fetch_data_westock(full_symbol: str, limit: int = 2000):
    """通过 WeStock Data (腾讯自选股) 拉取日K数据。"""
    cmd = [
        "npx", "-y", "westock-data-clawhub@1.0.4",
        "kline", full_symbol,
        "--period", "day", "--limit", str(limit), "--fq", "qfq",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        return None
    df = _parse_westock_table(result.stdout)
    if df is None or df.empty:
        return None
    # 列映射
    if "last" in df.columns and "close" not in df.columns:
        df = df.rename(columns={"last": "close"})
    if "exchange" in df.columns and "turnover" not in df.columns:
        df["turnover"] = pd.to_numeric(df["exchange"], errors="coerce") / 100.0
        df = df.drop(columns=["exchange"])
    # 类型转换
    for col in ["open", "close", "high", "low", "volume", "amount", "turnover"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").reset_index(drop=True)
    return df


def fetch_data(symbol: str, days: int, full_history: bool = False):
    """拉取日K数据。优先 WeStock，fallback 到 akshare。"""
    code, market, is_index = normalize_symbol(symbol)
    full_symbol = market + code
    limit = 2000 if full_history else min(int(days * 1.8), 2000)

    df = None
    errors = []

    # 方法1: WeStock Data (腾讯自选股)
    try:
        df = fetch_data_westock(full_symbol, limit=limit)
        if df is not None and not df.empty:
            print(f"[fetch] WeStock kline: {len(df)} rows")
    except Exception as e:
        errors.append(f"WeStock: {e}")

    # 方法2-5: AKShare fallback
    if df is None or df.empty:
        import akshare as ak
        end_date = datetime.now()
        end_str = end_date.strftime("%Y%m%d")

        if full_history:
            start_str = _get_listing_date(code, market, is_index)
        else:
            start_str = (end_date - timedelta(days=int(days * 1.8))).strftime("%Y%m%d")

        if is_index:
            try:
                df = ak.index_zh_a_hist(symbol=full_symbol, period="daily", start_date=start_str, end_date=end_str)
                if df is not None and not df.empty:
                    print(f"[fetch] index_zh_a_hist: {len(df)} rows")
            except Exception as e:
                errors.append(f"index_zh_a_hist: {e}")

        if df is None or df.empty:
            try:
                df = ak.stock_zh_a_hist(symbol=code, period="daily", start_date=start_str, end_date=end_str, adjust="qfq")
                if df is not None and not df.empty:
                    print(f"[fetch] stock_zh_a_hist: {len(df)} rows")
            except Exception as e:
                errors.append(f"stock_zh_a_hist: {e}")

        if df is None or df.empty:
            try:
                df = ak.stock_zh_a_hist_tx(symbol=full_symbol, start_date=start_str, end_date=end_str)
                if df is not None and not df.empty:
                    print(f"[fetch] stock_zh_a_hist_tx: {len(df)} rows")
            except Exception as e:
                errors.append(f"stock_zh_a_hist_tx: {e}")

        if (df is None or df.empty) and is_index:
            try:
                df = ak.stock_zh_index_daily_em(symbol=full_symbol)
                if df is not None and not df.empty:
                    start_fmt = datetime.strptime(start_str, "%Y%m%d").strftime("%Y-%m-%d")
                    end_fmt = end_date.strftime("%Y-%m-%d")
                    df = df[(df["date"] >= start_fmt) & (df["date"] <= end_fmt)]
                    print(f"[fetch] stock_zh_index_daily_em: {len(df)} rows")
            except Exception as e:
                errors.append(f"stock_zh_index_daily_em: {e}")

    if df is None or df.empty:
        print("[fetch] 所有方法均失败:")
        for err in errors:
            print(f"  - {err}")
        sys.exit(1)

    # 标准化列名
    df = df.copy()
    df.columns = [c.lower().strip() for c in df.columns]
    col_map = {
        "\u65e5\u671f": "date", "date": "date",
        "\u5f00\u76d8": "open", "open": "open",
        "\u6536\u76d8": "close", "close": "close",
        "\u6700\u9ad8": "high", "high": "high",
        "\u6700\u4f4e": "low", "low": "low",
        "\u6210\u4ea4\u91cf": "volume", "volume": "volume",
        "\u6210\u4ea4\u989d": "amount", "amount": "amount",
        "\u6da8\u8dcc\u5e45": "pct_chg", "pct_chg": "pct_chg",
        "\u632f\u5e45": "amplitude", "amplitude": "amplitude",
        "\u6362\u624b\u7387": "turnover", "turnover": "turnover",
    }
    rename = {}
    for old, new in col_map.items():
        if old in df.columns and new not in df.columns:
            rename[old] = new
    if rename:
        df = df.rename(columns=rename)

    # 腾讯数据源 amount = 成交额，需要转换为成交量或作为 volume 兜底
    if "volume" not in df.columns and "amount" in df.columns:
        # 用成交额近似替代成交量（无准确成交量时）
        df["volume"] = df["amount"]
    if "volume" not in df.columns:
        df["volume"] = 1e6  # 默认值
    if "turnover" not in df.columns:
        df["turnover"] = 0.002

    df["date"] = pd.to_datetime(df["date"])
    for col in ["open", "high", "low", "close", "volume"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    if "amount" in df.columns:
        df["amount"] = pd.to_numeric(df["amount"], errors="coerce")
    if "turnover" in df.columns:
        df["turnover"] = pd.to_numeric(df["turnover"], errors="coerce")

    df = df.dropna(subset=["open", "high", "low", "close"])
    df = df.sort_values("date").reset_index(drop=True)

    return df, code, market


# =============================================================================
# 2. 技术指标
# =============================================================================

def calc_macd(df: pd.DataFrame, fast=12, slow=26, signal=9):
    df = df.copy()
    ema_fast = df["close"].ewm(span=fast, adjust=False).mean()
    ema_slow = df["close"].ewm(span=slow, adjust=False).mean()
    df["dif"] = ema_fast - ema_slow
    df["dea"] = df["dif"].ewm(span=signal, adjust=False).mean()
    df["hist"] = 2 * (df["dif"] - df["dea"])
    return df


def calc_ma(df: pd.DataFrame, periods=(5, 10, 20)):
    df = df.copy()
    for p in periods:
        df[f"ma{p}"] = df["close"].rolling(window=p).mean()
    return df


# =============================================================================
# 2.5 CYQ 筹码分布分析
# =============================================================================

def _parse_turnover(value):
    """解析换手率，自动识别百分比或小数格式。"""
    if pd.isna(value):
        return 0.0
    value = float(value)
    return value / 100 if value > 1 else value


def calculate_cyq(df: pd.DataFrame, price_step=0.1, min_price_bins=100):
    """
    计算筹码分布 (CYQ)
    参数:
        df: DataFrame with columns ['open', 'high', 'low', 'close', 'turnover']
        price_step: 价格步长（默认0.1）
        min_price_bins: 最小价格区间数
    """
    n_days = len(df)
    if n_days == 0:
        return None

    df = df.copy().reset_index(drop=True)
    # 确保有 turnover 列，无则使用默认换手率 0.2%（早期数据常见）
    if "turnover" not in df.columns:
        df["turnover"] = 0.002
    df["turnover"] = pd.to_numeric(df["turnover"], errors="coerce").fillna(0.002)

    min_price = float(df["low"].min())
    max_price = float(df["high"].max())
    price_range = max_price - min_price

    n_bins = max(int(price_range / price_step) + 1, min_price_bins)
    price_bins = np.linspace(min_price, max_price, n_bins)

    chip_distribution = np.zeros(n_bins - 1)

    for i in range(n_days):
        day = df.iloc[i]
        open_p = float(day["open"])
        high = float(day["high"])
        low = float(day["low"])
        close = float(day["close"])
        turnover = _parse_turnover(day["turnover"])

        typical_price = (open_p + high + low + close) / 4.0

        # 三角分布
        a, b, c = low, high, typical_price

        for j in range(len(price_bins) - 1):
            bin_center = (price_bins[j] + price_bins[j + 1]) / 2.0

            if bin_center < a:
                density = 0.0
            elif bin_center < c:
                density = 2 * (bin_center - a) / ((b - a) * (c - a)) if c != a else 0.0
            elif bin_center <= b:
                density = 2 * (b - bin_center) / ((b - a) * (b - c)) if b != c else 0.0
            else:
                density = 0.0

            chip_distribution[j] += density * turnover

        # 历史筹码衰减
        if i < n_days - 1:
            chip_distribution *= (1 - turnover)

    # 归一化
    total = chip_distribution.sum()
    if total > 0:
        chip_distribution /= total

    current_price = float(df["close"].iloc[-1])

    # 获利盘比例（当前价以下筹码）
    profit_ratio = float(chip_distribution[price_bins[:-1] <= current_price].sum())

    # 平均成本
    avg_cost = float(np.sum(price_bins[:-1] * chip_distribution))

    # 筹码峰值
    peak_idx = int(np.argmax(chip_distribution))
    peak_price = float(price_bins[peak_idx])

    # 90%筹码集中度
    cumsum = np.cumsum(chip_distribution)
    idx_5 = int(np.searchsorted(cumsum, 0.05))
    idx_95 = int(np.searchsorted(cumsum, 0.95))
    price_low_90 = float(price_bins[idx_5])
    price_high_90 = float(price_bins[idx_95])
    if price_high_90 + price_low_90 > 0:
        concentration = (price_high_90 - price_low_90) / (price_high_90 + price_low_90)
    else:
        concentration = 0.0

    # 主力成本区（最密集的20%筹码）
    sorted_idx = np.argsort(chip_distribution)[::-1]
    cumsum_sorted = np.cumsum(chip_distribution[sorted_idx])
    main_indices = sorted_idx[cumsum_sorted <= 0.20]
    if len(main_indices) > 0:
        main_low = float(price_bins[main_indices.min()])
        main_high = float(price_bins[min(main_indices.max() + 1, len(price_bins) - 1)])
    else:
        main_low = main_high = peak_price

    return {
        "price_bins": price_bins[:-1].tolist(),
        "chip_distribution": chip_distribution.tolist(),
        "current_price": current_price,
        "profit_ratio": profit_ratio,
        "avg_cost": avg_cost,
        "peak_price": peak_price,
        "concentration": float(concentration),
        "main_force_low": main_low,
        "main_force_high": main_high,
        "price_low_90": price_low_90,
        "price_high_90": price_high_90,
    }


def fetch_cyq_westock(full_symbol: str):
    """通过 WeStock chip 命令获取腾讯筹码分布指标。"""
    cmd = [
        "npx", "-y", "westock-data-clawhub@1.0.4",
        "chip", full_symbol,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return None
    df = _parse_westock_table(result.stdout)
    if df is None or df.empty:
        return None
    latest = df.iloc[-1]
    return {
        "profit_ratio": float(latest.get("chipProfitRate", 0)) / 100.0,
        "avg_cost": float(latest.get("chipAvgCost", 0)),
        "concentration": float(latest.get("chipConcentration90", 0)),
        "concentration_70": float(latest.get("chipConcentration70", 0)),
    }


# =============================================================================
# 3. 缠论分析器
# =============================================================================

class ChanLunAnalyzer:
    def __init__(self, df: pd.DataFrame):
        self.df = df.copy().reset_index(drop=True)
        self.processed_klines = self._process_klines()
        self.top_fractals = []
        self.bottom_fractals = []
        self.pens = []
        self.segments = []
        self.centers = []
        self.divergences = []
        self.buy_sell_points = []

    def _process_klines(self):
        """K线包含处理：方向感知合并。"""
        df = self.df.copy()
        processed = []
        i = 0
        while i < len(df):
            curr = df.iloc[i]
            if not processed:
                processed.append(curr)
                i += 1
                continue
            prev = processed[-1]
            if len(processed) >= 2:
                direction = 1 if processed[-1]["high"] >= processed[-2]["high"] else -1
            else:
                direction = 1 if curr["close"] >= prev["close"] else -1
            if curr["high"] >= prev["high"] and curr["low"] <= prev["low"]:
                if direction > 0:
                    new_high = max(curr["high"], prev["high"])
                    new_low = max(curr["low"], prev["low"])
                else:
                    new_high = min(curr["high"], prev["high"])
                    new_low = min(curr["low"], prev["low"])
                processed[-1] = pd.Series({
                    "date": curr["date"] if "date" in curr.index else prev.get("date", ""),
                    "open": prev["open"],
                    "high": new_high,
                    "low": new_low,
                    "close": curr["close"],
                    "volume": prev.get("volume", 0) + curr.get("volume", 0),
                })
            else:
                processed.append(curr)
            i += 1
        return pd.DataFrame(processed).reset_index(drop=True)

    def find_fractals(self):
        """在包含处理后的K线上识别顶底分型（4条件严格判断）。"""
        kl = self.processed_klines
        n = len(kl)
        for i in range(1, n - 1):
            ch, ph, nh = kl["high"].iloc[i], kl["high"].iloc[i - 1], kl["high"].iloc[i + 1]
            cl, pl, nl = kl["low"].iloc[i], kl["low"].iloc[i - 1], kl["low"].iloc[i + 1]
            if ch > ph and ch > nh and cl > pl and cl > nl:
                orig_idx = kl.index[i]
                self.top_fractals.append(int(orig_idx))
            if cl < pl and cl < nl and ch < ph and ch < nh:
                orig_idx = kl.index[i]
                self.bottom_fractals.append(int(orig_idx))

    def find_pens(self):
        """识别笔：顶底交替连接，最少间隔1根K线。"""
        points = []
        for idx in self.top_fractals:
            points.append({"idx": idx, "type": "top", "price": float(self.df["high"].iloc[idx])})
        for idx in self.bottom_fractals:
            points.append({"idx": idx, "type": "bottom", "price": float(self.df["low"].iloc[idx])})
        points.sort(key=lambda x: x["idx"])
        if len(points) < 2:
            return
        pen_start = points[0]
        for i in range(1, len(points)):
            if points[i]["type"] != pen_start["type"]:
                if points[i]["idx"] - pen_start["idx"] >= 2:
                    direction = "up" if pen_start["type"] == "bottom" else "down"
                    self.pens.append({
                        "start_idx": int(pen_start["idx"]),
                        "end_idx": int(points[i]["idx"]),
                        "direction": direction,
                        "start_price": float(pen_start["price"]),
                        "end_price": float(points[i]["price"]),
                    })
                    pen_start = points[i]

    def find_segments(self):
        """识别线段：至少3笔，有重叠区域。"""
        if len(self.pens) < 3:
            return
        i = 0
        while i <= len(self.pens) - 3:
            p1, p2, p3 = self.pens[i], self.pens[i + 1], self.pens[i + 2]
            all_highs = [p1["start_price"], p1["end_price"], p2["start_price"],
                         p2["end_price"], p3["start_price"], p3["end_price"]]
            all_lows = list(all_highs)
            for pen in [p1, p2, p3]:
                s, e = pen["start_idx"], pen["end_idx"]
                all_lows.extend([float(self.df["low"].iloc[min(s, e)]),
                                 float(self.df["low"].iloc[max(s, e)])])
            overlap_high = min(max(all_highs[j], all_highs[j + 1]) for j in range(0, len(all_highs) - 1, 2))
            overlap_low = max(min(all_lows[j], all_lows[j + 1]) for j in range(0, len(all_lows) - 1, 2))
            if overlap_high > overlap_low:
                direction = "up" if p1["direction"] == "up" else "down"
                self.segments.append({
                    "start_idx": p1["start_idx"],
                    "end_idx": p3["end_idx"],
                    "direction": direction,
                    "overlap_high": round(float(overlap_high), 2),
                    "overlap_low": round(float(overlap_low), 2),
                })
                i += 3
            else:
                i += 1

    def find_centers(self):
        """识别中枢：3笔重叠区间（滑动窗口）。"""
        if len(self.pens) < 3:
            return
        for i in range(len(self.pens) - 2):
            p1, p2, p3 = self.pens[i], self.pens[i + 1], self.pens[i + 2]
            start_idx = min(p1["start_idx"], p2["start_idx"], p3["start_idx"])
            end_idx = max(p1["end_idx"], p2["end_idx"], p3["end_idx"])
            if end_idx - start_idx < 5:
                continue
            pen_prices = [p1["start_price"], p1["end_price"], p2["start_price"],
                          p2["end_price"], p3["start_price"], p3["end_price"]]
            hh = min(max(pen_prices[j], pen_prices[j + 1]) for j in range(0, 5, 2))
            ll = max(min(pen_prices[j], pen_prices[j + 1]) for j in range(0, 5, 2))
            if hh > ll:
                if not self.centers or start_idx > self.centers[-1]["end_idx"]:
                    self.centers.append({
                        "start_idx": int(start_idx),
                        "end_idx": int(end_idx),
                        "high": round(float(hh), 2),
                        "low": round(float(ll), 2),
                    })

    def find_divergence(self):
        """MACD柱面积背驰检测（面积缩小>20%判定）。"""
        if len(self.pens) < 2 or "hist" not in self.df.columns:
            return
        for i in range(len(self.pens) - 1):
            p1, p2 = self.pens[i], self.pens[i + 1]
            if p1["direction"] == p2["direction"]:
                continue
            s1, e1 = min(p1["start_idx"], p1["end_idx"]), max(p1["start_idx"], p1["end_idx"])
            s2, e2 = min(p2["start_idx"], p2["end_idx"]), max(p2["start_idx"], p2["end_idx"])
            area1 = float(abs(self.df["hist"].iloc[s1:e1 + 1]).sum())
            area2 = float(abs(self.df["hist"].iloc[s2:e2 + 1]).sum())
            if area1 == 0:
                continue
            if p2["direction"] == "down":
                price1, price2 = p1["start_price"], p2["end_price"]
                if price2 < price1 and area2 < 0.8 * area1:
                    self.divergences.append({
                        "idx": int(p2["end_idx"]),
                        "type": "\u5e95\u80cc\u9a70",
                        "price": round(float(price2), 2),
                        "confidence": round(1 - area2 / area1, 2),
                        "note": "MACD面积缩小{:.0f}%，价格创新低，可能见底".format((1 - area2 / area1) * 100),
                    })
            else:
                price1, price2 = p1["start_price"], p2["end_price"]
                if price2 > price1 and area2 < 0.8 * area1:
                    self.divergences.append({
                        "idx": int(p2["end_idx"]),
                        "type": "\u9876\u80cc\u9a70",
                        "price": round(float(price2), 2),
                        "confidence": round(1 - area2 / area1, 2),
                        "note": "MACD面积缩小{:.0f}%，价格创新高，可能见顶".format((1 - area2 / area1) * 100),
                    })

    def find_buy_sell_points(self):
        """识别三类买卖点。"""
        if not self.centers or not self.pens:
            return
        last_center = self.centers[-1]
        last_price = float(self.df["close"].iloc[-1])
        for div in self.divergences:
            if div["type"] == "\u5e95\u80cc\u9a70" and div["idx"] >= len(self.df) - 10:
                self.buy_sell_points.append({
                    "type": "\u7b2c\u4e00\u7c7b\u4e70\u70b9",
                    "idx": div["idx"],
                    "price": div["price"],
                    "reason": "\u4e0b\u8dcc\u8d8b\u52bf\u5e95\u80cc\u9a70\uff0c\u8f6c\u6298\u786e\u8ba4",
                })
                break
            if div["type"] == "\u9876\u80cc\u9a70" and div["idx"] >= len(self.df) - 10:
                self.buy_sell_points.append({
                    "type": "\u7b2c\u4e00\u7c7b\u5356\u70b9",
                    "idx": div["idx"],
                    "price": div["price"],
                    "reason": "\u4e0a\u6da8\u8d8b\u52bf\u9876\u80cc\u9a70\uff0c\u8f6c\u6298\u786e\u8ba4",
                })
                break
        if len(self.pens) >= 2:
            last_pen = self.pens[-1]
            if last_pen["direction"] == "up":
                retrace_low = last_pen["start_price"]
                if retrace_low > last_center["low"] and retrace_low >= len(self.df) - 15:
                    self.buy_sell_points.append({
                        "type": "\u7b2c\u4e8c\u7c7b\u4e70\u70b9",
                        "price": round(retrace_low, 2),
                        "reason": "\u7b2c\u4e00\u7c7b\u4e70\u70b9\u540e\u56de\u62bd\u4e0d\u7834\u4e2d\u67a2\u4f4e\u70b9",
                    })
            if last_pen["direction"] == "down":
                retrace_high = last_pen["start_price"]
                if retrace_high < last_center["high"] and retrace_high >= len(self.df) - 15:
                    self.buy_sell_points.append({
                        "type": "\u7b2c\u4e8c\u7c7b\u5356\u70b9",
                        "price": round(retrace_high, 2),
                        "reason": "\u7b2c\u4e00\u7c7b\u5356\u70b9\u540e\u56de\u62bd\u4e0d\u7834\u4e2d\u67a2\u9ad8\u70b9",
                    })
        if last_price > last_center["high"]:
            recent_low = float(self.df["low"].tail(5).min())
            if recent_low > last_center["high"]:
                self.buy_sell_points.append({
                    "type": "\u7b2c\u4e09\u7c7b\u4e70\u70b9",
                    "price": round(recent_low, 2),
                    "reason": "\u7a81\u7834\u4e2d\u67a2\u540e\u56de\u62bd\u4e0d\u8fdb\u5165\u4e2d\u67a2\u533a\u95f4",
                })
        elif last_price < last_center["low"]:
            recent_high = float(self.df["high"].tail(5).max())
            if recent_high < last_center["low"]:
                self.buy_sell_points.append({
                    "type": "\u7b2c\u4e09\u7c7b\u5356\u70b9",
                    "price": round(recent_high, 2),
                    "reason": "\u8dcc\u7834\u4e2d\u67a2\u540e\u53cd\u5f39\u4e0d\u8fdb\u5165\u4e2d\u67a2\u533a\u95f4",
                })

    def analyze(self):
        self.find_fractals()
        self.find_pens()
        self.find_segments()
        self.find_centers()
        self.find_divergence()
        self.find_buy_sell_points()
        return {
            "top_fractals": self.top_fractals,
            "bottom_fractals": self.bottom_fractals,
            "pens": self.pens,
            "segments": self.segments,
            "centers": self.centers,
            "divergences": self.divergences,
            "buy_sell_points": self.buy_sell_points,
            "trend": self._trend(),
        }

    def _trend(self):
        if not self.centers:
            if not self.pens:
                return "\u5206\u578b\u4e0d\u8db3\uff0c\u65e0\u6cd5\u5224\u65ad"
            last = self.pens[-1]
            return "\u4e0a\u6da8\u8d8b\u52bf\uff08\u6700\u540e\u4e00\u7b14\u5411\u4e0a\uff09" if last["direction"] == "up" else "\u4e0b\u8dcc\u8d8b\u52bf\uff08\u6700\u540e\u4e00\u7b14\u5411\u4e0b\uff09"
        if len(self.centers) >= 2:
            c1, c2 = self.centers[-2], self.centers[-1]
            if c2["high"] > c1["high"] and c2["low"] > c1["low"]:
                return "\u4e0a\u6da8\u8d8b\u52bf\uff08\u4e2d\u67a2\u9010\u6b65\u62ac\u9ad8\uff09"
            if c2["high"] < c1["high"] and c2["low"] < c1["low"]:
                return "\u4e0b\u8dcc\u8d8b\u52bf\uff08\u4e2d\u67a2\u9010\u6b65\u4e0b\u964d\uff09"
            return "\u76d8\u6574\u8d8b\u52bf\uff08\u4e2d\u67a2\u6a2a\u5411\u79fb\u52a8\uff09"
        last = self.pens[-1] if self.pens else None
        if last:
            return "\u4e0a\u6da8\u8d8b\u52bf" if last["direction"] == "up" else "\u4e0b\u8dcc\u8d8b\u52bf"
        return "\u6570\u636e\u4e0d\u8db3"


# =============================================================================
# 4. 道氏理论分析器
# =============================================================================

class DowTheoryAnalyzer:
    def __init__(self, df: pd.DataFrame):
        self.df = df.copy().reset_index(drop=True)
        self.peaks = []
        self.troughs = []
        self.trend_lines = []
        self.supports = []
        self.resistances = []

    def find_peaks_troughs(self, order=2):
        """识别波峰波谷，order 为左右各需几根K线确认。"""
        highs = self.df["high"].values
        lows = self.df["low"].values
        n = len(highs)
        for i in range(order, n - order):
            if all(highs[i] >= highs[i - j] for j in range(1, order + 1)) and \
               all(highs[i] >= highs[i + j] for j in range(1, order + 1)):
                self.peaks.append((i, float(highs[i])))
            if all(lows[i] <= lows[i - j] for j in range(1, order + 1)) and \
               all(lows[i] <= lows[i + j] for j in range(1, order + 1)):
                self.troughs.append((i, float(lows[i])))

    def find_trend_lines(self):
        """识别上升/下降趋势线。"""
        if len(self.troughs) >= 2:
            for i in range(len(self.troughs) - 1):
                t1, t2 = self.troughs[i], self.troughs[i + 1]
                if t2[0] > t1[0] and t2[1] > t1[1]:
                    self.trend_lines.append({
                        "type": "up",
                        "start_idx": t1[0], "start_price": t1[1],
                        "end_idx": t2[0], "end_price": t2[1],
                    })
        if len(self.peaks) >= 2:
            for i in range(len(self.peaks) - 1):
                p1, p2 = self.peaks[i], self.peaks[i + 1]
                if p2[0] > p1[0] and p2[1] < p1[1]:
                    self.trend_lines.append({
                        "type": "down",
                        "start_idx": p1[0], "start_price": p1[1],
                        "end_idx": p2[0], "end_price": p2[1],
                    })

    def find_support_resistance(self):
        """基于近期高低点和均线确定支撑压力位。"""
        recent = self.df.tail(20)
        recent_high = float(recent["high"].max())
        recent_low = float(recent["low"].min())
        recent_high_date = str(recent[recent["high"] == recent_high]["date"].iloc[0].date())
        recent_low_date = str(recent[recent["low"] == recent_low]["date"].iloc[0].date())

        ma5 = float(self.df["ma5"].iloc[-1]) if "ma5" in self.df.columns and not pd.isna(self.df["ma5"].iloc[-1]) else None
        ma10 = float(self.df["ma10"].iloc[-1]) if "ma10" in self.df.columns and not pd.isna(self.df["ma10"].iloc[-1]) else None
        ma20 = float(self.df["ma20"].iloc[-1]) if "ma20" in self.df.columns and not pd.isna(self.df["ma20"].iloc[-1]) else None

        self.supports = []
        self.resistances = []

        if ma20 is not None:
            self.supports.append({"price": round(ma20, 2), "label": "MA20\u652f\u6491"})
        self.supports.append({"price": round(recent_low, 2), "label": f"\u8fd1\u671f\u4f4e\u70b9 {recent_low_date[5:]}"})
        if ma10 is not None:
            self.supports.append({"price": round(ma10, 2), "label": "MA10\u652f\u6491"})

        if ma5 is not None:
            self.resistances.append({"price": round(ma5, 2), "label": "MA5\u538b\u529b"})
        self.resistances.append({"price": round(recent_high, 2), "label": f"\u8fd1\u671f\u9ad8\u70b9 {recent_high_date[5:]}"})
        if ma20 is not None:
            self.resistances.append({"price": round(ma20 * 1.02, 2), "label": "MA20\u6269\u5c55\u538b\u529b"})

        return {
            "recent_high": round(recent_high, 2),
            "recent_high_date": recent_high_date,
            "recent_low": round(recent_low, 2),
            "recent_low_date": recent_low_date,
        }

    def identify_trends(self):
        """识别主要趋势与次要趋势。"""
        n = len(self.df)
        ma20 = self.df["ma20"].values if "ma20" in self.df.columns else np.full(n, np.nan)
        if not np.isnan(ma20[-1]) and not np.isnan(ma20[-5]):
            if ma20[-1] > ma20[-5]:
                primary = "\u4e0a\u5347\u8d8b\u52bf"
            elif ma20[-1] < ma20[-5]:
                primary = "\u4e0b\u964d\u8d8b\u52bf"
            else:
                primary = "\u6a2a\u76d8\u6574\u7406"
        else:
            primary = "\u6570\u636e\u4e0d\u8db3"

        recent_highs, recent_lows = [], []
        for i in range(max(1, n - 5), n - 1):
            if self.df["high"].iloc[i] > self.df["high"].iloc[i - 1] and self.df["high"].iloc[i] > self.df["high"].iloc[i + 1]:
                recent_highs.append((i, self.df["high"].iloc[i]))
            if self.df["low"].iloc[i] < self.df["low"].iloc[i - 1] and self.df["low"].iloc[i] < self.df["low"].iloc[i + 1]:
                recent_lows.append((i, self.df["low"].iloc[i]))

        if len(recent_highs) > len(recent_lows):
            secondary = "\u77ed\u671f\u56de\u8c03"
        elif len(recent_lows) > len(recent_highs):
            secondary = "\u77ed\u671f\u53cd\u5f39"
        else:
            secondary = "\u77ed\u671f\u9707\u8361"

        return primary, secondary

    def volume_analysis(self):
        """量价分析：放量上涨/缩量下跌等判断。"""
        recent_vol = self.df["volume"].tail(5).mean()
        prev_vol = self.df["volume"].tail(10).head(5).mean()
        vol_change = float((recent_vol / prev_vol - 1) * 100) if prev_vol > 0 else 0.0

        latest_close = float(self.df["close"].iloc[-1])
        prev_close = float(self.df["close"].iloc[-2])
        price_change = float((latest_close / prev_close - 1) * 100) if prev_close > 0 else 0.0

        if price_change > 0 and vol_change > 10:
            trend = "\u653e\u91cf\u4e0a\u6da8"
        elif price_change > 0 and vol_change < -10:
            trend = "\u7f29\u91cf\u4e0a\u6da8"
        elif price_change < 0 and vol_change > 10:
            trend = "\u653e\u91cf\u4e0b\u8dcc"
        elif price_change < 0 and vol_change < -10:
            trend = "\u7f29\u91cf\u4e0b\u8dcc"
        else:
            trend = "\u91cf\u80fd\u5e73\u7a33"

        return trend, vol_change

    def analyze(self):
        self.find_peaks_troughs()
        self.find_trend_lines()
        extremes = self.find_support_resistance()
        volume_trend, vol_change = self.volume_analysis()
        primary, secondary = self.identify_trends()
        return {
            "peaks": self.peaks,
            "troughs": self.troughs,
            "trend_lines": self.trend_lines,
            "supports": self.supports,
            "resistances": self.resistances,
            "volume_trend": volume_trend,
            "volume_change": round(vol_change, 2),
            "primary_trend": primary,
            "secondary_trend": secondary,
            **extremes,
        }


# =============================================================================
# 4.5 道氏理论 —— 三档战法分析器
# =============================================================================

class ThreeGearsAnalyzer:
    """道氏理论三档战法分析器。

    一档线起点 = 上市以来历史最低点（或最高点），逐级加速：
    一档 <= 30度 -> 二档 ~ 45度 -> 三档 >= 45度
    每个档位从第三点介入。下跌三档急跌 + 底分型 = 潜龙买点。
    """

    def __init__(self, df: pd.DataFrame, lookback: int = None):
        self.df = df.copy().reset_index(drop=True)
        self.lookback = lookback or min(len(self.df), 1200)
        self.up_gears = {"first": None, "second": None, "third": None}
        self.down_gears = {"first": None, "second": None, "third": None}
        self.hidden_dragon_signal = False
        self.current_position = ""
        self.current_point = 0

    # ---- 辅助：波峰波谷检测 ----

    def _find_peaks(self, start_idx=0, order=3):
        highs = self.df["high"].values
        n = len(highs)
        peaks = []
        for i in range(max(start_idx, order), n - order):
            if all(highs[i] >= highs[i - j] for j in range(1, order + 1)) and \
               all(highs[i] >= highs[i + j] for j in range(1, order + 1)):
                peaks.append((i, float(highs[i])))
        return peaks

    def _find_troughs(self, start_idx=0, order=3):
        lows = self.df["low"].values
        n = len(lows)
        troughs = []
        for i in range(max(start_idx, order), n - order):
            if all(lows[i] <= lows[i - j] for j in range(1, order + 1)) and \
               all(lows[i] <= lows[i + j] for j in range(1, order + 1)):
                troughs.append((i, float(lows[i])))
        return troughs

    def _calc_angle(self, idx1, price1, idx3, price3):
        """计算趋势线与水平方向的夹角。
        基于每根K线的平均价格变化率（pct_per_bar）：
          0.5%/bar ≈ 26.6° 对应一档线
          1.0%/bar ≈ 45.0° 对应二档线
          2.0%/bar ≈ 63.4° 对应三档线
        """
        bar_diff = idx3 - idx1
        if bar_diff <= 0 or price1 == 0:
            return 0.0
        avg_price = (price1 + price3) / 2.0
        price_range = abs(price3 - price1)
        pct_per_bar = (price_range / avg_price) / bar_diff * 100.0
        angle = math.degrees(math.atan(pct_per_bar))
        return round(angle, 1)

    def _up_status(self, angle):
        if angle <= 30:
            return "向上"
        elif angle <= 45:
            return "加速"
        else:
            return "急涨"

    def _down_status(self, angle):
        if angle <= 30:
            return "下跌"
        elif angle <= 45:
            return "加速下跌"
        else:
            return "急跌"

    def _make_point(self, idx, price):
        return {
            "idx": int(idx),
            "price": round(float(price), 4),
            "date": str(self.df["date"].iloc[idx].date()),
        }

    # ---- 上涨三档检测 ----

    def _find_up_pivots(self, start_idx, min_retrace=0.05):
        """找上涨趋势中的回调低点序列（逐步抬高）。"""
        peaks = self._find_peaks(start_idx)
        troughs = self._find_bottom_fractals(start_idx)

        all_pts = [(i, p, "peak") for i, p in peaks] + [(i, p, "trough") for i, p in troughs]
        all_pts.sort(key=lambda x: x[0])

        pivots = []
        last_peak_price = None

        for idx, price, ptype in all_pts:
            if ptype == "peak":
                last_peak_price = price
            elif ptype == "trough" and last_peak_price is not None:
                retrace = (last_peak_price - price) / last_peak_price
                if retrace >= min_retrace:
                    if not pivots or price > pivots[-1][1]:
                        pivots.append((idx, price))
                    else:
                        break
        return pivots

    def _validate_short(self, p1_idx, p1_price, pn_idx, pn_price, direction="up"):
        """只验证两点间，不验证延长线。用于二档及后续档位。"""
        if pn_idx <= p1_idx or pn_idx >= len(self.df):
            return False
        slope = (pn_price - p1_price) / (pn_idx - p1_idx)
        for i in range(p1_idx + 1, pn_idx):
            line_price = p1_price + slope * (i - p1_idx)
            if direction == "up":
                if i - p1_idx <= 5:
                    continue
                if float(self.df["low"].iloc[i]) < line_price:
                    return False
        return True

    def _validate_trendline(self, p1_idx, p1_price, pn_idx, pn_price, direction="up", tolerance=0.015):
        """验证趋势线是否穿过K线。
        上升趋势线应在K线下方，所有K线的low >= 线值*(1-容差)
        下降趋势线应在K线上方，所有K线的high <= 线值*(1+容差)
        tolerance: 基于价格的容差比例（默认1.5%）
        """
        if pn_idx <= p1_idx or pn_idx >= len(self.df):
            return False
        slope = (pn_price - p1_price) / (pn_idx - p1_idx)
        for i in range(p1_idx + 1, pn_idx):
            line_price = p1_price + slope * (i - p1_idx)
            if direction == "up":
                # 上升趋势线：不能穿过K线实体（悬空无所谓）
                # 检查线是否穿过K线的高-低范围
                if i <= p1_idx + 5:
                    continue
                hi = float(self.df["high"].iloc[i])
                lo = float(self.df["low"].iloc[i])
                op = float(self.df["open"].iloc[i])
                cl = float(self.df["close"].iloc[i])
                body_lo = min(op, cl)
                body_hi = max(op, cl)
                if body_lo <= line_price <= body_hi:
                    return False
            else:
                # 下降趋势线必须在所有K线上方（严格高点检查）
                if float(self.df["high"].iloc[i]) > line_price:
                    return False
        return True


















    def _detect_up_gears(self):
        """上涨三档检测（旋转射线法）：
        一档：最低点垂直向下射线逆时针旋转，碰到的低点就是p2,p3
        二档：一档线上方11%内最后一点为起点，旋转射线找p2,p3
        三档：二档线上方11%内最后一点为起点，旋转射线找p2,p3
        """
        p1_idx = int(self.df["low"].idxmin())
        p1_price = float(self.df["low"].iloc[p1_idx])
        if p1_price == 0:
            return
        p1 = self._make_point(p1_idx, p1_price)
        
        def _rotating_find(anchor, count=2):
            cand = []
            for i in range(anchor["idx"] + 1, len(self.df)):
                p = float(self.df["low"].iloc[i])
                if p <= anchor["price"]:
                    continue
                a = self._calc_angle(anchor["idx"], anchor["price"], i, p)
                cand.append((a, i, p))
            cand.sort(key=lambda x: x[0])
            found = []
            for a, i, p in cand:
                if len(found) >= count:
                    break
                if self._validate_trendline(anchor["idx"], anchor["price"], i, p, "up"):
                    found.append((i, p))
            return found
        
        def _find_gear(anchor, m=1.11):
            """在gear线上方m%内找最后一点作为下一档起点，然后旋转找p2,p3"""
            g1 = _rotating_find(anchor, 2)
            if len(g1) < 2:
                return None, None
            g_p1 = anchor
            g_p2 = self._make_point(g1[0][0], g1[0][1])
            g_p3 = self._make_point(g1[1][0], g1[1][1])
            slope = (g_p3["price"] - g_p1["price"]) / (g_p3["idx"] - g_p1["idx"])
            angle = self._calc_angle(g_p1["idx"], g_p1["price"], g_p3["idx"], g_p3["price"])
            gear = {"points": [g_p1, g_p2, g_p3], "angle": angle, "status": self._up_status(angle)}
            
            # 找下一档起点：在该档线上方m%内找最后一点
            next_anchor = None
            for i in range(g_p3["idx"], len(self.df)):
                p = float(self.df["low"].iloc[i])
                lv = g_p1["price"] + slope * (i - g_p1["idx"])
                if lv * (2 - m) <= p <= lv * m:
                    next_anchor = self._make_point(i, p)
            if next_anchor is None:
                next_anchor = g_p3
            return gear, next_anchor
        
        g1, next1 = _find_gear(p1)
        if g1 is None or next1 is None:
            return
        self.up_gears["first"] = g1
        
        g2, next2 = _find_gear(next1)
        if g2 is None:
            return
        self.up_gears["second"] = g2
        
        g3, _ = _find_gear(next2)
        if g3 is None:
            return
        self.up_gears["third"] = g3
    # ---- 下跌三档检测 ----

    def _find_down_pivots(self, start_idx, min_retrace=0.05):
        """找下跌趋势中的反弹高点序列（逐步降低）。"""
        peaks = self._find_peaks(start_idx)
        troughs = self._find_bottom_fractals(start_idx)

        all_pts = [(i, p, "peak") for i, p in peaks] + [(i, p, "trough") for i, p in troughs]
        all_pts.sort(key=lambda x: x[0])

        pivots = []
        last_trough_price = None

        for idx, price, ptype in all_pts:
            if ptype == "trough":
                last_trough_price = price
            elif ptype == "peak" and last_trough_price is not None:
                retrace = (price - last_trough_price) / last_trough_price
                if retrace >= min_retrace:
                    if not pivots or price < pivots[-1][1]:
                        pivots.append((idx, price))
                    else:
                        break
        return pivots

    def _check_bottom_fractal(self, idx):
        """简化底分型检测。"""
        if idx < 1 or idx >= len(self.df) - 1:
            return False
        cl = float(self.df["low"].iloc[idx])
        pl = float(self.df["low"].iloc[idx - 1])
        nl = float(self.df["low"].iloc[idx + 1])
        ch = float(self.df["high"].iloc[idx])
        ph = float(self.df["high"].iloc[idx - 1])
        nh = float(self.df["high"].iloc[idx + 1])
        return cl < pl and cl < nl and ch < ph and ch < nh

    def _find_bottom_fractals(self, start_idx=0):
        """找所有底分型（low和high都比前后K线低）。"""
        results = []
        for i in range(max(start_idx, 1), len(self.df) - 1):
            if self._check_bottom_fractal(i):
                results.append((i, float(self.df["low"].iloc[i])))
        return results

    def _detect_down_gears(self):
        """下跌三档检测。"""
        pass

    # ---- 当前位置判断 ----

    def _determine_current_position(self):
        last_idx = len(self.df) - 1
        completed = []
        for label, key in [("一档", "first"), ("二档", "second"), ("三档", "third")]:
            gear = self.up_gears.get(key)
            if gear and gear.get("points") and len(gear["points"]) >= 3:
                p3_idx = gear["points"][2]["idx"]
                completed.append(("上涨", label, key, p3_idx, gear["angle"]))
            gear_d = self.down_gears.get(key)
            if gear_d and gear_d.get("points") and len(gear_d["points"]) >= 3:
                p3_idx = gear_d["points"][2]["idx"]
                completed.append(("下跌", label, key, p3_idx, gear_d["angle"]))
        if not completed:
            self.current_position = "档位结构未形成，观望"
            self.current_point = 0
            return
        completed.sort(key=lambda x: x[3])
        latest = completed[-1]
        trend_dir, label, key, p3_idx, angle = latest
        if last_idx == p3_idx:
            self.current_position = f"处于{trend_dir}{label}第三点附近（介入点）"
            self.current_point = 3
        elif last_idx < p3_idx + 20:
            self.current_position = f"处于{trend_dir}{label}第三点后整理阶段"
            self.current_point = 3
        elif last_idx > p3_idx:
            self.current_position = f"已越过{trend_dir}{label}第三点，等待下一档确认"
            self.current_point = 0

    # ---- 综合建议 ----

    def _recommendation(self):
        recs = []
        if self.hidden_dragon_signal:
            recs.append("下跌三档急跌后出现底分型，潜龙买点信号")
        for label, key in [("一档", "first"), ("二档", "second"), ("三档", "third")]:
            gear = self.up_gears.get(key)
            if gear and gear.get("points"):
                pts = gear["points"]
                p3_idx = pts[2]["idx"]
                if p3_idx >= len(self.df) - 20:
                    if key == "first":
                        recs.append(f"一档线第三点确认，角度{gear['angle']}度，长线建仓区")
                    elif key == "second":
                        recs.append(f"二档线第三点确认，角度{gear['angle']}度，中线加仓区")
                    else:
                        recs.append(f"三档线第三点确认，角度{gear['angle']}度，短线追涨区（注意风险）")
        for label, key in [("一档", "first"), ("二档", "second"), ("三档", "third")]:
            gear = self.down_gears.get(key)
            if gear and gear.get("points"):
                pts = gear["points"]
                p3_idx = pts[2]["idx"]
                if p3_idx >= len(self.df) - 20:
                    recs.append(f"下跌{label}第三点确认，角度{gear['angle']}度，暂勿抄底")
        if not recs:
            recs.append("当前无明确档位介入点，观望为主")
        return recs

    def analyze(self):
        self._detect_up_gears()
        self._detect_down_gears()
        self._determine_current_position()
        return {
            "up_gears": self.up_gears,
            "down_gears": self.down_gears,
            "hidden_dragon_signal": "有" if self.hidden_dragon_signal else "无",
            "current_position": self.current_position,
            "current_point": self.current_point,
            "recommendation": self._recommendation(),
        }


# =============================================================================
# 4.7 头肩底形态识别器
# =============================================================================

class HeadAndShouldersBottom:
    """头肩底（Inverse Head and Shoulders）形态识别器。

    全历史多级别检测：
    - 大周期(order=8): 跨季度/年级别的大头肩底
    - 中周期(order=5): 月级别头肩底
    - 小周期(order=3): 周级别头肩底

    支持完整形态（左肩+头+右肩）和部分形态（左肩+头，右肩形成中）。
    """

    SCALES = [
        ("大周期", 8, 15),
        ("中周期", 5, 8),
        ("小周期", 3, 5),
    ]

    def __init__(self, df: pd.DataFrame):
        self.df = df.copy().reset_index(drop=True)
        self.patterns = []

    def _find_swing_lows(self, order=3):
        """找摆动低点。"""
        lows = self.df["low"].values
        n = len(lows)
        swing_lows = []
        for i in range(order, n - order):
            if all(lows[i] <= lows[i - j] for j in range(1, order + 1)) and \
               all(lows[i] <= lows[i + j] for j in range(1, order + 1)):
                swing_lows.append((i, float(lows[i])))
        return swing_lows

    def _find_swing_highs(self, order=3):
        """找摆动高点。"""
        highs = self.df["high"].values
        n = len(highs)
        swing_highs = []
        for i in range(order, n - order):
            if all(highs[i] >= highs[i - j] for j in range(1, order + 1)) and \
               all(highs[i] >= highs[i + j] for j in range(1, order + 1)):
                swing_highs.append((i, float(highs[i])))
        return swing_highs

    def _make_pattern(self, df, left_i, head_i, right_i,
                      left_price, head_price, right_price,
                      neckline_price, neck_p1, neck_p2,
                      scale_name, stage=None):
        """构造形态结果字典。"""
        current_price = float(df["close"].iloc[-1])
        distance_to_neck = (current_price - neckline_price) / neckline_price
        head_depth = (neckline_price - head_price) / neckline_price
        target_price = neckline_price + (neckline_price - head_price)

        if stage is None:
            if distance_to_neck > 0:
                stage = "已突破"
            elif distance_to_neck > -0.03:
                stage = "接近颈线"
            else:
                stage = "形态形成中"

        if stage == "已突破":
            signal = "突破颈线，头肩底确认"
            action = "买入信号"
        elif stage == "接近颈线":
            signal = "接近颈线，即将突破"
            action = "关注突破"
        elif stage == "右肩形成中":
            signal = "左肩+头部已形成，右肩形成中"
            action = "关注右肩形成"
        else:
            signal = "头肩底形态形成中"
            action = "等待突破确认"

        vol_pattern = ""
        has_vol = "volume" in df.columns
        vol_left = float(df["volume"].iloc[left_i]) if has_vol else 0
        vol_head = float(df["volume"].iloc[head_i]) if has_vol else 0
        vol_right = float(df["volume"].iloc[right_i]) if has_vol and right_i is not None else 0

        if right_i is not None and vol_head > 0 and vol_left > 0 and vol_right > 0:
            if vol_left > vol_head and vol_right > vol_head:
                vol_pattern = "缩量筑底（左肩和右肩量能大于头部，理想形态）"
            elif vol_right > vol_left:
                vol_pattern = "右肩放量（突破动力较强）"
            else:
                vol_pattern = "量能一般"

        pattern = {
            "scale": scale_name,
            "stage": stage,
            "left_shoulder": {"idx": int(left_i), "price": round(left_price, 2),
                              "date": str(df["date"].iloc[left_i].date())},
            "head": {"idx": int(head_i), "price": round(head_price, 2),
                     "date": str(df["date"].iloc[head_i].date())},
            "neckline": round(neckline_price, 2),
            "head_depth": round(float(head_depth) * 100, 2),
            "distance_to_neckline": round(float(distance_to_neck) * 100, 2),
            "target_price": round(target_price, 2),
            "signal": signal,
            "action": action,
            "volume_pattern": vol_pattern,
            "current_price": round(current_price, 2),
        }

        if right_i is not None:
            pattern["right_shoulder"] = {"idx": int(right_i), "price": round(right_price, 2),
                                         "date": str(df["date"].iloc[right_i].date())}
        else:
            pattern["right_shoulder"] = None

        if neck_p1 is not None and neck_p2 is not None:
            pattern["neckline_points"] = [
                {"idx": int(neck_p1[0]), "price": round(neck_p1[1], 2)},
                {"idx": int(neck_p2[0]), "price": round(neck_p2[1], 2)},
            ]

        return pattern

    def _detect_complete(self, scale_name, order, min_distance):
        """检测完整头肩底形态（左肩+头+右肩）。"""
        df = self.df
        swing_lows = self._find_swing_lows(order=order)
        swing_highs = self._find_swing_highs(order=order)

        if len(swing_lows) < 3 or len(swing_highs) < 2:
            return []

        found = []
        for head_idx in range(1, len(swing_lows) - 1):
            head_i, head_price = swing_lows[head_idx]
            left_i, left_price = swing_lows[head_idx - 1]
            right_i, right_price = swing_lows[head_idx + 1]

            if head_i - left_i < min_distance or right_i - head_i < min_distance:
                continue

            if not (head_price < left_price and head_price < right_price):
                continue

            shoulder_diff = abs(left_price - right_price) / min(left_price, right_price)
            if shoulder_diff > 0.20:
                continue

            neckline_highs = [(i, p) for i, p in swing_highs
                              if left_i < i < right_i and p > head_price]
            if len(neckline_highs) < 2:
                continue

            neckline_highs.sort(key=lambda x: x[0])
            neck_p1 = neckline_highs[0]
            neck_p2 = neckline_highs[-1]
            neckline_price = (neck_p1[1] + neck_p2[1]) / 2.0

            head_depth = (neckline_price - head_price) / neckline_price
            if head_depth < 0.03:
                continue

            current_price = float(df["close"].iloc[-1])
            distance_to_neck = (current_price - neckline_price) / neckline_price
            if distance_to_neck > 0.15 or distance_to_neck < -0.30:
                continue

            pattern = self._make_pattern(
                df, left_i, head_i, right_i,
                left_price, head_price, right_price,
                neckline_price, neck_p1, neck_p2,
                scale_name,
            )
            found.append(pattern)

        return found

    def _detect_partial(self, scale_name, order, min_distance):
        """检测部分头肩底形态（左肩+头部已形成，右肩形成中）。

        逻辑：取最后两个 swing low，如果 head < left_shoulder，
        且当前价格已从头部反弹，则视为右肩正在形成。
        """
        df = self.df
        n = len(df)
        swing_lows = self._find_swing_lows(order=order)
        swing_highs = self._find_swing_highs(order=order)

        if len(swing_lows) < 2 or len(swing_highs) < 1:
            return []

        found = []
        # 只看最近的 swing low pair，避免找到太多历史遗留
        for head_idx in range(max(0, len(swing_lows) - 3), len(swing_lows)):
            if head_idx == 0:
                continue
            head_i, head_price = swing_lows[head_idx]
            left_i, left_price = swing_lows[head_idx - 1]

            if head_i - left_i < min_distance:
                continue

            if not (head_price < left_price):
                continue

            # 头部之后没有形成新的 swing low（即右肩尚未确认）
            subsequent_lows = [(i, p) for i, p in swing_lows if i > head_i]
            if not subsequent_lows:
                # head 是最后一个 swing low，右肩尚未形成
                pass
            else:
                # 如果后续已有 swing low，检查是否已经有完整形态（跳过）
                # 如果后续 swing low 价格与左肩接近，说明完整形态可能在 _detect_complete 中
                continue

            # 构造预估颈线：左肩和头部之间的 swing high
            neckline_highs = [(i, p) for i, p in swing_highs
                              if left_i < i < head_i and p > head_price]
            if len(neckline_highs) < 1:
                # 用 head 之后到当前之间的 high 补充
                post_highs = [(i, p) for i, p in swing_highs
                              if i > head_i and p > head_price]
                if not post_highs:
                    continue
                neckline_highs.extend(post_highs)

            if not neckline_highs:
                continue

            neckline_highs.sort(key=lambda x: x[0])
            neck_p1 = neckline_highs[0]
            neck_p2 = neckline_highs[-1]
            neckline_price = (neck_p1[1] + neck_p2[1]) / 2.0

            head_depth = (neckline_price - head_price) / neckline_price
            if head_depth < 0.03:
                continue

            current_price = float(df["close"].iloc[-1])
            distance_to_neck = (current_price - neckline_price) / neckline_price

            # 右肩形成中：当前价格在头部和颈线之间，且已经反弹
            head_to_neck = neckline_price - head_price
            if head_to_neck <= 0:
                continue

            rebound_ratio = (current_price - head_price) / head_to_neck
            if rebound_ratio < 0.3:
                # 反弹不够，还太弱
                continue

            # 当前价格不能太高（已经在颈线以上的让完整形态去处理）
            if distance_to_neck > 0.05:
                continue

            pattern = self._make_pattern(
                df, left_i, head_i, None,
                left_price, head_price, None,
                neckline_price, neck_p1, neck_p2,
                scale_name,
                stage="右肩形成中",
            )
            found.append(pattern)

        return found

    def detect(self):
        """全历史多级别检测头肩底形态。"""
        self.patterns = []
        by_scale = {}

        for scale_name, order, min_distance in self.SCALES:
            complete = self._detect_complete(scale_name, order, min_distance)
            partial = self._detect_partial(scale_name, order, min_distance)
            scale_patterns = complete + partial
            by_scale[scale_name] = scale_patterns
            self.patterns.extend(scale_patterns)

        # 去重：如果小周期形态的 head 落在大周期形态的范围内，移除小周期的
        self._dedup_patterns()
        # 重建去重后的 by_scale
        by_scale = {}
        for p in self.patterns:
            by_scale.setdefault(p["scale"], []).append(p)
        self.patterns.sort(key=lambda x: (
            0 if x["scale"] == "大周期" else 1 if x["scale"] == "中周期" else 2,
            abs(x["distance_to_neckline"]),
        ))
        self._by_scale = by_scale
        return self.patterns

    def _dedup_patterns(self):
        """去除被大周期包含的小周期重复形态，以及跨周期 head 相同的重复。"""
        to_remove = set()
        scale_order = {"大周期": 0, "中周期": 1, "小周期": 2}
        for i in range(len(self.patterns)):
            if i in to_remove:
                continue
            pi = self.patterns[i]
            for j in range(i + 1, len(self.patterns)):
                if j in to_remove:
                    continue
                pj = self.patterns[j]
                # 同一 head 位置且价格接近 → 保留大周期的
                if pi["head"]["idx"] == pj["head"]["idx"] and \
                   abs(pi["head"]["price"] - pj["head"]["price"]) / max(pi["head"]["price"], 1) < 0.03:
                    if scale_order.get(pi["scale"], 9) > scale_order.get(pj["scale"], 9):
                        to_remove.add(i)
                        break
                    else:
                        to_remove.add(j)
                        continue
        if to_remove:
            self.patterns = [p for i, p in enumerate(self.patterns) if i not in to_remove]

    def analyze(self):
        self.detect()
        best = self.patterns[0] if self.patterns else None
        by_scale = getattr(self, "_by_scale", {})
        return {
            "detected": len(self.patterns) > 0,
            "pattern_count": len(self.patterns),
            "best_pattern": best,
            "all_patterns": self.patterns,
            "by_scale": {k: v for k, v in by_scale.items() if v},
        }


# =============================================================================
# 4.8 筹码交易信号分析
# =============================================================================

def analyze_cyq_signals(cyq_result, df):
    """基于筹码分布指标生成交易信号。

    信号规则：
    1. 低位密集 + CYS<-20% -> 超卖+主力吸筹 -> 买入
    2. 放量突破筹码密集区 -> 有效突破 -> 跟进
    3. 高位密集 + CYS>30% -> 超买+主力派发 -> 卖出
    4. 筹码快速下沉 -> 主力出货 -> 离场
    """
    signals = []
    profit_ratio = cyq_result.get("profit_ratio", 0)
    avg_cost = cyq_result.get("avg_cost", 0)
    current_price = cyq_result.get("current_price", 0)
    concentration = cyq_result.get("concentration", 0)
    peak_price = cyq_result.get("peak_price", 0)
    main_low = cyq_result.get("main_force_low", 0)
    main_high = cyq_result.get("main_force_high", 0)

    if current_price <= 0 or avg_cost <= 0:
        return {"signals": [], "summary": "数据不足"}

    cys = (current_price - avg_cost) / avg_cost
    peak_position = (peak_price - current_price) / current_price
    is_low_concentration = abs(peak_position) < 0.10 and concentration > 0.5
    is_high_concentration = peak_price > current_price * 1.1 and concentration > 0.4

    if is_low_concentration and cys < -0.20:
        signals.append({
            "type": "BUY",
            "signal": "低位密集+超卖",
            "detail": f"筹码集中于低位(峰值{peak_price:.2f})，CYS={cys*100:.1f}%，主力吸筹信号",
        })
    if is_high_concentration and cys > 0.30:
        signals.append({
            "type": "SELL",
            "signal": "高位密集+超买",
            "detail": f"筹码集中于高位(峰值{peak_price:.2f})，CYS={cys*100:.1f}%，主力派发信号",
        })

    if len(df) >= 10 and "volume" in df.columns:
        recent_vol = float(df["volume"].tail(5).mean())
        prev_vol = float(df["volume"].iloc[-10:-5].mean())
        if prev_vol > 0:
            vol_ratio = recent_vol / prev_vol
            if vol_ratio > 1.5 and current_price > avg_cost * 1.02:
                signals.append({
                    "type": "FOLLOW",
                    "signal": "放量突破筹码密集区",
                    "detail": f"量比{vol_ratio:.1f}倍，价格突破平均成本{avg_cost:.2f}，有效突破",
                })

    if main_low > 0 and main_high > 0 and len(df) >= 20:
        recent_main_low = main_low
        older_idx = max(0, len(df) - 20)
        peak_above_current = peak_price > current_price
        if peak_above_current and peak_price < main_low:
            signals.append({
                "type": "EXIT",
                "signal": "筹码快速下沉",
                "detail": f"筹码峰值{peak_price:.2f}低于主力成本区下沿{main_low:.2f}，主力出货",
            })

    if not signals:
        signals.append({
            "type": "NEUTRAL",
            "signal": "筹码信号中性",
            "detail": f"获利盘{profit_ratio*100:.1f}%，集中度{concentration:.2%}，无明确信号",
        })

    summary_parts = [f"获利盘{profit_ratio*100:.1f}%", f"CYS={cys*100:.1f}%"]
    if signals:
        summary_parts.append(f"信号: {signals[0]['signal']}")

    return {
        "signals": signals,
        "cys": round(cys * 100, 2),
        "is_low_concentration": is_low_concentration,
        "is_high_concentration": is_high_concentration,
        "summary": " | ".join(summary_parts),
    }


# =============================================================================
# 5. MACD / MA 分析
# =============================================================================

def analyze_macd_cross(df: pd.DataFrame):
    """标准MACD金叉死叉检测。"""
    if "dif" not in df.columns or "dea" not in df.columns:
        df = calc_macd(df)
    dif = df["dif"].values
    dea = df["dea"].values
    hist = df["hist"].values if "hist" in df.columns else 2 * (dif - dea)
    n = len(dif)

    last_cross = None
    for i in range(1, n):
        if dif[i - 1] <= dea[i - 1] and dif[i] > dea[i]:
            last_cross = {"type": "金叉", "idx": int(i), "date": str(df["date"].iloc[i].date())}
        elif dif[i - 1] >= dea[i - 1] and dif[i] < dea[i]:
            last_cross = {"type": "死叉", "idx": int(i), "date": str(df["date"].iloc[i].date())}

    latest_dif = float(dif[-1]) if n > 0 else 0.0
    latest_dea = float(dea[-1]) if n > 0 else 0.0
    latest_hist = float(hist[-1]) if n > 0 else 0.0

    if latest_dif > latest_dea and latest_hist > 0:
        trend = "多头"
    elif latest_dif < latest_dea and latest_hist < 0:
        trend = "空头"
    else:
        trend = "整理"

    return {
        "dif": round(latest_dif, 4),
        "dea": round(latest_dea, 4),
        "hist": round(latest_hist, 4),
        "last_cross": last_cross,
        "trend": trend,
    }


def analyze_ma_arrangement(df: pd.DataFrame):
    """均线排列判断。"""
    ma_cols = [c for c in df.columns if c.startswith("ma")]
    if not ma_cols:
        df = calc_ma(df)
        ma_cols = ["ma5", "ma10", "ma20"]

    latest = {}
    for c in ma_cols:
        if c in df.columns and not pd.isna(df[c].iloc[-1]):
            latest[c] = round(float(df[c].iloc[-1]), 2)

    ma5 = df["ma5"].iloc[-1] if "ma5" in df.columns and not pd.isna(df["ma5"].iloc[-1]) else None
    ma10 = df["ma10"].iloc[-1] if "ma10" in df.columns and not pd.isna(df["ma10"].iloc[-1]) else None
    ma20 = df["ma20"].iloc[-1] if "ma20" in df.columns and not pd.isna(df["ma20"].iloc[-1]) else None

    if ma5 is not None and ma10 is not None and ma20 is not None:
        if ma5 > ma10 > ma20:
            arrangement = "多头排列"
        elif ma5 < ma10 < ma20:
            arrangement = "空头排列"
        else:
            arrangement = "均线纠缠"
    else:
        arrangement = "数据不足"

    return {
        "latest": latest,
        "arrangement": arrangement,
    }


# =============================================================================
# 6. 图表绘制
# =============================================================================

def plot_candles(ax, df, xvals=None):
    """在 matplotlib axes 上画 K 线蜡烛图。红涨绿跌配色。"""
    if xvals is None:
        xvals = np.arange(len(df))
    for i, row in df.iterrows():
        x = xvals[i]
        o, h, l, c = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])
        color = "#e74c3c" if c >= o else "#2ecc71"
        ax.plot([x, x], [l, h], color=color, linewidth=0.8, solid_capstyle="round")
        ax.bar(x, height=abs(c - o), bottom=min(o, c), color=color, width=0.7, edgecolor=color)


def _plot_gear_line(ax, gear, color, xvals, df, gear_name=""):
    """绘制三档趋势线及其延长虚线。"""
    if not gear or not gear.get("points") or len(gear["points"]) < 2:
        return
    pts = gear["points"]
    p1, p2, p3 = pts[0], pts[1], pts[2]
    idx1, idx2, idx3 = int(p1["idx"]), int(p2["idx"]), int(p3["idx"])
    pr1, pr2, pr3 = float(p1["price"]), float(p2["price"]), float(p3["price"])

    # 确保索引在有效范围内
    if idx1 >= len(xvals) or idx3 >= len(xvals):
        return

    # 实线部分：p1 -> p3
    ax.plot([xvals[idx1], xvals[idx3]], [pr1, pr3], color=color, linewidth=2.0, solid_capstyle="round")

    # 延长虚线：p3 到末尾
    if idx3 < len(xvals) - 1:
        slope = (pr3 - pr1) / (idx3 - idx1) if idx3 != idx1 else 0
        end_idx = len(xvals) - 1
        end_price = pr3 + slope * (end_idx - idx3)
        ax.plot([xvals[idx3], xvals[end_idx]], [pr3, end_price], color=color, linewidth=1.5, linestyle=":", alpha=0.7)

    # 第三点菱形标记
    if idx3 < len(xvals):
        ax.scatter([xvals[idx3]], [pr3], marker="D", s=80, color=color, zorder=5, edgecolors="white", linewidths=0.5)
        ax.annotate(
            f"{gear_name}③\n{pr3:.2f}",
            xy=(xvals[idx3], pr3),
            xytext=(8, 8),
            textcoords="offset points",
            fontsize=8,
            color=color,
        )

    # 标注档位名+角度
    mid_x = (xvals[idx1] + xvals[idx3]) / 2
    mid_price = (pr1 + pr3) / 2
    angle = gear.get("angle", 0)
    status = gear.get("status", "")
    ax.text(mid_x, mid_price, f"{gear_name} ({angle}° {status})", fontsize=7, color=color, ha="center", va="bottom")


def generate_dow_chart(df, analysis, name, output_path):
    """
    道氏图 —— 最重要的图。
    - 不限600根K线，显示全量数据
    - 不画波峰波谷、通用趋势线、支撑压力线
    - 只画K线 + 上升三档线（一档绿/二档金/三档红）+ 第三点菱形标记
    - 不画下降线
    - 有延长虚线
    - 只画 up_gears 的 first/second/third
    - 成交量副图
    - 深色背景 #1a1a2e
    """
    fig, axes = plt.subplots(2, 1, figsize=(16, 9), gridspec_kw={"height_ratios": [4, 1]}, facecolor="#1a1a2e")
    ax_price = axes[0]
    ax_vol = axes[1]

    for ax in axes:
        ax.set_facecolor("#1a1a2e")
        ax.tick_params(colors="white")
        for spine in ax.spines.values():
            spine.set_color("#444444")

    xvals = np.arange(len(df))
    plot_candles(ax_price, df, xvals)

    # 上升三档线
    tg = analysis.get("three_gears", {})
    up_gears = tg.get("up_gears", {})
    gear_colors = {"first": "#2ecc71", "second": "#f1c40f", "third": "#e74c3c"}
    gear_names = {"first": "一档", "second": "二档", "third": "三档"}
    for key in ["first", "second", "third"]:
        gear = up_gears.get(key)
        if gear:
            _plot_gear_line(ax_price, gear, gear_colors[key], xvals, df, gear_names[key])



    # 价格轴范围
    ymin = float(df["low"].min())
    ymax = float(df["high"].max())
    pad = (ymax - ymin) * 0.1
    ax_price.set_ylim(ymin - pad, ymax + pad)

    # 日期标签
    date_range = f"{str(df['date'].iloc[0].date())} ~ {str(df['date'].iloc[-1].date())}"
    ax_price.set_title(f"{name} 道氏理论分析 | {date_range}", fontsize=14, color="white", pad=10)

    # x轴日期
    n = len(df)
    step = max(n // 10, 1)
    tick_idx = list(range(0, n, step))
    if tick_idx[-1] != n - 1:
        tick_idx.append(n - 1)
    ax_price.set_xticks([xvals[i] for i in tick_idx])
    ax_price.set_xticklabels([str(df["date"].iloc[i].date()) for i in tick_idx], rotation=30, ha="right", color="white", fontsize=7)

    # 成交量
    if "volume" in df.columns:
        colors_vol = ["#e74c3c" if df["close"].iloc[i] >= df["open"].iloc[i] else "#2ecc71" for i in range(len(df))]
        ax_vol.bar(xvals, df["volume"].values, color=colors_vol, width=0.7, alpha=0.7)
        ax_vol.set_ylabel("成交量", color="white", fontsize=9)
        ax_vol.set_xticks([xvals[i] for i in tick_idx])
        ax_vol.set_xticklabels([str(df["date"].iloc[i].date()) for i in tick_idx], rotation=30, ha="right", color="white", fontsize=7)

    plt.tight_layout()
    fig.savefig(output_path, dpi=150, facecolor="#1a1a2e", edgecolor="none")
    plt.close(fig)
    print(f"[chart] 道氏图已保存: {output_path}")
    return output_path


def generate_chanlun_chart(df, analysis, name, output_path):
    """
    缠论分析图。标准K线 + 缠论标注（分型、笔、中枢）。
    """
    fig, axes = plt.subplots(3, 1, figsize=(16, 10), gridspec_kw={"height_ratios": [4, 1.5, 1.5]}, facecolor="#1a1a2e")
    ax_price = axes[0]
    ax_macd = axes[1]
    ax_vol = axes[2]

    for ax in axes:
        ax.set_facecolor("#1a1a2e")
        ax.tick_params(colors="white")
        for spine in ax.spines.values():
            spine.set_color("#444444")

    xvals = np.arange(len(df))
    plot_candles(ax_price, df, xvals)

    chan = analysis.get("chanlun", {})
    top_fractals = chan.get("top_fractals", [])
    bottom_fractals = chan.get("bottom_fractals", [])
    pens = chan.get("pens", [])
    centers = chan.get("centers", [])
    divergences = chan.get("divergences", [])




    # 笔
    for pen in pens:
        sidx = int(pen["start_idx"])
        eidx = int(pen["end_idx"])
        if sidx < len(df) and eidx < len(df):
            sp = float(pen["start_price"])
            ep = float(pen["end_price"])
            ax_price.plot([xvals[sidx], xvals[eidx]], [sp, ep], color="white", linewidth=1.8, solid_capstyle="round", alpha=0.9)

    # 分型标记
    for idx in top_fractals:
        if idx < len(df):
            ax_price.scatter([xvals[idx]], [float(df["high"].iloc[idx])], marker="v", s=30, color="#ff6b6b", zorder=5)
    for idx in bottom_fractals:
        if idx < len(df):
            ax_price.scatter([xvals[idx]], [float(df["low"].iloc[idx])], marker="^", s=30, color="#51cf66", zorder=5)

    # 中枢
    for center in centers:
        sidx = int(center["start_idx"])
        eidx = int(center["end_idx"])
        if sidx < len(df) and eidx < len(df):
            hi = float(center["high"])
            lo = float(center["low"])
            rect = plt.Rectangle((xvals[sidx], lo), xvals[eidx] - xvals[sidx], hi - lo, facecolor="purple", alpha=0.15, edgecolor="purple", linewidth=1)
            ax_price.add_patch(rect)

    # 背驰
    for div in divergences:
        idx = int(div["idx"])
        if idx < len(df):
            price = float(df["low"].iloc[idx]) if div["type"] == "底背驰" else float(df["high"].iloc[idx])
            ax_price.annotate(
                f"{div['type']}",
                xy=(xvals[idx], price),
                xytext=(20, 20),
                textcoords="offset points",
                fontsize=8,
                color="#f39c12",
                arrowprops=dict(arrowstyle="->", color="#f39c12"),
            )

    # MACD
    if "dif" in df.columns and "dea" in df.columns:
        ax_macd.plot(xvals, df["dif"].values, color="#3498db", linewidth=1.0, label="DIF")
        ax_macd.plot(xvals, df["dea"].values, color="#e67e22", linewidth=1.0, label="DEA")
        hist = df["hist"].values if "hist" in df.columns else 2 * (df["dif"].values - df["dea"].values)
        colors_hist = ["#e74c3c" if h >= 0 else "#2ecc71" for h in hist]
        ax_macd.bar(xvals, hist, color=colors_hist, width=0.7, alpha=0.6)
        ax_macd.axhline(0, color="#555555", linewidth=0.5)
        ax_macd.legend(loc="upper left", fontsize=8, facecolor="#1a1a2e", edgecolor="#444444", labelcolor="white")
        ax_macd.set_ylabel("MACD", color="white", fontsize=9)

    # 成交量
    if "volume" in df.columns:
        colors_vol = ["#e74c3c" if df["close"].iloc[i] >= df["open"].iloc[i] else "#2ecc71" for i in range(len(df))]
        ax_vol.bar(xvals, df["volume"].values, color=colors_vol, width=0.7, alpha=0.7)
        ax_vol.set_ylabel("成交量", color="white", fontsize=9)

    n = len(df)
    step = max(n // 10, 1)
    tick_idx = list(range(0, n, step))
    if tick_idx[-1] != n - 1:
        tick_idx.append(n - 1)
    for ax in axes:
        ax.set_xticks([xvals[i] for i in tick_idx])
        ax.set_xticklabels([str(df["date"].iloc[i].date()) for i in tick_idx], rotation=30, ha="right", color="white", fontsize=7)

    ax_price.set_title(f"{name} 缠论分析", fontsize=14, color="white", pad=10)
    plt.tight_layout()
    fig.savefig(output_path, dpi=150, facecolor="#1a1a2e", edgecolor="none")
    plt.close(fig)
    print(f"[chart] 缠论图已保存: {output_path}")
    return output_path


def generate_hsb_chart(df, analysis, name, output_path):
    """
    头肩底颈线分析图。
    - K线 + 左肩/头部/右肩标记
    - 颈线（水平虚线）+ 目标价线
    - 形态区域半透明标注
    - 成交量副图
    - 深色背景 #1a1a2e
    """
    hs = analysis.get("head_shoulders_bottom", {})
    if not hs or not hs.get("detected") or not hs.get("best_pattern"):
        print(f"[chart] 头肩底未检测到，跳过图表生成")
        return None

    bp = hs["best_pattern"]
    left = bp.get("left_shoulder")
    head = bp.get("head")
    right = bp.get("right_shoulder")
    neckline = bp.get("neckline")
    target = bp.get("target_price")
    neck_points = bp.get("neckline_points")

    if not left or not head or not neckline:
        print(f"[chart] 头肩底数据不完整，跳过图表生成")
        return None

    fig, axes = plt.subplots(2, 1, figsize=(16, 9), gridspec_kw={"height_ratios": [4, 1]}, facecolor="#1a1a2e")
    ax_price = axes[0]
    ax_vol = axes[1]

    for ax in axes:
        ax.set_facecolor("#1a1a2e")
        ax.tick_params(colors="white")
        for spine in ax.spines.values():
            spine.set_color("#444444")

    xvals = np.arange(len(df))
    plot_candles(ax_price, df, xvals)

    # 形态区域半透明背景
    left_idx = int(left["idx"])
    rightmost_idx = int(right["idx"]) if right else int(head["idx"])
    head_idx = int(head["idx"])
    if left_idx < len(xvals) and rightmost_idx < len(xvals):
        lo_region = float(df["low"].iloc[left_idx:rightmost_idx + 1].min())
        ax_price.axvspan(xvals[left_idx], xvals[rightmost_idx],
                         alpha=0.08, color="#f1c40f", zorder=0)

    # 颈线
    if neck_points and len(neck_points) >= 2:
        np1, np2 = neck_points[0], neck_points[1]
        ni1, np1_price = int(np1["idx"]), float(np1["price"])
        ni2, np2_price = int(np2["idx"]), float(np2["price"])
        # 延长到全图范围
        extend_start = 0
        extend_end = len(xvals) - 1
        if ni2 != ni1:
            slope = (np2_price - np1_price) / (ni2 - ni1)
            ext_start_price = np1_price + slope * (extend_start - ni1)
            ext_end_price = np2_price + slope * (extend_end - ni2)
        else:
            ext_start_price = neckline
            ext_end_price = neckline
        ax_price.plot([xvals[extend_start], xvals[extend_end]],
                      [ext_start_price, ext_end_price],
                      color="#f1c40f", linewidth=2.0, linestyle="--", alpha=0.9, label=f"颈线 {neckline:.2f}")
    else:
        ax_price.axhline(neckline, color="#f1c40f", linewidth=2.0, linestyle="--", alpha=0.9, label=f"颈线 {neckline:.2f}")

    # 目标价线
    if target:
        ax_price.axhline(target, color="#2ecc71", linewidth=1.5, linestyle=":", alpha=0.8, label=f"目标价 {target:.2f}")

    # 左肩标记
    if left_idx < len(xvals):
        ax_price.scatter([xvals[left_idx]], [float(left["price"])],
                         marker="^", s=120, color="#3498db", zorder=6, edgecolors="white", linewidths=1)
        ax_price.annotate(f"左肩\n{left['price']:.2f}",
                          xy=(xvals[left_idx], float(left["price"])),
                          xytext=(0, -30), textcoords="offset points",
                          fontsize=9, color="#3498db", fontweight="bold",
                          arrowprops=dict(arrowstyle="->", color="#3498db"))

    # 头部标记
    if head_idx < len(xvals):
        ax_price.scatter([xvals[head_idx]], [float(head["price"])],
                         marker="^", s=150, color="#e74c3c", zorder=6, edgecolors="white", linewidths=1)
        ax_price.annotate(f"头部\n{head['price']:.2f}",
                          xy=(xvals[head_idx], float(head["price"])),
                          xytext=(0, -35), textcoords="offset points",
                          fontsize=9, color="#e74c3c", fontweight="bold",
                          arrowprops=dict(arrowstyle="->", color="#e74c3c"))

    # 右肩标记
    if right and int(right["idx"]) < len(xvals):
        right_idx = int(right["idx"])
        ax_price.scatter([xvals[right_idx]], [float(right["price"])],
                         marker="^", s=120, color="#9b59b6", zorder=6, edgecolors="white", linewidths=1)
        ax_price.annotate(f"右肩\n{right['price']:.2f}",
                          xy=(xvals[right_idx], float(right["price"])),
                          xytext=(0, -30), textcoords="offset points",
                          fontsize=9, color="#9b59b6", fontweight="bold",
                          arrowprops=dict(arrowstyle="->", color="#9b59b6"))

    # 信号文字
    signal = bp.get("signal", "")
    stage = bp.get("stage", "")
    action = bp.get("action", "")
    info_text = f"信号: {signal}\n阶段: {stage}\n操作: {action}"
    if target:
        info_text += f"\n目标价: {target:.2f}"
    ax_price.text(0.02, 0.97, info_text, transform=ax_price.transAxes,
                  fontsize=10, color="#f1c40f", va="top", ha="left",
                  bbox=dict(boxstyle="round,pad=0.4", facecolor="#1a1a2e", edgecolor="#f1c40f", alpha=0.85))

    # 图例
    ax_price.legend(loc="upper right", fontsize=9, facecolor="#1a1a2e", edgecolor="#444444", labelcolor="white")

    # 价格轴范围
    ymin = float(df["low"].min())
    ymax = float(df["high"].max())
    if target and target > ymax:
        ymax = target
    pad = (ymax - ymin) * 0.1
    ax_price.set_ylim(ymin - pad, ymax + pad)

    # 日期标签
    date_range = f"{str(df['date'].iloc[0].date())} ~ {str(df['date'].iloc[-1].date())}"
    scale = bp.get("scale", "")
    ax_price.set_title(f"{name} 头肩底颈线分析 ({scale}) | {date_range}", fontsize=14, color="white", pad=10)

    # x轴日期
    n = len(df)
    step = max(n // 10, 1)
    tick_idx = list(range(0, n, step))
    if tick_idx[-1] != n - 1:
        tick_idx.append(n - 1)
    for ax in axes:
        ax.set_xticks([xvals[i] for i in tick_idx])
        ax.set_xticklabels([str(df["date"].iloc[i].date()) for i in tick_idx], rotation=30, ha="right", color="white", fontsize=7)

    # 成交量
    if "volume" in df.columns:
        colors_vol = ["#e74c3c" if df["close"].iloc[i] >= df["open"].iloc[i] else "#2ecc71" for i in range(len(df))]
        ax_vol.bar(xvals, df["volume"].values, color=colors_vol, width=0.7, alpha=0.7)
        ax_vol.set_ylabel("成交量", color="white", fontsize=9)

    plt.tight_layout()
    fig.savefig(output_path, dpi=150, facecolor="#1a1a2e", edgecolor="none")
    plt.close(fig)
    print(f"[chart] 头肩底颈线分析图已保存: {output_path}")
    return output_path


def generate_cyq_chart(df, analysis, name, output_path, chan_result=None):
    """
    筹码分布图。左侧K线 + 右侧筹码分布。
    """
    fig = plt.figure(figsize=(16, 9), facecolor="#1a1a2e")
    gs = fig.add_gridspec(2, 2, height_ratios=[4, 1], width_ratios=[3, 1])
    ax_kline = fig.add_subplot(gs[0, 0])
    ax_cyq = fig.add_subplot(gs[0, 1], sharey=ax_kline)
    ax_vol = fig.add_subplot(gs[1, 0])

    for ax in [ax_kline, ax_cyq, ax_vol]:
        ax.set_facecolor("#1a1a2e")
        ax.tick_params(colors="white")
        for spine in ax.spines.values():
            spine.set_color("#444444")

    xvals = np.arange(len(df))
    plot_candles(ax_kline, df, xvals)

    cyq = analysis.get("cyq", {})
    current_price = cyq.get("current_price", float(df["close"].iloc[-1]))
    avg_cost = cyq.get("avg_cost", current_price)
    peak_price = cyq.get("peak_price", current_price)
    main_low = cyq.get("main_force_low", current_price)
    main_high = cyq.get("main_force_high", current_price)

    # 关键价位水平线
    for val, color, label in [
        (current_price, "#ffffff", f"现价 {current_price:.2f}"),
        (avg_cost, "#3498db", f"平均成本 {avg_cost:.2f}"),
        (peak_price, "#f1c40f", f"筹码峰值 {peak_price:.2f}"),
    ]:
        ax_kline.axhline(val, color=color, linewidth=0.8, linestyle="--", alpha=0.7)
        ax_kline.text(xvals[-1], val, label, color=color, fontsize=7, va="bottom", ha="right")

    if main_low != main_high:
        ax_kline.axhspan(main_low, main_high, color="#e74c3c", alpha=0.1)
        ax_kline.text(xvals[0], (main_low + main_high) / 2, "主力成本区", color="#e74c3c", fontsize=7, va="center")

    # 右侧筹码分布
    price_bins = cyq.get("price_bins", [])
    chip_dist = cyq.get("chip_distribution", [])
    if price_bins and chip_dist and len(price_bins) == len(chip_dist):
        price_bins = np.array(price_bins)
        chip_dist = np.array(chip_dist)
        max_dist = chip_dist.max() if chip_dist.max() > 0 else 1
        colors_cyq = ["#e74c3c" if p >= current_price else "#2ecc71" for p in price_bins]
        ax_cyq.barh(price_bins, chip_dist, height=np.diff(price_bins[:2])[0] if len(price_bins) > 1 else 0.1, color=colors_cyq, alpha=0.7)
        ax_cyq.set_xlim(0, max_dist * 1.2)
        ax_cyq.set_xlabel("筹码密度", color="white", fontsize=9)
        ax_cyq.tick_params(axis="y", labelleft=False)

    # 成交量
    if "volume" in df.columns:
        colors_vol = ["#e74c3c" if df["close"].iloc[i] >= df["open"].iloc[i] else "#2ecc71" for i in range(len(df))]
        ax_vol.bar(xvals, df["volume"].values, color=colors_vol, width=0.7, alpha=0.7)
        ax_vol.set_ylabel("成交量", color="white", fontsize=9)

    # 右下角文字面板
    profit = cyq.get("profit_ratio", 0)
    concentration = cyq.get("concentration", 0)
    textstr = (
        f"获利盘: {profit*100:.1f}%\n"
        f"平均成本: {avg_cost:.2f}\n"
        f"筹码峰值: {peak_price:.2f}\n"
        f"集中度(90%): {concentration:.2%}\n"
        f"主力成本: {main_low:.2f} ~ {main_high:.2f}"
    )
    props = dict(boxstyle="round", facecolor="#1a1a2e", edgecolor="#555555", alpha=0.9)
    ax_cyq.text(0.02, 0.98, textstr, transform=ax_cyq.transAxes, fontsize=9, verticalalignment="top", color="white", bbox=props)

    n = len(df)
    step = max(n // 10, 1)
    tick_idx = list(range(0, n, step))
    if tick_idx[-1] != n - 1:
        tick_idx.append(n - 1)
    ax_kline.set_xticks([xvals[i] for i in tick_idx])
    ax_kline.set_xticklabels([str(df["date"].iloc[i].date()) for i in tick_idx], rotation=30, ha="right", color="white", fontsize=7)
    ax_vol.set_xticks([xvals[i] for i in tick_idx])
    ax_vol.set_xticklabels([str(df["date"].iloc[i].date()) for i in tick_idx], rotation=30, ha="right", color="white", fontsize=7)

    date_range = f"{str(df['date'].iloc[0].date())} ~ {str(df['date'].iloc[-1].date())}"
    ax_kline.set_title(f"{name} 筹码分布 | {date_range}", fontsize=14, color="white", pad=10)
    plt.tight_layout()
    fig.savefig(output_path, dpi=150, facecolor="#1a1a2e", edgecolor="none")
    plt.close(fig)
    print(f"[chart] 筹码图已保存: {output_path}")
    return output_path


def generate_infographic(df, report, output_path):
    """
    竖版信息图 (1080x1920)。当前价格、涨跌幅、分析结论、操作建议。
    """
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("[infographic] Pillow 未安装，跳过信息图")
        return None

    W, H = 1080, 1920
    img = Image.new("RGB", (W, H), color="#0a0e17")
    draw = ImageDraw.Draw(img)

    # 字体
    try:
        font_large = ImageFont.truetype("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 72)
        font_mid = ImageFont.truetype("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 40)
        font_small = ImageFont.truetype("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 28)
        font_tiny = ImageFont.truetype("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 22)
    except Exception:
        try:
            font_large = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 72)
            font_mid = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 40)
            font_small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 28)
            font_tiny = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 22)
        except Exception:
            font_large = font_mid = font_small = font_tiny = ImageFont.load_default()

    latest = report.get("latest", {})
    meta = report.get("meta", {})
    name = meta.get("name", "")
    current_price = latest.get("close", 0)
    prev_close = latest.get("prev_close", current_price)
    change_pct = latest.get("change_pct", 0)
    color = "#e74c3c" if change_pct >= 0 else "#2ecc71"

    y = 60
    # 标题
    draw.text((W // 2, y), name, fill="white", font=font_large, anchor="mm")
    y += 100
    # 日期
    draw.text((W // 2, y), f"分析日期: {meta.get('analysis_date', '')}", fill="#aaaaaa", font=font_small, anchor="mm")
    y += 80
    # 价格
    draw.text((W // 2, y), f"{current_price:.2f}", fill=color, font=font_large, anchor="mm")
    y += 90
    sign = "+" if change_pct >= 0 else ""
    draw.text((W // 2, y), f"{sign}{change_pct:.2f}%", fill=color, font=font_mid, anchor="mm")
    y += 100

    # 分隔线
    draw.line([(60, y), (W - 60, y)], fill="#333333", width=2)
    y += 40

    # 各分析模块
    sections = []
    chan = report.get("chanlun", {})
    if chan:
        bs_points = chan.get("buy_sell_points", [])
        bs_str = f" | {bs_points[0]['type']}" if bs_points else ""
        sections.append(("缠论分析", f"{chan.get('trend', '未知')}{bs_str}"))
    tg = report.get("three_gears", {})
    if tg:
        sections.append(("三档战法", tg.get("current_position", "未知")))
    hs = report.get("head_shoulders_bottom", {})
    if hs and hs.get("detected") and hs.get("best_pattern"):
        bp = hs["best_pattern"]
        sections.append(("头肩底", f"[{bp.get('scale', '')}] {bp['signal']} 目标{bp['target_price']:.2f}"))
    ma = report.get("ma", {})
    if ma:
        latest_ma = ma.get("latest", {})
        ma_str = " ".join([f"{k}={v}" for k, v in list(latest_ma.items())[:3]])
        sections.append(("均线", f"{ma_str} ({ma.get('arrangement', '')})"))
    cyq = report.get("cyq", {})
    if cyq:
        cyq_sig = cyq.get("signals", {}).get("signals", [])
        sig_str = cyq_sig[0]["signal"] if cyq_sig else ""
        sections.append(("筹码", f"获利盘{cyq.get('profit_ratio', 0)*100:.1f}% {sig_str}"))
    ff = report.get("fund_flow", {})
    if ff:
        main_in = ff.get("main_net_inflow")
        if main_in is not None:
            direction = "流入" if main_in >= 0 else "流出"
            sections.append(("资金流向", f"主力净{direction} {abs(main_in)/1e8:.2f}亿"))
    fund_data = report.get("fundamentals", {})
    if fund_data:
        parts = []
        income = fund_data.get("income", {})
        if income.get("revenue_yoy") is not None:
            parts.append(f"营收同比{income['revenue_yoy']*100:+.1f}%")
        if income.get("roe") is not None:
            parts.append(f"ROE {income['roe']:.1f}%")
        if income.get("eps") is not None:
            parts.append(f"EPS {income['eps']:.2f}")
        bs = fund_data.get("balance_sheet", {})
        if bs.get("debt_ratio") is not None:
            parts.append(f"负债率{bs['debt_ratio']*100:.1f}%")
        cf = fund_data.get("cashflow", {})
        if cf.get("operating_cash_flow") is not None:
            parts.append(f"经营现金流{cf['operating_cash_flow']/1e8:.1f}亿")
        if parts:
            sections.append(("基本面", " | ".join(parts)))

    for title, content in sections:
        draw.text((80, y), title, fill="#f1c40f", font=font_small)
        y += 45
        # 文本换行处理
        max_width = W - 160
        words = []
        for char in content:
            test_line = "".join(words + [char])
            bbox = draw.textbbox((0, 0), test_line, font=font_tiny)
            if bbox[2] - bbox[0] > max_width and words:
                draw.text((80, y), "".join(words), fill="white", font=font_tiny)
                y += 35
                words = [char]
            else:
                words.append(char)
        if words:
            draw.text((80, y), "".join(words), fill="white", font=font_tiny)
            y += 50

    # 操作建议
    y += 20
    draw.line([(60, y), (W - 60, y)], fill="#333333", width=2)
    y += 30
    draw.text((80, y), "操作建议", fill="#f1c40f", font=font_small)
    y += 50
    recs = report.get("recommendation", [])
    if not recs:
        recs = ["当前无明确信号，观望为主"]
    for rec in recs:
        words = []
        for char in rec:
            test_line = "".join(words + [char])
            bbox = draw.textbbox((0, 0), test_line, font=font_tiny)
            if bbox[2] - bbox[0] > max_width and words:
                draw.text((80, y), "".join(words), fill="#3498db", font=font_tiny)
                y += 35
                words = [char]
            else:
                words.append(char)
        if words:
            draw.text((80, y), "".join(words), fill="#3498db", font=font_tiny)
            y += 40

    # 数据来源
    y = H - 60
    draw.text((W // 2, y), "数据来源: akshare + 国信证券 | 仅供参考，不构成投资建议", fill="#666666", font=font_tiny, anchor="mm")

    img.save(output_path, quality=95)
    print(f"[chart] 信息图已保存: {output_path}")
    return output_path


# =============================================================================
# 7. COS 上传
# =============================================================================

def upload_to_cos(local_path, remote_dir="h5-chart"):
    """上传文件到 COS，返回公开 URL。使用 cos_util 或 coscli fallback。"""
    if not os.path.isfile(local_path):
        print(f"[upload] 文件不存在: {local_path}")
        return None

    # 加载环境变量
    env_path = "/root/h5-chat/.env"
    if os.path.isfile(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and val:
                    os.environ.setdefault(key, val)

    # 方法1: cos_util
    bridge_dir = "/root/h5-chat/bridge"
    if bridge_dir not in sys.path:
        sys.path.insert(0, bridge_dir)

    try:
        from cos_util import upload_file
        filename = os.path.basename(local_path)
        with open(local_path, "rb") as f:
            file_data = f.read()
        url = upload_file(file_data, filename, content_type="image/png")
        print(f"[upload] COS上传成功: {url}")
        return url
    except Exception as e:
        print(f"[upload] cos_util 上传失败: {e}")

    # 方法2: coscli
    try:
        bucket = "nickhome-1329273633"
        custom_domain = "https://nickstorage.top"
        date_prefix = datetime.now().strftime("%Y%m%d")
        remote_key = f"{remote_dir}/{date_prefix}/{os.path.basename(local_path)}"
        cmd = [
            "coscli", "cp", local_path,
            f"cos://{bucket}/{remote_key}",
            "-r", "ap-seoul",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            url = f"{custom_domain}/{remote_key}"
            print(f"[upload] coscli 上传成功: {url}")
            return url
        else:
            print(f"[upload] coscli 失败: {result.stderr}")
    except Exception as e:
        print(f"[upload] coscli 异常: {e}")

    # 方法3: 本地网站 assets 目录
    try:
        assets_dir = "/var/www/chat/assets"
        date_prefix = datetime.now().strftime("%Y%m%d")
        target_dir = os.path.join(assets_dir, date_prefix)
        os.makedirs(target_dir, exist_ok=True)
        dest_path = os.path.join(target_dir, os.path.basename(local_path))
        shutil.copy2(local_path, dest_path)
        os.chmod(dest_path, 0o644)
        url = f"https://www.nickhome.cloud/chat/assets/{date_prefix}/{os.path.basename(local_path)}"
        print(f"[upload] 本地assets上传成功: {url}")
        return url
    except Exception as e:
        print(f"[upload] 本地assets上传失败: {e}")

    print("[upload] 所有上传方式均失败")
    return None


# =============================================================================
# 8. 报告构建
# =============================================================================

def build_report(df, chan_result, ma_result, cyq_result, cyq_signals, three_gears_result,
                 head_shoulders_result, name, symbol, code, market,
                 fund_flow=None, fundamentals=None, balance_sheet=None, cashflow=None):
    """构建 JSON 报告。六大模块：均线 + 头肩底 + 缠论 + 筹码 + 三档 + 基本面。"""
    latest = df.iloc[-1]
    prev = df.iloc[-2] if len(df) > 1 else latest
    current_price = float(latest["close"])
    prev_close = float(prev["close"])
    change_pct = float((current_price / prev_close - 1) * 100) if prev_close > 0 else 0.0

    recommendations = []

    # 三档战法建议（最高优先级）
    tg = three_gears_result
    tg_recs = tg.get("recommendation", [])
    if tg_recs:
        recommendations.extend(tg_recs[:3])
    position = tg.get("current_position", "")
    if "一档" in position and "第三点" in position:
        recommendations.insert(0, "一档线第三点介入区，长线建仓")
    elif "二档" in position and "第三点" in position:
        recommendations.insert(0, "二档线第三点介入区，中线加仓")
    elif "三档" in position and "第三点" in position:
        recommendations.insert(0, "三档线第三点介入区，短线追涨（注意风险）")

    # 头肩底建议
    hs = head_shoulders_result
    if hs.get("detected") and hs.get("best_pattern"):
        bp = hs["best_pattern"]
        scale_tag = f"[{bp['scale']}]" if bp.get("scale") else ""
        recommendations.insert(0, f"头肩底{scale_tag}: {bp['signal']}，目标价 {bp['target_price']:.2f}")

    # 缠论建议
    if chan_result.get("buy_sell_points"):
        for pt in chan_result["buy_sell_points"][:2]:
            recommendations.append(f"缠论{pt['type']}: {pt['reason']}")
    if chan_result.get("divergences"):
        for div in chan_result["divergences"][-1:]:
            recommendations.append(f"缠论{div['type']}: {div.get('note', '')}")

    # 均线建议
    if ma_result.get("arrangement") == "多头排列":
        recommendations.append("均线多头排列，趋势向好")
    elif ma_result.get("arrangement") == "空头排列":
        recommendations.append("均线空头排列，趋势偏弱")

    # 筹码信号建议
    if cyq_signals.get("signals"):
        for sig in cyq_signals["signals"]:
            if sig["type"] in ("BUY", "SELL", "EXIT"):
                recommendations.append(f"筹码{sig['signal']}: {sig['detail']}")

    # 资金流向建议
    ff = fund_flow or {}
    if ff.get("main_net_inflow") is not None:
        inflow = ff["main_net_inflow"]
        if inflow > 0:
            recommendations.append(f"主力资金净流入 {inflow/1e8:.2f}亿，资金面偏多")
        elif inflow < 0:
            recommendations.append(f"主力资金净流出 {abs(inflow)/1e8:.2f}亿，资金面偏空")

    # 基本面建议
    fund = fundamentals or {}
    if fund.get("revenue_yoy") is not None:
        if fund["revenue_yoy"] > 0.1:
            recommendations.append(f"营收同比增长 {fund['revenue_yoy']*100:.1f}%，成长性较好")
        elif fund["revenue_yoy"] < -0.1:
            recommendations.append(f"营收同比下降 {abs(fund['revenue_yoy'])*100:.1f}%，基本面承压")
    if fund.get("roe") is not None and fund["roe"] > 15:
        recommendations.append(f"ROE {fund['roe']:.1f}%，盈利能力较强")

    bs = balance_sheet or {}
    if bs.get("debt_ratio") is not None:
        if bs["debt_ratio"] > 0.7:
            recommendations.append(f"资产负债率 {bs['debt_ratio']*100:.1f}%，负债偏高")

    cf = cashflow or {}
    if cf.get("operating_cash_flow") is not None and cf["operating_cash_flow"] < 0:
        recommendations.append(f"经营现金流为负 ({cf['operating_cash_flow']/1e8:.2f}亿)，关注现金流风险")

    if not recommendations:
        recommendations.append("当前无明确信号，观望为主")

    report = {
        "meta": {
            "symbol": symbol,
            "code": code,
            "market": market,
            "name": name,
            "analysis_date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "data_range": f"{str(df['date'].iloc[0].date())} ~ {str(df['date'].iloc[-1].date())}",
            "data_count": len(df),
        },
        "latest": {
            "date": str(latest["date"].date()),
            "open": round(float(latest["open"]), 2),
            "high": round(float(latest["high"]), 2),
            "low": round(float(latest["low"]), 2),
            "close": round(current_price, 2),
            "volume": int(latest["volume"]) if "volume" in latest and pd.notna(latest["volume"]) else None,
            "change_pct": round(change_pct, 2),
            "prev_close": round(prev_close, 2),
        },
        "chanlun": {
            "top_fractals_count": len(chan_result.get("top_fractals", [])),
            "bottom_fractals_count": len(chan_result.get("bottom_fractals", [])),
            "pens_count": len(chan_result.get("pens", [])),
            "segments_count": len(chan_result.get("segments", [])),
            "centers_count": len(chan_result.get("centers", [])),
            "divergences": chan_result.get("divergences", []),
            "buy_sell_points": chan_result.get("buy_sell_points", []),
            "bottom_fractals": chan_result.get("bottom_fractals", []),
            "trend": chan_result.get("trend", "未知"),
        },
        "ma": ma_result,
        "head_shoulders_bottom": hs,
        "three_gears": {
            "up_gears": three_gears_result.get("up_gears", {}),
            "down_gears": three_gears_result.get("down_gears", {}),
            "hidden_dragon_signal": three_gears_result.get("hidden_dragon_signal", "无"),
            "current_position": three_gears_result.get("current_position", ""),
            "current_point": three_gears_result.get("current_point", 0),
            "recommendation": three_gears_result.get("recommendation", []),
        },
        "cyq": {
            "current_price": cyq_result.get("current_price", current_price),
            "profit_ratio": round(cyq_result.get("profit_ratio", 0), 4),
            "avg_cost": round(cyq_result.get("avg_cost", current_price), 2),
            "peak_price": round(cyq_result.get("peak_price", current_price), 2),
            "concentration": round(cyq_result.get("concentration", 0), 4),
            "main_force_low": round(cyq_result.get("main_force_low", current_price), 2),
            "main_force_high": round(cyq_result.get("main_force_high", current_price), 2),
            "price_low_90": round(cyq_result.get("price_low_90", current_price), 2),
            "price_high_90": round(cyq_result.get("price_high_90", current_price), 2),
            "signals": cyq_signals,
            "source": cyq_result.get("source", "local"),
        },
        "fundamentals": {
            "income": fund,
            "balance_sheet": bs,
            "cashflow": cf,
        },
        "fund_flow": ff,
        "recommendation": recommendations,
    }
    return report


# =============================================================================
# 9. 主函数
# =============================================================================

def main():
    args = parse_args()

    setup_chinese_font()

    df, code, market = fetch_data(args.symbol, args.days, full_history=True)
    _, _, is_index = normalize_symbol(args.symbol)
    print(f"[main] 全量数据: {len(df)} 根K线, {df['date'].iloc[0].date()} ~ {df['date'].iloc[-1].date()}")

    df_full = df.copy()
    df_full = calc_macd(df_full)
    df_full = calc_ma(df_full, periods=(5, 10, 20))

    df_visible = df.tail(args.days).reset_index(drop=True)
    print(f"[main] 可见范围: {len(df_visible)} 根K线 ({args.days}天)")

    df_visible = calc_macd(df_visible)
    df_visible = calc_ma(df_visible, periods=(5, 10, 20))

    # === 六大模块分析 ===

    # 1. 缠论分析
    print("[main] 缠论分析...")
    chan = ChanLunAnalyzer(df_visible)
    chan_result = chan.analyze()

    # 2. 均线分析
    print("[main] 均线分析...")
    ma_result = analyze_ma_arrangement(df_visible)
    macd_result = analyze_macd_cross(df_visible)

    # 3. 头肩底识别（使用全历史K线，多级别检测）
    print("[main] 头肩底形态识别（全历史多级别）...")
    hs_detector = HeadAndShouldersBottom(df_full)
    head_shoulders_result = hs_detector.analyze()
    if head_shoulders_result["detected"]:
        scales = head_shoulders_result.get("by_scale", {})
        scale_info = ", ".join(f"{k}×{len(v)}" for k, v in scales.items())
        print(f"[main] 发现 {head_shoulders_result['pattern_count']} 个头肩底形态 ({scale_info})")

    # 4. 筹码分析
    print("[main] 筹码分布分析...")
    cyq_external = None
    full_symbol = market + code
    try:
        cyq_external = fetch_cyq_westock(full_symbol)
        if cyq_external:
            print(f"[main] WeStock 筹码: 获利盘 {cyq_external['profit_ratio']*100:.1f}%, 平均成本 {cyq_external['avg_cost']:.2f}")
    except Exception as e:
        print(f"[main] WeStock 筹码接口失败: {e}")

    cyq_local = calculate_cyq(df)
    if cyq_local is None:
        cyq_local = {}
    if cyq_external:
        cyq_result = {**cyq_local, **cyq_external}
        cyq_result["source"] = "westock"
    else:
        cyq_result = cyq_local
        cyq_result["source"] = "local"

    cyq_signals = analyze_cyq_signals(cyq_result, df_visible)
    print(f"[main] 筹码信号: {cyq_signals['summary']}")

    # 5. 三档战法
    print("[main] 三档战法分析...")
    tg = ThreeGearsAnalyzer(df, lookback=args.days)
    three_gears_result = tg.analyze()

    # 6. 基本面分析
    gs_set_code = 1 if market == "sh" else 0
    gs_market = "SH" if market == "sh" else "SZ"

    fund_flow_result = {}
    financial_result = {}
    balance_result = {}
    cashflow_result = {}

    if not is_index:
        try:
            fund_flow_result = fetch_gs_fund_flow(code, gs_set_code, period=10)
            if fund_flow_result:
                print(f"[main] 资金流向: 主力净流入 {fund_flow_result.get('main_net_inflow', 'N/A')}")
        except Exception as e:
            print(f"[main] 资金流向失败: {e}")

        try:
            financial_result = fetch_gs_financials(code, gs_market)
            if financial_result:
                print(f"[main] 利润表: 营收 {financial_result.get('revenue', 'N/A')}, ROE {financial_result.get('roe', 'N/A')}")
        except Exception as e:
            print(f"[main] 利润表失败: {e}")

        try:
            balance_result = fetch_gs_balance_sheet(code, gs_market)
            if balance_result:
                print(f"[main] 资产负债表: 负债率 {balance_result.get('debt_ratio', 'N/A')}")
        except Exception as e:
            print(f"[main] 资产负债表失败: {e}")

        try:
            cashflow_result = fetch_gs_cashflow(code, gs_market)
            if cashflow_result:
                print(f"[main] 现金流: 经营现金流 {cashflow_result.get('operating_cash_flow', 'N/A')}")
        except Exception as e:
            print(f"[main] 现金流失败: {e}")

    report = build_report(
        df_visible, chan_result, ma_result, cyq_result, cyq_signals,
        three_gears_result, head_shoulders_result,
        args.name, args.symbol, code, market,
        fund_flow=fund_flow_result, fundamentals=financial_result,
        balance_sheet=balance_result, cashflow=cashflow_result,
    )
    print("\n" + "=" * 60)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print("=" * 60 + "\n")

    paths = {}
    urls = {}
    if not args.no_charts:
        os.makedirs(args.output_dir, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        prefix = f"{market}{code}"

        # 缠论图
        chan_path = os.path.join(args.output_dir, f"chanlun_{prefix}_{ts}.png")
        generate_chanlun_chart(df_visible, report, args.name, chan_path)
        paths["chanlun"] = chan_path

        # 头肩底颈线分析图
        hsb_path = os.path.join(args.output_dir, f"hsb_{prefix}_{ts}.png")
        hsb_result = generate_hsb_chart(df_full, report, args.name, hsb_path)
        if hsb_result:
            paths["hsb"] = hsb_path

        # 筹码图（使用全量K线）
        cyq_path = os.path.join(args.output_dir, f"cyq_{prefix}_{ts}.png")
        generate_cyq_chart(df_full, report, args.name, cyq_path, chan_result=chan_result)
        paths["cyq"] = cyq_path

        # 信息图
        info_path = os.path.join(args.output_dir, f"infographic_{prefix}_{ts}.png")
        generate_infographic(df_visible, report, info_path)
        if info_path and os.path.exists(info_path):
            paths["infographic"] = info_path

        if args.upload:
            for key, path in paths.items():
                if os.path.exists(path):
                    url = upload_to_cos(path)
                    if url:
                        urls[key] = url

    return report, paths, urls


if __name__ == "__main__":
    main()
