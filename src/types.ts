/** Wire types for the Magnus `/v1` API. See CONTRACT.md. */

/** An agent (persona), presented as an OpenAI "model". */
export interface Agent {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
  permission?: unknown[];
  root?: string;
  parent?: string | null;
  [key: string]: unknown;
}

/** A text part of a multimodal message. */
export interface TextPart {
  type: "text";
  text: string;
}

/** An image part. Magnus reads no text from it; an image-only turn is a 400. */
export interface ImagePart {
  type: "image_url";
  image_url: { url: string; detail?: string };
}

export type ContentPart = TextPart | ImagePart | Record<string, unknown>;

/** A message's content: a plain string, or multimodal parts. */
export type Content = string | ContentPart[];

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: Content;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Magnus's non-standard additions to the OpenAI response. */
export interface MagnusExtensions {
  /** The conversation the server actually ran on — carry this, not what you sent. */
  session_id: string;
  /** How the session was decided. */
  session_source: "explicit" | "derived" | "new";
  /** Identifies this turn in the Magnus per-turn traces. */
  trace_id: string | null;
  turn_id: string | null;
  /**
   * `measured` = real provider token counts. `estimated` = the `len/4`
   * character heuristic, used by turns that never reached an LLM. Anyone
   * metering or billing off `usage` has to be able to tell them apart.
   */
  usage_source: "measured" | "estimated";
  /**
   * True while a person from the team owns the conversation: the turn where
   * the agent hands off, and every turn after it, whose reply is a fixed
   * notice. A server older than the field omits it; that is not a handoff.
   */
  handoff?: boolean;
}

export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: Usage;
  session_id?: string;
  magnus?: MagnusExtensions;
}
