import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";

type Session = { displayName: string; role: "operator"; expiresAt: string; csrfToken: string };
type Section = "overview" | "locations" | "payments" | "subscriptions" | "operations" | "audit";
type Row = Record<string, unknown>;
type Notice = { kind: "success" | "error" | "warning"; text: string };
type FilterState = Record<string, string>;
type PendingMutation = { path: string; method: "POST" | "PATCH"; body: Record<string, unknown>; key: string; label: string };

const sectionLabels: Record<Section, string> = {
  overview: "概要", locations: "拠点", payments: "決済", subscriptions: "契約・ENS", operations: "処理", audit: "監査ログ",
};
const statuses: Record<string, string> = {
  available: "販売中", paused: "停止中", pending: "処理待ち", settling: "決済確認中", reconciling: "照合中", unknown: "結果不明",
  pending_readback: "反映確認中", manual_review: "要確認", active: "有効", expired: "期限切れ", fulfilled: "完了", failed: "失敗",
  not_purchased: "未購入", synced: "同期済み", requested: "受付済み", applied: "反映済み", rejected: "拒否", queued: "照合要求済み",
};
const columns: Record<Exclude<Section, "overview">, Array<[keyof Row, string]>> = {
  locations: [["displayName", "拠点"], ["slug", "slug"], ["publicArea", "公開エリア"], ["postalCode", "郵便番号"], ["address", "提供住所"], ["status", "販売状態"], ["version", "version"], ["issuedSubscriptionCount", "発行済み契約"]],
  payments: [["id", "決済ID"], ["kind", "種類"], ["locationId", "拠点ID"], ["floor", "仮想区画"], ["amountAtomic", "金額（atomic）"], ["status", "状態"], ["riskVerdict", "リスク判定"], ["riskReasonCode", "理由コード"], ["traceId", "trace ID"], ["createdAt", "作成日時"]],
  subscriptions: [["id", "契約ID"], ["locationId", "拠点ID"], ["floor", "仮想区画"], ["status", "契約状態"], ["expiresAt", "期限"], ["ensName", "ENS名"], ["ensNameType", "ENS種別"], ["ensStatus", "ENS状態"], ["registryStatus", "Registry状態"], ["mailEnabled", "転送設定"], ["destinationConfigured", "転送先登録有無"]],
  operations: [["id", "処理ID"], ["kind", "種別"], ["targetId", "対象ID"], ["status", "状態"], ["lastErrorCode", "最終エラー"], ["nextAttemptAt", "次回確認"], ["version", "version"], ["updatedAt", "更新日時"]],
  audit: [["occurredAt", "日時"], ["action", "操作"], ["targetType", "対象種別"], ["targetId", "対象ID"], ["result", "結果"], ["reason", "理由"], ["beforeVersion", "変更前"], ["afterVersion", "変更後"], ["traceId", "trace ID"]],
};

function labelValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (key === "floor") return `仮想区画 V${String(value).padStart(5, "0")}`;
  if (key === "amountAtomic") return `${String(value)} USDC atomic（6桁）`;
  if (key === "mailEnabled") return value ? "有効" : "無効";
  if (key === "destinationConfigured") return value ? "登録済み" : "未登録";
  if (key === "ensNameType") return value === "floor" ? "標準名" : value === "custom" ? "custom名" : "未購入";
  if (key.toLowerCase().includes("at") || key === "expiresAt") {
    const date = new Date(String(value));
    if (Number.isNaN(date.valueOf())) return String(value);
    return `${new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(date)}（${date.toISOString()}）`;
  }
  return statuses[String(value)] ?? String(value);
}

