// Supabase Edge Function "ask": the in-app writing assistant.
// Signed-in users only (Supabase verifies the JWT before this runs).
//
// Secrets (Dashboard -> Edge Functions -> Secrets):
//   ANTHROPIC_API_KEY  required
//   CLAUDE_MODEL       optional, defaults to claude-opus-5-5 (claude-haiku-5-5 costs much less)
//   AI_DAILY_LIMIT     optional, messages per person per day, defaults to 30
//   ALLOWED_ORIGIN     optional, your site origin, e.g. https://vikramtkv.github.io
// SUPABASE_URL and SUPABASE_ANON_KEY are provided by Supabase automatically.

import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-opus-5-5";
const DAILY_LIMIT = Number(Deno.env.get("AI_DAILY_LIMIT") ?? "30");
const ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
// Models that accept the server-side refusal fallback ("default" form).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

const MAX_TURNS = 20;
const MAX_NOTE_CHARS = 12000;
const MAX_MESSAGE_CHARS = 4000;

const SYSTEM = `You are the writing helper inside an online notepad. The person is working on the note in the first message. Answer their questions about it briefly and concretely. Use plain text; short dash lists are fine. When they ask you to rewrite or add content, reply with only the new text so it can be added to the note.`;

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

type Turn = { role: "user" | "assistant"; content: string };

function readTurns(raw: unknown): Turn[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const turns: Turn[] = [];
  for (const t of raw.slice(-MAX_TURNS)) {
    if (!t || (t.role !== "user" && t.role !== "assistant") || typeof t.content !== "string") return null;
    const content = t.content.trim().slice(0, MAX_MESSAGE_CHARS);
    if (content) turns.push({ role: t.role, content });
  }
  if (!turns.length || turns[turns.length - 1].role !== "user") return null;
  return turns;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "sign_in_required" }, 401);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: userData } = await sb.auth.getUser();
  if (!userData?.user) return json({ error: "sign_in_required" }, 401);

  let payload: { note?: { title?: unknown; type?: unknown; text?: unknown }; messages?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const turns = readTurns(payload.messages);
  if (!turns) return json({ error: "bad_request" }, 400);

  const note = payload.note ?? {};
  const title = typeof note.title === "string" && note.title.trim() ? note.title.trim().slice(0, 200) : "(untitled)";
  const type = typeof note.type === "string" ? note.type.slice(0, 20) : "plain";
  const text = typeof note.text === "string" && note.text.trim() ? note.text.slice(0, MAX_NOTE_CHARS) : "(empty)";

  const { data: allowed, error: usageError } = await sb.rpc("bump_ai_usage", { p_limit: DAILY_LIMIT });
  if (usageError) return json({ error: "server_error" }, 500);
  if (!allowed) return json({ error: "daily_limit" }, 429);

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: `Note title: ${title}\nNote type: ${type}\n<note>\n${text}\n</note>` },
    ...turns,
  ];

  // `fallbacks` re-runs a declined request on a suitable model inside the same call.
  // Cast: the field may be newer than the SDK's published types.
  const params = {
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { effort: "low" },
    messages,
    ...(FALLBACK_MODELS.has(MODEL) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming;

  try {
    const response = await anthropic.beta.messages.create(params);
    if (response.stop_reason === "refusal") return json({ error: "refused" }, 422);
    const answer = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n\n")
      .trim();
    if (!answer) return json({ error: "empty" }, 502);
    return json({ text: answer, truncated: response.stop_reason === "max_tokens" });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return json({ error: "busy" }, 503);
    if (error instanceof Anthropic.AuthenticationError) {
      console.error("ANTHROPIC_API_KEY is missing or invalid");
      return json({ error: "server_error" }, 500);
    }
    if (error instanceof Anthropic.APIError) {
      console.error(`Claude API error ${error.status}: ${error.message}`);
      return json({ error: "upstream_error" }, 502);
    }
    console.error(error);
    return json({ error: "server_error" }, 500);
  }
});
