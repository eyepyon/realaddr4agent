import { renderToStaticMarkup } from "react-dom/server";
import { PublicPage } from "./PublicPages";
import type { PublicPageKey } from "./public-content";

export function renderPublicPage(page: PublicPageKey): string {
  return renderToStaticMarkup(<PublicPage page={page} />);
}
