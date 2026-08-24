import { describe, test, expect } from "bun:test";
import {
  compress,
  findBloat,
  minifyJson,
  minifyJsonTable,
  normalizeUnicode,
  findProtectedRanges,
} from "../src/index";

describe("unicode", () => {
  test("NBSP and curly quotes become ASCII with valid indexes", () => {
    const original = "hello\u00A0there \u201Cworld\u201D";
    const findings = findBloat(original);

    const nbsp = findings.find((f) => f.originalText === "\u00A0");
    expect(nbsp).toBeDefined();
    expect(nbsp!.suggestedReplacement).toBe(" ");
    expect(original.slice(nbsp!.start, nbsp!.end)).toBe("\u00A0");

    const left = findings.find((f) => f.originalText === "\u201C");
    const right = findings.find((f) => f.originalText === "\u201D");
    expect(left?.suggestedReplacement).toBe('"');
    expect(right?.suggestedReplacement).toBe('"');
    expect(original.slice(left!.start, left!.end)).toBe("\u201C");
    expect(original.slice(right!.start, right!.end)).toBe("\u201D");

    expect(compress(original)).toBe('hello there "world"');
    expect(normalizeUnicode(original)).toBe('hello there "world"');
  });

  test("adjacent unicode folds merge into one span", () => {
    const original = "x\u00A0\u00A0y";
    const findings = findBloat(original);
    const hit = findings.find((f) => f.originalText === "\u00A0\u00A0");
    expect(hit).toBeDefined();
    expect(hit!.suggestedReplacement).toBe("  ");
    expect(original.slice(hit!.start, hit!.end)).toBe(hit!.originalText);
  });

  test("unicode inside a fence is left alone", () => {
    const text = "```\nhello\u00A0world\n```";
    const findings = findBloat(text);
    expect(findings.every((f) => f.originalText !== "\u00A0")).toBe(true);
  });
});

describe("abbreviations", () => {
  test("for example → e.g. with valid indexes", () => {
    const original = "try this for example now";
    const findings = findBloat(original);
    const hit = findings.find((f) => f.originalText === "for example");
    expect(hit).toBeDefined();
    expect(hit!.suggestedReplacement).toBe("e.g.");
    expect(original.slice(hit!.start, hit!.end)).toBe("for example");
    expect(compress(original)).toBe("try this e.g. now");
  });

  test("that is copula still contracts; that is to say → i.e.", () => {
    expect(compress("that is fine")).toBe("that's fine");
    expect(compress("that is to say we left")).toBe("i.e. we left");
  });

  test("abbreviations: false skips e.g. mapping", () => {
    const findings = findBloat("try this for example now", {
      abbreviations: false,
    });
    expect(findings.every((f) => f.originalText !== "for example")).toBe(true);
  });
});

describe("consecutive dedup", () => {
  test("second identical line is dropped with valid indexes", () => {
    const original = "hello\nhello\nworld";
    const findings = findBloat(original);
    const dup = findings.find(
      (f) => f.suggestedReplacement === "" && f.originalText.includes("hello"),
    );
    expect(dup).toBeDefined();
    expect(original.slice(dup!.start, dup!.end)).toBe(dup!.originalText);
    expect(dup!.originalText).toBe("\nhello");
    expect(compress(original)).toBe("hello\nworld");
  });

  test("consecutive duplicate paragraphs are collapsed", () => {
    const original = "hello\n\nhello\n\nworld";
    expect(compress(original)).toBe("hello\n\nworld");
  });

  test("dedupeLines: false keeps pasted duplicates", () => {
    expect(compress("hello\nhello", { dedupeLines: false })).toBe(
      "hello\nhello",
    );
  });

  test("duplicate lines inside a fence are kept", () => {
    const text = "```\nfoo\nfoo\n```";
    expect(compress(text)).toContain("foo\nfoo");
  });
});

