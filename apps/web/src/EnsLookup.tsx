import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocale } from "./i18n";
import "./ens-lookup.css";

import { parseEnsLookup, type Lookup } from "./ens-lookup-result";

export function EnsLookup() {
  const { t, locale } = useLocale();
  const [name, setName] = useState("");
  const [result, setResult] = useState<Lookup | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  const displayDate = (value: string) => new Date(value).toLocaleString(locale === "ja" ? "ja-JP" : "en-US");
  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const requestedName = name.trim().toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+eth$/.test(requestedName)) { setResult({ status: "blocked", reasonCode: "invalid_ens_name" }); return; }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true); setResult(null);
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`/v1/ens/resolve?name=${encodeURIComponent(requestedName)}`, { credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal });
      const text = await response.text();
      if (text.length > 65_536) throw new Error();
      const data: unknown = JSON.parse(text);
      if (!response.ok) {
        const code = data && typeof data === "object" ? (data as Record<string, unknown>).error : null;
        setResult({ status: "blocked", reasonCode: typeof code === "string" && /^[a-z0-9_]{1,100}$/.test(code) ? code : "ens_lookup_unavailable" });
      } else setResult(parseEnsLookup(data, requestedName));
    } catch {
      if (active.current === controller) setResult({ status: "blocked", reasonCode: "ens_lookup_unavailable" });
    } finally {
      clearTimeout(timeout);
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  }
  const label = result?.status === "verified" ? t("検証済み", "Verified") : result?.status === "pending" ? t("確認待ち", "Pending") : result?.reasonCode === "ens_entitlement_inactive" ? t("利用権が無効", "Inactive entitlement") : result?.status === "invalid" ? t("検証不成立", "Invalid") : t("確認不可", "Blocked");
  return <section className="ens-lookup" aria-labelledby="ens-lookup-title">
    <h2 id="ens-lookup-title">{t("ENSv2契約名を照合", "Verify an ENSv2 lease name")}</h2>
    <p>{t("Ethereum Sepoliaのテストネット照合。登録済みの契約名を入力すると、APIが支払済み利用権、registry階層、専用resolverと権限を確認します。", "Ethereum Sepolia testnet verification. Enter a registered lease name to check its paid entitlement, registry hierarchy, dedicated resolver, and permissions through the API.")}</p>
    <form onSubmit={lookup}>
      <label htmlFor="ens-lookup-name">{t("契約のENS名", "Lease ENS name")}</label>
      <div className="ens-lookup-input"><input id="ens-lookup-name" value={name} onChange={event => { setName(event.target.value); setResult(null); }} required maxLength={255} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={busy} /><button type="submit" disabled={busy || !name.trim()}>{busy ? t("照合中…", "Checking…") : t("照合", "Verify")}</button></div>
    </form>
    <p className="ens-lookup-note">{t("照合結果と公開参照情報を表示します。契約の住所は所有者の認証後に確認できます。", "View the verification result and public reference information. The lease address is available after owner authentication.")}</p>
    <div aria-live="polite" aria-busy={busy}>{result && <div className="ens-lookup-result">
      <strong>{label} <code>{result.status}</code></strong>
      <p><code>{result.reasonCode}</code></p>
      {result.normalizedName && <p>{result.normalizedName}</p>}
      {result.checkedAt && <p>{t("確認日時", "Checked at")}: <time dateTime={result.checkedAt} title={result.checkedAt}>{displayDate(result.checkedAt)}</time></p>}
      {result.expiresAt && <p>{t("契約期限", "Lease expiry")}: <time dateTime={result.expiresAt} title={result.expiresAt}>{displayDate(result.expiresAt)}</time></p>}
      {result.verifiedBlock && <p>{t("最終確定ブロック", "Finalized block")}: {result.verifiedBlock}</p>}
      {result.reference && <dl>{Object.entries(result.reference).map(([field, value]) => <div key={field}><dt>{field}</dt><dd><code>{value}</code></dd></div>)}</dl>}
    </div>}</div>
  </section>;
}
