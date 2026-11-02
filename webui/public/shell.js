/**
 * shell.js — the frame around every page: light/dark theme, the sidebar as a
 * drawer on small screens, the mobile title, and keyboard shortcuts.
 *
 * Nothing here reads or writes team data. Browser storage holds only the
 * theme choice, and every access is guarded: a private window or blocked
 * storage simply falls back to the system theme.
 */

const THEME_KEY = "paseo-team-theme";

function readTheme() {
	try {
		return localStorage.getItem(THEME_KEY);
	} catch {
		return null;
	}
}

function systemTheme() {
	return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function mountShell({ selectTab, $ }) {
	const root = document.documentElement;
	const current = () => root.dataset.theme || systemTheme();
	const setTheme = (next) => {
		root.dataset.theme = next;
		try {
			localStorage.setItem(THEME_KEY, next);
		} catch {}
		$("theme-toggle")?.setAttribute("aria-pressed", String(next === "light"));
	};
	if (readTheme()) root.dataset.theme = readTheme();
	$("theme-toggle")?.addEventListener("click", () => setTheme(current() === "light" ? "dark" : "light"));

	// Sidebar as a drawer below the breakpoint.
	const sidebar = $("sidebar");
	const scrim = $("scrim");
	const openBtn = $("nav-open");
	const setOpen = (open) => {
		document.body.classList.toggle("nav-open", open);
		openBtn?.setAttribute("aria-expanded", String(open));
		if (scrim) scrim.hidden = !open;
	};
	openBtn?.addEventListener("click", () => setOpen(!document.body.classList.contains("nav-open")));
	scrim?.addEventListener("click", () => setOpen(false));
	sidebar?.addEventListener("click", (event) => {
		if (event.target?.closest?.("button[data-tab]")) setOpen(false);
	});

	// Keyboard: g then a letter jumps to a page; Esc closes the drawer.
	const jumps = { h: "home", a: "graph", f: "flow", p: "permissions", m: "hosts", c: "config", r: "roles" };
	let pending = false;
	let timer = null;
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") setOpen(false);
		const target = event.target;
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName ?? ""))) return;
		if (event.key === "g") {
			pending = true;
			clearTimeout(timer);
			timer = setTimeout(() => (pending = false), 900);
			return;
		}
		if (pending && jumps[event.key]) {
			pending = false;
			const button = document.querySelector(`#tabs button[data-tab="${jumps[event.key]}"]`);
			if (button && button.offsetParent !== null) selectTab(jumps[event.key]);
		}
	});

	return {
		/** Called on every tab change: mobile title + a fresh entrance animation. */
		onTab(name) {
			const label = document.querySelector(`#tabs button[data-tab="${name}"] span[data-i18n]`)?.textContent ?? "";
			const title = $("topbar-title");
			if (title) title.textContent = label;
			const section = $(`tab-${name}`);
			if (section) {
				section.classList.remove("enter");
				void section.offsetWidth;
				section.classList.add("enter");
			}
		},
	};
}