describe("JSON table encoding", () => {
  test("uniform object array becomes a CSV table when shorter", () => {
    const rows = [
      { name: "John", age: 30 },
      { name: "Ada", age: 36 },
    ];
    const table = minifyJsonTable(rows);
    expect(table).toBe("name,age\nJohn,30\nAda,36");

    const pretty = JSON.stringify(rows, null, 2);
    const wrapped = `data ${pretty} end`;
    const findings = findBloat(wrapped);
    const hit = findings.find((f) => f.originalText.includes('"name"'));
    expect(hit).toBeDefined();
    expect(hit!.suggestedReplacement).toBe("name,age\nJohn,30\nAda,36");
    expect(hit!.suggestedReplacement.length).toBeLessThan(pretty.length);
    expect(wrapped.slice(hit!.start, hit!.end)).toBe(hit!.originalText);
  });

  test("non-uniform arrays stay compact JSON", () => {
    const text = 'x [{"a": 1}, {"b": 2}] y';
    expect(compress(text)).toBe('x [{"a":1},{"b":2}] y');
    expect(minifyJsonTable([{ a: 1 }, { b: 2 }])).toBe('[{"a":1},{"b":2}]');
  });

  test("unclosed JSON still not minified; fenced JSON still skipped", () => {
    const incomplete = '{ "name": "Jo';
    expect(minifyJson(incomplete)).toBe(incomplete);
    expect(minifyJsonTable(incomplete)).toBe(incomplete);
    const findings = findBloat(incomplete);
    expect(findings.every((f) => !f.originalText.includes("{"))).toBe(true);
    expect(
      findProtectedRanges(incomplete).some(
        (r) => r.start === 0 && r.end === incomplete.length,
      ),
    ).toBe(true);

    const fenced = 'before\n```\n[{"name": "John", "age": 30}]\n```\nafter';
    const fencedFindings = findBloat(fenced);
    expect(
      fencedFindings.every((f) => !f.originalText.includes('"name"')),
    ).toBe(true);
  });
});

describe("markdown tables", () => {
  test("complete GFM table → TSV with valid indexes", () => {
    const original = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const findings = findBloat(original);
    const hit = findings.find((f) => f.originalText.includes("| a |"));
    expect(hit).toBeDefined();
    expect(hit!.suggestedReplacement).toBe("a\tb\n1\t2");
    expect(original.slice(hit!.start, hit!.end)).toBe(hit!.originalText);
    expect(compress(original)).toBe("a\tb\n1\t2");
  });

  test("incomplete table (no separator) is left alone", () => {
    const original = "| a | b |\n| 1 | 2 |";
    const findings = findBloat(original);
    expect(findings.every((f) => !f.suggestedReplacement.includes("\t"))).toBe(
      true,
    );
    expect(compress(original)).toContain("| a | b |");
  });

  test("ragged still-typing row is left alone", () => {
    const original = "| a | b |\n| --- | --- |\n| 1 |";
    expect(compress(original)).toContain("| a | b |");
  });
});

describe("tokenizer gate", () => {
  test("mock tokenizer that makes a replacement more expensive drops the finding", () => {
    const tokenizer = (t: string): number => (t === "to" ? 100 : t.length);
    const findings = findBloat("go in order to rest", { tokenizer });
    expect(findings.every((f) => f.originalText !== "in order to")).toBe(true);

    const allowed = findBloat("go in order to rest");
    expect(allowed.some((f) => f.originalText === "in order to")).toBe(true);
  });
});

describe("parenthetical asides", () => {
  test("aside stripped only in strictMode; (not ready) kept", () => {
    expect(compress("ready (by the way) now")).toContain("(by the way)");
    expect(compress("ready (by the way) now", { strictMode: true })).toBe(
      "ready now",
    );
    expect(compress("wait (not ready) please", { strictMode: true })).toContain(
      "(not ready)",
    );
    expect(compress("flag (optional) item", { strictMode: true })).toContain(
      "(optional)",
    );
    expect(compress("Beethoven (1815–1852) wrote", { strictMode: true })).toContain(
      "(1815–1852)",
    );
  });

  test("stripAsides can run without strictMode", () => {
    expect(compress("ready (by the way) now", { stripAsides: true })).toBe(
      "ready now",
    );
  });
});

describe("tautologies", () => {
  test("ATM machine collapses", () => {
    expect(compress("use the ATM machine please")).toContain("ATM");
    expect(compress("use the ATM machine please")).not.toContain("ATM machine");
  });
});
