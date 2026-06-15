import { describe, expect, it } from "vitest";
import {
  fileExtension,
  highlightSource,
  isMarkdownFile,
  renderMarkdown
} from "./fileView";

describe("fileExtension", () => {
  it("returns the lowercased extension across separators", () => {
    expect(fileExtension("a.ts")).toBe("ts");
    expect(fileExtension("a/b/c.TSX")).toBe("tsx");
    expect(fileExtension("C:\\repo\\main.RS")).toBe("rs");
    expect(fileExtension("archive.tar.gz")).toBe("gz");
  });

  it("maps extension-less names by their full name", () => {
    expect(fileExtension("Dockerfile")).toBe("dockerfile");
    expect(fileExtension("Makefile")).toBe("makefile");
    expect(fileExtension("src/Dockerfile")).toBe("dockerfile");
  });

  it("treats a leading-dot dotfile as having no extension", () => {
    expect(fileExtension(".gitignore")).toBe(".gitignore");
  });
});

describe("isMarkdownFile", () => {
  it("recognizes markdown extensions", () => {
    expect(isMarkdownFile("README.md")).toBe(true);
    expect(isMarkdownFile("notes.markdown")).toBe(true);
    expect(isMarkdownFile("doc.mdx")).toBe(true);
  });

  it("rejects non-markdown files", () => {
    expect(isMarkdownFile("main.ts")).toBe(false);
    expect(isMarkdownFile("Dockerfile")).toBe(false);
  });
});

describe("highlightSource", () => {
  it("highlights a known language by filename", () => {
    const html = highlightSource("const x = 1;", "main.ts");
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("hljs-");
  });

  it("falls back to auto-detection for unknown extensions", () => {
    const html = highlightSource("SELECT 1 FROM dual;", "query.unknownext");
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
  });
});

describe("renderMarkdown", () => {
  it("renders headings and escapes raw HTML", () => {
    const html = renderMarkdown("# Title\n\nsome **bold** text");
    expect(html).toContain("<h1>");
    expect(html).toContain("<strong>");
  });

  it("does not pass through raw HTML", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
  });

  it("highlights fenced code blocks (known and unknown langs)", () => {
    const known = renderMarkdown("```ts\nconst y = 2;\n```");
    expect(known).toContain("hljs-");
    const unknown = renderMarkdown("```nosuchlang\nplain body\n```");
    // Unknown fence lang → auto-highlight path; output is still a fenced code block.
    expect(unknown).toContain("<code");
    expect(unknown).toContain("plain");
  });
});
