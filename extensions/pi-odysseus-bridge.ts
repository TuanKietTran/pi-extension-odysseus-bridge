import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

const HOST = process.env.PI_BRIDGE_HOST ?? "127.0.0.1";
const PORT = parsePort(process.env.PI_BRIDGE_PORT, 8787);
const API_KEY = process.env.PI_BRIDGE_API_KEY;
const MAX_BODY_BYTES = parsePositiveInt(process.env.PI_BRIDGE_MAX_BODY_BYTES, 10 * 1024 * 1024);
const REQUEST_TIMEOUT_MS = parsePositiveInt(process.env.PI_BRIDGE_REQUEST_TIMEOUT_MS, 30 * 60 * 1000);

type OpenAIMessage = {
  role?: string;
  content?: string | Array<Record<string, unknown>> | null;
  name?: string;
};

type ChatRequest = {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  user?: string;
};

type ActiveRequest = {
  id: string;
  model: string;
  stream: boolean;
  response: ServerResponse;
  text: string;
  done: boolean;
  timer: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: Error) => void;
};

export default function piOdysseusBridge(pi: ExtensionAPI) {
  let server: Server | undefined;
  let context: ExtensionContext | undefined;
  let active: ActiveRequest | undefined;
  let requestQueue: Promise<void> = Promise.resolve();

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    if (server) return;

    server = createServer((req, res) => {
      void route(req, res).catch((error: unknown) => {
        if (!res.headersSent) sendError(res, 500, errorMessage(error), "server_error");
        else if (!res.writableEnded) res.end();
      });
    });

    server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(PORT, HOST, () => {
        server!.off("error", reject);
        resolve();
      });
    });

    ctx.ui.notify(`Pi OpenAI bridge: http://${HOST}:${PORT}/v1`, "info");
  });

  pi.on("model_select", (_event, ctx) => {
    context = ctx;
  });

  pi.on("before_agent_start", (event) => {
    if (!active) return;
    const system = currentSystemInstructions;
    currentSystemInstructions = "";
    if (!system) return;
    return { systemPrompt: `${event.systemPrompt}\n\nOpenAI client instructions for this request:\n${system}` };
  });

  pi.on("message_update", (event) => {
    if (!active || event.assistantMessageEvent.type !== "text_delta") return;
    const delta = event.assistantMessageEvent.delta;
    active.text += delta;
    if (active.stream && !active.response.writableEnded) {
      writeSse(active.response, chatChunk(active, { content: delta }, null));
    }
  });

  pi.on("agent_settled", () => {
    if (!active) return;
    finishActive();
  });

  pi.on("session_shutdown", async () => {
    context = undefined;
    if (active) failActive(new Error("Pi session shut down"));
    const closing = server;
    server = undefined;
    if (closing) {
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  });

  let currentSystemInstructions = "";

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (!authorized(req)) {
      sendError(res, 401, "Invalid or missing bearer token", "invalid_api_key");
      return;
    }

    const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && ["/", "/health", "/healthz", "/v1/health"].includes(pathname)) {
      sendJson(res, 200, {
        status: "ok",
        service: "pi-odysseus-bridge",
        busy: Boolean(active) || Boolean(context && !context.isIdle()),
        model: activeModelId(),
      });
      return;
    }

    if (req.method === "GET" && ["/models", "/v1/models"].includes(pathname)) {
      sendJson(res, 200, modelList());
      return;
    }

    const modelMatch = pathname.match(/^\/v1\/models\/(.+)$/);
    if (req.method === "GET" && modelMatch) {
      const id = decodeURIComponent(modelMatch[1]);
      const model = availableModels().find((candidate) => modelId(candidate) === id || candidate.id === id);
      if (!model) sendError(res, 404, `Model not found: ${id}`, "model_not_found");
      else sendJson(res, 200, modelObject(model));
      return;
    }

    if (req.method === "POST" && ["/chat/completions", "/v1/chat/completions"].includes(pathname)) {
      let body: ChatRequest;
      try {
        body = (await readJson(req)) as ChatRequest;
      } catch (error) {
        sendError(res, errorMessage(error).includes("too large") ? 413 : 400, errorMessage(error), "invalid_request_error");
        return;
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        sendError(res, 400, "messages must be a non-empty array", "invalid_request_error");
        return;
      }

      requestQueue = requestQueue.then(
        () => runChat(body, req, res),
        () => runChat(body, req, res),
      );
      await requestQueue;
      return;
    }

    sendError(res, 404, `Route not found: ${req.method ?? "GET"} ${pathname}`, "not_found");
  }

  async function runChat(body: ChatRequest, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!context) {
      sendError(res, 503, "Pi session is not ready", "service_unavailable");
      return;
    }
    if (!context.isIdle()) {
      sendError(res, 409, "Pi is busy with another prompt", "pi_busy");
      return;
    }

    const selected = resolveModel(body.model);
    if (body.model && body.model !== "pi-agent" && !selected) {
      sendError(res, 404, `Model not found: ${body.model}`, "model_not_found");
      return;
    }
    if (selected && modelId(selected) !== activeModelId()) {
      const switched = await pi.setModel(selected);
      if (!switched) {
        sendError(res, 401, `No authentication is available for ${body.model}`, "authentication_error");
        return;
      }
    }

    const prompt = extractLatestPrompt(body.messages!);
    if (!prompt.text && prompt.images.length === 0) {
      sendError(res, 400, "No user text or image was found in messages", "invalid_request_error");
      return;
    }

    currentSystemInstructions = extractSystemInstructions(body.messages!);
    const id = `chatcmpl-pi-${randomUUID()}`;
    const stream = body.stream === true;

    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        context?.abort();
        failActive(new Error("Pi bridge request timed out"));
      }, REQUEST_TIMEOUT_MS);
      active = { id, model: activeModelId(), stream, response: res, text: "", done: false, timer, resolve, reject };
      if (stream) writeSse(res, chatChunk(active, { role: "assistant" }, null));

      req.once("aborted", () => {
        if (active?.id === id) {
          context?.abort();
          failActive(new Error("Client disconnected"));
        }
      });

      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
      if (prompt.text) content.push({ type: "text", text: prompt.text });
      content.push(...prompt.images);
      try {
        pi.sendUserMessage(content, { expandPromptTemplates: false });
      } catch (error) {
        failActive(error instanceof Error ? error : new Error(String(error)));
      }
    }).catch((error: unknown) => {
      if (!res.headersSent) sendError(res, 500, errorMessage(error), "pi_error");
      else if (!res.writableEnded) {
        writeSse(res, { error: { message: errorMessage(error), type: "pi_error" } });
        res.write("data: [DONE]\n\n");
        res.end();
      }
    });
  }

  function finishActive(): void {
    const request = active;
    if (!request || request.done) return;
    request.done = true;
    clearTimeout(request.timer);

    if (request.stream) {
      if (!request.response.writableEnded) {
        writeSse(request.response, chatChunk(request, {}, "stop"));
        request.response.write("data: [DONE]\n\n");
        request.response.end();
      }
    } else if (!request.response.writableEnded) {
      sendJson(request.response, 200, {
        id: request.id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{ index: 0, message: { role: "assistant", content: request.text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    active = undefined;
    request.resolve();
  }

  function failActive(error: Error): void {
    const request = active;
    if (!request || request.done) return;
    request.done = true;
    clearTimeout(request.timer);
    active = undefined;
    request.reject(error);
  }

  function availableModels(): Array<{ id: string; provider: string; created?: number }> {
    return (context?.modelRegistry.getAvailable() ?? []) as Array<{ id: string; provider: string; created?: number }>;
  }

  function activeModelId(): string {
    return context?.model ? modelId(context.model) : "pi-agent";
  }

  function resolveModel(requested?: string) {
    if (!requested || requested === "pi-agent") return context?.model;
    const models = availableModels();
    return models.find((model) => modelId(model) === requested)
      ?? models.find((model) => model.id === requested);
  }

  function modelList() {
    const data = availableModels().map(modelObject);
    if (data.length === 0) data.push({ id: "pi-agent", object: "model", created: 0, owned_by: "pi" });
    return { object: "list", data };
  }
}

function modelId(model: { id: string; provider: string }): string {
  return `${model.provider}/${model.id}`;
}

function modelObject(model: { id: string; provider: string; created?: number }) {
  return { id: modelId(model), object: "model", created: model.created ?? 0, owned_by: model.provider };
}

function chatChunk(request: Pick<ActiveRequest, "id" | "model">, delta: Record<string, string>, finishReason: string | null) {
  return {
    id: request.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function writeSse(res: ServerResponse, value: unknown): void {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function extractSystemInstructions(messages: OpenAIMessage[]): string {
  return messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => contentToText(message.content))
    .filter(Boolean)
    .join("\n\n");
}

function extractLatestPrompt(messages: OpenAIMessage[]) {
  const latestUser = [...messages].reverse().find((message) => message.role === "user") ?? messages.at(-1)!;
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];

  if (Array.isArray(latestUser.content)) {
    for (const part of latestUser.content) {
      if (part.type !== "image_url") continue;
      const raw = typeof part.image_url === "string"
        ? part.image_url
        : typeof part.image_url === "object" && part.image_url !== null
          ? String((part.image_url as Record<string, unknown>).url ?? "")
          : "";
      const match = raw.match(/^data:([^;,]+);base64,(.+)$/s);
      if (match) images.push({ type: "image", mimeType: match[1], data: match[2] });
    }
  }

  return { text: contentToText(latestUser.content), images };
}

function contentToText(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text" || part.type === "input_text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) throw new Error("Request body is empty");
  return JSON.parse(raw);
}

function authorized(req: IncomingMessage): boolean {
  if (!API_KEY) return true;
  return req.headers.authorization === `Bearer ${API_KEY}` || req.headers["x-api-key"] === API_KEY;
}

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string, type: string): void {
  sendJson(res, status, { error: { message, type, code: type } });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
