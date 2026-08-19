import type { Thread, XPost } from "../types.js";
import { escapeAttr, escapeHtml } from "./escape.js";
import { renderPage } from "./layout.js";

export function renderThreadPage(thread: Thread): string {
  const handle = thread.author.handle;
  const title = `@${handle} thread unrolled | ThreadAPI`;
  const description = firstLine(thread.posts[0]?.text ?? `Unrolled thread by @${handle}`);
  const posts = thread.posts.map((post, index) => renderPost(post, index + 1, thread.posts.length));
  const missing = thread.missingIds.map(renderMissing).join("\n");
  return renderPage({
    title,
    description,
    canonicalPath: `/status/${encodeURIComponent(thread.rootId)}`,
    body: `<main>
    <p><a href="/">← New unroll</a></p>
    <h1>Thread by @${escapeHtml(handle)}</h1>
    <p>${escapeHtml(thread.author.name)}${thread.author.verified ? " · verified" : ""} · ${thread.posts.length} post${thread.posts.length === 1 ? "" : "s"}</p>
    ${posts.join("\n")}
    ${missing}
  </main>`,
  });
}

function renderPost(post: XPost, floor: number, total: number): string {
  const text =
    post.text === ""
      ? `<p class="empty-text"></p>`
      : `<p class="post-text">${nl2br(escapeHtml(post.text))}</p>`;
  const quote = post.quote === null ? "" : renderQuote(post.quote);
  const media = post.media
    .map((item) => {
      const label = item.type === "photo" ? "Image" : item.type === "gif" ? "GIF" : "Video";
      return `<p class="media"><a href="${escapeAttr(item.url)}">${escapeHtml(label)}</a></p>`;
    })
    .join("\n");
  return `<article class="post" id="post-${escapeAttr(post.id)}" data-post-id="${escapeAttr(post.id)}">
      <header>
        <strong>@${escapeHtml(post.author.handle)}</strong>
        <span> · ${floor}/${total}</span>
        <time datetime="${escapeAttr(post.createdAt)}">${escapeHtml(post.createdAt)}</time>
      </header>
      ${text}
      ${quote}
      ${media}
      <p><a href="${escapeAttr(post.permalink)}">Original</a></p>
    </article>`;
}

function renderQuote(quote: XPost): string {
  const text = quote.text === "" ? "" : `<p>${nl2br(escapeHtml(quote.text))}</p>`;
  return `<blockquote class="quote">
        <p>Quoted @${escapeHtml(quote.author.handle)}</p>
        ${text}
      </blockquote>`;
}

function renderMissing(id: string): string {
  return `<aside class="missing" data-missing-id="${escapeAttr(id)}">
      <p>Missing post ${escapeHtml(id)}. We do not invent deleted floors.</p>
    </aside>`;
}

function firstLine(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  if (line === "") {
    return "Unrolled X / Twitter thread.";
  }
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function nl2br(escaped: string): string {
  return escaped.replace(/\n/g, "<br>");
}
