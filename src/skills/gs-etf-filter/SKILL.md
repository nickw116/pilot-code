---
name: gs-etf-filter
description: 提供ETF专业榜单筛选与自定义多维分析；当用户需要筛选ETF产品、查询ETF榜单、按条件筛选ETF或分析ETF投资数据时使用
dependency:
  python:
    - httpx>=0.24.0
    - pandas>=1.5.0
    - openpyxl>=3.1.0
---

# ETF智能筛选

## 技能调用方式

```bash
python /workspace/projects/gs-etf-filter/scripts/get_data.py --help
```

## 功能范围

### 1. 专业榜单筛选

通过专业榜单直接获取筛选结果，支持以下榜单：

| classId | 榜单分类 | listId | 榜单名称 |
|---------|----------|--------|----------|
| 1 | 短线热榜 | 11 | 热点赛道 |
| 1 | 短线热榜 | 13 | T+0短线突破 |
| 2 | 中长期精选 | 21 | 高分红低波动 |
| 2 | 中长期精选 | 22 | 能涨又能跌 |
| 2 | 中长期精选 | 23 | 低估且优质 |
| 2 | 中长期精选 | 24 | 低估且弹性大 |
| 2 | 中长期精选 | 25 | 稳做绩优生 |
| 3 | 特色品种 | 31 | 全市场热门 |
| 3 | 特色品种 | 32 | 平衡资产配置 |

### 2. 自定义筛选

支持7大维度24个指标的筛选：

| 维度 | 指标 | 参数名 | 说明 |
|------|------|--------|------|
| 基本信息 | 一级类型 | class1 | 行业-1, 宽基-2, 风格策略-3, 跨境-4, 债券-5, 黄金-6, 货币-7 |
| 基本信息 | 二级类型 | class2 | 科技-11, 金融地产-12, 军工-13, 制造-14, 消费-15, 医药-16, 周期-17, 其它-18等 |
| 基本信息 | 规模 | endamt | 单位：亿，多区间用分号连接，如"10,50"表示10-50亿 |
| 基本信息 | 成立年限 | estyear | 大于等于n年传n |
| 基本信息 | 费率 | tgfandglf | 托管费+管理费之和，单位%，如"0,0.3"表示≤0.3% |
| 基本信息 | 基金公司 | tacode | 基金公司代码 |
| 基本信息 | 基金经理规模 | mgrAmount | 单位：亿，如"5,10"表示5-10亿 |
| 交易属性 | T+0 | isT0 | 1-是 |
| 交易属性 | 融资融券 | isrzrq | 1-是 |
| 交易属性 | 20%涨跌幅 | is20perrange | 1-是 |
| 交易属性 | 短线突破 | isdxtp | 1-是 |
| 交易属性 | 低波 | isLowwave | 1-是 |
| 收益表现 | 净值涨跌幅 | profit | 格式：profit1w:5,6;profit1m:-5.2,6.9 |
| 收益表现 | 涨跌幅排名 | profitrank | 格式：profit1wrank:5.6 |
| 收益表现 | 定投回测 | dt | 格式：dt1y:5,6 |
| 风险波动 | 回撤 | drawback | 格式：drawback1y:20 |
| 风险波动 | 波动率 | std | 格式：std1yrank:5.6 |
| 风险波动 | 夏普比率 | sharpe | 格式：sharpe1yrank:5.6 |
| 行情指标 | 价格涨跌幅 | pricerange | 格式：range5d:5,6 |
| 行情指标 | 溢价率 | premiumrate | 格式：5,6 表示5%~6% |
| 行情指标 | 成交额 | matchamt | 单位：万 |
| 行情指标 | 日均成交额 | avg20dmatchamt | 20日日均成交额 |
| 基本面 | 指数估值 | temperRegion | 1-高温,2-较高温,3-常温,4-较低温,5-低温 |
| 基本面 | 行业景气度 | hayjqidu | 高：-3, 中：-2, 低：-1 |
| 基本面 | 指数股息率 | diviendyield | 格式：5,6 表示5%~6% |
| 趋势热度 | 人气排名 | hotrank | 如100表示前100名 |
| 趋势热度 | 行业趋势度 | hyqsdu | 强：-3, 中：-2, 弱：-1 |

## 前置准备

