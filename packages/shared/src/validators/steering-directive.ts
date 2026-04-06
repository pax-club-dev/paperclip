import { z } from "zod";

const STEERING_DIRECTIVE_SCOPES = ["company", "project", "agent", "issue"] as const;

export const createSteeringDirectiveSchema = z.object({
  scope: z.enum(STEERING_DIRECTIVE_SCOPES),
  scopeId: z.string().uuid(),
  key: z.string().min(1).max(128),
  content: z.string().min(1),
  priority: z.number().int().min(0).optional().default(0),
  active: z.boolean().optional().default(true),
  projectId: z.string().uuid().optional().nullable(),
  agentId: z.string().uuid().optional().nullable(),
});

export type CreateSteeringDirective = z.infer<typeof createSteeringDirectiveSchema>;

export const updateSteeringDirectiveSchema = createSteeringDirectiveSchema.partial();

export type UpdateSteeringDirective = z.infer<typeof updateSteeringDirectiveSchema>;
