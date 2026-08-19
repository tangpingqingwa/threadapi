import { escapeAttr, escapeHtml } from "./escape.js";
import { renderPage } from "./layout.js";

export type HomeInput = {
  url?: string;
  error?: string;
};

export function renderHome(input: HomeInput = {}): string {
  const urlValue = input.url ?? "";
  const errorBanner =
    input.error === undefined
      ? ""
      : `<p class="banner error" role="alert">${escapeHtml(input.error)}</p>`;
  return renderPage({
    title: "Twitter thread unroller | ThreadAPI",
    description:
      "Paste an X / Twitter thread URL. Get the full author chain as readable text. Free, no signup.",
    canonicalPath: "/",
    body: `<main>
    <h1>Twitter thread unroller</h1>
    <p>Paste a public x.com or twitter.com status URL. We expand the author’s self-reply chain. Missing floors stay empty — we never invent a tweet.</p>
    ${errorBanner}
    <form method="get" action="/">
      <label for="url">Thread URL</label>
      <input id="url" name="url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://x.com/user/status/1234567890123456789" value="${escapeAttr(urlValue)}">
      <button type="submit">Unroll thread</button>
    </form>
    <section id="api">
      <h2>Need this as JSON?</h2>
      <p>Same backend as this page: <code>GET /v1/threads/by-url</code>. $5/mo, not $200.</p>
    </section>
  </main>`,
  });
}