function makeQuery(section: Exclude<Section, "overview">, filters: FilterState, cursor?: string): URLSearchParams {
  const query = new URLSearchParams({ limit: "20" });
  if (filters.id?.trim()) { query.set("id", filters.id.trim()); return query; }
  if (cursor) query.set("cursor", cursor);
  if (section === "locations" && filters.status) query.set("status", filters.status);
  if ((section === "payments" || section === "subscriptions") && filters.status) query.set("status", filters.status);
  if ((section === "payments" || section === "subscriptions") && filters.locationId) query.set("locationId", filters.locationId.trim());
  if (section === "operations" && filters.kind) query.set("kind", filters.kind);
  if (section === "operations" && filters.status) query.set("status", filters.status);
  if (section === "audit" && filters.targetType && filters.targetId?.trim()) { query.set("targetType", filters.targetType); query.set("targetId", filters.targetId.trim()); }
  return query;
}

async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof data.error === "string" ? data.error : `http_${response.status}`;
    const error = new Error(code) as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = code;
    throw error;
  }
  return data as T;
}

function publicError(error: unknown): string {
  if (error instanceof TypeError) return "サーバーへ接続できませんでした。接続を確認してください。";
  const code = (error as { code?: string } | null)?.code ?? "";
  const messages: Record<string, string> = {
    location_conflict: "拠点が別の操作で更新されました。最新値を読み直してください。",
    idempotency_conflict: "同じ操作IDに異なる内容が指定されました。対象の状態を再取得してください。",
    invalid_request: "入力内容を確認してください。",
    unauthorized: "ログインの有効期限が切れました。もう一度ログインしてください。",
    forbidden: "この操作を行う権限がありません。",
  };
  return messages[code] ?? "処理を完了できませんでした。内容を確認して再度お試しください。";
}

function statusClass(value: unknown): string {
  const text = String(value ?? "").toLowerCase();
  if (["available", "active", "fulfilled", "applied", "allow", "synced"].includes(text)) return "success";
  if (["paused", "pending", "settling", "reconciling", "unknown", "manual_review", "pending_readback", "hold"].includes(text)) return "warning";
  if (["failed", "rejected", "deny", "expired"].includes(text)) return "danger";
  return "";
}

