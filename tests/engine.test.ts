import { describe, test, expect } from "bun:test";
import {
  compress,
  findBloat,
  estimateTokens,
  PromptWatcher,
  minifyJson,
  flattenJsonValue,
  findProtectedRanges,
} from "../src/index";

describe("compress()", () => {
  test("collapses a known verbose phrase", () => {
    const out = compress("despite the fact that it rained");
    expect(out).toBe("although it rained");
  });

  test("collapses capitalized phrases with matching casing", () => {
    expect(compress("Despite the fact that it rained")).toBe(
      "Although it rained",
    );
  });

  test("strips polite conversational filler", () => {
    const out = compress("could you please help me");
    expect(out).toBe("help me");
  });

  test("does not strip hedges unless strictMode is on", () => {
    expect(compress("this is basically ready")).toBe("this is basically ready");
    expect(compress("this is basically ready", { strictMode: true })).toBe(
      "this is ready",
    );
  });

  test("removeArticles drops a/an/the", () => {
    const out = compress("the cat sat on a mat", { removeArticles: true });
    expect(out).toBe("cat sat on mat");
  });

  test("longest-match prefers the full polite phrase over a suffix", () => {
    const out = compress("I was wondering if you could please send it");
    expect(out.toLowerCase()).not.toContain("wondering");
    expect(out.toLowerCase()).not.toContain("could you please");
    expect(out).toContain("send it");
  });
});

describe("findBloat()", () => {
  test("start/end indexes slice back to originalText", () => {
    const original =
      "Hello, I was wondering if you could please help me with this.";
    const findings = findBloat(original);
    expect(findings.length).toBeGreaterThan(0);

    for (const finding of findings) {
      expect(original.slice(finding.start, finding.end)).toBe(
        finding.originalText,
      );
      expect(finding.end).toBeGreaterThan(finding.start);
    }

    const filler = findings.find((f) =>
      f.originalText.toLowerCase().includes("wondering"),
    );
    expect(filler).toBeDefined();
    expect(filler!.suggestedReplacement).toBe("");
    expect(filler!.tokensSaved).toBeGreaterThan(0);
  });

  test("reports tokensSaved from the 4-char heuristic", () => {
    const phrase = "in order to";
    const findings = findBloat(`please go ${phrase} rest`);
    const hit = findings.find((f) => f.originalText === phrase);
    expect(hit).toBeDefined();
    expect(hit!.suggestedReplacement).toBe("to");
    expect(hit!.tokensSaved).toBe(
      estimateTokens(phrase) - estimateTokens("to"),
    );
  });
});

describe("minifyJson()", () => {
  test("compact (default) strips insignificant whitespace", () => {
    const input = 'Please process {"name":"John", "age":30} and continue.';
    const output = minifyJson(input);

    expect(output).toBe(
      'Please process {"name":"John","age":30} and continue.',
    );
  });

  test("flatten mode still densifies to k:v|k:v", () => {
    const input = 'Please process {"name":"John", "age":30} and continue.';
    const output = minifyJson(input, { mode: "flatten" });

    expect(output).toContain("Please process ");
    expect(output).toContain(" and continue.");
    expect(output).toContain("name:John");
    expect(output).toContain("age:30");
    expect(output).toContain("name:John|age:30");
    expect(output).not.toContain('"name"');
    expect(output).not.toContain("{");
  });

  test("flattens nested objects with dotted keys", () => {
    const cells = flattenJsonValue({ user: { name: "Ada", age: 36 } });
    expect(cells).toContain("user.name:Ada");
    expect(cells).toContain("user.age:36");
    expect(
      minifyJson('data {"user":{"name":"Ada","age":36}} done', {
        mode: "flatten",
      }),
    ).toBe("data user.name:Ada|user.age:36 done");
  });

  test("leaves invalid JSON untouched and does not throw", () => {
    const messy = "not json {foo: bar} still here";
    expect(minifyJson(messy)).toBe(messy);
  });

  test("does not treat array[1] indexing as JSON", () => {
    expect(minifyJson("array[1] stays")).toBe("array[1] stays");
  });

  test("leaves incomplete JSON as-is", () => {
    const incomplete = '{ "name": "Jo';
    expect(minifyJson(incomplete)).toBe(incomplete);
    expect(minifyJson(incomplete, { mode: "flatten" })).toBe(incomplete);
  });
});

