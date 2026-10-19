import { describe, expect, it } from "vitest";
import { assertChannelMatch, parseYoutubeVideoId, resolveUploadPrivacy } from "./youtube-policy.js";

describe("YouTube publishing safety", () => {
  it("defaults every new upload to private", () => {
    expect(resolveUploadPrivacy()).toBe("private");
  });
  it("accepts unlisted and private only when requested", () => {
    expect(resolveUploadPrivacy("unlisted")).toBe("unlisted");
    expect(resolveUploadPrivacy("private")).toBe("private");
  });
  it("refuses accidental public visibility without explicit opt-in", () => {
    expect(() => resolveUploadPrivacy("public")).toThrow(/approval|autoriza|explicit/i);
    expect(resolveUploadPrivacy("public", { explicitlyApprovedPublic: true })).toBe("public");
  });
  it("refuses missing or different channel", () => {
    expect(() => assertChannelMatch(undefined, "UCabcdef")).toThrow();
    expect(() => assertChannelMatch("UCone", "UCtwo")).toThrow();
    expect(() => assertChannelMatch("UCone", undefined)).toThrow();
    expect(assertChannelMatch("UCone", "UCone")).toBe("UCone");
  });
  it("never accepts malformed upload success as a video", () => {
    expect(() => parseYoutubeVideoId({ id: "" })).toThrow();
    expect(() => parseYoutubeVideoId({})).toThrow();
    expect(parseYoutubeVideoId({ id: "Yt123456789" })).toBe("Yt123456789");
  });
});
