/**
 * Audit trail routes — export controls per CISO §3.2.
 *
 * POST /api/companies/:companyId/audit/exports  → create export job
 * GET  /api/companies/:companyId/audit/exports  → list export jobs
 * GET  /api/companies/:companyId/audit/exports/:id → get export job status
 * GET  /api/companies/:companyId/audit/exports/:id/download → download encrypted output
 */

import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { auditExportService, ExportError } from "../services/audit-export.js";
import { auditAlertService, type AlertType, type AlertSeverity } from "../services/audit-alerts.js";
import { auditAnomalyDetectionService } from "../services/audit-anomaly-detection.js";
import { agentService } from "../services/agents.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, unauthorized } from "../errors.js";

/**
 * Role-based access control for audit exports per CISO §3.1:
 *   - CLO/CISO agents: full read + export access
 *   - Board users: full access
 *   - CEO/COO/CTO agents: full access
 *   - IC agents: denied (own traces only via query API, no bulk export)
 */
const EXPORT_ALLOWED_ROLES = new Set(["clo", "ciso", "ceo", "coo", "cto"]);

async function assertExportAccess(req: Request, db: Db) {
  if (req.actor.type === "board") return;

  if (req.actor.type === "agent") {
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const agents = agentService(db);
    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent) throw forbidden("Agent not found");

    const role = actorAgent.role?.toLowerCase() ?? "";
    if (EXPORT_ALLOWED_ROLES.has(role)) return;

    throw forbidden("Export access requires CLO, CISO, or board privileges");
  }

  throw unauthorized();
}

/**
 * Role-based access control for audit alerts per CISO §6.3:
 *   - CISO/CLO agents: full access
 *   - Board users: full access
 *   - CEO/COO/CTO agents: read access
 *   - IC agents: denied
 */
const ALERT_READ_ROLES = new Set(["ciso", "clo", "ceo", "coo", "cto"]);

async function assertAlertReadAccess(req: Request, db: Db) {
  if (req.actor.type === "board") return;

  if (req.actor.type === "agent") {
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const agentsSvc = agentService(db);
    const actorAgent = await agentsSvc.getById(req.actor.agentId);
    if (!actorAgent) throw forbidden("Agent not found");
    const role = actorAgent.role?.toLowerCase() ?? "";
    if (ALERT_READ_ROLES.has(role)) return;
    throw forbidden("Alert access requires CISO, CLO, CTO, or board privileges");
  }

  throw unauthorized();
}

export function auditRoutes(db: Db) {
  const router = Router();
  const exportSvc = auditExportService(db);
  const alertSvc = auditAlertService(db);
  const anomalySvc = auditAnomalyDetectionService(db);

  // ── Create export job ──────────────────────────────────────────

  router.post("/companies/:companyId/audit/exports", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertExportAccess(req, db);

    const { filters } = req.body;
    if (!filters || typeof filters !== "object") {
      res.status(400).json({ error: "Request body must include 'filters' object" });
      return;
    }

    const actor = getActorInfo(req);

    try {
      const job = await exportSvc.createExportJob(companyId, filters, actor);

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "audit.export_created",
        entityType: "audit_export",
        entityId: job.id,
        details: {
          spanCount: job.spanCount,
          status: job.status,
          approvalId: job.approvalId,
          filters,
        },
      });

      res.status(201).json(job);
    } catch (err) {
      if (err instanceof ExportError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // ── List export jobs ───────────────────────────────────────────

  router.get("/companies/:companyId/audit/exports", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertExportAccess(req, db);

    const limit = Math.min(
      parseInt(req.query.limit as string, 10) || 50,
      200,
    );

    const jobs = await exportSvc.listExportJobs(companyId, limit);
    res.json(jobs);
  });

  // ── Get export job ─────────────────────────────────────────────

  router.get("/companies/:companyId/audit/exports/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertExportAccess(req, db);

    const job = await exportSvc.getExportJob(req.params.id as string);
    if (!job || job.companyId !== companyId) {
      res.status(404).json({ error: "Export job not found" });
      return;
    }

    // Don't include the encrypted output in the status response.
    const { encryptedOutput: _, ...jobWithoutOutput } = job;
    res.json(jobWithoutOutput);
  });

  // ── Download export ────────────────────────────────────────────

  router.get(
    "/companies/:companyId/audit/exports/:id/download",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await assertExportAccess(req, db);

      try {
        const download = await exportSvc.downloadExport(req.params.id as string);

        if (download.companyId !== companyId) {
          res.status(404).json({ error: "Export job not found" });
          return;
        }

        // Audit the download event.
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "audit.export_downloaded",
          entityType: "audit_export",
          entityId: download.exportJobId,
          details: {
            spanCount: download.spanCount,
            outputSizeBytes: download.outputSizeBytes,
          },
        });

        res.json(download);
      } catch (err) {
        if (err instanceof ExportError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ── List alerts ────────────────────────────────────────────────

  router.get("/companies/:companyId/audit/alerts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertAlertReadAccess(req, db);

    const filters = {
      companyId,
      alertType: req.query.alertType as AlertType | undefined,
      severity: req.query.severity as AlertSeverity | undefined,
      acknowledged: req.query.acknowledged === "true" ? true : req.query.acknowledged === "false" ? false : undefined,
      since: req.query.since ? new Date(req.query.since as string) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const alerts = await alertSvc.list(filters);
    res.json(alerts);
  });

  // ── Count unacknowledged alerts (before :id to avoid route conflict) ──

  router.get("/companies/:companyId/audit/alerts/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertAlertReadAccess(req, db);

    const counts = await alertSvc.countUnacknowledged(companyId);
    res.json(counts);
  });

  // ── Get alert by ID ───────────────────────────────────────────

  router.get("/companies/:companyId/audit/alerts/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertAlertReadAccess(req, db);

    const alert = await alertSvc.getById(parseInt(req.params.id as string, 10));
    if (!alert || alert.companyId !== companyId) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json(alert);
  });

  // ── Acknowledge alert ─────────────────────────────────────────

  router.post("/companies/:companyId/audit/alerts/:id/acknowledge", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertAlertReadAccess(req, db);

    const alertId = parseInt(req.params.id as string, 10);
    const existing = await alertSvc.getById(alertId);
    if (!existing || existing.companyId !== companyId) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }

    const actor = getActorInfo(req);
    const updated = await alertSvc.acknowledge(alertId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "audit.alert.acknowledged",
      entityType: "audit_alert",
      entityId: String(alertId),
      details: {
        alertType: existing.alertType,
        severity: existing.severity,
      },
    });

    res.json(updated);
  });

  // ── Run anomaly detection scan ────────────────────────────────

  router.post("/companies/:companyId/audit/anomaly-scan", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertAlertReadAccess(req, db);

    // Only CISO/board can trigger scans.
    if (req.actor.type === "agent") {
      const agentsSvc = agentService(db);
      const actorAgent = await agentsSvc.getById(req.actor.agentId!);
      const role = actorAgent?.role?.toLowerCase() ?? "";
      if (role !== "ciso" && role !== "clo") {
        throw forbidden("Only CISO, CLO, or board users can trigger anomaly scans");
      }
    }

    const windowHours = Math.min(
      parseInt(req.body.windowHours as string, 10) || 24,
      720, // Max 30 days
    );
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - windowHours * 60 * 60 * 1000);

    const report = await anomalySvc.runAllDetectors(companyId, { startTime, endTime });
    res.json(report);
  });

  return router;
}
