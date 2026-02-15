import type { Input, CartTransformRunResult } from "../generated/api";

const NO_CHANGES: CartTransformRunResult = { operations: [] };

export function cartTransformRun(input: Input): CartTransformRunResult {
  const operations: CartTransformRunResult["operations"] = [];

  for (const line of input.cart.lines) {
    const merch = line.merchandise;
    if (merch.__typename !== "ProductVariant") continue;

    const raw = merch.metafield?.value;
    const componentVariantIds = parseVariantIdList(raw);
    if (componentVariantIds.length < 2) continue;

    operations.push({
      lineExpand: {
        cartLineId: line.id,
        expandedCartItems: componentVariantIds.slice(0, 2).map((merchandiseId) => ({
          merchandiseId,
          quantity: 1,
        })),
      },
    });
  }

  return operations.length ? { operations } : NO_CHANGES;
}

function parseVariantIdList(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((v): v is string => typeof v === "string")
        .filter((s) => s.startsWith("gid://shopify/ProductVariant/"));
    }
  } catch {}
  return [];
}
