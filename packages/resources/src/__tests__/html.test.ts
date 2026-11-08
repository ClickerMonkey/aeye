import { describe, expect, it } from "@jest/globals";
import { decodeHtmlEntities } from "../html/entities.js";
import { type HtmlElement, findElement, parseHtml, parseHtmlAttributes, textContent } from "../html/dom.js";
import { htmlToCleanMarkdown, htmlVisibleTextLength } from "../html/markdown.js";

/** The markdown of html, with defaults. */
const md = (html: string, options?: Parameters<typeof htmlToCleanMarkdown>[1]) => htmlToCleanMarkdown(html, options).markdown;

/** The names of an element's element children. */
const childNames = (element: HtmlElement | undefined) =>
  (element?.children ?? []).flatMap((child) => (child.kind === "element" ? [child.name] : []));

describe("html entities", () => {
  it("decodes numeric and common named references and leaves unknown ones", () => {
    expect(decodeHtmlEntities("a &amp; b &lt;c&gt; &#39;q&#x27; &copy; &hellip;&nbsp;&bogus; &#xD800;")).toBe("a & b <c> 'q' © … &bogus; �");
    expect(decodeHtmlEntities("no refs")).toBe("no refs");
  });
});

describe("html attributes", () => {
  it("reads quoted, unquoted and bare attributes, lower-casing names and keeping the first of a repeat", () => {
    expect(parseHtmlAttributes(` HREF="a&amp;b" data-x='y' width=10 hidden class="one" class="two"`)).toEqual({
      href: "a&b", "data-x": "y", width: "10", hidden: "", class: "one",
    });
  });
});

describe("html parser", () => {
  it("builds a tree with void elements, raw text and implied end tags", () => {
    const root = parseHtml("<!doctype html><!-- c --><p>one<p>two<br>three<ul><li>a<li>b</ul><table><tr><td>1<td>2<tr><td>3</table><script>if (a < b) {}</script>");
    expect(childNames(root)).toEqual(["p", "p", "ul", "table", "script"]);
    const ul = findElement(root, (e) => e.name === "ul");
    expect(childNames(ul)).toEqual(["li", "li"]);
    const table = findElement(root, (e) => e.name === "table");
    expect(childNames(table)).toEqual(["tr", "tr"]);
    const script = findElement(root, (e) => e.name === "script");
    expect(script ? textContent(script) : "").toBe("if (a < b) {}");
  });

  it("treats a stray < as text, ignores unmatched end tags and keeps attributes with > in quotes", () => {
    const root = parseHtml(`a < b</span><a title="x > y" href="/z">link</a>`);
    expect(textContent(root)).toBe("a < blink");
    expect(findElement(root, (e) => e.name === "a")?.attributes).toEqual({ title: "x > y", href: "/z" });
  });

  it("reads huge attributes (inline data images) as one tag", () => {
    const data = "x".repeat(10000);
    const root = parseHtml(`<img src="data:image/png;base64,${data}"><p>after</p>`);
    expect(childNames(root)).toEqual(["img", "p"]);
  });
});

