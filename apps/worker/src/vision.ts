import type { AiCredential } from "./ai-orchestrator.js";

type BrandKitResult = {
  preset?: string;
  primaryColor?: string;
  accentColor?: string;
  backgroundColor?: string;
  headline?: { color?: string; fontSize?: number; weight?: number };
  caption?: { fontSize?: number; position?: string; highlight?: boolean; uppercase?: boolean; maxWords?: number };
  safeArea?: { top?: number; bottom?: number; left?: number; right?: number };
  logo?: { enabled?: boolean; position?: string; opacity?: number };
  secondaryVideo?: { enabled?: boolean; ratio?: number; position?: string };
  analysisNotes?: string[];
};

function parseResult(value: string): BrandKitResult {
  const cleaned = value.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(cleaned) as BrandKitResult;
  return parsed && typeof parsed === "object" ? parsed : {};
}

export async function analyzeBrandKitFrames(frames: Buffer[], credential: AiCredential) {
  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: `Analyze these video frames as a visual brand reference for short-form video editing. Return ONLY valid JSON, no markdown. Infer only visible properties. Use this exact shape and conservative values: {"preset":"string","primaryColor":"#RRGGBB","accentColor":"#RRGGBB","backgroundColor":"#RRGGBB","headline":{"color":"#RRGGBB","fontSize":52,"weight":800},"caption":{"fontSize":46,"position":"bottom","highlight":true,"uppercase":false,"maxWords":7},"safeArea":{"top":120,"bottom":180,"left":64,"right":64},"logo":{"enabled":false,"position":"top-right","opacity":0.9},"secondaryVideo":{"enabled":true,"ratio":0.5,"position":"bottom"},"analysisNotes":["short note"]}. The renderer currently applies accentColor, headline.color and headline.fontSize; keep all other fields as best-effort review data. Do not invent a logo if none is visible.`,
    },
  ];
  for (const frame of frames) {
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${frame.toString("base64")}` } });
  }
  const response = await fetch(`${credential.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: credential.model, temperature: 0.1, messages: [{ role: "user", content }] }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Vision analysis failed: ${response.status} ${body.slice(0, 300)}`);
  const data = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Vision model returned an empty analysis");
  return parseResult(text);
}
