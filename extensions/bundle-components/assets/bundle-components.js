function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getSelectedVariantId() {
  const url = new URL(window.location.href);
  const variantFromUrl = url.searchParams.get("variant");
  if (variantFromUrl) return variantFromUrl;

  const selectedInput =
    document.querySelector('form[action*="/cart/add"] input[name="id"][value]:checked') ||
    document.querySelector('form[action*="/cart/add"] input[name="id"]') ||
    document.querySelector('input[name="id"][value]:checked') ||
    document.querySelector('input[name="id"]');

  return selectedInput?.value || "";
}

function buildEndpoint(baseEndpoint, variantId) {
  if (!baseEndpoint) return "";
  const url = new URL(baseEndpoint, window.location.origin);

  if (variantId) {
    url.searchParams.set("variant_id", variantId);
  } else {
    url.searchParams.delete("variant_id");
  }

  return url.toString();
}

async function renderSimpleBundlerBlock(root) {
  const baseEndpoint = root.dataset.endpoint;
  const fallbackHeading = root.dataset.fallbackHeading || "THIS BUNDLE COMES WITH:";

  if (!baseEndpoint) return;

  const variantId = getSelectedVariantId();
  const endpoint = buildEndpoint(baseEndpoint, variantId);

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) return;

    const data = await response.json();
    if (!data?.ok || !data?.found) {
      if (!root.querySelector(".simple-bundler-placeholder")) {
        root.innerHTML = "";
      }
      return;
    }

    const heading = (data.bundleIncludesText || "").trim() || fallbackHeading;
    const components = Array.isArray(data.components) ? data.components : [];

    if (!components.length && !heading) {
      root.innerHTML = "";
      return;
    }

    const listItems = components
      .map((component) => {
        const title = escapeHtml(component.title || "");
        return `<li class="simple-bundler-components__item">${title}</li>`;
      })
      .join("");

    root.innerHTML = `
      <div class="simple-bundler-components">
        ${heading ? `<p class="simple-bundler-components__heading">${escapeHtml(heading)}</p>` : ""}
        ${components.length ? `<ul class="simple-bundler-components__list">${listItems}</ul>` : ""}
      </div>
    `;
  } catch (error) {
    console.error("Simple Bundler block failed to load.", error);
  }
}

function rerenderAllSimpleBundlerBlocks() {
  const roots = document.querySelectorAll(".simple-bundler-block[data-endpoint]");
  roots.forEach((root) => {
    renderSimpleBundlerBlock(root);
  });
}

function bootSimpleBundlerBlocks() {
  rerenderAllSimpleBundlerBlocks();

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.matches('input[name="id"], select[name="id"]')) {
      setTimeout(() => {
        rerenderAllSimpleBundlerBlocks();
      }, 50);
    }
  });

  window.addEventListener("popstate", () => {
    rerenderAllSimpleBundlerBlocks();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootSimpleBundlerBlocks);
} else {
  bootSimpleBundlerBlocks();
}