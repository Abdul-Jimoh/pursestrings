export const REPO = "https://github.com/Abdul-Jimoh/pursestrings";
export const blob = (path: string) => `${REPO}/blob/main/${path}`;

/** The Range backend; the page falls back to static copy when it isn't reachable. */
export const RANGE_API = process.env.NEXT_PUBLIC_RANGE_API ?? "http://localhost:8787";
