// Synthetic UI fixtures only. No real accounts, databases, network or keys.
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import SettingsDialog from "../src/components/SettingsDialog";
import en from "../src/locales/en.json";
import zh from "../src/locales/zh.json";
import "@fontsource-variable/inter-tight";
import "../src/styles.css";

const configuration = { mcpServers: { "scholay-today": { command: "/Applications/scholay today.app/Contents/Resources/mcp/scholay-mcp", args: ["--socket", "/Users/example/Library/Application Support/com.thomas.papr/agent.sock"] } } };
mockIPC((command) => {
  if (command.includes("version")) return "0.15.0";
  if (command === "list_feeds") return [];
  if (command === "list_folders") return [{ id: 1, name: "科研精选", position: 0 }, { id: 2, name: "人工智能", parentId: 1, position: 0 }];
  if (command === "library_status") return { enabled: true, writable: true, revision: 1, configuration, archived: [{ id: 1, title: "示例：已移除的来源", articles: 128, archivedAt: "2026-09-06" }], history: [{ id: 1, actor: "mcp", actions: [{ action: "move_folder" }], createdAt: "2026-09-06 12:00:00" }] };
  if (command === "platform_status") return [{ id: "zhihu", name: "知乎", method: "开放平台 Access Secret · 系统钥匙串", status: "configured", service: "available", detail: "API 授权用于知识雷达抓取，不等同于知乎网页账号登录。" }, { id: "wechat", name: "微信公众号", method: "WechRss · 微信读书扫码会话", status: "expired", service: "available", detail: "已配置凭证，但最近抓取报告登录过期。请重新扫码授权。" }];
  return null;
});
document.documentElement.dataset.platform = "mac";
document.documentElement.dataset.palette = "paper";
document.documentElement.dataset.mode = new URLSearchParams(location.search).has("dark") ? "dark" : "light";
const i18n = createInstance();await i18n.use(initReactI18next).init({ lng: "zh", resources: { zh: { translation: zh }, en: { translation: en } } });
createRoot(document.getElementById("root")!).render(<I18nextProvider i18n={i18n}><QueryClientProvider client={new QueryClient()}><SettingsDialog onClose={() => {}} onAddFeed={() => {}} onToast={() => {}} initialSection={new URLSearchParams(location.search).get("section") ?? "agents"}/></QueryClientProvider></I18nextProvider>);
