import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createSteeringDirectiveSchema,
  updateSteeringDirectiveSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { steeringDirectiveService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function steeringDirectiveRoutes(db: Db) {
  const router = Router();
  const svc = steeringDirectiveService(db);

  // List directives (optionally filtered by scope + scopeId)
  router.get("/companies/:companyId/steering-directives", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const scope = req.query.scope as string | undefined;
    const scopeId = req.query.scopeId as string | undefined;
    const result = await svc.list(companyId, scope, scopeId);
    res.json(result);
  });

  // Compose directives for a given context (used by heartbeat or preview)
  router.get("/companies/:companyId/steering-directives/compose", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const projectId = (req.query.projectId as string) || null;
    const agentId = (req.query.agentId as string) || null;
    const issueId = (req.query.issueId as string) || null;
    const directives = await svc.compose({ companyId, projectId, agentId, issueId });
    const markdown = svc.formatAsMarkdown(directives);
    res.json({ directives, markdown });
  });

  // Get by ID
  router.get("/steering-directives/:id", async (req, res) => {
    const id = req.params.id as string;
    const directive = await svc.getById(id);
    if (!directive) {
      res.status(404).json({ error: "Steering directive not found" });
      return;
    }
    assertCompanyAccess(req, directive.companyId);
    res.json(directive);
  });

  // Create
  router.post(
    "/companies/:companyId/steering-directives",
    validate(createSteeringDirectiveSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const directive = await svc.create({
        ...req.body,
        companyId,
        createdByAgentId: actor.agentId ?? undefined,
        createdByUserId: actor.actorType === "user" ? actor.actorId : undefined,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "steering_directive.created",
        entityType: "steering_directive",
        entityId: directive!.id,
        details: { key: directive!.key, scope: directive!.scope },
      });
      res.status(201).json(directive);
    },
  );

  // Update
  router.patch(
    "/steering-directives/:id",
    validate(updateSteeringDirectiveSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Steering directive not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);
      const directive = await svc.update(id, req.body);
      if (!directive) {
        res.status(404).json({ error: "Steering directive not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: directive.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "steering_directive.updated",
        entityType: "steering_directive",
        entityId: directive.id,
        details: req.body,
      });
      res.json(directive);
    },
  );

  // Delete
  router.delete("/steering-directives/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Steering directive not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const directive = await svc.remove(id);
    if (!directive) {
      res.status(404).json({ error: "Steering directive not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: directive.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "steering_directive.deleted",
      entityType: "steering_directive",
      entityId: directive.id,
    });
    res.json(directive);
  });

  return router;
}