describe("PromptWatcher", () => {
  const wait = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  test("debounces feed() and emits optimization_ready", async () => {
    const watcher = new PromptWatcher({ debounceMs: 25 });
    const payloads: Array<{ tokensSaved: number; findings: unknown[] }> = [];

    watcher.on("optimization_ready", (payload) => {
      payloads.push(payload);
    });

    watcher.feed("despite the fact that we tried");
    watcher.feed("despite the fact that we tried again");
    expect(payloads).toHaveLength(0);

    await wait(80);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.findings.length).toBeGreaterThan(0);
    expect(payloads[0]!.tokensSaved).toBeGreaterThan(0);
    watcher.destroy();
  });

  test("off() removes a listener so it is not called", async () => {
    const watcher = new PromptWatcher({ debounceMs: 20 });
    let calls = 0;
    const handler = () => {
      calls += 1;
    };
    watcher.on("optimization_ready", handler);
    watcher.off("optimization_ready", handler);
    watcher.feed("in order to win");
    await wait(60);
    expect(calls).toBe(0);
    watcher.destroy();
  });

  test("destroy() clears the timer and ignores later feed()", async () => {
    const watcher = new PromptWatcher({ debounceMs: 20 });
    let calls = 0;
    watcher.on("optimization_ready", () => {
      calls += 1;
    });
    watcher.feed("despite the fact that x");
    watcher.destroy();
    await wait(60);
    expect(calls).toBe(0);

    watcher.feed("despite the fact that y");
    await wait(60);
    expect(calls).toBe(0);
  });

  test("emits JSON minify findings after debounce", async () => {
    const watcher = new PromptWatcher({ debounceMs: 20 });
    const payloads: Array<{ findings: Array<{ originalText: string }> }> = [];
    watcher.on("optimization_ready", (payload) => {
      payloads.push(payload);
    });
    watcher.feed('User {"name": "John", "age": 30} ok');
    await wait(60);
    expect(payloads).toHaveLength(1);
    expect(
      payloads[0]!.findings.some((f) => f.originalText.includes('"name"')),
    ).toBe(true);
    watcher.destroy();
  });
});

describe("fences + incomplete JSON", () => {
  test("incomplete JSON is not minified and has no covering finding", () => {
    const text = '{ "name": "Jo';
    expect(minifyJson(text)).toBe(text);
    const findings = findBloat(text);
    expect(findings.every((f) => !f.originalText.includes("{"))).toBe(true);
    const protectedRanges = findProtectedRanges(text);
    expect(
      protectedRanges.some((r) => r.start === 0 && r.end === text.length),
    ).toBe(true);
  });

  test("complete JSON in prose is compacted by default", () => {
    const input = 'User {"name":"John","age":30} ok';
    expect(minifyJson(input)).toBe('User {"name":"John","age":30} ok');

    const spaced = 'User {"name": "John", "age": 30} ok';
    expect(compress(spaced)).toBe('User {"name":"John","age":30} ok');
    const findings = findBloat(spaced);
    const jsonHit = findings.find((f) => f.originalText.includes('"name"'));
    expect(jsonHit).toBeDefined();
    expect(jsonHit!.suggestedReplacement).toBe('{"name":"John","age":30}');
    expect(spaced.slice(jsonHit!.start, jsonHit!.end)).toBe(jsonHit!.originalText);
  });

  test("flatten mode still works through compress/findBloat", () => {
    const text = 'User {"name":"John","age":30} ok';
    expect(compress(text, { minifyJson: { mode: "flatten" } })).toBe(
      "User name:John|age:30 ok",
    );
    const findings = findBloat(text, { minifyJson: { mode: "flatten" } });
    const hit = findings.find((f) => f.originalText.startsWith("{"));
    expect(hit?.suggestedReplacement).toBe("name:John|age:30");
  });

  test("array[1] is not treated as JSON by findBloat", () => {
    const findings = findBloat("array[1] stays");
    expect(findings.every((f) => !f.originalText.includes("["))).toBe(true);
    expect(compress("array[1] stays")).toBe("array[1] stays");
  });

  test("unclosed fence skips chrome and JSON inside", () => {
    const text = "intro ```\n**hello** {\"name\": \"John\", \"age\": 30}\ndo not";
    const findings = findBloat(text);
    expect(findings.some((f) => f.originalText.includes("**"))).toBe(false);
    expect(findings.some((f) => f.originalText.includes("{"))).toBe(false);
    expect(findings.some((f) => f.originalText === "do not")).toBe(false);
  });

  test("closed fence does not minify JSON inside", () => {
    const text =
      'before\n```\n{"name": "John", "age": 30}\n```\nafter do not';
    const findings = findBloat(text);
    expect(findings.some((f) => f.originalText.includes('"name"'))).toBe(false);
    const contraction = findings.find((f) => f.originalText === "do not");
    expect(contraction).toBeDefined();
    expect(contraction!.suggestedReplacement).toBe("don't");
  });
});

