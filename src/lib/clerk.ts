import { createClerkClient } from "@clerk/backend";

// Singleton Backend API client. Used for: (a) verifying bearer tokens sent
// by the frontend, and (b) the one-time profile fetch when a Clerk user is
// seen locally for the first time (see services/auth.ts). Never imported
// by anything that runs in the browser.
export const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});
