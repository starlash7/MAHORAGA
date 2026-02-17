import type { Account, Position } from "../../../core/types";
import type { BuyCandidate, StrategyContext } from "../../types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function selectPredictionEntries(ctx: StrategyContext, positions: Position[], account: Account): BuyCandidate[] {
  const heldSymbols = new Set(positions.map((p) => p.symbol.toUpperCase()));
  const availableSlots = Math.max(0, ctx.config.max_positions - positions.length);
  if (availableSlots === 0) return [];

  const sentimentThreshold = Math.max(0.15, ctx.config.min_sentiment_score);
  const candidates = ctx.signals
    .filter((signal) => signal.source === "prediction_market")
    .filter((signal) => !heldSymbols.has(signal.symbol.toUpperCase()))
    .filter((signal) => signal.sentiment >= sentimentThreshold)
    .filter((signal) => {
      if (typeof signal.price !== "number") return false;
      // Avoid entering near binary extremes where asymmetry is poor.
      return signal.price >= 0.05 && signal.price <= 0.95;
    })
    .sort((a, b) => {
      const scoreA = a.sentiment * 0.7 + ((a.quality_score ?? 0) / 100) * 0.3;
      const scoreB = b.sentiment * 0.7 + ((b.quality_score ?? 0) / 100) * 0.3;
      return scoreB - scoreA;
    });

  const maxEntriesPerCycle = Math.min(availableSlots, 3);
  const results: BuyCandidate[] = [];

  for (const signal of candidates) {
    if (results.length >= maxEntriesPerCycle) break;

    const confidence = clamp(signal.sentiment, 0, 1);
    const positionSizePct = Math.min(20, ctx.config.position_size_pct_of_cash);
    const rawNotional = account.cash * (positionSizePct / 100) * confidence;
    const notional = Math.min(rawNotional, ctx.config.max_position_value);

    // Kalshi notional is dollar-based with contract pricing in cents.
    // Keep a small floor so order->contract conversion does not round to zero.
    if (notional < 5) continue;

    results.push({
      symbol: signal.symbol,
      confidence,
      notional,
      reason: `Prediction edge entry (${signal.reason})`,
    });
  }

  return results;
}