export function AdminApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [authState, setAuthState] = useState<"loading" | "ready" | "login" | "unconfigured" | "error">("loading");
  const [authError, setAuthError] = useState("");
  const [section, setSection] = useState<Section>("overview");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [overview, setOverview] = useState<Row | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined]);
  const [filters, setFilters] = useState<FilterState>({});
  const [appliedFilters, setAppliedFilters] = useState<FilterState>({});
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Row | null>(null);
  const [locationForm, setLocationForm] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Row | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; description: string; action: () => void } | null>(null);
  const [reason, setReason] = useState("");
  const reasonRef = useRef("");
  const [pendingMutation, setPendingMutation] = useState<PendingMutation | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const mutationLock = useRef(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const requestGeneration = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);

  const get = useCallback(async <T,>(path: string): Promise<T> => {
    const response = await fetch(path, { credentials: "same-origin", redirect: "error", cache: "no-store", headers: { "x-admin-request": "1" } });
    return readResponse<T>(response);
  }, []);

  useEffect(() => {
    let alive = true;
    void get<Session>("/v1/admin/session").then((value) => {
      if (!alive) return;
      setSession(value);
      setAuthState("ready");
    }).catch((error: unknown) => {
      if (!alive) return;
      const status = (error as { status?: number }).status;
      setAuthState(status === 401 ? "login" : status === 503 ? "unconfigured" : "error");
      setAuthError(publicError(error));
    });
    return () => { alive = false; };
  }, [get]);

  const request = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    if (!session) throw new Error("unauthorized");
    const headers = new Headers(options.headers);
    headers.set("x-admin-request", "1");
    if (options.method && options.method !== "GET") {
      headers.set("content-type", "application/json");
      headers.set("X-CSRF-Token", session.csrfToken);
    }
    const response = await fetch(path, { ...options, headers, credentials: "same-origin", redirect: "error", cache: "no-store" });
    return readResponse<T>(response);
  }, [session]);

  const load = useCallback(async (target: Section, selectedFilters: FilterState, cursor?: string) => {
    if (!session) return;
    const generation = ++requestGeneration.current;
    setBusy(true);
    setNotice(null);
    try {
      if (target === "overview") {
        const value = await request<Row>("/v1/admin/overview");
        if (generation !== requestGeneration.current) return;
        setOverview(value);
        return;
      }
      const endpoint: Record<Exclude<Section, "overview">, string> = {
        locations: "/v1/admin/locations", payments: "/v1/admin/payment-intents", subscriptions: "/v1/admin/subscriptions",
        operations: "/v1/admin/operations", audit: "/v1/admin/audit-events",
      };
      const query = makeQuery(target, selectedFilters, cursor);
      if (target === "audit" && Boolean(selectedFilters.targetType) !== Boolean(selectedFilters.targetId?.trim())) {
        setNotice({ kind: "error", text: "監査ログの絞り込みには対象種別と対象IDの両方を入力してください。" });
        setRows([]); setNextCursor(null); return;
      }
      const value = await request<Record<string, unknown>>(`${endpoint[target]}?${query.toString()}`);
      if (generation !== requestGeneration.current) return;
      const collectionKey: Record<Exclude<Section, "overview">, string> = { locations: "locations", payments: "paymentIntents", subscriptions: "subscriptions", operations: "operations", audit: "auditEvents" };
      const items = value[collectionKey[target]];
      setRows(Array.isArray(items) ? items as Row[] : []);
      setNextCursor(typeof value.nextCursor === "string" ? value.nextCursor : null);
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setRows([]); setNextCursor(null);
      setNotice({ kind: "error", text: publicError(error) });
    } finally {
      if (generation === requestGeneration.current) setBusy(false);
    }
  }, [request, session]);

  useEffect(() => {
    if (authState === "ready" && session) void load("overview", {});
  }, [authState, session, load]);

  const changeSection = (next: Section) => {
    requestGeneration.current++;
    setFilters({}); setAppliedFilters({});
    setSection(next); setDetail(null); setRows([]); setNextCursor(null); setCursorStack([undefined]); setNotice(null);
    if (next === "overview") void load(next, {});
    else void load(next, {}, undefined);
  };

  const refresh = () => {
    setCursorStack([undefined]); setRows([]); setNextCursor(null);
    void load(section, section === "overview" ? {} : appliedFilters, undefined);
  };

  const submitFilters = (event: FormEvent) => {
    event.preventDefault();
    if (filters.id?.trim()) {
      const other = Object.entries(filters).some(([key, value]) => key !== "id" && value.trim());
      if (other) { setNotice({ kind: "error", text: "ID検索は他の絞り込みと併用できません。条件をクリアしてください。" }); return; }
    }
    if (section === "audit" && Boolean(filters.targetType) !== Boolean(filters.targetId?.trim())) {
      setNotice({ kind: "error", text: "監査ログの絞り込みには対象種別と対象IDの両方を入力してください。" }); return;
    }
    requestGeneration.current++;
    const next = { ...filters };
    setAppliedFilters(next); setCursorStack([undefined]); setRows([]); setNextCursor(null); setDetail(null);
    void load(section, next, undefined);
  };

  const changePage = (direction: "next" | "previous") => {
    if (direction === "next" && nextCursor) {
      const nextStack = [...cursorStack, nextCursor]; setCursorStack(nextStack); void load(section, appliedFilters, nextCursor);
    } else if (direction === "previous" && cursorStack.length > 1) {
      const nextStack = cursorStack.slice(0, -1); setCursorStack(nextStack); void load(section, appliedFilters, nextStack.at(-1));
    }
  };

  const mutate = async (mutation: PendingMutation): Promise<boolean> => {
    if (mutationLock.current) return false;
    mutationLock.current = true;
    setMutationBusy(true); setNotice({ kind: "warning", text: `${mutation.label}を送信しています。` });
    const headers = new Headers({ "Idempotency-Key": mutation.key });
    try {
      await request(mutation.path, { method: mutation.method, headers, body: JSON.stringify(mutation.body) });
      setPendingMutation(null); setConfirm(null); setReason(""); setNotice({ kind: "success", text: `${mutation.label}を受け付けました。状態を更新します。` });
      await load(section, section === "overview" ? {} : appliedFilters, cursorStack.at(-1));
      return true;
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      if (error instanceof TypeError || (status !== undefined && status >= 500)) {
        setPendingMutation(mutation);
        setNotice({ kind: "warning", text: "通信結果を確認できません。新しい操作を作らず、同じ内容・同じ操作IDで再試行するか、対象状態を再取得してください。" });
      } else {
        setNotice({ kind: "error", text: publicError(error) });
      }
      return false;
    } finally { mutationLock.current = false; setMutationBusy(false); }
  };

  const startLocationEdit = (row: Row) => { setEditingLocation(row); setFormErrors({}); };
  const closeLocationEdit = () => {
    const hasChanges = formRef.current ? Array.from(formRef.current.elements).some((element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.name !== "reason" && element.value !== element.defaultValue || element.name === "reason" && element.value.trim() !== "" : false) : false;
    if (hasChanges && !window.confirm("編集内容を破棄して閉じますか？")) return;
    setEditingLocation(null); setLocationForm(false); setFormErrors({});
  };

  const createLocation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body = {
      slug: String(form.get("slug") ?? "").trim(), displayName: String(form.get("displayName") ?? "").trim(),
      publicArea: String(form.get("publicArea") ?? "").trim(), postalCode: String(form.get("postalCode") ?? "").trim(),
      address: String(form.get("address") ?? "").trim(), status: "paused", reason: String(form.get("reason") ?? "").trim(),
    };
    if (body.reason.length < 3) { setFormErrors({ reason: "理由は3文字以上で入力してください。" }); return; }
    if (await mutate({ path: "/v1/admin/locations", method: "POST", body, key: crypto.randomUUID(), label: "拠点登録" })) { setLocationForm(false); formElement.reset(); }
  };

  const saveLocation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!editingLocation) return;
    const form = new FormData(event.currentTarget);
    const changes: Record<string, string> = {};
    for (const key of ["displayName", "publicArea", "postalCode", "address"] as const) {
      const value = String(form.get(key) ?? "").trim(); if (value !== String(editingLocation[key] ?? "")) changes[key] = value;
    }
    const reasonText = String(form.get("reason") ?? "").trim();
    if (reasonText.length < 3) { setFormErrors({ reason: "理由は3文字以上で入力してください。" }); return; }
    if (!Object.keys(changes).length) { setNotice({ kind: "warning", text: "変更された項目はありません。" }); return; }
    if (await mutate({ path: `/v1/admin/locations/${encodeURIComponent(String(editingLocation.id))}`, method: "PATCH", body: { expectedVersion: editingLocation.version, reason: reasonText, changes }, key: crypto.randomUUID(), label: "拠点情報の更新" })) setEditingLocation(null);
  };

  const requestLocationStatus = (row: Row, status: "available" | "paused") => {
    const resuming = status === "available";
    setReason(""); reasonRef.current = "";
    setConfirm({
      title: resuming ? "拠点の販売を再開" : "拠点の販売を停止",
      description: resuming ? `「${String(row.displayName)}」を販売中にします。提供住所を利用・公開する許可を確認し、理由を入力してください。` : `「${String(row.displayName)}」の新規販売を停止します。成立済み契約や既存照合は変更しません。理由を入力してください。`,
      action: () => {
        const reasonText = reasonRef.current.trim(); if (reasonText.length < 3) { setNotice({ kind: "error", text: "理由は3文字以上で入力してください。" }); return; }
        void mutate({ path: `/v1/admin/locations/${encodeURIComponent(String(row.id))}`, method: "PATCH", body: { expectedVersion: row.version, reason: reasonText, changes: { status }, ...(resuming ? { publicationConfirmed: true } : {}) }, key: crypto.randomUUID(), label: resuming ? "販売再開" : "販売停止" });
      },
    });
  };

  const requestReconcile = (row: Row) => {
    setReason(""); reasonRef.current = "";
    setConfirm({ title: "読取照合を要求", description: `処理 ${String(row.id)} の既存決済・chain状態を読み取り再確認します。送金、契約の強制反映、chain書込は行いません。`, action: () => {
      const reasonText = reasonRef.current.trim(); if (reasonText.length < 3) { setNotice({ kind: "error", text: "理由は3文字以上で入力してください。" }); return; }
      void mutate({ path: `/v1/admin/operations/${encodeURIComponent(String(row.id))}/reconcile`, method: "POST", body: { expectedVersion: row.version, reason: reasonText }, key: crypto.randomUUID(), label: "読取照合要求" });
    } });
  };

  const pageLabel = useMemo(() => section === "overview" ? "概要" : sectionLabels[section], [section]);

  if (authState === "loading") return <main className="login-page"><div className="login-card"><h1>運用者認証を確認しています</h1><p role="status">管理APIへ接続しています。</p></div></main>;
  if (authState !== "ready" || !session) return <main className="login-page"><div className="login-card"><a className="brand" href="/">RealAddr <span>for Agents</span></a><h1>{authState === "login" ? "運用者ログイン" : authState === "unconfigured" ? "管理画面は未設定です" : "管理画面へ接続できません"}</h1><p role="status">{authState === "login" ? "運用者データを表示するには、登録済みアカウントでログインしてください。" : authState === "unconfigured" ? "運用者認証が設定されていないため、管理データは表示できません。" : authError}</p>{authState === "login" && <a className="admin-button primary" href="/auth/admin/start">Googleでログイン</a>}{authState === "error" && <button className="admin-button" onClick={() => window.location.reload()}>再試行</button>}<p><a href="/">公開トップへ</a></p></div></main>;

  return <div className="admin-shell">
    <aside className="admin-sidebar"><a className="brand" href="/">RealAddr <span>for Agents</span></a><nav aria-label="運用メニュー">{(Object.keys(sectionLabels) as Section[]).map((key) => <button key={key} aria-current={section === key ? "page" : undefined} onClick={() => changeSection(key)}>{sectionLabels[key]}</button>)}</nav><p className="environment-label">testnet / sandbox<br />決済 Base Sepolia · ENS Ethereum Sepolia</p></aside>
    <main className="admin-main" id="main-content">
      <div className="admin-topbar"><div className="admin-heading"><p className="eyebrow">運用コンソール</p><h1>{pageLabel}</h1><p>{session.displayName} · operator · session期限 {labelValue("expiresAt", session.expiresAt)}</p></div><div className="admin-actions"><button className="admin-button" disabled={busy || mutationBusy} onClick={refresh}>更新</button><button className="admin-button" onClick={() => void request("/v1/admin/session", { method: "DELETE", body: "{}", headers: { "X-CSRF-Token": session.csrfToken, "Idempotency-Key": crypto.randomUUID() } }).then(() => window.location.reload()).catch((e) => setNotice({ kind: "error", text: publicError(e) }))}>ログアウト</button></div></div>
      {notice && <div className={`notice compact ${notice.kind}`} role="status" aria-live="polite">{notice.text}</div>}
      {pendingMutation && <div className="notice warning" role="alert"><strong>結果不明の操作があります。</strong><p>{pendingMutation.label}を同じ内容で再試行できます。先に対象状態を再取得して確認してください。</p><button className="admin-button" disabled={mutationBusy} onClick={() => void mutate(pendingMutation)}>同じ操作を再試行</button></div>}
      {section === "overview" ? <OverviewPanel value={overview} /> : <>
        {section === "locations" && <div className="admin-toolbar"><button className="admin-button primary" onClick={() => { setLocationForm((v) => !v); setFormErrors({}); }}>拠点を登録</button></div>}
        {section !== "audit" && <FilterForm section={section} values={filters} busy={busy} onChange={setFilters} onSubmit={submitFilters} />}
        {section === "audit" && <FilterForm section={section} values={filters} busy={busy} onChange={setFilters} onSubmit={submitFilters} />}
        {locationForm && section === "locations" && <LocationCreateForm busy={mutationBusy || !!pendingMutation} errors={formErrors} onSubmit={createLocation} onCancel={() => setLocationForm(false)} />}
        {busy ? <div className="empty-state" role="status">データを読み込んでいます。</div> : <DataTable section={section} rows={rows} onOpen={setDetail} onEdit={section === "locations" ? startLocationEdit : undefined} onToggle={section === "locations" ? requestLocationStatus : undefined} onReconcile={section === "operations" ? requestReconcile : undefined} />}
        <div className="pagination"><span className="muted">このページの {rows.length} 件</span><button className="admin-button" disabled={cursorStack.length <= 1 || busy} onClick={() => changePage("previous")}>前へ</button><button className="admin-button" disabled={!nextCursor || busy || !!appliedFilters.id} onClick={() => changePage("next")}>次へ</button></div>
      </>}
    </main>
    {detail && <DetailDrawer section={section} row={detail} onClose={() => setDetail(null)} />}
    {editingLocation && <LocationEditDrawer row={editingLocation} formRef={formRef} busy={mutationBusy || !!pendingMutation} errors={formErrors} onSubmit={saveLocation} onClose={closeLocationEdit} />}
    {confirm && <div className="dialog-backdrop" role="presentation"><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><h2 id="confirm-title">{confirm.title}</h2><p>{confirm.description}</p><label className="field">操作理由<textarea value={reason} minLength={3} maxLength={500} onChange={(event) => { setReason(event.target.value); reasonRef.current = event.target.value; }} /></label><p className="muted">理由は監査記録に保存されます。3〜500文字で入力してください。</p><div className="confirm-actions"><button className="admin-button" onClick={() => setConfirm(null)}>キャンセル</button><button className="admin-button primary" disabled={mutationBusy || !!pendingMutation || reason.trim().length < 3} onClick={() => confirm.action()}>実行</button></div></section></div>}
  </div>;
}

