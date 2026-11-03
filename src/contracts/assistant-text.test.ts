import { describe, it, expect } from "vitest";
import { isMediaOrSignedUrl, stripMediaReferences } from "./assistant-text";

// The exact shape persisted for the 2026-11-03 03:02 turn (no tool call; the
// model imitated the context's file list). Signature values are fake.
const SIGNED =
  "https://s3.us-east-005.backblazeb2.com/agentChat/generated/01a19ae8-48cb-7e22-b227-711369ba1dd3/01a19db0-76ca-7baa-ae40-6ac488d6bb01-0.png" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=FAKEKEYID%2F20261102%2Fus-east-005%2Fs3%2Faws4_request" +
  "&X-Amz-Date=20261102T190000Z&X-Amz-Expires=3600&X-Amz-Signature=deadbeef&X-Amz-SignedHeaders=host";
const OBSERVED =
  "I've generated the image with a sunset scene and a flight going by:\n\n" +
  "https://g.tlcdn.com/gen/171dd3a33e2f4c50a0f1e9a7d2c5bb98.png\n\n" +
  "The image shows a beautiful sunset with warm golden and orange colors, and you can see a flight (airplane) in the sky going by.\n\n" +
  `Generated files (in order):\n1. image/png ${SIGNED}`;

describe("stripMediaReferences", () => {
  it("removes the provider URL, the file list and the signed URL from the observed reply, keeping the prose", () => {
    const out = stripMediaReferences(OBSERVED);
    expect(out).toBe(
      "I've generated the image with a sunset scene and a flight going by:\n\n" +
        "The image shows a beautiful sunset with warm golden and orange colors, and you can see a flight (airplane) in the sky going by.",
    );
    expect(out).not.toMatch(/X-Amz|backblazeb2|tlcdn|Generated files/);
  });

  it("removes a provider URL echoed after a real generation (the 18:47 shape)", () => {
    const text =
      "Here's the new image with the couple facing the camera:\n\nhttps://g.tlcdn.com/gen/b1866182d3714b78a75d52bc5fc8a83e.png\n\nThe image shows a young couple.";
    expect(stripMediaReferences(text)).toBe("Here's the new image with the couple facing the camera:\n\nThe image shows a young couple.");
  });

  it("removes media URLs inline, in markdown images/links and angle brackets", () => {
    expect(stripMediaReferences("See https://static.magica.com/a.png for it.")).toBe("See for it.");
    expect(stripMediaReferences("![result](https://g.tlcdn.com/gen/x.png)\nDone.")).toBe("Done.");
    expect(stripMediaReferences("Open [the image](https://g.tlcdn.com/gen/x.png).")).toBe("Open the image.");
    expect(stripMediaReferences("Link: <https://g.tlcdn.com/gen/x.png>")).toBe("Link:");
    expect(stripMediaReferences("- https://g.tlcdn.com/gen/x.png\n- second")).toBe("- second");
  });

  it("removes the attached-files list and any presigned URL, whatever its host", () => {
    expect(stripMediaReferences("Sure.\n\nAttached files (in order):\n1. image/png https://x.example/a.png\n2. video/mp4 https://x.example/b.mp4")).toBe("Sure.");
    expect(stripMediaReferences("Here: https://cdn.example.com/f.png?X-Amz-Signature=abc ok")).toBe("Here: ok");
  });

  it("keeps ordinary text and unrelated links exactly", () => {
    const text = "Read https://en.wikipedia.org/wiki/Gurgaon and [docs](https://example.com/docs).\n\n\nThanks!";
    expect(stripMediaReferences(text)).toBe(text);
    expect(stripMediaReferences("Plain answer, no links.")).toBe("Plain answer, no links.");
  });

  it("holds back a URL still being streamed, then judges it once complete", () => {
    expect(stripMediaReferences("Here it is: https://g.tlcdn.com/gen/17", { streaming: true })).toBe("Here it is: ");
    expect(stripMediaReferences("Read https://en.wikipedia.org/wiki/X and more", { streaming: true })).toBe(
      "Read https://en.wikipedia.org/wiki/X and more",
    );
  });
});

describe("isMediaOrSignedUrl", () => {
  it("classifies media, storage and presigned URLs", () => {
    expect(isMediaOrSignedUrl("https://g.tlcdn.com/gen/a.png")).toBe(true);
    expect(isMediaOrSignedUrl("https://static.magica.com/a.png")).toBe(true);
    expect(isMediaOrSignedUrl(SIGNED)).toBe(true);
    expect(isMediaOrSignedUrl("https://example.com/a.png")).toBe(false);
    expect(isMediaOrSignedUrl("not a url")).toBe(false);
  });
});
