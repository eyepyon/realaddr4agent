import termsMarkdown from "../../../docs/terms.md?raw";

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

export function TermsDraft() {
  return <article className="terms-draft">
    <div className="notice warning"><strong>利用規約の原案です。正式な規約は未確定です。</strong><p>施行日は未定で、この原案は現在のwallet認証における同意対象ではありません。原案を読む操作によって、契約や同意は成立しません。</p></div>
    {termsBlocks().map((block, index) => block.kind === "title" ? <h1 key={index}>{block.text}</h1>
      : block.kind === "heading" ? <h2 key={index}>{block.text}</h2>
      : block.kind === "list" ? <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>
      : <p key={index}>{block.text}</p>)}
  </article>;
}