function OverviewPanel({ value }: { value: Row | null }) {
  if (!value) return <div className="empty-state">概要を取得できません。更新してください。</div>;
  const metrics = [["locationCount", "拠点"], ["activeSubscriptionCount", "有効契約"], ["uncertainPaymentCount", "決済確認中"], ["syncPendingCount", "同期保留"], ["manualReviewCount", "要確認"]] as const;
  return <><p className="muted">{value.available === true ? `集計時刻: ${labelValue("asOf", value.asOf)}` : "集計を取得できません。未取得を0件として表示していません。"}</p><div className="metric-grid">{metrics.map(([key, title]) => <dl className="metric" key={key}><dt>{title}</dt><dd>{value.available === true && typeof value[key] === "number" ? value[key] : "取得不可"}</dd></dl>)}</div><div className="panel"><h2>処理の確認</h2><p>件数は運用APIの bounded 集計です。決済は{labelValue("network", value.paymentNetwork)}, ENSは{labelValue("network", value.ensNetwork)}です。保留・結果不明は成功として扱いません。</p></div></>;
}

function FilterForm({ section, values, busy, onChange, onSubmit }: { section: Exclude<Section, "overview">; values: FilterState; busy: boolean; onChange: (value: FilterState) => void; onSubmit: (event: FormEvent) => void }) {
  const idEnabled = section !== "audit";
  const set = (key: string, value: string) => onChange({ ...values, [key]: value });
  const lookup = !!values.id?.trim();
  const clear = () => onChange({});
  return <form className="admin-toolbar filter-form" onSubmit={onSubmit}>
    {section === "locations" && <SelectFilter label="販売状態" value={values.status ?? ""} disabled={busy || lookup} options={[["", "すべて"], ["available", "販売中"], ["paused", "停止中"]]} onChange={(value) => set("status", value)} />}
    {(section === "payments" || section === "subscriptions") && <>
      <SelectFilter label={section === "payments" ? "決済状態" : "契約状態"} value={values.status ?? ""} disabled={busy || lookup} options={[["", "すべて"], ["pending", "処理待ち"], ["settling", "決済確認中"], ["fulfilled", "完了"], ["failed", "失敗"], ["active", "有効"], ["expired", "期限切れ"]]} onChange={(value) => set("status", value)} />
      <TextFilter label="拠点ID" value={values.locationId ?? ""} disabled={busy || lookup} onChange={(value) => set("locationId", value)} />
    </>}
    {section === "operations" && <>
      <SelectFilter label="処理種別" value={values.kind ?? ""} disabled={busy || lookup} options={[["", "すべて"], ["payment", "決済"], ["registry", "Registry"], ["ens", "ENS"]]} onChange={(value) => set("kind", value)} />
      <SelectFilter label="状態" value={values.status ?? ""} disabled={busy || lookup} options={[["", "すべて"], ["reconciling", "照合中"], ["pending_readback", "反映確認中"], ["manual_review", "要確認"], ["unknown", "結果不明"]]} onChange={(value) => set("status", value)} />
    </>}
    {section === "audit" && <><TextFilter label="対象種別" value={values.targetType ?? ""} onChange={(value) => set("targetType", value)} /><TextFilter label="対象ID" value={values.targetId ?? ""} onChange={(value) => set("targetId", value)} /></>}
    {idEnabled && <TextFilter label="IDで一件検索" value={values.id ?? ""} disabled={busy} onChange={(value) => set("id", value)} />}
    <button className="admin-button primary" type="submit" disabled={busy}>検索</button><button className="admin-button" type="button" disabled={busy} onClick={clear}>条件クリア</button>
    {lookup && <span className="muted">ID検索は他条件・ページ送りと併用しません。</span>}
  </form>;
}