describe("html to markdown", () => {
  it("writes headings, paragraphs, emphasis, code and line breaks", () => {
    expect(md("<h1>Title</h1><p>Some <strong>bold </strong>and <em>soft</em> text<br>next line with <code>a`b</code>.</p><h3> Deep  </h3>")).toBe(
      "# Title\n\nSome **bold** and *soft* text\nnext line with ``a`b``.\n\n### Deep",
    );
  });

  it("writes nested and numbered lists", () => {
    const html = "<ol start='3'><li>three<ul><li>inner</li></ul></li><li><p>four</p></li></ol>";
    expect(md(html)).toBe("3. three\n   - inner\n4. four");
  });

  it("writes data tables with headers, escaped pipes and colspans, and layout tables as blocks", () => {
    const data = "<table><caption>Prices</caption><thead><tr><th>Item</th><th>Cost</th></tr></thead><tbody><tr><td>a|b</td><td>1</td></tr><tr><td colspan=2>total</td></tr></tbody></table>";
    expect(md(data)).toBe("*Prices*\n\n| Item | Cost |\n| --- | --- |\n| a\\|b | 1 |\n| total |   |");
    expect(md("<table><tr><td><p>Just a column</p></td></tr></table>")).toBe("Just a column");
  });

  it("fences code with its language and a fence longer than any inside", () => {
    expect(md(`<pre><code class="language-ts">const a = 1;\n\nconst b = 2;</code></pre>`)).toBe("```ts\nconst a = 1;\n\nconst b = 2;\n```");
    expect(md("<pre>has ``` inside</pre>")).toBe("````\nhas ``` inside\n````");
  });

  it("makes links and images absolute, drops fragment, script and data links, and tracking pixels", () => {
    const html = `<p><a href="/docs/a b">Docs</a> <a href="#top">Top</a> <a href="javascript:void(0)">Run</a> <a href="https://x.dev/">https://x.dev/</a>
      <img src="img/p.png" alt="A [pic]"> <img src="data:image/png;base64,AAA" alt="inline"> <img src="/t.gif" width="1"></p>`;
    expect(md(html, { baseUrl: "https://site.dev/guide/" })).toBe(
      "[Docs](https://site.dev/docs/a%20b) Top Run <https://x.dev/> ![A pic](https://site.dev/guide/img/p.png)",
    );
    expect(md(`<a href="/x">x</a><img src="/y.png" alt="y">`, { links: false, images: false })).toBe("x");
  });

  it("uses the page's <base href>", () => {
    expect(md(`<head><base href="/v2/"></head><body><a href="page">p</a></body>`, { baseUrl: "https://a.dev/v1/index.html" })).toBe("[p](https://a.dev/v2/page)");
  });

  it("keeps the main content and drops page chrome, scripts, forms and hidden elements", () => {
    const html = `<html lang="en"><head><title> My  Page </title><meta name="description" content="About it"><link rel="canonical" href="/canon"></head>
      <body><header><nav><a href="/">Home</a></nav></header><div class="sidebar">Side</div>
      <main><article><header><h1>Story</h1></header><p>Body text.</p><p hidden>secret</p><p style="display: none">gone</p>
      <form><input value="q"><button>Go</button></form><script>track()</script><div aria-hidden="true">x</div></article></main>
      <footer>© Site</footer></body></html>`;
    const page = htmlToCleanMarkdown(html, { baseUrl: "https://a.dev/p" });
    expect(page.markdown).toBe("# Story\n\nBody text.");
    expect(page.title).toBe("My Page");
    expect(page.description).toBe("About it");
    expect(page.language).toBe("en");
    expect(page.canonicalUrl).toBe("https://a.dev/canon");
  });

  it("uses the one article, or the body less its chrome when there are several", () => {
    expect(md(`<div class="menu">Menu</div><article><p>Only</p></article><p>outside</p>`)).toBe("Only");
    expect(md(`<nav>N</nav><article><p>One</p></article><article><p>Two</p></article><aside>A</aside>`)).toBe("One\n\nTwo");
  });

  it("falls back to the body when the main element is nearly empty, and keeps everything with content body", () => {
    const text = "Real content. ".repeat(20);
    expect(md(`<main></main><div><p>${text}</p></div>`)).toBe(text.trim());
    expect(md(`<nav>Links</nav><p>Text</p>`, { content: "body" })).toBe("Links\n\nText");
    // A page that is nothing but chrome keeps its chrome rather than becoming empty.
    expect(md(`<nav>Only nav</nav>`)).toBe("Only nav");
  });

  it("writes quotes, definitions, rules and summaries", () => {
    expect(md("<blockquote><p>One</p><p>Two</p></blockquote><hr><dl><dt>Term</dt><dd>Meaning</dd></dl><details><summary>More</summary><p>Hidden</p></details>")).toBe(
      "> One\n>\n> Two\n\n---\n\n**Term**\n: Meaning\n\n**More**\n\nHidden",
    );
  });

  it("escapes text that would read as markdown structure", () => {
    expect(md("<p># not a heading</p><p>1. not a list</p><p>- nor this</p>")).toBe("\\# not a heading\n\n\\1. not a list\n\n\\- nor this");
  });

  it("takes the title from og:title or the first h1 when there is no <title>", () => {
    expect(htmlToCleanMarkdown(`<meta property="og:title" content="OG">`).title).toBe("OG");
    expect(htmlToCleanMarkdown(`<h1>Heading</h1>`).title).toBe("Heading");
  });

  it("counts visible text, ignoring scripts and styles", () => {
    expect(htmlVisibleTextLength("<body><script>var a = 'long long long';</script><style>p{}</style><p>Hi  there</p></body>")).toBe("Hi there".length);
  });
});
