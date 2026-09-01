/**
 * Validate Developer → Quality handoff using @praxis/contracts.
 */
import {
  DeveloperToQualityHandoffSchema,
  verificationIsReady,
  type DeveloperToQualityHandoff,
} from "@praxis/contracts";
import type { DevQualityHandoff } from "./review-engine.js";

export class HandoffValidationError extends Error {
  readonly statusCode = 400;
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HandoffValidationError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Parse + validate handoff. Throws HandoffValidationError on contract failures.
 * Also requires verification readiness (required checks passed).
 */
export function validateDeveloperQualityHandoff(
  raw: unknown,
): DeveloperToQualityHandoff {
  let parsed: DeveloperToQualityHandoff;
  try {
    parsed = DeveloperToQualityHandoffSchema.parse(raw);
  } catch (err) {
    throw new HandoffValidationError(
      "invalid_handoff",
      "developer.quality.handoff failed schema validation",
      err instanceof Error ? err.message : err,
    );
  }
  if (parsed.contract !== "developer.quality.handoff") {
    throw new HandoffValidationError(
      "wrong_contract",
      `unexpected contract: ${parsed.contract}`,
    );
  }
  if (!parsed.workPackageId) {
    throw new HandoffValidationError(
      "missing_workPackageId",
      "workPackageId is required",
    );
  }
  if (!verificationIsReady(parsed.verification)) {
    throw new HandoffValidationError(
      "verification_not_ready",
      "required verification checks are not all passed",
      parsed.verification,
    );
  }
  return parsed;
}

export function asDevQualityHandoff(
  h: DeveloperToQualityHandoff,
): DevQualityHandoff {
  return h as unknown as DevQualityHandoff;
}
