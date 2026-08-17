import type { FastifyInstance } from "fastify";
import { getClaudeOnboardingStatus, setClaudeOnboardingSkip } from "../claude-onboarding.js";
import { errors } from "../errors.js";

export async function registerClaudeOnboardingRoutes(app: FastifyInstance) {
  app.get("/api/claude/onboarding-skip", async () => await getClaudeOnboardingStatus());

  app.put<{ Body: { enabled?: unknown } }>("/api/claude/onboarding-skip", async (req) => {
    if (typeof req.body?.enabled !== "boolean") {
      throw errors.invalidQuery("enabled must be a boolean");
    }
    return await setClaudeOnboardingSkip(req.body.enabled);
  });
}
