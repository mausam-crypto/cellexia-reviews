/**
 * Cellexia Reviews — the AI spend ledger (SPEC-1.20 §3).
 *
 * One rolling per-shop, per-calendar-month total in dollars, and one question:
 * "would this next call take the merchant past the ceiling they set?"
 *
 * It lives in its own module rather than inside curation.server because
 * TRANSLATION is billed too — an all_translated curation run pays for the
 * translations it triggers — and translate.server cannot import curation.server
 * (curation.server imports translate.server). Both import this instead.
 *
 * Only BILLED usage is recorded: real input/output token counts returned by
 * the API, never an estimate. A model with no published price records nothing
 * rather than an invented number, and callers are told so up front.
 */
import type { ClaudeUsage } from "./ai.server";
import prisma from "~/db.server";
import { costUsd } from "./pricing.server";
import { getSettings } from "./settings.server";

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Would `additionalUsd` push this shop past its ceiling? A shop with no
 * ceiling always passes. Reads the rolling monthly counter, resetting it
 * implicitly when the month changes.
 */
export async function checkBudget(
  shop: string,
  additionalUsd: number,
): Promise<{ ok: boolean; spent: number; ceiling: number | null }> {
  const settings = await getSettings(shop);
  const ceiling = settings.curationBudgetUsd ?? null;
  const raw = settings.curationSpendMonth === currentMonth() ? settings.curationSpendUsd : 0;
  // Reservations are released by subtracting, so the stored total can dip
  // below zero if a batch came in cheaper than estimated. Never show or judge
  // a negative spend.
  const spent = Math.max(0, raw);
  if (ceiling == null) return { ok: true, spent, ceiling };
  return { ok: spent + additionalUsd <= ceiling, spent, ceiling };
}

/** Adds BILLED usage to the rolling monthly counter. Never throws. */
export async function recordSpend(
  shop: string,
  model: string,
  usage: ClaudeUsage,
  batch: boolean,
): Promise<void> {
  const amount = costUsd({
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    batch,
  });
  if (amount == null || amount <= 0) return;
  await addSpend(shop, amount);
}

/** Adds an already-computed dollar amount. Never throws. */
export async function addSpend(shop: string, amount: number): Promise<void> {
  if (!Number.isFinite(amount) || amount <= 0) return;
  await adjustSpend(shop, amount);
}

/**
 * Signed version of addSpend, for releasing a reservation.
 *
 * A release must credit the month the money was CHARGED to, which is why
 * callers pass `forMonth`. Releasing a July reservation in August against
 * August's counter would subtract it from a total it was never part of and
 * wipe out the new month's real spend. When the stored month has already
 * moved on, the release is simply dropped: that month's counter is gone, and
 * this month never carried the charge.
 */
export async function adjustSpend(
  shop: string,
  delta: number,
  forMonth: string = currentMonth(),
): Promise<void> {
  if (!Number.isFinite(delta) || delta === 0) return;
  if (delta < 0) {
    await prisma.setting
      .updateMany({
        where: { shop, curationSpendMonth: forMonth },
        data: { curationSpendUsd: { increment: delta } },
      })
      .catch((error) => {
        console.error("[cellexia] spend release failed", error);
      });
    return;
  }
  await incrementSpend(shop, delta, currentMonth());
}

async function incrementSpend(shop: string, amount: number, month: string): Promise<void> {
  try {
    // Atomic increment, never read-then-write: curation runs concurrently
    // (CURATION_CONCURRENCY) and a lost update here would under-count spend
    // against the merchant's ceiling — always in the direction that lets it
    // be breached.
    const bumped = await prisma.setting.updateMany({
      where: { shop, curationSpendMonth: month },
      data: { curationSpendUsd: { increment: amount } },
    });
    if (bumped.count > 0) return;

    // The stored month is not this one (rollover, or a shop that has never
    // spent). Roll it over with a compare-and-set on the OLD month, so of two
    // callers arriving together exactly one performs the reset...
    const rolled = await prisma.setting.updateMany({
      where: { shop, curationSpendMonth: { not: month } },
      data: { curationSpendMonth: month, curationSpendUsd: amount },
    });
    if (rolled.count > 0) return;

    // ...and the other, which lost that race, increments the fresh total
    // rather than overwriting it. A plain `update` here would drop its amount.
    await prisma.setting.updateMany({
      where: { shop, curationSpendMonth: month },
      data: { curationSpendUsd: { increment: amount } },
    });
  } catch (error) {
    console.error("[cellexia] spend record failed", error);
  }
}