function TextFilter({ label, value, disabled = false, onChange }: { label: string; value: string; disabled?: boolean; onChange: (value: string) => void }) { return <label className="field">{label}<input value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} /></label>; }
function SelectFilter({ label, value, disabled, options, onChange }: { label: string; value: string; disabled: boolean; options: Array<[string, string]>; onChange: (value: string) => void }) { return <label className="field">{label}<select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>; }

function DataTable({ section, rows, onOpen, onEdit, onToggle, onReconcile }: { section: Exclude<Section, "overview">; rows: Row[]; onOpen: (row: Row) => void; onEdit?: (row: Row) => void; onToggle?: (row: Row, status: "available" | "paused") => void; onReconcile?: (row: Row) => void }) {
  if (!rows.length) return <div className="empty-state"><strong>表示するデータがありません</strong><p>絞り込み条件を確認するか、必要な運用操作を行ってください。</p></div>;
  const visibleColumns = columns[section];
  return <div className="table-wrap"><table><thead><tr>{visibleColumns.map(([key, title]) => <th key={String(key)} scope="col">{title}</th>)}<th scope="col">詳細 / 操作</th></tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? row.eventId ?? `${section}-${index}`)}>{visibleColumns.map(([key]) => <td key={String(key)}>{key === "status" || key === "riskVerdict" || key === "ensStatus" || key === "registryStatus" || key === "result" ? <span className={`status-badge ${statusClass(row[key])}`}>{labelValue(String(key), row[key])}</span> : labelValue(String(key), row[key])}</td>)}<td className="row-actions"><button className="row-button" onClick={() => onOpen(row)}>詳細</button>{section === "locations" && onEdit && <><button className="row-button" onClick={() => onEdit(row)}>編集</button>{onToggle && <button className="row-button" onClick={() => onToggle(row, row.status === "available" ? "paused" : "available")}>{row.status === "available" ? "停止" : "再開"}</button>}</>}{section === "operations" && onReconcile && <button className="row-button" onClick={() => onReconcile(row)}>照合要求</button>}</td></tr>)}</tbody></table></div>;
}

