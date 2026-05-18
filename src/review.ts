import fs from "fs";
import path from "path";

interface FileStat {
  mtime: number;
  size: number;
}

export interface ChangedFile {
  relPath: string;
  content: string;
}

export interface ReviewResult {
  hasIssues: boolean;
  review: string;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".next", "dist", "build",
  ".cache", ".claude", "session-env", "file-history",
]);

export function snapshotWorkspace(root: string): Map<string, FileStat> {
  const snapshot = new Map<string, FileStat>();
  function walk(dir: string): void {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          snapshot.set(fullPath, { mtime: stat.mtimeMs, size: stat.size });
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  walk(root);
  return snapshot;
}

export function findChangedFiles(
  root: string,
  before: Map<string, FileStat>
): ChangedFile[] {
  const after = snapshotWorkspace(root);
  const changed: ChangedFile[] = [];
  for (const [fullPath, afterStat] of after) {
    const beforeStat = before.get(fullPath);
    if (
      !beforeStat ||
      beforeStat.mtime !== afterStat.mtime ||
      beforeStat.size !== afterStat.size
    ) {
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        if (content.length > 100_000) continue;
        changed.push({
          relPath: path.relative(root, fullPath),
          content,
        });
      } catch {
        /* binary or unreadable */
      }
    }
  }
  return changed;
}

export async function callMimoReview(
  task: string,
  ccOutput: string,
  changes: ChangedFile[]
): Promise<ReviewResult> {
  const apiKey = process.env.XIAOMI_API_KEY;
  if (!apiKey) {
    return { hasIssues: false, review: "MIMO API Key 未配置，跳过 review" };
  }

  const filesText = changes
    .map((f) => `### ${f.relPath}\n\`\`\`\n${f.content.slice(0, 8000)}\n\`\`\``)
    .join("\n\n")
    .slice(0, 80_000);

  const prompt = `请审查以下代码变更。

## 原始任务
${task.slice(0, 2000)}

## Claude Code 的执行结果摘要
${ccOutput.slice(0, 2000)}

## 变更的文件
${filesText}

## 审查标准
只关注实际问题，忽略代码风格偏好：
1. 逻辑错误、bug、死循环、空指针、off-by-one
2. 安全漏洞（注入、XSS、路径遍历、敏感信息泄露）
3. 明显的性能问题（N+1 查询、大循环内重复计算、内存泄漏）
4. 错误处理缺失（未捕获异常、未处理边界情况、资源未释放）

如果代码没有上述实际问题，只需回复 "LGTM"。
如果发现问题，用以下格式：
**[高/中/低] 简述问题** - 文件: xxx
修复建议: 具体的修复方案（给出关键代码片段）`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    const response = await fetch(
      "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "mimo-v2.5",
          messages: [
            {
              role: "system",
              content:
                "你是代码审查专家。只报告实际的 bug、安全漏洞和明显性能问题，不报告代码风格偏好。用中文回复。如果代码没有实际问题，回复 LGTM。",
            },
            { role: "user", content: prompt },
          ],
          max_tokens: 4096,
        }),
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(
        "[review] MIMO API error:",
        response.status,
        text.slice(0, 200)
      );
      return { hasIssues: false, review: `MIMO API 错误 (${response.status})` };
    }

    const data = (await response.json()) as any;
    const reviewText =
      data.choices?.[0]?.message?.content ||
      data.choices?.[0]?.message?.reasoning_content ||
      "";

    if (!reviewText) {
      return { hasIssues: false, review: "Review 无输出" };
    }

    const upperReview = reviewText.toUpperCase();
    const hasIssues =
      !upperReview.includes("LGTM") &&
      (reviewText.includes("[高]") ||
        reviewText.includes("[中]") ||
        reviewText.includes("问题") ||
        reviewText.includes("BUG") ||
        reviewText.includes("漏洞") ||
        reviewText.includes("修复"));

    return { hasIssues, review: reviewText };
  } catch (err: any) {
    if (err.name === "AbortError") {
      return { hasIssues: false, review: "MIMO Review 超时" };
    }
    console.error("[review] MIMO call failed:", err.message);
    return { hasIssues: false, review: `Review 调用失败: ${err.message}` };
  }
}
