import { useTranslation } from "react-i18next";
import { useUi } from "../store";
import Icon from "./Icon";

/** One reversible preference for RSS and Hot's shared embedded browser. */
export default function WebThemeToggle({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const enabled = useUi((s) => s.prefs.webDarkMode);
  const setPref = useUi((s) => s.setPref);
  return <button type="button" className="web-theme-toggle" aria-pressed={enabled}
    aria-label={t("reader.webDarkMode")} disabled={disabled}
    title={t(enabled ? "reader.webDarkRestore" : "reader.webDarkEnable")}
    onClick={() => setPref({ webDarkMode: !enabled })}>
    <Icon name="moon" size={14}/>
    <span>{t(enabled ? "reader.webDarkAuto" : "reader.webOriginalColors")}</span>
  </button>;
}
