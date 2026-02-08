import type {
  RunInput,
  CartTransformRunResult,
  Operation,
} from "../generated/api";

const NO_CHANGES: CartTransformRunResult = { operations: [] };

export function cartTransformRun(input: RunInput): CartTransformRunResult {
  const operations: Operation[] = [];

  for (const line of input.cart.lines) {
    const merch = line.merchandise;

    // Only bundles are ProductVariant lines that have our metafield
    if (merch.__typename !== "ProductVariant") continue;

    const raw = merch.componentReference?.value;
    const componentVariantIds = parseVariantIdList(raw);

    if (componentVariantIds.length === 0) continue;

    // Expand the bundle line into component variants.
    // IMPORTANT: Do NOT set fixedPricePerUnit on components,
    // so the parent line keeps the bundle price (e.g. $150).
    const expandedCartItems = componentVariantIds.map((variantGid) => ({
      merchandiseId: variantGid,
      quantity: line.quantity, // mirror the bundle line qty
      attributes: [
        { key: "_bundle_parent_variant_id", value: merch.id },
        { key: "_bundle_component", value: "true" },
      ],
    }));

    operations.push({
      lineExpand: {
        cartLineId: line.id,
        expandedCartItems,
        // Leave price undefined so the bundle parent line keeps its price
        // price: undefined,
        // Optional: you can override the displayed title if you want:
        // title: merch.title,
      },
    });
  }

  return operations.length ? { operations } : NO_CHANGES;
}

function parseVariantIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);

    // Expected for list.product_variant_reference:
    // ["gid://shopify/ProductVariant/...", "gid://shopify/ProductVariant/..."]
    if (Array.isArray(parsed)) {
      return parsed.filter((v) => typeof v === "string" && v.startsWith("gid://"));
    }
  } catch {
    // ignore
  }

  return [];
}
