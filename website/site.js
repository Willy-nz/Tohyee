/* Progressive enhancement: all navigation, downloads and FAQs work without JS. */
document.documentElement.classList.replace("no-js", "js");
const menu = document.querySelector(".menu-toggle");
const navigation = document.querySelector(".site-nav");
function closeMenu() {
  menu.setAttribute("aria-expanded", "false");
  navigation.classList.remove("is-open");
}
menu.addEventListener("click", () => {
  const open = menu.getAttribute("aria-expanded") !== "true";
  menu.setAttribute("aria-expanded", String(open));
  navigation.classList.toggle("is-open", open);
});
navigation.addEventListener("click", (event) => {
  if (event.target.closest("a")) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menu.getAttribute("aria-expanded") === "true") {
    closeMenu();
    menu.focus();
  }
});
// Each tab list switches only its own panels.
document.querySelectorAll('[role="tablist"]').forEach((list) => {
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  function selectTab(selected) {
    tabs.forEach((tab) => {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden =
        !active;
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft")
        next = (index + tabs.length - 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    });
  });
});

// Marketing illustration only: fixed fictional values, not accounting calculations.
const chartExamples = {
  sales: { total: "$195,000", label: "sales", heights: [48, 62, 54, 72, 68, 86], values: ["$24,000", "$31,000", "$27,000", "$36,000", "$34,000", "$43,000"] },
  costs: { total: "$139,000", label: "costs", heights: [36, 42, 40, 50, 52, 58], values: ["$18,000", "$21,000", "$20,000", "$25,000", "$26,000", "$29,000"] },
};
const chartButtons = document.querySelectorAll("[data-chart]");
chartButtons.forEach((button) => button.addEventListener("click", () => {
  const example = chartExamples[button.dataset.chart];
  chartButtons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  document.getElementById("chart-total").textContent = example.total;
  document.getElementById("chart-description").textContent = `Example ${example.label} · April–September`;
  document.getElementById("bar-chart").setAttribute("aria-label", `Monthly ${example.label} in NZ dollars`);
  document.querySelectorAll("#bar-chart .bar").forEach((bar, index) => {
    bar.style.setProperty("--bar", `${example.heights[index]}%`);
    bar.dataset.value = example.values[index];
  });
  const months = ["April", "May", "June", "July", "August", "September"];
  document.getElementById("chart-accessible").textContent = `${example.label}: ${months.map((month, index) => `${month} ${example.values[index]}`).join("; ")}.`;
}));
