import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

function toGidProductId(restProductId: number | string) {
  // Webhook payload uses REST numeric IDs, but your DB stores GraphQL GIDs
  return `gid://shopify/Product/${String(restProductId)}`;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  let topic: string;
  let shop: string;
  let payload: any;

  try {
    // ✅ Correct for shopify-app-react-router template
    ({ topic, shop, payload } = await authenticate.webhook(request));
  } catch (e) {
    // Invalid webhook (bad HMAC, wrong route, etc.)
    console.error("Webhook authentication failed:", e);
    return new Response("unauthorized", { status: 401 });
  }

  try {
    switch (topic) {
      case "PRODUCTS_DELETE": {
        // Payload usually contains REST numeric `id`
        // Sometimes includes `admin_graphql_api_id` too — handle both.
        const gid =
          payload?.admin_graphql_api_id ??
          (payload?.id ? toGidProductId(payload.id) : null);

        if (gid) {
          await db.bundle.deleteMany({
            where: {
              shop,
              parentProductId: String(gid),
            },
          });
        }

        break;
      }

      case "PRODUCTS_UPDATE": {
        const gid =
          payload?.admin_graphql_api_id ??
          (payload?.id ? toGidProductId(payload.id) : null);

        const status = String(payload?.status || "").toLowerCase(); // active|draft|archived

        if (gid) {
          await db.bundle.updateMany({
            where: {
              shop,
              parentProductId: String(gid),
            },
            data: {
              status: status || "unknown",
            },
          });
        }

        break;
      }

      case "APP_UNINSTALLED": {
        await db.bundle.deleteMany({ where: { shop } });
        break;
      }

      default:
        // ignore
        break;
    }

    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("Webhook handler error:", topic, e);
    return new Response("error", { status: 500 });
  }
};
