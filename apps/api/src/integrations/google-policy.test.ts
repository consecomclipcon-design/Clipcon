import { describe, expect, it } from "vitest";
import { keepOfflineRefreshToken, oauthScopesGranted } from "./google-policy.js";

const uploadScope = "https://www.googleapis.com/auth/youtube.upload";
describe("Google authorization persistence", () => {
  it("preserves old refresh token when Google does not return a new one", () => {
    expect(keepOfflineRefreshToken(undefined, "encrypted-previous")).toBe("encrypted-previous");
  });
  it("prefers new refresh token on reconnection", () => {
    expect(keepOfflineRefreshToken("encrypted-new", "encrypted-previous")).toBe("encrypted-new");
  });
  it("refuses offline integration without any refresh token", () => {
    expect(() => keepOfflineRefreshToken(undefined, undefined)).toThrow(/offline|refresh/i);
  });
  it("checks actual granted upload scope", () => {
    expect(oauthScopesGranted(uploadScope + " openid", [uploadScope])).toBe(true);
    expect(oauthScopesGranted("openid email", [uploadScope])).toBe(false);
    expect(oauthScopesGranted(undefined, [uploadScope])).toBe(false);
  });
});
