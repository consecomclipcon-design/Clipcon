/**
 * Fail-closed publishing policy: tests and upload worker share these invariants.
 * No user data and no OAuth credentials are ever logged from this module.
 */
export type YoutubePrivacy = "private" | "unlisted" | "public";

export function resolveUploadPrivacy(
  requested: unknown = "private",
  options: { explicitlyApprovedPublic?: boolean } = {},
): YoutubePrivacy {
  if (requested === "private" || requested === undefined || requested === null)
    return "private";
  if (requested === "unlisted") return "unlisted";
  if (requested === "public" && options.explicitlyApprovedPublic === true)
    return "public";
  if (requested === "public")
    throw new Error("Explicit public publishing approval is required");
  throw new Error("Unsupported YouTube privacy setting");
}

export function assertChannelMatch(
  actual: string | null | undefined,
  expected: string | null | undefined,
): string {
  if (!expected) throw new Error("Missing authorized channel identity: reconnect YouTube");
  if (!actual) throw new Error("Cannot verify authenticated YouTube channel");
  if (actual !== expected)
    throw new Error("Authenticated YouTube channel differs from approved workspace channel");
  return actual;
}

export function parseYoutubeVideoId(input: unknown): string {
  const id = (input as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(id))
    throw new Error("YouTube upload did not return a valid video ID");
  return id;
}
