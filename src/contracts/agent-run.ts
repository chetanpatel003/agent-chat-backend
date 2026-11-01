import { z } from "zod";
import { enumSchema } from "./enum-schema";
import {
  AgentRunStatus,
  ToolInvocationStatus,
  WaitpointStatus,
  WaitingReason,
} from "@/generated/prisma/enums";

export const AgentRunStatusSchema = enumSchema(AgentRunStatus);
export const ToolInvocationStatusSchema = enumSchema(ToolInvocationStatus);
export const WaitpointStatusSchema = enumSchema(WaitpointStatus);
export const WaitingReasonSchema = enumSchema(WaitingReason);

export const AgentRunResponseSchema = z.object({
  id: z.uuid(),
  chatId: z.uuid(),
  status: AgentRunStatusSchema,
  waitingReason: WaitingReasonSchema.nullable(),
  model: z.string().nullable(),
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  turnCount: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AgentRunResponse = z.infer<typeof AgentRunResponseSchema>;
