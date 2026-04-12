/**
 * FAA-enhanced trace enrichment for aviation cost-sharing operations.
 *
 * Per CLO §9: FAA-regulated spans require enhanced span attributes with full
 * input/output parameters for flight cost calculations, passenger matching,
 * and payment processing. These spans carry a 3-year (1095-day) retention
 * override.
 *
 * Security: All PII fields (passenger names, emails, payment card numbers)
 * MUST be redacted or hashed before inclusion in span attributes. Only
 * anonymized identifiers and aggregate values are permitted (CLO §2, CISO §4).
 */

import type { AuditActionType } from "./audit-types.js";

// ── Constants ──────────────────────────────────────────────────

/** FAA-mandated retention period in days (3 years). */
export const FAA_RETENTION_DAYS = 1095;

/** Attribute namespace for FAA-enhanced spans. */
const NS = "pax.faa";

/** All FAA-specific span attribute keys. */
export const FAA_ATTR = {
  // Flight cost calculation
  FLIGHT_ID: `${NS}.flight.id`,
  FLIGHT_ORIGIN: `${NS}.flight.origin`,
  FLIGHT_DESTINATION: `${NS}.flight.destination`,
  FLIGHT_DATE: `${NS}.flight.date`,
  FLIGHT_CARRIER: `${NS}.flight.carrier`,
  COST_TOTAL_CENTS: `${NS}.cost.total_cents`,
  COST_CURRENCY: `${NS}.cost.currency`,
  COST_PER_SEAT_CENTS: `${NS}.cost.per_seat_cents`,
  COST_SPLIT_METHOD: `${NS}.cost.split_method`,
  COST_SEAT_COUNT: `${NS}.cost.seat_count`,

  // Passenger matching
  PASSENGER_COUNT: `${NS}.passenger.count`,
  PASSENGER_HASH_LIST: `${NS}.passenger.hash_list`,
  MATCH_ALGORITHM: `${NS}.match.algorithm`,
  MATCH_CONFIDENCE: `${NS}.match.confidence`,
  MATCH_RESULT_COUNT: `${NS}.match.result_count`,

  // Payment processing
  PAYMENT_ID: `${NS}.payment.id`,
  PAYMENT_METHOD: `${NS}.payment.method`,
  PAYMENT_AMOUNT_CENTS: `${NS}.payment.amount_cents`,
  PAYMENT_CURRENCY: `${NS}.payment.currency`,
  PAYMENT_STATUS: `${NS}.payment.status`,
  PAYMENT_PROCESSOR: `${NS}.payment.processor`,

  // Cost-sharing decision
  DECISION_ID: `${NS}.decision.id`,
  DECISION_RULE: `${NS}.decision.rule`,
  DECISION_PARTICIPANTS: `${NS}.decision.participant_count`,
  DECISION_OUTCOME: `${NS}.decision.outcome`,

  // Retention metadata
  RETENTION_OVERRIDE_DAYS: `${NS}.retention.override_days`,
  REGULATORY_AUTHORITY: `${NS}.regulatory.authority`,
} as const;

/** The set of FAA action types for type-safe filtering. */
export const FAA_ACTION_TYPES: readonly AuditActionType[] = [
  "faa.flight_cost_calculation",
  "faa.passenger_matching",
  "faa.payment_processing",
  "faa.cost_sharing_decision",
] as const;

// ── Input Types ────────────────────────────────────────────────

export interface FlightCostInput {
  flightId: string;
  origin: string;
  destination: string;
  flightDate: string;
  carrier: string;
  seatCount: number;
  splitMethod: "equal" | "proportional" | "custom";
}

export interface FlightCostOutput {
  totalCostCents: number;
  perSeatCostCents: number;
  currency: string;
}

export interface PassengerMatchInput {
  passengerHashList: string[];
  algorithm: string;
}

export interface PassengerMatchOutput {
  matchCount: number;
  confidence: number;
}

export interface PaymentInput {
  paymentId: string;
  method: "card" | "ach" | "wire" | "wallet";
  amountCents: number;
  currency: string;
  processor: string;
}

export interface PaymentOutput {
  status: "success" | "failed" | "pending" | "refunded";
}

export interface CostSharingDecisionInput {
  decisionId: string;
  rule: string;
  participantCount: number;
}

