import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { DomainError } from "../engine.js";

export function isPublicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a === 198
    );
  }
  return (
    isIP(address) === 6 &&
    /^2[0-9a-f]{3}:/i.test(address) &&
    !/^2001:(?:db8|0:|2:|10:)/i.test(address)
  );
}
export function publicHttpsUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new DomainError(400, "Use a public HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash ||
    !url.hostname.includes(".") ||
    url.hostname.endsWith(".local") ||
    (isIP(url.hostname) && !isPublicAddress(url.hostname))
  )
    throw new DomainError(
      400,
      "Only public HTTPS endpoints on port 443 without embedded credentials are supported.",
    );
  return url;
}
// Resolve once and pin that public address to the TLS request, preventing DNS rebinding.
export async function publicRequest(
  input: string,
  headers: Record<string, string> = {},
  maxBytes = 250_000,
): Promise<{ status: number; text: string }> {
  const url = publicHttpsUrl(input);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new DomainError(
      400,
      "The endpoint resolves to a private or reserved network.",
    );
  const chosen = addresses[0];
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        headers,
        family: chosen.family,
        lookup: (_hostname, _options, cb) =>
          cb(null, chosen.address, chosen.family),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes)
            req.destroy(
              new Error("Endpoint response exceeded the size limit."),
            );
          else chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(20_000, () => req.destroy(new Error("Endpoint timed out.")));
    req.on("error", reject);
    req.end();
  });
}
