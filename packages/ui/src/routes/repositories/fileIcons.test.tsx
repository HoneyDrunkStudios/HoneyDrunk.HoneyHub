import { describe, expect, it } from "vitest";
import { fileIconSpec } from "./fileIcons";

describe("fileIconSpec", () => {
  it("returns a distinct, non-empty badge for each key file type", () => {
    const specs = {
      ts: fileIconSpec("main.ts"),
      tsx: fileIconSpec("App.tsx"),
      js: fileIconSpec("bundle.js"),
      json: fileIconSpec("data.json"),
      cs: fileIconSpec("Program.cs"),
      razor: fileIconSpec("Counter.razor"),
      sql: fileIconSpec("migrate.sql"),
      yaml: fileIconSpec("ci.yml"),
      md: fileIconSpec("README.md"),
      css: fileIconSpec("theme.css"),
      html: fileIconSpec("index.html"),
      rs: fileIconSpec("lib.rs"),
      toml: fileIconSpec("Cargo.toml"),
      gitignore: fileIconSpec(".gitignore")
    };

    for (const [key, spec] of Object.entries(specs)) {
      expect(spec.label, `${key} label`).not.toBe("");
      expect(spec.color, `${key} color`).toMatch(/^#[0-9a-f]{3,8}$/i);
    }

    // A few concrete labels + cross-category colour distinctions.
    expect(specs.ts.label).toBe("TS");
    expect(specs.js.label).toBe("JS");
    expect(specs.cs.label).toBe("C#");
    expect(specs.razor.label).toBe("@");
    expect(specs.ts.color).not.toBe(specs.cs.color);
    expect(specs.json.color).not.toBe(specs.md.color);
    expect(specs.yaml.color).not.toBe(specs.html.color);
  });

  it("matches special full names before extensions", () => {
    expect(fileIconSpec("some/dir/.gitignore").label).toBe("GI");
    expect(fileIconSpec("package.json")).toEqual({ label: "{}", color: expect.any(String) });
    // Cargo.toml resolves via its name, not the generic .toml extension.
    expect(fileIconSpec("Cargo.toml").label).toBe("TO");
    expect(fileIconSpec("LICENSE").label).toBe("LI");
  });

  it("falls back to a neutral generic glyph for unknown or extension-less files", () => {
    expect(fileIconSpec("notes.unknownext").label).toBe("");
    expect(fileIconSpec("mystery").label).toBe("");
  });

  it("is tolerant of Windows and POSIX separators and case", () => {
    expect(fileIconSpec("C:\\src\\Program.CS").label).toBe("C#");
    expect(fileIconSpec("/repo/src/Main.TS").label).toBe("TS");
  });
});
