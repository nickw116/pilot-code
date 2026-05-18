# stock-chart-analysis

金融技术分析六大模块 —— 均线 + 头肩底 + 缠论 + 筹码 + 三档理论 + 基本面。图表输出：缠论图、头肩底颈线图、筹码图、信息图。

## 触发条件

当用户提及以下关键词时激活：
- 分析股票 / 分析指数 / K线分析 / 技术分析 / 股票走势 / 分析行情 / A股分析
- 均线 / MA / 均线排列 / 多头排列 / 空头排列
- 头肩底 / 底部形态 / 反转形态 / 颈线突破
- 缠论 / 缠论分析 / 缠论分型 / 笔 / 中枢 / 背驰 / 买卖点 / 线段
- 筹码分布 / 筹码分析 / CYQ / 获利盘 / 主力成本 / 筹码集中度 / 套牢盘
- 三档 / 三档战法 / 三档理论 / 潜龙 / 第三点
- 基本面 / 财务分析 / ROE / 营收 / 现金流 / 资产负债率
- 上证指数 / 深证成指 / 创业板指

## 输出语言

**所有分析结果必须使用中文输出**，包括：
- 图表标题、轴标签、图例全部使用中文
- 分析报告、操作建议、信号描述全部使用中文
- 技术术语保留原文标注（如"均线(MA)"、"筹码(CYQ)"）

## 禁止事项

**严格禁止在分析中输出以下内容**（无论脚本返回了什么数据）：
- KDJ 指标及其分析
- RSI 指标及其分析
- DMI / SAR 指标及其分析
- 布林带(Bollinger Bands)及其分析
- 威廉指标(WR)及其分析
- 乖离率(BIAS)及其分析
- 任何不在六大模块范围内的技术指标

分析只做六大模块：均线、头肩底、缠论、筹码、三档理论、基本面。超出范围的指标不要自行补充或编造。

## 六大分析模块

### 1. 均线分析 (MA)
- MA5 / MA10 / MA20 均线计算与数值
- 均线排列判断（多头排列 / 空头排列 / 均线纠缠）
- 趋势方向判断

### 2. 头肩底形态识别 (Head and Shoulders Bottom)
- 左肩、头部、右肩三低点自动识别
- 颈线价格计算（两反弹高点均值）
- 两肩对称性校验（差异<15%）
- 突破信号判定（接近/突破颈线）
- 量能形态分析（缩量筑底 / 右肩放量）
- 目标价位计算（颈线 + 颈线到头部距离）
- 输出：形态位置、颈线价、信号、目标价

### 3. 缠论分析 (Chan Theory)
- **K线包含处理**：方向感知合并，消除包含关系
- **分型识别**：4条件严格判断（顶底分型）
- **笔识别**：顶底交替连接，最小间隔校验
- **线段识别**：3笔重叠区域确认
- **中枢识别**：滑动窗口3笔重叠区间
- **背驰检测**：MACD柱面积比较（面积缩小>20%）
- **三类买卖点**：
  - 第一类：趋势背驰后的转折点
  - 第二类：第一类买卖点后回抽不破中枢
  - 第三类：突破/跌破中枢后回抽确认
- 走势判断（上涨/下跌/盘整，基于中枢位置）

### 4. 筹码分析 (CYQ)
- 获利盘比例、平均成本、筹码峰值价格
- 90%筹码集中度、主力成本区（最密集20%筹码）
- 90%价格区间
- **交易信号规则**：
  - 低位密集 + CYS<-20% → 超卖+主力吸筹 → 买入
  - 放量突破筹码密集区 → 有效突破 → 跟进
  - 高位密集 + CYS>30% → 超买+主力派发 → 卖出
  - 筹码快速下沉 → 主力出货 → 离场
- 数据来源：WeStock(腾讯) 优先，本地三角分布模型 fallback

### 5. 三档理论 (Three Gears)
- 上涨三档：一档线(绿)/二档线(金)/三档线(红)
- 旋转射线法检测各档趋势线
- 第三点介入标注（菱形标记+价格标签）
- 延长虚线显示趋势延续
- 潜龙买点信号（下跌三档急跌+底分型）
- 当前所处档位阶段判断
- 专属操作建议（长线/中线/短线）

