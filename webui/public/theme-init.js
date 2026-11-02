// Applies the saved light/dark choice before the first paint (a classic,
// render-blocking script: no flash of the wrong theme). The page's CSP allows
// only same-origin scripts, so this cannot be an inline <script>.
try {
	const saved = localStorage.getItem("paseo-team-theme");
	if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch {}
