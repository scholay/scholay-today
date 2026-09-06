import type { ReactNode } from "react";
import type { ReaderTab } from "../lib/aiFormatted";

export const readerViewKey = (articleId: number, mode: ReaderTab) => `reader-view:${articleId}:${mode}`;
export const readerSummaryKey = (articleId: number) => `reader-summary:${articleId}`;

interface Props {
  articleId: number;
  mode: ReaderTab;
  renderReading: () => ReactNode;
  renderWeb: () => ReactNode;
  renderFormatted: () => ReactNode;
}

/** One keyed outlet owns the reader body. Only the chosen render function is
 *  invoked; inactive panes are unmounted, not stacked or hidden with CSS.
 *  Its semantic key cannot collide with the sibling AI-summary drawer. */
export default function ReaderViewOutlet({ articleId, mode, renderReading, renderWeb, renderFormatted }: Props) {
  const content = mode === "formatted" ? renderFormatted() : mode === "web" ? renderWeb() : renderReading();
  return <div key={readerViewKey(articleId, mode)} className="reader-view-content" data-reader-view={mode} data-reader-article={articleId}>{content}</div>;
}
