"use strict";
document.querySelector("p").textContent = new URLSearchParams(location.search).get("message") || "Foundry unavailable";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
