"use strict";
// 面板空态页:还没有 Foundry 地址时的落点。文案由 main 按当前语言经 query 下发,
// 主题经 ?theme= 与系统对齐(同 foundry-unavailable 的链路)。
const query = new URLSearchParams(location.search);

document.documentElement.dataset.theme = query.get("theme") === "dark" ? "dark" : "light";
document.querySelector("h1").textContent = query.get("title") || "No Foundry address yet";
document.querySelector(".body").textContent = query.get("body") || "Share a Foundry address in the chat to open it here.";
