import { NextResponse, type NextRequest } from "next/server";
import { authorize, wwwAuthenticate } from "@/lib/basic-auth";

/**
 * Home-studio login on every route (ticket 020). Next.js 16 renamed
 * `middleware.ts` to `proxy.ts`, and a proxy runs on the Node.js runtime by
 * default, so node:crypto scrypt and node:fs are available here.
 *
 * The decision lives in lib/basic-auth.ts; this file only maps it to a
 * response. Server Actions are POSTs to page routes, so they pass through
 * here too.
 */
export async function proxy(request: NextRequest) {
  const decision = await authorize(request.headers, process.env.AIPANEL_AUTH_FILE, request.nextUrl.pathname);
  if (decision.ok) return NextResponse.next();
  if (decision.log) console.warn(decision.log);
  return new NextResponse(decision.message, {
    status: decision.status,
    headers: { "WWW-Authenticate": wwwAuthenticate(), "Content-Type": "text/plain; charset=utf-8" },
  });
}

export const config = {
  // Everything except `_next/static`: content-hashed JS/CSS built from this
  // public repo, holding no secrets (the app has no NEXT_PUBLIC_* vars).
  // Skipping it avoids one scrypt per chunk on page load. `_next/image`,
  // public/ files, pages and /api/* all require the login.
  matcher: ["/((?!_next/static/).*)"],
};
