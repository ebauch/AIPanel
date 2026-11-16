import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/openrouter";
import { getRegistry } from "@/lib/providers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every provider with its status and the models Settings can add from it. */
export async function GET(request: Request) {
  const ctx = { openRouterApiKey: resolveApiKey(request) };
  const providers = await Promise.all(
    getRegistry().providers.map(async (provider) => {
      const [status, offered] = await Promise.all([
        provider.isConfigured(ctx).catch((err: unknown) => ({
          state: "error" as const,
          detail: err instanceof Error ? err.message : String(err),
        })),
        provider.listOfferedModels(ctx).catch(() => []),
      ]);
      return {
        id: provider.id,
        label: provider.label,
        kind: provider.kind,
        efforts: provider.efforts,
        status,
        offeredModels: offered,
      };
    }),
  );
  return NextResponse.json({ providers });
}
