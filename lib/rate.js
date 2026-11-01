// Sliding failure window for the sync passphrase. Pure so tests can lock it.

export function rateCheck(prev, now, max) {
  if (!prev || typeof prev.resetAt !== "number" || now >= prev.resetAt) {
    return { limited: false };
  }
  return { limited: prev.fails >= max };
}

export function rateFail(prev, now, windowMs) {
  if (!prev || typeof prev.resetAt !== "number" || now >= prev.resetAt) {
    return { fails: 1, resetAt: now + windowMs };
  }
  return { fails: prev.fails + 1, resetAt: prev.resetAt };
}
