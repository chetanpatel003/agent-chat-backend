import { describe, it, expect } from "vitest";
import { sanitizeAssistantText, stripCreditStatements } from "./assistant-text";

describe("stripCreditStatements — removes model-written consumption statements", () => {
  it("the observed reply: keeps the conversation, drops only the final credit sentence", () => {
    const observed =
      "Here's the new image with the couple on the 11th floor balcony in Gurgaon, enjoying the sunset with a flight going by:\n\n" +
      "The image features a beautiful sunset scene.\n\n" +
      "It used 273936 credits. Let me know if you'd like any adjustments or another version!";
    expect(stripCreditStatements(observed)).toBe(
      "Here's the new image with the couple on the 11th floor balcony in Gurgaon, enjoying the sunset with a flight going by:\n\n" +
        "The image features a beautiful sunset scene.\n\n" +
        "Let me know if you'd like any adjustments or another version!",
    );
  });

  it.each([
    ["It used 273936 credits.", ""],
    ["This generation consumed 273,936 credits.", ""],
    ["The image cost 0.27M credits.", ""],
    ["Done! It used about 0.27M Magica credits.", "Done!"],
    ["You were charged 5,000 credits for the crop.", ""],
    ["273,936 credits were used.", ""],
    ["Credits used: 273,936", ""],
    ["Here is your image (273,936 credits used).", "Here is your image."],
    ["Generated it — this took 1.2 million credits. Enjoy!", "Enjoy!"],
  ])("%s", (input, expected) => {
    expect(stripCreditStatements(input)).toBe(expected);
  });
});

describe("stripCreditStatements — keeps ordinary numbers and credit discussion", () => {
  it.each([
    "Each image costs about 50,000 credits at high quality.",
    "A high-quality image will cost roughly 270,000 credits.",
    "You have 8.9M credits left.",
    "Credits are deducted only after a tool finishes.",
    "I used 3 reference photos and a 1024x1024 canvas.",
    "The flight leaves at 18:45 on 2026-11-03 and costs $120.",
    "The film won 3 awards; the credits used a serif font.",
    "Plain answer with no numbers.",
  ])("%s", (text) => {
    expect(stripCreditStatements(text)).toBe(text);
  });
});

describe("stripCreditStatements — streaming", () => {
  it("holds back an unfinished sentence heading for a credit statement, never shows the finished one", () => {
    expect(stripCreditStatements("Here it is. It used 2739", { streaming: true })).toBe("Here it is.");
    expect(stripCreditStatements("Here it is. It used 273936 credits", { streaming: true })).toBe("Here it is.");
    expect(stripCreditStatements("Here it is. It used 273936 credits. Enjoy", { streaming: true })).toBe("Here it is. Enjoy");
    expect(stripCreditStatements("The sunset looks warm and", { streaming: true })).toBe("The sunset looks warm and");
  });
});

describe("sanitizeAssistantText", () => {
  it("applies both media-URL and credit-statement removal", () => {
    expect(
      sanitizeAssistantText("Here you go:\n\nhttps://g.tlcdn.com/gen/a.png\n\nA sunset. It used 273936 credits."),
    ).toBe("Here you go:\n\nA sunset.");
  });
});
