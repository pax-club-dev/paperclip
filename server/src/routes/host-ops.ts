/**
 * Host operations routes — secure gateway for agents to apply patches
 * and push to git without needing direct host filesystem or credential access.
 *
 * Auth: requires board access (local_trusted) OR valid agent JWT/key.
 * In local_trusted mode, all requests are implicitly authenticated.
 * Agent JWTs are issued per-run by the heartbeat system.
 */

import { Router } from "express";
import { hostPatchService } from "../services/host-patch.js";
import { getActorInfo } from "./authz.js";
import { badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";

export function hostOpsRoutes() {
  const router = Router();
  const patchSvc = hostPatchService();

  // -----------------------------------------------------------------------
  // POST /host/apply-patch
  //
  // Accepts a unified diff and applies it to the host repo.
  // Validates, applies, typechecks, commits — all server-side.
  // -----------------------------------------------------------------------
  router.post("/host/apply-patch", async (req, res) => {
    const actor = getActorInfo(req); // throws 401 if unauthenticated

    const {
      patch,
      commitMessage,
      agentName,
      issueIdentifier,
      skipTypecheck,
      targetDir,
    } = req.body ?? {};

    if (!patch || typeof patch !== "string") {
      throw badRequest("'patch' is required and must be a string (unified diff)");
    }
    if (!commitMessage || typeof commitMessage !== "string") {
      throw badRequest("'commitMessage' is required and must be a string");
    }

    logger.info(
      {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentName,
        issueIdentifier,
        patchSize: patch.length,
        skipTypecheck: !!skipTypecheck,
      },
      "host-ops: apply-patch request received",
    );

    const result = await patchSvc.applyPatch({
      patch,
      commitMessage,
      agentName: agentName ?? (actor.actorType === "agent" ? actor.actorId : undefined),
      agentId: actor.actorType === "agent" ? actor.actorId : undefined,
      issueIdentifier,
      skipTypecheck: !!skipTypecheck,
      targetDir,
    });

    if (!result.ok) {
      logger.warn(
        { ...result, actorId: actor.actorId },
        "host-ops: apply-patch failed",
      );
      res.status(422).json(result);
      return;
    }

    logger.info(
      { commitSha: result.commitSha, actorId: actor.actorId, issueIdentifier },
      "host-ops: apply-patch succeeded",
    );
    res.json(result);
  });

  // -----------------------------------------------------------------------
  // POST /host/git-push
  //
  // Pushes the current branch to a remote using server-side credentials.
  // -----------------------------------------------------------------------
  router.post("/host/git-push", async (req, res) => {
    const actor = getActorInfo(req);

    const { remote, branch, force } = req.body ?? {};

    logger.info(
      {
        actorType: actor.actorType,
        actorId: actor.actorId,
        remote: remote ?? "origin",
        branch: branch ?? "(current)",
        force: !!force,
      },
      "host-ops: git-push request received",
    );

    const result = await patchSvc.gitPush({
      remote,
      branch,
      force: !!force,
    });

    if (!result.ok) {
      logger.warn({ ...result, actorId: actor.actorId }, "host-ops: git-push failed");
      res.status(422).json(result);
      return;
    }

    logger.info(
      { remote: result.remote, branch: result.branch, actorId: actor.actorId },
      "host-ops: git-push succeeded",
    );
    res.json(result);
  });

  // -----------------------------------------------------------------------
  // GET /host/git-status
  //
  // Returns current branch and working tree status (diagnostic endpoint).
  // -----------------------------------------------------------------------
  router.get("/host/git-status", async (req, res) => {
    getActorInfo(req); // auth check
    const status = await patchSvc.gitStatus();
    res.json(status);
  });

  return router;
}