### 6. 基本面分析 (Fundamentals)
- **利润表**：营收、净利润、营收同比、净利同比、毛利率、ROE、EPS
- **资产负债表**：总资产、总负债、资产负债率、流动比率、每股净资产
- **现金流量表**：经营现金流、投资现金流、筹资现金流、自由现金流、经营现金流同比
- 数据来源：国信证券API（需GS_API_KEY）

## 执行参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `symbol` | string | `sh000001` | 股票/指数代码，支持 `sh000001`、`000001.SH`、`000001` |
| `name` | string | `上证指数` | 中文名称，用于图表标题 |
| `days` | int | `60` | 回溯交易日天数 |
| `full-history` | flag | — | 拉取从上市日至今的全历史数据（推荐用于三档战法） |
| `output_dir` | string | `/tmp/stock_charts/` | 图表输出目录 |
| `upload` | bool | `true` | 生成图表后自动上传 COS |
| `no-upload` | flag | — | 跳过 COS 上传 |
| `no-charts` | flag | — | 仅输出 JSON 报告，不生成图表 |

## 执行流程

```
python generate_analysis.py --symbol sh000001 --name 上证指数 --days 60
python generate_analysis.py --symbol 600519 --name 贵州茅台 --days 120

-> 拉取日K数据（WeStock优先，akshare fallback）
-> [均线] MA5/MA10/MA20 + 均线排列判断
-> [缠论] K线包含处理 → 分型 → 笔 → 线段 → 中枢 → 背驰 → 买卖点
-> [头肩底] 三低点识别 → 颈线计算 → 突破信号 → 目标价
-> [筹码] CYQ分布 + 交易信号（买入/跟进/卖出/离场）
-> [三档] 旋转射线法 → 三档趋势线 → 第三点 → 潜龙信号
-> [基本面] 利润表 + 资产负债表 + 现金流量表
-> 输出 JSON 分析报告到 stdout
-> 生成缠论分析图 PNG（K线+白色笔+分型+中枢+背驰）
-> 生成头肩底颈线分析图 PNG（左肩/头部/右肩标记+颈线+目标价）
-> 生成筹码分布图 PNG（通达信风格）
-> 生成竖版信息图 PNG（1080x1920）
-> 自动上传所有图表到 COS，返回公开 URL
```

## 输出

### 图表交付规则
所有生成的图表必须以内联预览形式呈现（MEDIA 标签或图片嵌入），**禁止输出下载链接或 URL 表格**。

### 文字分析报告规范

JSON 数据输出后，**必须**按以下结构生成中文文字分析报告，六大模块缺一不可：

```
## 📊 {股票名称}（{代码}）技术分析报告

**当前价格**: {close}  **涨跌幅**: {change_pct}%  **分析日期**: {analysis_date}

---

### 1️⃣ 均线分析
- MA5={ma5} MA10={ma10} MA20={ma20}
- 均线排列：{arrangement}（多头排列/空头排列/均线纠缠）
- 趋势判断

### 2️⃣ 头肩底形态
- 若 detected=true：
  - 左肩: {left_shoulder.price}（{left_shoulder.date}）
  - 头部: {head.price}（{head.date}）
  - 右肩: {right_shoulder.price}（{right_shoulder.date}）
  - 颈线: {neckline}  目标价: {target_price}
  - 信号: {signal}（突破颈线确认/接近颈线/形态形成中）
  - 量能形态: {volume_pattern}
  - 操作: {action}
- 若 detected=false：
  - "当前未检测到头肩底形态"

### 3️⃣ 缠论分析
- 走势: {trend}
- 分型: {top_fractals_count}个顶分型, {bottom_fractals_count}个底分型
- 笔: {pens_count}笔  线段: {segments_count}段  中枢: {centers_count}个
- 买卖点: 逐一列出 {buy_sell_points} 的类型和原因
- 背驰: 逐一列出 {divergences} 的类型、置信度、说明

### 4️⃣ 筹码分析
- 获利盘: {profit_ratio}%  平均成本: {avg_cost}  峰值: {peak_price}
- 集中度(90%): {concentration}%  主力成本区: {main_force_low} ~ {main_force_high}
- CYS: {cys}%  交易信号: {signals[0].signal} — {signals[0].detail}

### 5️⃣ 三档战法
- 当前位置: {current_position}
- 潜龙信号: {hidden_dragon_signal}
- 各档状态: 一档角度{angle}°/状态  二档... 三档...
- 操作建议: {recommendation}

### 6️⃣ 基本面
- 利润表: 营收{revenue}亿(同比{revenue_yoy}%)  净利润{net_profit}亿  ROE {roe}%  EPS {eps}
- 资产负债表: 负债率{debt_ratio}  流动比率{current_ratio}  每股净资产{bvps}
- 现金流: 经营现金流{operating_cash_flow}亿  自由现金流{free_cash_flow}亿
- 资金流向: 主力净{流入/流出}{main_net_inflow}亿

---

### 📋 综合操作建议
将 recommendation 数组中的建议逐条列出，按优先级排序。

### 图表
内联展示生成的图表（缠论图、头肩底颈线图、筹码图、信息图）。
```

