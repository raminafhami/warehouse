/** @param {AbortSignal} signal */
export async function isApiReady(signal) {
  const response = await fetch("/api/v1/health/ready", {
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
  });
  if (!response.ok) return false;
  const payload = await response.json();
  return payload?.result?.status === "ready";
}
