import { enumSchema } from "./enum-schema";
import {
  AgentRunStatus,
  ToolInvocationStatus,
  WaitpointStatus,
} from "@/generated/prisma/enums";

export const AgentRunStatusSchema = enumSchema(AgentRunStatus);
export const ToolInvocationStatusSchema = enumSchema(ToolInvocationStatus);
export const WaitpointStatusSchema = enumSchema(WaitpointStatus);
