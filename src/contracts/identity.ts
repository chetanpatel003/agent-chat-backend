import { z } from "zod";

export const AuthenticatedUserResponseSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  displayName: z.string().nullable(),
  imageUrl: z.url().nullable(),
  createdAt: z.iso.datetime(),
});
export type AuthenticatedUserResponse = z.infer<
  typeof AuthenticatedUserResponseSchema
>;
