import { useTranslation } from "react-i18next";
import Icon from "./Icon";

export default function ArticleListControls({ sortOldest, unreadOnly, onToggleSort, onToggleUnreadOnly, onMarkAll }: {
  sortOldest: boolean;
  unreadOnly: boolean;
  onToggleSort: () => void;
  onToggleUnreadOnly: () => void;
  onMarkAll: () => void;
}) {
  const { t } = useTranslation();
  const sortLabel = sortOldest ? t("articleList.oldestFirst") : t("articleList.newestFirst");
  const filterLabel = unreadOnly ? t("articleList.unreadOnly") : t("smart.all");
  return <div className="list-meta" role="group" aria-label={t("articleList.controls")}>
    <button className={`list-meta-btn ${!sortOldest ? "on" : ""}`} onClick={onToggleSort}
      title={t("articleList.sort")} aria-label={sortLabel} aria-pressed={sortOldest}>
      <Icon name={sortOldest ? "arrow-up" : "arrow-down"} size={12}/>
      <span>{sortLabel}</span>
    </button>
    <button className={`list-meta-btn ${unreadOnly ? "on" : ""}`} onClick={onToggleUnreadOnly}
      title={t("articleList.hideRead")} aria-label={filterLabel} aria-pressed={unreadOnly}>
      <Icon name={unreadOnly ? "eye-off" : "eye"} size={12}/>
      <span>{filterLabel}</span>
    </button>
    <button className="list-meta-btn list-mark-read" onClick={onMarkAll}
      title={t("articleList.markAllRead")} aria-label={t("articleList.markRead")}>
      <Icon name="check-all" size={12}/>
      <span>{t("articleList.markRead")}</span>
    </button>
  </div>;
}
