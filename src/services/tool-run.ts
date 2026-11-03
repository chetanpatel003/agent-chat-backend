import { ValidationError } from "@/lib/errors";
import { PRODUCTION_TOOL_REGISTRY } from "@/tools/registry";
import type { ToolRegistry } from "@/tools/types";
import { sendTurn } from "@/services/send-turn";
import type { ToolRunRequest } from "@/contracts/tool-run";
import type { SendMessageResponse } from "@/contracts/message";

/**
 * POST /api/v1/chats/{chatId}/tool-runs. Input is checked against the
 * tool's own schema before anything is persisted; the run is then admitted
 * exactly like a message (ownership, one active run per chat, idempotency)
 * and executed by the agent task without a model call. Credit admission and
 * settlement happen inside the tool, as for any agent-requested call.
 */
export async function submitToolRun(
  userId: string,
  chatId: string,
  idempotencyKey: string,
  request: ToolRunRequest,
  registry: ToolRegistry = PRODUCTION_TOOL_REGISTRY,
): Promise<SendMessageResponse> {
  const tool = registry.get(request.tool);
  if (!tool) throw new ValidationError(`Tool ${request.tool} is not available`);
  const parsed = tool.inputSchema.safeParse(request.input);
  if (!parsed.success) throw new ValidationError("Invalid tool input", parsed.error.issues);
  const input = parsed.data as Record<string, unknown>;
  return sendTurn(userId, chatId, idempotencyKey, {
    text: `Run ${request.tool} with ${JSON.stringify(input)}`.slice(0, 8000),
    directTool: { name: request.tool, input },
  });
}