export interface CostSharingDecisionOutput {
  outcome: "approved" | "rejected" | "escalated";
}

// ── Enrichment Functions ───────────────────────────────────────

/**
 * Build span attributes for a flight cost calculation.
 * Returns a flat attribute map suitable for `span.setAttributes()`.
 */
export function enrichFlightCostCalculation(
  input: FlightCostInput,
  output: FlightCostOutput,
): Record<string, string | number> {
  return {
    [FAA_ATTR.FLIGHT_ID]: input.flightId,
    [FAA_ATTR.FLIGHT_ORIGIN]: input.origin,
    [FAA_ATTR.FLIGHT_DESTINATION]: input.destination,
    [FAA_ATTR.FLIGHT_DATE]: input.flightDate,
    [FAA_ATTR.FLIGHT_CARRIER]: input.carrier,
    [FAA_ATTR.COST_SEAT_COUNT]: input.seatCount,
    [FAA_ATTR.COST_SPLIT_METHOD]: input.splitMethod,
    [FAA_ATTR.COST_TOTAL_CENTS]: output.totalCostCents,
    [FAA_ATTR.COST_PER_SEAT_CENTS]: output.perSeatCostCents,
    [FAA_ATTR.COST_CURRENCY]: output.currency,
    [FAA_ATTR.RETENTION_OVERRIDE_DAYS]: FAA_RETENTION_DAYS,
    [FAA_ATTR.REGULATORY_AUTHORITY]: "FAA",
  };
}

/**
 * Build span attributes for passenger matching.
 * Passenger identifiers MUST be pre-hashed (SHA-256) before calling this.
 */
export function enrichPassengerMatching(
  input: PassengerMatchInput,
  output: PassengerMatchOutput,
): Record<string, string | number> {
  return {
    [FAA_ATTR.PASSENGER_COUNT]: input.passengerHashList.length,
    [FAA_ATTR.PASSENGER_HASH_LIST]: input.passengerHashList.join(","),
    [FAA_ATTR.MATCH_ALGORITHM]: input.algorithm,
    [FAA_ATTR.MATCH_RESULT_COUNT]: output.matchCount,
    [FAA_ATTR.MATCH_CONFIDENCE]: output.confidence,
    [FAA_ATTR.RETENTION_OVERRIDE_DAYS]: FAA_RETENTION_DAYS,
    [FAA_ATTR.REGULATORY_AUTHORITY]: "FAA",
  };
}

/**
 * Build span attributes for payment processing.
 */
export function enrichPaymentProcessing(
  input: PaymentInput,
  output: PaymentOutput,
): Record<string, string | number> {
  return {
    [FAA_ATTR.PAYMENT_ID]: input.paymentId,
    [FAA_ATTR.PAYMENT_METHOD]: input.method,
    [FAA_ATTR.PAYMENT_AMOUNT_CENTS]: input.amountCents,
    [FAA_ATTR.PAYMENT_CURRENCY]: input.currency,
    [FAA_ATTR.PAYMENT_PROCESSOR]: input.processor,
    [FAA_ATTR.PAYMENT_STATUS]: output.status,
    [FAA_ATTR.RETENTION_OVERRIDE_DAYS]: FAA_RETENTION_DAYS,
    [FAA_ATTR.REGULATORY_AUTHORITY]: "FAA",
  };
}

/**
 * Build span attributes for a cost-sharing decision.
 */
export function enrichCostSharingDecision(
  input: CostSharingDecisionInput,
  output: CostSharingDecisionOutput,
): Record<string, string | number> {
  return {
    [FAA_ATTR.DECISION_ID]: input.decisionId,
    [FAA_ATTR.DECISION_RULE]: input.rule,
    [FAA_ATTR.DECISION_PARTICIPANTS]: input.participantCount,
    [FAA_ATTR.DECISION_OUTCOME]: output.outcome,
    [FAA_ATTR.RETENTION_OVERRIDE_DAYS]: FAA_RETENTION_DAYS,
    [FAA_ATTR.REGULATORY_AUTHORITY]: "FAA",
  };
}

/**
 * Check whether an action type is FAA-regulated and requires
 * the 3-year retention override.
 */
export function isFaaRegulatedAction(actionType: string): boolean {
  return (FAA_ACTION_TYPES as readonly string[]).includes(actionType);
}
