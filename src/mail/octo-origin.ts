export function normalizeOctoOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error("Agent Mail API baseUrl must be a valid URL", { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Agent Mail API baseUrl must use http or https");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(
      "Agent Mail API baseUrl must be an origin without credentials, path, query, or fragment",
    );
  }
  return url.origin;
}
