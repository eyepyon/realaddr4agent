import termsMarkdown from "../../../docs/terms.md?raw";
import { CURRENT_TERMS_VERSION } from "../../../packages/domain/src/terms";

type TermsBlock = { kind: "title" | "heading" | "paragraph"; text: string } | { kind: "list"; items: string[] };

function termsBlocks(): TermsBlock[] {
  const blocks: TermsBlock[] = [];
  for (const section of termsMarkdown.trim().split(/\n\s*\n/)) {
    const lines = section.split("\n");
    if (section.startsWith("# ")) blocks.push({ kind: "title", text: section.slice(2).trim() });
    else if (section.startsWith("## ")) blocks.push({ kind: "heading", text: section.slice(3).trim() });
    else if (lines.every((line) => line.startsWith("- "))) blocks.push({ kind: "list", items: lines.map((line) => line.slice(2)) });
    else blocks.push({ kind: "paragraph", text: lines.join(" ") });
  }
  return blocks;
}

export function TermsPage() {
  return <article className="terms-page">
    <div className="notice"><strong>正式な利用規約 version 1（{CURRENT_TERMS_VERSION}）</strong><p>このversionの提示と同意から適用されます。過去の開発用署名へ遡って適用しません。機能の提供状態はサービスの接続状況をご確認ください。</p></div>
    {termsBlocks().map((block, index) => block.kind === "title" ? <h1 key={index}>{block.text}</h1>
      : block.kind === "heading" ? <h2 key={index}>{block.text}</h2>
      : block.kind === "list" ? <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>
      : <p key={index}>{block.text}</p>)}
  </article>;
}