### 获取API Key

该技能依赖国信证券小信智慧助手的数据服务，需要先配置API Key。

配置步骤：
1. 访问 https://www.guosen.com.cn/gs/xxskills/index.html 注册/登录账号
2. 登录后获取您的API Key。登录位置：网页一级标题栏-登录。登录后，点击账号，在弹窗上可一键复制API Key。
3. 在技能凭证配置中填入API Key

### API Key配置

该技能依赖国信证券小信智慧助手的数据服务，需要先配置API Key。

配置步骤：
1. 访问 https://www.guosen.com.cn/gs/xxskills/index.html 注册/登录账号
2. 登录后获取您的API Key。登录位置：网页一级标题栏-登录。登录后，点击账号，在弹窗上可一键复制API Key。
3. API Key 由服务端通过环境变量统一管理，无需手动存储到文件

**调用脚本时**：
- 环境变量 `COZE_GUOSEN_API_KEY_7627056463827140634` 由服务端预配置
- 脚本自动从环境变量读取 API Key

### 安装依赖

依赖已在SKILL.md前言区定义，系统会自动安装。

### 智能体调用脚本流程

智能体在调用脚本执行ETF筛选时，**必须**遵循以下流程：

1. **确认环境变量**：
   - 脚本从环境变量 `COZE_GUOSEN_API_KEY_7627056463827140634` 读取 API Key（服务端预配置）

2. **调用脚本执行筛选**：
   ```bash
   python /workspace/projects/gs-etf-filter/scripts/get_data.py [参数]
   ```

3. **读取结果并展示**：
   - 读取脚本输出的txt或xlsx文件
   - 格式化展示ETF数据

**注意事项**：
- 环境变量 `COZE_GUOSEN_API_KEY_7627056463827140634` 由服务端统一管理
- 如果 API 调用失败，提示用户检查 API Key 配置

## 输出说明

脚本会在 `/workspace/projects/gs-etf-filter/scripts/output/` 目录下生成中间结果文件（xlsx、txt），这些文件仅用于数据存储，**不应向用户展示文件路径或文件内容**。

### 智能体输出要求

智能体在脚本执行完成后，**必须**：
1. 读取脚本输出的txt或xlsx文件，解析其中的数据
2. **直接将筛选到的全部ETF以表格或列表形式完整呈现给用户**（最多100只），不得省略或截断，仅需展示以下字段：
   - ETF名称（产品名称）
   - ETF代码（产品代码）
   - ETF价格（最新价）
   - ETF最新涨跌幅（实时涨跌）
   - ETF规模（最新规模/规模(亿)）
   - ETF成立年限
3. 首行说明筛选到的ETF只数和本次筛选条件
4. 末行固定输出：**筛选结果展示满足条件的前100只ETF。**
5. **不得**向用户展示文件路径、文件名等中间文件信息

## 使用示例

### 专业榜单调用

```bash
python /workspace/projects/gs-etf-filter/scripts/get_data.py --list-id 21 --class-id 2
python /workspace/projects/gs-etf-filter/scripts/get_data.py --list-id 13 --class-id 1 --order-col nowrange
```

### 自定义筛选调用

```bash
# 筛选规模>10亿且管理费率<0.5%的宽基ETF
python /workspace/projects/gs-etf-filter/scripts/get_data.py --class1 2 --endamt "10,100000" --tgfandglf "0,0.5"

# 筛选近1年业绩排名前25%的行业ETF
python /workspace/projects/gs-etf-filter/scripts/get_data.py --class1 1 --profitrank "profit1yrank:25"

# 按夏普比率排序
python /workspace/projects/gs-etf-filter/scripts/get_data.py --class1 1 --order-col sharpe1yrank --order-type 1
```

## 补充说明

- 本技能面向ETF筛选分析，不提供投资建议
- 支持中英文输入
- 筛选结果最多返回满足条件的前100只ETF
- 脚本取数完成后，智能体应读取结果文件，直接向用户呈现数据表格和分析报告，不得展示文件路径
- API Key 由服务端通过环境变量统一管理，无需手动存储

## 必须输出的声明内容

**每次调用本SKILL后，智能体必须在输出末尾附上以下风险提示：**
> **风险提示**:筛选结果展示满足条件的前100只ETF。
