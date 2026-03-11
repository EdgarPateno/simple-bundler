function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function renderSimpleBundlerBlock(root) {
  const endpoint = root.dataset.endpoint;
  const fallbackHeading = root.dataset.fallbackHeading || "THIS BUNDLE COMES WITH:";

  if (!endpoint) return;

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

function bootSimpleBundlerBlocks() {
  const roots = document.querySelectorAll(".simple-bundler-block[data-endpoint]");
  roots.forEach((root) => {
    renderSimpleBundlerBlock(root);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootSimpleBundlerBlocks);
} else {
  bootSimpleBundlerBlocks();
}