import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";
import { decryptToken, encryptToken, requireAppSecret } from "./crypto.js";
import { assertChannelMatch, parseYoutubeVideoId, resolveUploadPrivacy, type YoutubePrivacy } from "./youtube-policy.js";

export type GoogleProvider = "drive" | "youtube";

function requireGoogleCredentials() {
  if (
    !config.GOOGLE_CLIENT_ID ||
    !config.GOOGLE_CLIENT_SECRET ||
    !config.GOOGLE_REDIRECT_URI
  )
    throw new Error(
      "Google OAuth client credentials are not configured on the worker",
    );
  return {
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    redirectUri: config.GOOGLE_REDIRECT_URI,
  };
}

export async function getAccessToken(
  supabase: SupabaseClient,
  tenantId: string,
  provider: GoogleProvider,
  workspaceId?: string,
  forceRefresh = false,
) {
  requireAppSecret();
  let query = supabase
    .from("integrations")
    .select("encrypted_access_token, encrypted_refresh_token, token_expires_at")
    .eq("tenant_id", tenantId)
    .eq("provider", provider);
  if (workspaceId) query = query.eq("workspace_id", workspaceId);
  const { data } = await query.maybeSingle();
  if (!data?.encrypted_access_token)
    throw new Error(`No ${provider} integration connected for tenant`);
  const accessToken = decryptToken(data.encrypted_access_token);
  const refreshToken = data.encrypted_refresh_token
    ? decryptToken(data.encrypted_refresh_token)
    : null;
  const expiresAt = data.token_expires_at
    ? new Date(data.token_expires_at).getTime()
    : 0;
  const needsRefresh =
    !!refreshToken && (forceRefresh || !expiresAt || expiresAt - Date.now() < 60_000);
  if (!refreshToken && (!expiresAt || expiresAt - Date.now() < 60_000))
    throw new Error("Google refresh token is missing; reconnect the integration");
  if (needsRefresh) {
    const fresh = await refreshAccessToken(refreshToken);
    await supabase
      .from("integrations")
      .update({
        encrypted_access_token: encryptToken(fresh.access_token),
        token_expires_at: fresh.expiry_date
          ? new Date(fresh.expiry_date).toISOString()
          : null,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)
      .eq("provider", provider)
      .match(workspaceId ? { workspace_id: workspaceId } : {});
    return fresh.access_token;
  }
  return accessToken;
}

async function refreshAccessToken(refreshToken: string) {
  const { clientId, clientSecret } = requireGoogleCredentials();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok)
    throw new Error(
      "Google token refresh failed: " +
        res.status +
        " - reconnect the Google integration",
    );
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Google did not return an access token");
  return {
    access_token: data.access_token,
    expiry_date: Date.now() + Math.max(60, Number(data.expires_in ?? 3600)) * 1000,
  };
}

function isUnauthorized(message: string) {
  return (
    /401/.test(message) || /Invalid Credentials|UNAUTHENTICATED/i.test(message)
  );
}

async function uploadMultipart(
  url: string,
  accessToken: string,
  metadata: unknown,
  mimeType: string,
  data: Buffer,
) {
  const boundary = "clipcon-" + Date.now();
  const parts = [
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    ),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: Buffer.concat(parts),
  });
  if (!res.ok)
    throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function uploadFileToDrive(
  supabase: SupabaseClient,
  tenantId: string,
  fileName: string,
  mimeType: string,
  data: Buffer,
  folderId?: string,
  workspaceId?: string,
) {
  const metadata = {
    name: fileName,
    mimeType,
    ...(folderId ? { parents: [folderId] } : {}),
  };
  // Resumable upload per Google Drive docs (recommended for files > 5 MB):
  // https://developers.google.com/workspace/drive/api/guides/manage-uploads
  let token = await getAccessToken(supabase, tenantId, "drive", workspaceId);
  async function run(t: string) {
    const init = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink,size",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${t}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": mimeType,
          "X-Upload-Content-Length": String(data.length),
        },
        body: JSON.stringify(metadata),
      },
    );
    if (!init.ok)
      throw new Error(
        `Drive resumable init failed: ${init.status} ${await init.text()}`,
      );
    const sessionUrl = init.headers.get("location");
    if (!sessionUrl) throw new Error("Drive resumable session missing Location");
    const put = await fetch(sessionUrl, {
      method: "PUT",
      headers: { "Content-Length": String(data.length) },
      body: new Uint8Array(data),
    });
    if (!put.ok)
      throw new Error(
        `Drive resumable upload failed: ${put.status} ${await put.text()}`,
      );
    return (await put.json()) as {
      id: string;
      name: string;
      webViewLink?: string;
      size?: string;
    };
  }
  try {
    return await run(token);
  } catch (err) {
    if (isUnauthorized(err instanceof Error ? err.message : String(err))) {
      token = await getAccessToken(supabase, tenantId, "drive", workspaceId);
      return await run(token);
    }
    throw err;
  }
}

