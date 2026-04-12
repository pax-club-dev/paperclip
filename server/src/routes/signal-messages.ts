import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { signalMessageService } from "../services/signal-messages.js";
import { assertCompanyAccess } from "./authz.js";

export function signalMessageRoutes(db: Db) {
  const router = Router();
  const svc = signalMessageService(db);

  router.get("/companies/:companyId/signal-messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const since = req.query.since as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const messages = await svc.list(companyId, { since, limit });
    res.json(messages);
  });

  return router;
}
