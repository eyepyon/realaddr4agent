import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { PublicPage } from "./PublicPages";
import { getPublicPage } from "./public-content";
import { AdminApp } from "./admin/AdminApp";
import { AppArea } from "./app/AppArea";
import { ApprovalShell } from "./approve/ApprovalShell";
import "./styles.css";

function RouteApp() {
  const path = window.location.pathname;
  const page = getPublicPage(path);
  if (page) return <PublicPage page={page} />;
  if (path === "/admin" || path === "/admin/") return <AdminApp />;
  if (path === "/app" || path.startsWith("/app/")) return <AppArea />;
  if (/^\/approve\/[^/]+\/?$/.test(path)) return <ApprovalShell />;
  return <main className="not-found"><h1>ページが見つかりません</h1><p>指定されたページは存在しないか、現在利用できません。</p><a href="/">トップへ戻る</a></main>;
}

const root = document.getElementById("root");
if (root) {
  const app = <React.StrictMode><RouteApp /></React.StrictMode>;
  if (root.dataset.prerender === "public") hydrateRoot(root, app);
  else createRoot(root).render(app);
}
