/** Small HTTP helpers shared by the public pages and the admin routes. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { baseUrl } from "./config.js";

export const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Express handler from an async function that returns the JSON body; errors go to the error middleware. */
export function wrap(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next: NextFunction) => {
    fn(req, res).then(
      out => {
        if (!res.headersSent) res.json(out);
      },
      err => next(err)
    );
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** Render public/<file> replacing {{VAR}} with escaped values. */
export async function page(file: string, vars: Record<string, string> = {}): Promise<string> {
  let html = await fs.readFile(path.join(publicDir, file), "utf8");
  for (const [k, v] of Object.entries(vars)) html = html.replaceAll(`{{${k}}}`, escapeHtml(v));
  return html;
}

/** The paste-into-your-assistant block. Same text everywhere a key is handed out. */
export function connectBlock(token: string): string {
  return [
    `Connect to Relay. MCP server: ${baseUrl()}/mcp`,
    `Auth header: Authorization: Bearer ${token}`,
    "Ask me for the key using your secure credential prompt.",
    "To reach someone, call agent.ask with timeout_s 60: it returns their answer inline when their agent is listening.",
    "When I ask you to check Relay, call inbox.list with wait_s 30. If you can run recurring tasks, do that every few minutes too.",
    "If anything needs my decision, summarise it and ask me before replying."
  ].join("\n");
}
