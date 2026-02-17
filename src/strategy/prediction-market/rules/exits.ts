import type { Account, Position } from "../../../core/types";
import type { SellCandidate, StrategyContext } from "../../types";

function toPositionPlPct(position: Position): number {
  if (Number.isFinite(position.unrealized_plpc)) {
    return position.unrealized_plpc * 100;
  }
  const cost = position.market_value - position.unrealized_pl;
  if (!Number.isFinite(cost) || cost === 0) return 0;
  return (position.unrealized_pl / cost) * 100;
}

export function selectPredictionExits(ctx: StrategyContext, positions: Position[], _account: Account): SellCandidate[] {
  const exits: SellCandidate[] = [];
  const signalBySymbol = new Map(
    ctx.signals.filter((signal) => signal.source === "prediction_market").map((signal) => [signal.symbol, signal])
  );

  for (const position of positions) {
    const plPct = toPositionPlPct(position);

    if (plPct >= ctx.config.take_profit_pct) {
      exits.push({
        symbol: position.symbol,
        reason: `Prediction take profit at +${plPct.toFixed(2)}%`,
      });
      continue;
    }

    if (plPct <= -ctx.config.stop_loss_pct) {
      exits.push({
        symbol: position.symbol,
        reason: `Prediction stop loss at ${plPct.toFixed(2)}%`,
      });
      continue;
    }

    const signal = signalBySymbol.get(position.symbol);
    if (signal && signal.sentiment <= -0.45) {
      exits.push({
        symbol: position.symbol,
        reason: `Prediction signal reversal (${signal.reason})`,
      });
      continue;
    }

    // Reduce tail risk near binary resolution.
    if (typeof position.prediction_probability === "number" && position.prediction_probability >= 0.95) {
      exits.push({
        symbol: position.symbol,
        reason: `Prediction contract near resolution (${(position.prediction_probability * 100).toFixed(1)}%)`,
      });
    }
  }

  return exits;
}