describe("contractions + markdown chrome", () => {
  test("do not → don't with valid indexes", () => {
    const original = "please do not go";
    const findings = findBloat(original);
    const hit = findings.find((f) => f.originalText === "do not");
    expect(hit).toBeDefined();
    expect(hit!.suggestedReplacement).toBe("don't");
    expect(original.slice(hit!.start, hit!.end)).toBe("do not");
    expect(compress(original)).toBe("please don't go");
  });

  test("negation is preserved (don't, not empty)", () => {
    const findings = findBloat("do not");
    expect(findings[0]!.suggestedReplacement).toBe("don't");
    expect(findings[0]!.suggestedReplacement.toLowerCase()).toContain("n't");
    expect(compress("do not")).toBe("don't");
  });

  test("**hello** → hello with valid indexes", () => {
    const original = "say **hello** now";
    const findings = findBloat(original);
    const hit = findings.find((f) => f.originalText === "**hello**");
    expect(hit).toBeDefined();
    expect(hit!.suggestedReplacement).toBe("hello");
    expect(original.slice(hit!.start, hit!.end)).toBe("**hello**");
    expect(compress(original)).toBe("say hello now");
  });

  test("<!-- secret --> is stripped", () => {
    const original = "keep <!-- secret --> this";
    const findings = findBloat(original);
    const hit = findings.find((f) => f.originalText.includes("secret"));
    expect(hit).toBeDefined();
    expect(hit!.suggestedReplacement).toBe("");
    expect(original.slice(hit!.start, hit!.end)).toBe(hit!.originalText);
    expect(compress(original)).toBe("keep this");
  });

  test("--- on its own line is stripped", () => {
    const original = "hello\n---\nworld";
    const findings = findBloat(original);
    const hit = findings.find((f) => f.originalText.includes("---"));
    expect(hit).toBeDefined();
    expect(hit!.suggestedReplacement).toBe("");
    expect(original.slice(hit!.start, hit!.end)).toBe(hit!.originalText);
    expect(compress(original)).toBe("hello\nworld");
  });

  test("simple wrapping tags unwrap inner text", () => {
    expect(compress("see <b>bold</b> here")).toBe("see bold here");
    expect(compress("see <strong>x</strong> here")).toBe("see x here");
  });

  test("minifyJson: false skips the payload pass", () => {
    const text = 'User {"name": "John", "age": 30} ok';
    const findings = findBloat(text, { minifyJson: false });
    expect(findings.every((f) => !f.originalText.includes("{"))).toBe(true);
    expect(compress(text, { minifyJson: false })).toContain("{");
  });
});
