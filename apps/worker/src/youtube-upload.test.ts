import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("./crypto.js", () => ({
  decryptToken: (value: string) => value,
  encryptToken: (value: string) => value,
  requireAppSecret: () => {},
}));
vi.mock("./config.js", () => ({
  config: { GOOGLE_CLIENT_ID: null, GOOGLE_CLIENT_SECRET: null, GOOGLE_REDIRECT_URI: null },
}));

import { uploadVideoToYouTube } from "./google.js";

const VIDEO_ID = "ABCDEF12345";
function fakeDatabase(channelId: string | undefined): SupabaseClient {
  const record = {
    encrypted_access_token: "test-access",
    encrypted_refresh_token: "test-refresh",
    token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    metadata: channelId ? { channelId } : {},
  };
  const builder: Record<string, any> = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: record, error: null }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

afterEach(() => vi.unstubAllGlobals());

describe("YouTube upload with explicit channel authorization", () => {
  it("uploads privately and verifies the workspace channel before starting a session", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (method === "GET") return new Response(JSON.stringify({ items: [{ id: "UCcorrect" }] }), { status: 200 });
      if (method === "POST") return new Response(null, {
        status: 200,
        headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=sample" },
      });
      if (method === "PUT") return new Response(JSON.stringify({ id: VIDEO_ID }), { status: 201 });
      return new Response(null, { status: 500 });
    }));
    const result = await uploadVideoToYouTube(
      fakeDatabase("UCcorrect"), "tenant", "Título válido", "Descrição", Buffer.from("fake mp4"), "workspace",
    );
    expect(result).toEqual({ id: VIDEO_ID, channelId: "UCcorrect", privacyStatus: "private" });
    expect(calls.map(x => x.method)).toEqual(["GET", "POST", "PUT"]);
    const metadata = JSON.parse(calls.find(x => x.method === "POST")!.body!);
    expect(metadata.status.privacyStatus).toBe("private");
  });

  it("blocks wrong channel before a video is sent", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ items: [{ id: "UCdifferent" }] }), { status: 200 });
    }));
    await expect(uploadVideoToYouTube(
      fakeDatabase("UCapproved"), "tenant", "Título", "Descrição", Buffer.from("video"), "workspace",
    )).rejects.toThrow(/differs/);
    expect(requests).toEqual(["GET"]);
  });

  it("requires reauthorization of legacy connections without recorded channel ID", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(uploadVideoToYouTube(
      fakeDatabase(undefined), "tenant", "Título", "Descrição", Buffer.from("video"), "workspace",
    )).rejects.toThrow(/reconnect/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses public uploads without explicit owner authorization", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(uploadVideoToYouTube(
      fakeDatabase("UCcorrect"), "tenant", "Título", "Descrição", Buffer.from("video"), "workspace",
      { privacyStatus: "public" },
    )).rejects.toThrow(/approval/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
