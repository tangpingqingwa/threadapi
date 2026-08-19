import { ADSENSE_CLIENT, ADSENSE_SLOT, API_CTA_HREF, API_CTA_LABEL, LEGAL_FOOTER } from "./legal.js";
import { escapeAttr, escapeHtml } from "./escape.js";

export type PageOptions = {
  title: string;
  description: string;
  body: string;
  canonicalPath?: string;
  extraHead?: string;
};

const STYLES = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0 auto; max-width: 42rem; padding: 1.25rem; line-height: 1.5; }
h1 { font-size: 1.75rem; line-height: 1.2; }
form { display: grid; gap: 0.75rem; margin: 1.5rem 0; }
label { font-weight: 600; }
input[name="url"] { width: 100%; box-sizing: border-box; font-size: 1rem; padding: 0.75rem; }
button { font-size: 1rem; padding: 0.75rem 1rem; }
article.post { border-top: 1px solid currentColor; padding: 1rem 0; }
article.post:first-of-type { border-top: 0; }
blockquote.quote { margin: 0.75rem 0 0; padding: 0.5rem 0.75rem; border-left: 3px solid currentColor; }
.media a { display: inline-block; margin-top: 0.5rem; }
.missing { border: 1px dashed currentColor; padding: 0.75rem; margin: 0.75rem 0; }
.ad { min-height: 90px; margin: 1.5rem 0; }
.banner { padding: 0.75rem 1rem; border: 1px solid currentColor; margin: 1rem 0; }
.error { font-weight: 600; }
footer { margin-top: 2.5rem; font-size: 0.875rem; }
`.trim();

export function renderPage(options: PageOptions): string {
  const canonical =
    options.canonicalPath === undefined
      ? ""
      : `<link rel="canonical" href="${escapeAttr(options.canonicalPath)}">`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <meta name="description" content="${escapeAttr(options.description)}">
  ${canonical}
  <style>
${STYLES}
  </style>
  ${options.extraHead ?? ""}
</head>
<body>
  ${options.body}
  ${renderAdSlot()}
  ${renderFooter()}
</body>
</html>
`;
}

export function renderFooter(): string {
  return `<footer>
    <p><a href="${escapeAttr(API_CTA_HREF)}">${escapeHtml(API_CTA_LABEL)}</a></p>
    <p>${escapeHtml(LEGAL_FOOTER)}</p>
  </footer>`;
}

export function renderAdSlot(): string {
  return `<aside class="ad" aria-label="advertisement">
    <ins class="adsbygoogle"
         style="display:block"
         data-ad-client="${escapeAttr(ADSENSE_CLIENT)}"
         data-ad-slot="${escapeAttr(ADSENSE_SLOT)}"
         data-ad-format="auto"
         data-full-width-responsive="true"></ins>
  </aside>`;
}
