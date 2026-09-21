import type { StructuredDocument, StructuredListItem } from "../types";

/** Authored, offline examples. Never inserted into feeds/articles, sent to a
 * cleaner, or mixed into the real library's counts and folder tree. */
const TICK = String.fromCharCode(96);
const examples = [
  {
    title: "一篇清洗文档，应该保留什么？",
    category: "清洗规范",
    markdown: `## 先保留证据，再整理结构

这是一篇内置的排版示例，不是真实论文或网页的清洗结果。它展示文库如何呈现标题、段落、引用、列表与表格；其中的内容仅用于说明产品的清洗规则。

结构化清洗负责把已有内容整理成可读、可导出的文档，不负责替作者补充结论。正文、来源和不完整提示应当一起保留，让读者知道内容从哪里来，又有哪些地方需要回到原文核对。

## 内容保留清单

| 原文元素 | 文库中的呈现 | 清洗边界 |
| --- | --- | --- |
| 分节标题 | 分级标题与目录 | 不凭空生成章节 |
| 段落与引用 | 正文、独立引用块 | 保留原意与顺序 |
| 有序与嵌套列表 | 编号与层级 | 不把步骤改成散落段落 |
| 表格与代码 | 可横向滚动的内容块 | 不推算缺失数据 |
| 图片 | 图片引用与图注 | 不伪称已下载原图 |

## 清洗的三个步骤

1. 确认来源。
   - 优先使用已保存的网页快照。
   - 没有完整内容时，再由应用补抓公开网页。
2. 整理结构，移除脚本、表单和明确的导航噪声。
3. 检查结果，将截断、短正文和补抓失败等情况显式记录。

> 清洗成功不等于事实已经核验。引用一篇文档之前，仍应检查原文及其证据。

## 需要人工复核的情况

当结果只是摘要、表格含有合并单元格，或网页内容需要登录才能看到时，文库应保留限制说明。已有清洗文档不会因为规则升级而被静默覆盖。`,
  },
  {
    title: "研究笔记样式：从问题到证据",
    category: "阅读排版",
    markdown: `## 研究问题

如何让一个研究问题在多次阅读之后仍然保持清晰？下面是一份虚构的笔记模板，用来展示较长段落、重点标记和引用的阅读效果，不包含真实研究结果。

一个完整的问题通常包含对象、条件与希望观察的变化。阅读时可以把原文明确写出的信息，与读者自己的解释分开放置。**证据来自原文，判断由读者负责。**

### 建立证据卡片

- 原文说了什么？
- 作者用了什么方法？
- 哪些限制被作者明确说明？
- 还有哪些材料尚未取得？

## 引用与解释

> 这一段是专门编写的引用样式示例。
>
> 多段引用应保持在同一个视觉层级中，而不是混回普通正文。

### 给不确定性留出位置

“没有找到”不等于“不存在”。当资料不完整时，可以明确写出尚未确认的范围，而不是为缺失的信息补上看起来合理的答案。

## 下一次阅读

1. 回到原始材料，确认上下文。
2. 对照笔记，标记需要修订的地方。
3. 保存来源与版本信息，便于以后追溯。`,
  },
  {
    title: "长标题与中英混排示例：让 Structured Markdown 在窄阅读区里依然清晰可读",
    category: "表格与代码",
    markdown: `## Structured content / 结构化内容

这是一个用于测试长标题、英文标识符和代码排版的内置示例。缩窄中间列表或右侧正文时，标题应自然换行；代码与宽表格在自己的区域内滚动，不撑破整个页面。

### 保存来源，而不是猜测内容

使用 ${TICK}source_kind${TICK} 记录来源类型，使用 ${TICK}capture_id${TICK} 对应保存的快照。示例标识符 example_document_with_a_deliberately_long_identifier_for_layout_testing 应当仍在阅读区内。

${TICK.repeat(3)}json
{
  "example": true,
  "source_kind": "offline_example",
  "policy": "preserve_evidence_without_inventing_missing_content",
  "sections": ["headings", "paragraphs", "lists", "tables", "code"]
}
${TICK.repeat(3)}

## 检查记录（虚构示例）

| 检查项 | 输入条件 | 预期表现 | 备注 |
| --- | --- | --- | --- |
| 长标题 | 中英文混排、连续标识符 | 标题换行，操作按钮保持可见 | 不截断正文标题 |
| 宽表格 | 多列与较长内容 | 表格区域内水平滚动 | 不改变侧栏宽度 |
| 代码片段 | 缩进与较长行 | 保留空白与换行 | 只读源码可复制 |
| 深色主题 | 暗色阅读背景 | 正文、边框和拖动把手可辨识 | 沿用全局主题 |

## 切换阅读方式

上方可以切换预览与 Markdown 源码，也可以复制或下载这份示例。示例不连接网络，不会添加 RSS 订阅或清洗任务。`,
  },
];

export const LIBRARY_EXAMPLES: { item: StructuredListItem; document: StructuredDocument }[] = examples.map((example, index) => {
  const articleId = -(index + 1);
  const words = example.markdown.replace(/[#*|>`\-]/g, "").length;
  return {
    item: { articleId, feedId: 0, feedTitle: "内置示例 · 非真实文章", folderId: null, folderName: example.category, title: example.title, url: null, publishedAt: null, cleanedAt: "", sourceKind: "example", blocks: 0, words, images: 0, staleSchema: false },
    document: { articleId, cleaned: true, sourceKind: "example", words, images: 0, markdown: example.markdown, warnings: [] },
  };
});
