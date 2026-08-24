import { describe, test, expect } from "bun:test";
import { summarize, estimateTokens } from "../src/index";
import { splitSentences } from "../src/summarize";

const ARTICLE = `
Photosynthesis is the process by which green plants convert sunlight into chemical energy. The weather was nice yesterday and many people went outside for a walk. Chlorophyll in the leaves absorbs light, mostly in the blue and red wavelengths. Meanwhile, unrelated to plants, some tourists bought souvenirs at the market. Carbon dioxide and water are the inputs; oxygen is released as a byproduct. The cafe around the corner serves decent coffee in the afternoon. The light-dependent reactions occur in the thylakoid membrane of the chloroplast. A neighbor mentioned that traffic was heavy during rush hour. The Calvin cycle then fixes carbon into sugars that the plant can store or use. Several blogs repeated that photosynthesis is the process by which green plants convert sunlight into chemical energy.
`.trim();

describe("splitSentences", () => {
  test("does not split on Mr. / e.g. abbreviations", () => {
    const text = "Mr. Smith met Dr. Jones, e.g. at noon. They left later.";
    const parts = splitSentences(text);
    expect(parts.length).toBe(2);
    expect(parts[0]?.text).toContain("Mr. Smith");
    expect(parts[1]?.text).toContain("They left");
  });

  test("skips fenced code and complete JSON", () => {
    const text =
      'Intro sentence is here. ```js\nconst x = 1;\n``` The payload is {"name":"Ada","age":36} and we continue. Closing thought follows.';
    const parts = splitSentences(text);
    const joined = parts.map((p) => p.text).join(" ");
    expect(joined).not.toContain("const x");
    expect(joined).not.toContain('"Ada"');
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });
});

describe("summarize", () => {
  test("returns empty for blank input and never throws", () => {
    expect(summarize("")).toEqual({ summary: "", sentences: [] });
    expect(summarize("   \n")).toEqual({ summary: "", sentences: [] });
    expect(summarize("{not json")).toBeDefined();
  });

  test("single sentence is returned as-is", () => {
    const text = "Only one claim lives here.";
    const result = summarize(text, { maxSentences: 1 });
    expect(result.summary).toBe(text);
    expect(result.sentences).toHaveLength(1);
    expect(result.sentences[0]?.selected).toBe(true);
  });

  test("indexes are into the original string", () => {
    const result = summarize(ARTICLE, { maxSentences: 3 });
    expect(result.sentences.length).toBeGreaterThan(3);
    for (const s of result.sentences) {
      expect(ARTICLE.slice(s.start, s.end)).toBe(s.text);
    }
  });

  test("selected sentences stay in original order", () => {
    const result = summarize(ARTICLE, { maxSentences: 3 });
    const starts = result.sentences.filter((s) => s.selected).map((s) => s.start);
    const sorted = [...starts].sort((a, b) => a - b);
    expect(starts).toEqual(sorted);
    expect(result.summary.split(". ").length).toBeGreaterThanOrEqual(1);
  });

  test("maxSentences is respected and summary is shorter than source", () => {
    const result = summarize(ARTICLE, { maxSentences: 3 });
    const picked = result.sentences.filter((s) => s.selected);
    expect(picked.length).toBeLessThanOrEqual(3);
    expect(picked.length).toBeGreaterThan(0);
    expect(result.summary.length).toBeLessThan(ARTICLE.length);
  });

  test("prefers topical sentences over filler", () => {
    const result = summarize(ARTICLE, { maxSentences: 4 });
    const summary = result.summary.toLowerCase();
    expect(summary).toMatch(/photosynthesis|chlorophyll|calvin|chloroplast|carbon/);
    expect(summary).not.toContain("decent coffee");
    expect(summary).not.toContain("traffic was heavy");
  });

  test("query biases selection", () => {
    const text =
      "Cats sleep for many hours each day. Dogs need regular walks and enjoy fetch. The weather is cloudy. Canine training uses treats. Feline whiskers sense airflow.";
    const dogs = summarize(text, { query: "dog training walks", maxSentences: 2 });
    const summary = dogs.summary.toLowerCase();
    expect(summary).toMatch(/dog|canine/);
    const dogHits = (summary.match(/dog|canine|fetch|walks/g) ?? []).length;
    const catHits = (summary.match(/cat|feline/g) ?? []).length;
    expect(dogHits).toBeGreaterThan(catHits);
  });

  test("MMR drops a near-duplicate sentence", () => {
    const text =
      "Photosynthesis converts sunlight into chemical energy in plants. Unrelated traffic was terrible downtown today. Photosynthesis converts sunlight into chemical energy in plants. Chlorophyll absorbs blue and red light.";
    const result = summarize(text, { maxSentences: 2, lambda: 0.5 });
    const picked = result.sentences.filter((s) => s.selected).map((s) => s.text);
    const photo = picked.filter((t) => t.includes("Photosynthesis converts"));
    expect(photo.length).toBe(1);
  });

  test("maxTokens stops the extract", () => {
    const result = summarize(ARTICLE, { maxTokens: 20 });
    expect(estimateTokens(result.summary)).toBeLessThanOrEqual(24);
    expect(result.sentences.some((s) => s.selected)).toBe(true);
  });

  test("fenced code is not in the summary", () => {
    const text = `Alpha plants grow fast in spring. \`\`\`js
secretPayload()
\`\`\`
Beta chlorophyll captures photons. Gamma tourists bought hats.`;
    const result = summarize(text, { maxSentences: 2 });
    expect(result.summary).not.toContain("secretPayload");
    expect(result.sentences.every((s) => !s.text.includes("secretPayload"))).toBe(
      true,
    );
  });

  test("textrank method returns a non-empty extract", () => {
    const result = summarize(ARTICLE, { method: "textrank", maxSentences: 3 });
    expect(result.summary.length).toBeGreaterThan(20);
    expect(result.sentences.filter((s) => s.selected).length).toBeLessThanOrEqual(3);
    expect(result.summary.length).toBeLessThan(ARTICLE.length);
  });

  test("default ratio keeps a fraction of sentences", () => {
    const result = summarize(ARTICLE);
    const total = result.sentences.length;
    const picked = result.sentences.filter((s) => s.selected).length;
    expect(picked).toBeGreaterThan(0);
    expect(picked).toBeLessThan(total);
    expect(picked).toBeLessThanOrEqual(Math.max(1, Math.round(total * 0.3) + 1));
  });
});