**关键要求**：
1. 六大模块**必须全部输出**，不得省略任何模块
2. 头肩底 detected=false 时也必须输出"未检测到"的说明
3. 所有内容使用中文
4. 禁止输出 KDJ/RSI/DMI/SAR/布林带等不在六大模块内的指标

### JSON 报告结构

```json
{
  "meta": { "symbol", "code", "market", "name", "analysis_date", "data_range" },
  "latest": { "date", "open", "high", "low", "close", "volume", "change_pct" },
  "chanlun": {
    "top_fractals_count", "bottom_fractals_count",
    "pens_count", "segments_count", "centers_count",
    "divergences": [{ "type", "price", "confidence", "note" }],
    "buy_sell_points": [{ "type", "price", "reason" }],
    "trend"
  },
  "ma": { "latest": {"ma5","ma10","ma20"}, "arrangement" },
  "head_shoulders_bottom": {
    "detected", "pattern_count",
    "best_pattern": { "left_shoulder", "head", "right_shoulder", "neckline",
                      "target_price", "signal", "action", "volume_pattern" }
  },
  "three_gears": { "up_gears", "down_gears", "hidden_dragon_signal",
                   "current_position", "current_point", "recommendation" },
  "cyq": { "current_price", "profit_ratio", "avg_cost", "peak_price",
           "concentration", "main_force_low/high", "signals", "source" },
  "fundamentals": {
    "income": { "revenue", "revenue_yoy", "net_profit", "roe", "eps" },
    "balance_sheet": { "debt_ratio", "current_ratio", "bvps" },
    "cashflow": { "operating_cash_flow", "free_cash_flow", "ocf_yoy" }
  },
  "fund_flow": { "main_net_inflow" },
  "recommendation": ["综合操作建议"]
}
```

### 生成图表

| 图表 | 文件前缀 | 内容 |
|------|---------|------|
| 缠论图 | `chanlun_` | K线+白色笔线+分型标记(红/绿)+中枢+背驰+MACD副图+成交量 |
| 头肩底图 | `hsb_` | K线+左肩/头部/右肩标记+颈线(黄虚线)+目标价(绿虚线)+信号面板+成交量 |
| 筹码图 | `cyq_` | K线+右侧筹码分布+关键价位线+指标面板 |
| 信息图 | `infographic_` | 竖版1080x1920，六大模块卡片+操作建议 |

### 图表交付规范
- **禁止给出下载链接/URL**
- 使用 `MEDIA:<url>` 或 `![描述](url)` 内联预览
- 优先上传竖版信息图作为主预览图
- 上传优先使用 cos_util（走自定义域名 nickstorage.top），fallback 到 coscli

## 文件结构

```
skills/stock-chart-analysis/
├── SKILL.md              # 本文件
├── generate_analysis.py  # 主脚本（一站式：数据+六大模块分析+出图+上传）
├── upload_chart.py       # 独立上传工具（保留）
└── requirements.txt      # 合并后的依赖
```

## 依赖

- `akshare`: A股日K数据拉取（fallback）
- `westock-data-clawhub`: 腾讯自选股数据（优先）
- `pandas` + `numpy`: 数据处理
- `matplotlib`: 图表绘制
- `mplfinance`: 专业金融K线图（可选，未安装时自动 fallback）
- `Pillow`: 竖版信息图生成
- `requests` / `urllib`: HTTP请求

## 注意事项

- 分析结果仅供参考，不构成投资建议
- 字体兼容：优先 WenQuanYi，自动 fallback 到系统可用中文字体
- COS 凭证从 `/root/h5-chat/.env` 读取
- 国信API需配置 `GS_API_KEY`（从 memory.md 读取）
- 代码格式同时兼容 `sh000001`、`000001.SH`、纯数字 `000001`
- 头肩底识别至少需要30根K线，建议 days>=60