function DetailDrawer({ section, row, onClose }: { section: Section; row: Row; onClose: () => void }) {
  const keys: string[] = section === "overview" ? [] : columns[section].map(([key]) => String(key));
  if (section === "locations") keys.push("id", "plan", "updatedAt");
  if (section === "payments") keys.push("updatedAt");
  if (section === "subscriptions") keys.push("updatedAt");
  if (section === "operations") keys.push("version", "updatedAt");
  if (section === "audit") keys.push("eventId", "actorId", "beforeVersion", "afterVersion", "idempotencyKeyHash", "traceId");
  const allowedKeys = [...new Set(keys)].filter((key) => key in row);
  return <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><div className="detail-header"><div><p className="eyebrow">{sectionLabels[section]}</p><h2 id="drawer-title">{String(row.id ?? row.eventId ?? "詳細")}</h2></div><button className="admin-button" onClick={onClose}>閉じる</button></div><dl className="detail-grid">{allowedKeys.map((key) => <div className="detail-row" key={key}><dt>{key}</dt><dd>{labelValue(key, row[key])}</dd></div>)}</dl></aside></div>;
}

function LocationCreateForm({ busy, errors, onSubmit, onCancel }: { busy: boolean; errors: Record<string, string>; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  return <form className="admin-card location-form" onSubmit={onSubmit}><h2 className="wide">拠点を登録</h2><div className="form-grid">
    <label className="field">slug<input name="slug" required maxLength={63} pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" autoComplete="off" /></label>
    <label className="field">表示名<input name="displayName" required maxLength={100} /></label>
    <label className="field">公開エリア<input name="publicArea" required maxLength={100} /></label>
    <label className="field">郵便番号<input name="postalCode" required pattern="[0-9]{3}-?[0-9]{4}" placeholder="123-4567" /></label>
    <label className="field wide">提供住所<textarea name="address" required minLength={1} maxLength={500} /></label>
    <label className="field wide">変更理由<textarea name="reason" required minLength={3} maxLength={500} /></label>
    <p className="wide muted">30日固定plan: testnet/dev 0.55 USDC。新規拠点は停止状態で登録され、販売再開は別操作です。</p>
    {errors.reason && <p className="wide error-text">{errors.reason}</p>}
  </div><div className="form-actions"><button className="admin-button primary" disabled={busy}>停止状態で登録</button><button className="admin-button" type="button" disabled={busy} onClick={onCancel}>キャンセル</button></div></form>;
}

function LocationEditDrawer({ row, formRef, busy, errors, onSubmit, onClose }: { row: Row; formRef: RefObject<HTMLFormElement | null>; busy: boolean; errors: Record<string, string>; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onClose: () => void }) {
  return <div className="drawer-backdrop" role="presentation"><aside className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="edit-location-title"><div className="detail-header"><div><p className="eyebrow">拠点を編集</p><h2 id="edit-location-title">{String(row.displayName)}</h2></div><button className="admin-button" onClick={onClose}>閉じる</button></div><p className="muted">version {String(row.version)}。保存時に期待versionを照合します。競合時は最新値を確認してください。</p><form ref={formRef} className="location-form" onSubmit={onSubmit}><div className="form-grid">
    <label className="field">表示名<input name="displayName" required maxLength={100} defaultValue={String(row.displayName ?? "")} /></label>
    <label className="field">公開エリア<input name="publicArea" required maxLength={100} defaultValue={String(row.publicArea ?? "")} /></label>
    <label className="field">郵便番号<input name="postalCode" required pattern="[0-9]{3}-?[0-9]{4}" defaultValue={String(row.postalCode ?? "")} /></label>
    <label className="field wide">提供住所<textarea name="address" required minLength={1} maxLength={500} defaultValue={String(row.address ?? "")} /></label>
    <label className="field wide">変更理由<textarea name="reason" required minLength={3} maxLength={500} /></label>
    {errors.reason && <p className="wide error-text">{errors.reason}</p>}
  </div><div className="form-actions"><button className="admin-button primary" disabled={busy}>変更を保存</button><button className="admin-button" type="button" onClick={onClose}>キャンセル</button></div></form></aside></div>;
}
