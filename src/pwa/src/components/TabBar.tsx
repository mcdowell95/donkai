import { navigate } from "../hooks";

const TABS = [
  { path: "/", label: "Home", icon: "⌂" },
  { path: "/queue", label: "Queue", icon: "☰" },
  { path: "/settings", label: "Settings", icon: "⚙" },
  { path: "/costs", label: "Costs", icon: "$" },
];

export function TabBar({ path }: { path: string }) {
  return (
    <nav class="tabbar">
      {TABS.map((tab) => {
        const active = tab.path === "/" ? path === "/" || path.startsWith("/ticket/") : path.startsWith(tab.path);
        return (
          <button
            key={tab.path}
            class={`tab${active ? " tab-active" : ""}`}
            onClick={() => navigate(tab.path)}
          >
            <span class="tab-icon">{tab.icon}</span>
            <span class="tab-label">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
