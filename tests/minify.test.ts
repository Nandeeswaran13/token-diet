import { describe, test, expect } from "bun:test";
import {
  minifyCode,
  minifyCsvTsv,
  minifyYaml,
  minifyXmlHtml,
  minifyMarkdown,
  minifyJsonTable,
  normalizeUnicode,
} from "../src/index";

describe("minifyCode", () => {
  test("strips comments not in strings", () => {
    const code = `const url = "http://example.com"; // fetch it
const x = 1; /* block */
const hash = "not # a comment";
# python-style
`;
    const out = minifyCode(code);
    expect(out).toContain("http://example.com");
    expect(out).not.toContain("fetch it");
    expect(out).not.toContain("block");
    expect(out).toContain("not # a comment");
    expect(out).not.toContain("python-style");
  });

  test("does not rename identifiers and never throws", () => {
    expect(minifyCode("function fooBar() { return 1; }")).toContain("fooBar");
    expect(minifyCode("")).toBe("");
  });
});

describe("minifyCsvTsv", () => {
  test("trims cells and drops empty rows", () => {
    expect(minifyCsvTsv(" a , b \n 1 , 2 ")).toBe("a,b\n1,2");
    expect(minifyCsvTsv("a,b\n,\n1,2")).toBe("a,b\n1,2");
  });

  test("drops all-empty columns and handles TSV", () => {
    expect(minifyCsvTsv("a,,c\n1,,3")).toBe("a,c\n1,3");
    expect(minifyCsvTsv("a\tb\n1\t2")).toBe("a\tb\n1\t2");
    expect(minifyCsvTsv(" a \t b \n 1 \t 2 ")).toBe("a\tb\n1\t2");
  });
});

describe("minifyYaml", () => {
  test("strips comments and compact key: value", () => {
    const yaml = "# header\nname: John\n\n\nage: 30\n";
    const out = minifyYaml(yaml);
    expect(out).not.toContain("# header");
    expect(out).toContain("name:John");
    expect(out).toContain("age:30");
    expect(out).not.toMatch(/\n{3,}/);
  });

  test("does not strip # inside quotes", () => {
    expect(minifyYaml('title: "foo # bar"')).toContain("foo # bar");
  });
});

describe("minifyXmlHtml / markdown / table / unicode", () => {
  test("minifyXmlHtml strips tags and comments", () => {
    expect(minifyXmlHtml("<p>hello <!--x--> <b>world</b></p>")).toBe(
      "hello world",
    );
  });

  test("minifyMarkdown unwraps emphasis and converts tables", () => {
    const md = "**hi**\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    const out = minifyMarkdown(md);
    expect(out).toContain("hi");
    expect(out).not.toContain("**");
    expect(out).toContain("a\tb");
    expect(out).toContain("1\t2");
  });

  test("minifyJsonTable leaves prose without JSON unchanged", () => {
    expect(minifyJsonTable("just words")).toBe("just words");
  });

  test("normalizeUnicode never throws on empty", () => {
    expect(normalizeUnicode("")).toBe("");
    expect(normalizeUnicode("\u2026")).toBe("...");
  });
});