export async function uploadVideoToYouTube(
  supabase: SupabaseClient,
  tenantId: string,
  title: string,
  description: string,
  data: Buffer,
  workspaceId?: string,
  options: {
    privacyStatus?: YoutubePrivacy;
    explicitlyApprovedPublic?: boolean;
  } = {},
) {
  if (!workspaceId) throw new Error("YouTube upload requires a verified workspace");
  if (!data.length) throw new Error("Cannot upload an empty video");

  const visibility = resolveUploadPrivacy(options.privacyStatus, {
    explicitlyApprovedPublic: options.explicitlyApprovedPublic,
  });
  const { data: integration, error } = await supabase
    .from("integrations")
    .select("metadata, encrypted_refresh_token")
    .eq("tenant_id", tenantId)
    .eq("workspace_id", workspaceId)
    .eq("provider", "youtube")
    .maybeSingle();
  if (error || !integration?.encrypted_refresh_token)
    throw new Error("YouTube offline authorization is required: reconnect this workspace");
  const expectedChannelId = (integration.metadata as { channelId?: string } | null)?.channelId;
  if (!expectedChannelId)
    throw new Error("YouTube channel identity missing: reconnect and approve the correct channel");

  const metadata = {
    snippet: { title: title.slice(0, 100), description, categoryId: "22" },
    status: { privacyStatus: visibility },
  };

  async function verifyChannel(accessToken: string) {
    const response = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true",
      { headers: { Authorization: "Bearer " + accessToken } },
    );
    if (!response.ok) throw new Error("YouTube channel verification failed: HTTP " + response.status);
    const json = (await response.json()) as { items?: Array<{ id?: string }> };
    const actualId = json.items?.length === 1 ? json.items[0]?.id : undefined;
    return assertChannelMatch(actualId, expectedChannelId);
  }

  async function upload(accessToken: string) {
    const channelId = await verifyChannel(accessToken);
    // All new videos default to PRIVATE; public is available only with explicit approval.
    const init = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": "video/mp4",
          "X-Upload-Content-Length": String(data.length),
        },
        body: JSON.stringify(metadata),
      },
    );
    if (!init.ok)
      throw new Error("YouTube resumable init failed: HTTP " + init.status);
    const sessionUrl = init.headers.get("location");
    if (!sessionUrl?.startsWith("https://www.googleapis.com/"))
      throw new Error("YouTube resumable upload session is missing or invalid");

    const put = await fetch(sessionUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(data.length),
        "Content-Type": "video/mp4",
      },
      body: new Uint8Array(data),
    });
    if (!put.ok)
      throw new Error("YouTube upload did not complete; inspect session before retrying: HTTP " + put.status);
    const videoId = parseYoutubeVideoId(await put.json());
    return { id: videoId, channelId, privacyStatus: visibility };
  }

  let token = await getAccessToken(supabase, tenantId, "youtube", workspaceId);
  try {
    return await upload(token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Retry auth only if the session was not started; never repeat an
    // ambiguous video PUT which might already have created the upload.
    if (!/channel verification failed: HTTP 401/.test(message))
      throw error;
    token = await getAccessToken(supabase, tenantId, "youtube", workspaceId, true);
    return await upload(token);
  }
}

export async function fetchYoutubeVideoMetrics(
  supabase: SupabaseClient,
  tenantId: string,
  videoId: string,
  workspaceId?: string,
) {
  const token = await getAccessToken(supabase, tenantId, "youtube", workspaceId);
  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails,snippet,status&id=${encodeURIComponent(videoId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok)
    throw new Error(
      "YouTube metrics failed: " +
        response.status +
        " " +
        (await response.text()),
    );
  const data = (await response.json()) as {
    items?: Array<{
      snippet?: {
        publishedAt?: string;
        channelId?: string;
        channelTitle?: string;
      };
      statistics?: {
        viewCount?: string;
        likeCount?: string;
        commentCount?: string;
      };
      status?: { privacyStatus?: string };
    }>;
  };
  const item = data.items?.[0];
  if (!item) throw new Error("YouTube video was not found for metrics sync");
  let analytics: {
    subscribersGained?: number;
    averagePercentageViewed?: number;
    averageViewDurationSeconds?: number;
  } | null = null;
  if (item.snippet?.publishedAt) {
    const startDate = item.snippet.publishedAt.slice(0, 10);
    const endDate = new Date().toISOString().slice(0, 10);
    const analyticsResponse = await fetch(
      `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE&startDate=${startDate}&endDate=${endDate}&metrics=views%2Clikes%2Ccomments%2CsubscribersGained%2CaverageViewPercentage%2CaverageViewDuration&filters=video%3D%3D${encodeURIComponent(videoId)}`,
      { headers: { Authorization: "Bearer " + token } },
    );
    if (analyticsResponse.ok) {
      const report = (await analyticsResponse.json()) as {
        columnHeaders?: Array<{ name?: string }>;
        rows?: Array<Array<number>>;
      };
      const headers = (report.columnHeaders ?? []).map(
        (header) => header.name ?? "",
      );
      const values = report.rows?.[0] ?? [];
      analytics = {
        subscribersGained: values[headers.indexOf("subscribersGained")],
        averagePercentageViewed:
          values[headers.indexOf("averageViewPercentage")],
        averageViewDurationSeconds:
          values[headers.indexOf("averageViewDuration")],
      };
    }
  }
  return {
    views: Number(item.statistics?.viewCount ?? 0),
    likes: Number(item.statistics?.likeCount ?? 0),
    comments: Number(item.statistics?.commentCount ?? 0),
    subscribersGained: analytics?.subscribersGained,
    averagePercentageViewed: analytics?.averagePercentageViewed,
    averageViewDurationSeconds: analytics?.averageViewDurationSeconds,
    publishedAt: item.snippet?.publishedAt ?? null,
    channelId: item.snippet?.channelId ?? null,
    channelTitle: item.snippet?.channelTitle ?? null,
    privacyStatus: item.status?.privacyStatus ?? null,
  };
}
